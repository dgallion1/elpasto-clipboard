"use client";

import type { DirectClipEnvelope } from "@/lib/direct-transfer";
import type { BinaryClipCatalogEntry } from "@/lib/clip-store";
import type { ThreadRecord } from "@/lib/threads";
import type { ClipKind, ClipZone } from "@/lib/clips";
import type { DirectTransferControlMessage } from "@/lib/webrtc";

// Security (H1/H3): a data-channel control message arrives as attacker-controlled
// JSON from any peer in the session. Everything below validates and bounds it
// before the dispatcher acts on it — unknown types, wrong field shapes, and
// oversized strings/arrays are rejected (returns null) so a malicious peer cannot
// inject malformed state or exhaust memory through the control plane.

export const PEER_MESSAGE_LIMITS = {
  rawChars: 1_000_000,
  idChars: 256,
  nameChars: 256,
  filenameChars: 1024,
  mimeChars: 255,
  noteChars: 100_000,
  timestampChars: 64,
  declaredSizeBytes: 2_147_483_648, // 2 GiB
  arrayItems: 1000,
  threads: 200,
  positions: 200,
  namesEntries: 500,
} as const;

const CLIP_KINDS: ReadonlySet<ClipKind> = new Set(["text", "html", "image", "file"]);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Non-empty identifier (transferId, peer id, thread/zone id).
function parseId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.trim().length === 0 || value.length > PEER_MESSAGE_LIMITS.idChars) return null;
  return value;
}

// A bounded string that may be empty (display names, etc.).
function parseBoundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length > max) return null;
  return value;
}

// Optional `string | null` field (note); `undefined`/`null` collapse to null.
function parseOptionalText(value: unknown, max: number): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || value.length > max) return { ok: false };
  return { ok: true, value };
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function parseIdArray(value: unknown, max = PEER_MESSAGE_LIMITS.arrayItems): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const item of value) {
    const id = parseId(item);
    if (id === null) return null;
    out.push(id);
  }
  return out;
}

// encryptionMeta is validated again on the server; here we only require it to be
// a plain object or null, bounded overall by the raw-message cap.
function parseEncryptionMeta(value: unknown): { ok: true; value: Record<string, unknown> | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false };
  return { ok: true, value };
}

function parseEncryptionVersion(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false };
  return { ok: true, value };
}

function parseClipKind(value: unknown): ClipKind | null {
  return typeof value === "string" && CLIP_KINDS.has(value as ClipKind) ? (value as ClipKind) : null;
}

function parseSizeBytes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value > PEER_MESSAGE_LIMITS.declaredSizeBytes) return null;
  return value;
}

function parseEnvelope(value: unknown): DirectClipEnvelope | null {
  if (!isRecord(value)) return null;

  const transferId = parseId(value.transferId);
  const zone = parseId(value.zone);
  const kind = parseClipKind(value.kind);
  const mimeType = parseBoundedString(value.mimeType, PEER_MESSAGE_LIMITS.mimeChars);
  const originalName = parseBoundedString(value.originalName, PEER_MESSAGE_LIMITS.filenameChars);
  const createdAt = parseBoundedString(value.createdAt, PEER_MESSAGE_LIMITS.timestampChars);
  const sizeBytes = parseSizeBytes(value.sizeBytes);
  const version = parseEncryptionVersion(value.encryptionVersion);
  const meta = parseEncryptionMeta(value.encryptionMeta);
  const note = parseOptionalText(value.note, PEER_MESSAGE_LIMITS.noteChars);

  if (
    transferId === null || zone === null || kind === null || mimeType === null ||
    originalName === null || createdAt === null || sizeBytes === null ||
    !version.ok || !meta.ok || !note.ok || typeof value.encrypted !== "boolean"
  ) {
    return null;
  }

  return {
    transferId,
    zone: zone as ClipZone,
    kind,
    mimeType,
    originalName,
    encrypted: value.encrypted,
    encryptionVersion: version.value,
    encryptionMeta: meta.value as DirectClipEnvelope["encryptionMeta"],
    sizeBytes,
    createdAt,
    note: note.value,
  };
}

type CatalogEntry = {
  transferId: string;
  zone: ClipZone;
  kind: ClipKind;
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  encryptionVersion: number | null;
  encryptionMeta: Record<string, unknown> | null;
  createdAt: string;
  note: string | null;
};

function parseCatalogEntry(value: unknown): CatalogEntry | null {
  if (!isRecord(value)) return null;
  const transferId = parseId(value.transferId);
  const zone = parseId(value.zone);
  const kind = parseClipKind(value.kind);
  const mimeType = parseBoundedString(value.mimeType, PEER_MESSAGE_LIMITS.mimeChars);
  const originalName = parseBoundedString(value.originalName, PEER_MESSAGE_LIMITS.filenameChars);
  const createdAt = parseBoundedString(value.createdAt, PEER_MESSAGE_LIMITS.timestampChars);
  const sizeBytes = parseSizeBytes(value.sizeBytes);
  const version = parseEncryptionVersion(value.encryptionVersion);
  const meta = parseEncryptionMeta(value.encryptionMeta);
  const note = parseOptionalText(value.note, PEER_MESSAGE_LIMITS.noteChars);

  if (
    transferId === null || zone === null || kind === null || mimeType === null ||
    originalName === null || createdAt === null || sizeBytes === null ||
    !version.ok || !meta.ok || !note.ok
  ) {
    return null;
  }

  return {
    transferId,
    zone: zone as ClipZone,
    kind,
    mimeType,
    originalName,
    sizeBytes,
    encryptionVersion: version.value,
    encryptionMeta: meta.value,
    createdAt,
    note: note.value,
  };
}

function parseThread(value: unknown): ThreadRecord | null {
  if (!isRecord(value)) return null;
  const id = parseId(value.id);
  const name = parseBoundedString(value.name, PEER_MESSAGE_LIMITS.nameChars);
  if (id === null || name === null) return null;
  if (typeof value.position !== "number" || !Number.isFinite(value.position)) return null;
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;
  if (value.deletedAt !== undefined && value.deletedAt !== null) {
    if (typeof value.deletedAt !== "number" || !Number.isFinite(value.deletedAt)) return null;
  }
  const record: ThreadRecord = {
    id: id as ClipZone,
    name,
    position: value.position,
    updatedAt: value.updatedAt,
  };
  if (typeof value.deletedAt === "number") {
    record.deletedAt = value.deletedAt;
  }
  return record;
}

function parsePositions(value: unknown): { id: string; position: number; updatedAt: number }[] | null {
  if (!Array.isArray(value) || value.length > PEER_MESSAGE_LIMITS.positions) return null;
  const out: { id: string; position: number; updatedAt: number }[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const id = parseId(item.id);
    if (id === null) return null;
    if (typeof item.position !== "number" || !Number.isFinite(item.position)) return null;
    const updatedAt = parseTimestamp(item.updatedAt);
    if (updatedAt === null) return null;
    out.push({ id, position: item.position, updatedAt });
  }
  return out;
}

function parseNamesRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > PEER_MESSAGE_LIMITS.namesEntries) return null;
  const out: Record<string, string> = {};
  for (const [key, name] of entries) {
    if (FORBIDDEN_KEYS.has(key)) continue; // prototype-pollution guard (L1)
    const id = parseId(key);
    const value = parseBoundedString(name, PEER_MESSAGE_LIMITS.nameChars);
    if (id === null || value === null) return null;
    out[id] = value;
  }
  return out;
}

export function parseControlMessage(raw: string): DirectTransferControlMessage | null {
  if (typeof raw !== "string" || raw.length > PEER_MESSAGE_LIMITS.rawChars) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  switch (parsed.type) {
    case "clip:start":
    case "clip:update": {
      const envelope = parseEnvelope(parsed.envelope);
      return envelope ? { type: parsed.type, envelope } : null;
    }
    case "clip:end": {
      const transferId = parseId(parsed.transferId);
      const totalChunks = parsePositiveInt(parsed.totalChunks);
      return transferId && totalChunks !== null ? { type: "clip:end", transferId, totalChunks } : null;
    }
    case "clip:delete": {
      const transferId = parseId(parsed.transferId);
      return transferId ? { type: "clip:delete", transferId } : null;
    }
    case "clips:clear": {
      const transferIds = parseIdArray(parsed.transferIds);
      if (!transferIds) return null;
      if (parsed.zone === undefined) return { type: "clips:clear", transferIds };
      const zone = parseId(parsed.zone);
      return zone ? { type: "clips:clear", transferIds, zone: zone as ClipZone } : null;
    }
    case "catalog:offer": {
      if (!Array.isArray(parsed.clips) || parsed.clips.length > PEER_MESSAGE_LIMITS.arrayItems) return null;
      const clips: CatalogEntry[] = [];
      for (const item of parsed.clips) {
        const entry = parseCatalogEntry(item);
        if (!entry) return null;
        clips.push(entry);
      }
      return { type: "catalog:offer", clips: clips as unknown as BinaryClipCatalogEntry[] };
    }
    case "catalog:request":
    case "catalog:unavailable": {
      const transferIds = parseIdArray(parsed.transferIds);
      return transferIds ? { type: parsed.type, transferIds } : null;
    }
    case "peer:name": {
      const peerId = parseId(parsed.peerId);
      const name = parseBoundedString(parsed.name, PEER_MESSAGE_LIMITS.nameChars);
      return peerId && name !== null ? { type: "peer:name", peerId, name } : null;
    }
    case "peer:names-sync": {
      const names = parseNamesRecord(parsed.names);
      return names ? { type: "peer:names-sync", names } : null;
    }
    case "peer:identify": {
      const fromPeerId = parseId(parsed.fromPeerId);
      return fromPeerId ? { type: "peer:identify", fromPeerId } : null;
    }
    case "threads:sync": {
      if (!Array.isArray(parsed.threads) || parsed.threads.length > PEER_MESSAGE_LIMITS.threads) return null;
      const threads: ThreadRecord[] = [];
      for (const item of parsed.threads) {
        const thread = parseThread(item);
        if (!thread) return null;
        threads.push(thread);
      }
      return { type: "threads:sync", threads };
    }
    case "thread:created": {
      const thread = parseThread(parsed.thread);
      return thread ? { type: "thread:created", thread } : null;
    }
    case "thread:renamed": {
      const id = parseId(parsed.id);
      const name = parseBoundedString(parsed.name, PEER_MESSAGE_LIMITS.nameChars);
      const updatedAt = parseTimestamp(parsed.updatedAt);
      return id && name !== null && updatedAt !== null
        ? { type: "thread:renamed", id, name, updatedAt }
        : null;
    }
    case "thread:reordered": {
      const positions = parsePositions(parsed.positions);
      return positions ? { type: "thread:reordered", positions } : null;
    }
    case "thread:deleted": {
      const id = parseId(parsed.id);
      const deletedAt = parseTimestamp(parsed.deletedAt);
      return id && deletedAt !== null ? { type: "thread:deleted", id, deletedAt } : null;
    }
    default:
      return null;
  }
}
