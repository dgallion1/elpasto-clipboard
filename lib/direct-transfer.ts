"use client";

import type { Clip, ClipKind, ClipZone } from "@/lib/clips";
import { sortClipsNewestFirst } from "@/lib/clips";
import type { ClipEncryptionMeta } from "@/lib/clip-encryption";
import type { BinaryClipCatalogEntry, StoredBinaryClip } from "@/lib/clip-store";
import { addTombstone, deleteStoredBinaryClip, putStoredBinaryClip } from "@/lib/clip-store";
import { logRestoreDebug } from "@/lib/restore-debug";

const CHUNK_HEADER_KIND = "clip:chunk";
const HEADER_LENGTH_BYTES = 4;

export const DIRECT_TRANSFER_CHUNK_SIZE = 16 * 1024;
export const DIRECT_TRANSFER_TIMEOUT_MS = 20_000;

export interface DirectClipEnvelope {
  transferId: string;
  zone: ClipZone;
  kind: ClipKind;
  mimeType: string;
  originalName: string;
  encrypted: boolean;
  encryptionVersion: number | null;
  encryptionMeta: ClipEncryptionMeta | null;
  sizeBytes: number;
  createdAt: string;
  note?: string | null;
}

interface DirectTransferCacheEntry {
  clipId?: number;
  envelope: DirectClipEnvelope;
  ciphertext: Uint8Array;
}

export interface TransferStats {
  progress: number;
  bytesReceived: number;
  totalBytes: number;
  speedBps: number;
}

interface PendingTransfer {
  envelope: DirectClipEnvelope;
  chunks: Map<number, Uint8Array>;
  timeoutId: ReturnType<typeof setTimeout>;
  startedAt: number;
  lastChunkAt: number;
  bytesReceived: number;
}

interface LocalTransferClipEntry {
  transferId: string;
  clip: Clip;
}

// Security (H3): a peer streams chunks into memory; cap the accumulated bytes
// per transfer so a malicious or buggy peer cannot exhaust the tab's memory.
// 2 GiB matches the decoder's declared-size cap, plus slack for encryption
// overhead and chunk framing.
export const MAX_DIRECT_TRANSFER_BYTES = 2_147_483_648 + 16 * 1024 * 1024;

interface DirectTransferStoreOptions {
  sessionToken?: string;
  ownerTabId?: string;
  timeoutMs?: number;
  maxTransferBytes?: number;
}

interface StartTransferOptions {
  replaceExisting?: boolean;
}

export function createChunkFrame(
  transferId: string,
  index: number,
  payload: Uint8Array
): ArrayBuffer {
  const headerBytes = textEncoder.encode(
    JSON.stringify({
      type: CHUNK_HEADER_KIND,
      transferId,
      index,
    } satisfies DirectTransferChunkHeader)
  );
  const framed = new Uint8Array(HEADER_LENGTH_BYTES + headerBytes.length + payload.byteLength);
  const view = new DataView(framed.buffer);
  view.setUint32(0, headerBytes.length);
  framed.set(headerBytes, HEADER_LENGTH_BYTES);
  framed.set(payload, HEADER_LENGTH_BYTES + headerBytes.length);
  return framed.buffer;
}

export function parseChunkFrame(data: ArrayBuffer | Uint8Array): {
  transferId: string;
  index: number;
  payload: Uint8Array;
} {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < HEADER_LENGTH_BYTES) {
    throw new Error("Chunk frame is too small");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0);
  if (headerLength <= 0 || bytes.byteLength < HEADER_LENGTH_BYTES + headerLength) {
    throw new Error("Chunk frame header is invalid");
  }

  const headerBytes = bytes.subarray(HEADER_LENGTH_BYTES, HEADER_LENGTH_BYTES + headerLength);
  const header = JSON.parse(textDecoder.decode(headerBytes)) as DirectTransferChunkHeader;
  if (
    header.type !== CHUNK_HEADER_KIND ||
    typeof header.transferId !== "string" ||
    !header.transferId ||
    !Number.isInteger(header.index) ||
    header.index < 0
  ) {
    throw new Error("Chunk frame header is invalid");
  }

  return {
    transferId: header.transferId,
    index: header.index,
    payload: bytes.slice(HEADER_LENGTH_BYTES + headerLength),
  };
}

export class DirectTransferStore {
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, PendingTransfer>();
  private readonly completed = new Map<string, DirectTransferCacheEntry>();
  private readonly localClips = new Map<string, LocalTransferClipEntry>();
  private readonly clipToTransferId = new Map<number, string>();
  private readonly transferToClipId = new Map<string, number>();
  private nextLocalClipId = -1_000_000;
  private localClipSnapshot: Record<string, Clip[]> = {};
  private readonly emptyLocalClips: Clip[] = [];
  private readonly cachedStats = new Map<string, TransferStats>();
  private readonly timeoutMs: number;
  private readonly maxTransferBytes: number;
  private readonly sessionToken?: string;
  private readonly ownerTabId?: string;

  constructor(options: number | DirectTransferStoreOptions = {}) {
    const normalized = typeof options === "number"
      ? { timeoutMs: options }
      : options;
    this.timeoutMs = normalized.timeoutMs ?? DIRECT_TRANSFER_TIMEOUT_MS;
    this.maxTransferBytes = normalized.maxTransferBytes ?? MAX_DIRECT_TRANSFER_BYTES;
    this.sessionToken = normalized.sessionToken;
    this.ownerTabId = normalized.ownerTabId;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pending.clear();
    this.completed.clear();
    this.localClips.clear();
    this.clipToTransferId.clear();
    this.transferToClipId.clear();
    this.emit();
  }

  hydrateStoredReceiverClips(records: StoredBinaryClip[]) {
    let changed = false;
    const receiverRecords = records.filter((record) => record.origin === "receiver");
    logRestoreDebug("direct-transfer", "hydrating stored receiver clips", {
      sessionToken: this.sessionToken ?? null,
      ownerTabId: this.ownerTabId ?? null,
      recordCount: receiverRecords.length,
      transferIds: receiverRecords.map((record) => record.transferId),
    });
    for (const record of records) {
      if (record.origin !== "receiver") {
        continue;
      }
      this.hydrateStoredReceiverClip(record);
      changed = true;
    }
    if (changed) {
      this.emit();
    }
  }

  upsertRemoteMetadata(metadata: BinaryClipCatalogEntry, localPayloadAvailable = false) {
    const existingComplete = this.completed.has(metadata.transferId) || localPayloadAvailable;
    const isEncrypted = metadata.encryptionVersion != null && metadata.encryptionMeta != null;
    const clip = this.upsertLocalClip(metadata.transferId, {
      zone: metadata.zone,
      kind: metadata.kind,
      client_transfer_id: metadata.transferId,
      mime_type: metadata.mimeType,
      original_name: metadata.originalName,
      size_bytes: metadata.sizeBytes,
      encrypted: isEncrypted,
      encryption_version: metadata.encryptionVersion,
      encryption_meta: metadata.encryptionMeta,
      created_at: metadata.createdAt,
      note: metadata.note,
      local_transfer_state: existingComplete ? "complete" : "pending",
    });
    this.clipToTransferId.set(clip.id, metadata.transferId);
    this.transferToClipId.set(metadata.transferId, clip.id);
    logRestoreDebug("direct-transfer", "upserted remote metadata", {
      transferId: metadata.transferId,
      localPayloadAvailable,
      existingComplete,
      localState: clip.local_transfer_state,
    });
    this.emit();
  }

  startTransfer(envelope: DirectClipEnvelope, options: StartTransferOptions = {}): boolean {
    const replaceExisting = options.replaceExisting === true;
    if (!replaceExisting && (this.completed.has(envelope.transferId) || this.pending.has(envelope.transferId))) {
      return false;
    }
    if (replaceExisting) {
      this.resetTransferForReplacement(envelope.transferId);
    }
    const startedAt = Date.now();

    const clip = this.upsertLocalClip(envelope.transferId, {
      zone: envelope.zone,
      kind: envelope.kind,
      client_transfer_id: envelope.transferId,
      mime_type: envelope.mimeType,
      original_name: envelope.originalName,
      size_bytes: envelope.sizeBytes,
      encrypted: envelope.encrypted,
      encryption_version: envelope.encryptionVersion,
      encryption_meta: envelope.encryptionMeta,
      created_at: envelope.createdAt,
      note: envelope.note || null,
      local_transfer_state: "pending",
    }, { preserveCompletedState: !replaceExisting });

    this.pending.set(envelope.transferId, {
      envelope,
      chunks: new Map(),
      timeoutId: this.scheduleExpiry(envelope.transferId),
      startedAt,
      lastChunkAt: startedAt,
      bytesReceived: 0,
    });

    this.transferToClipId.set(envelope.transferId, clip.id);
    this.clipToTransferId.set(clip.id, envelope.transferId);
    this.emit();
    return true;
  }

  appendChunk(transferId: string, index: number, payload: Uint8Array) {
    const pending = this.pending.get(transferId);
    if (!pending) {
      return;
    }

    const existing = pending.chunks.get(index);
    pending.chunks.set(index, payload.slice());
    pending.bytesReceived = Math.max(
      pending.bytesReceived + payload.byteLength - (existing?.byteLength ?? 0),
      0
    );

    // Security (H3): bound accumulated bytes so a peer cannot exhaust memory by
    // streaming chunks beyond the declared/permitted size.
    if (pending.bytesReceived > this.maxTransferBytes) {
      this.clearPending(transferId);
      this.markLocalTransferFailed(transferId);
      this.emit();
      return;
    }

    pending.lastChunkAt = Date.now();
    this.refreshPending(transferId, pending);
    this.emit();
  }

  async finishTransfer(transferId: string, totalChunks: number): Promise<boolean> {
    const pending = this.pending.get(transferId);
    if (!pending) {
      return false;
    }
    if (!Number.isInteger(totalChunks) || totalChunks <= 0) {
      this.clearPending(transferId);
      this.markLocalTransferFailed(transferId);
      this.emit();
      return false;
    }

    const ciphertext = assembleChunks(pending.chunks, totalChunks);
    if (!ciphertext) {
      this.clearPending(transferId);
      this.markLocalTransferFailed(transferId);
      this.emit();
      return false;
    }

    clearTimeout(pending.timeoutId);
    this.pending.delete(transferId);
    this.cachedStats.delete(transferId);

    const localEntry = this.localClips.get(transferId);
    const localClip = localEntry?.clip;
    const clipId = this.transferToClipId.get(transferId) ?? localClip?.id;
    const entry: DirectTransferCacheEntry = {
      clipId,
      envelope: pending.envelope,
      ciphertext,
    };
    this.completed.set(transferId, entry);

    if (clipId != null) {
      this.clipToTransferId.set(clipId, transferId);
    }

    try {
      if (this.sessionToken && this.ownerTabId) {
        await putStoredBinaryClip({
          transferId,
          sessionToken: this.sessionToken,
          ownerTabId: this.ownerTabId,
          zone: pending.envelope.zone,
          kind: pending.envelope.kind,
          mimeType: pending.envelope.mimeType,
          originalName: pending.envelope.originalName,
          sizeBytes: pending.envelope.sizeBytes,
          encryptionVersion: pending.envelope.encryptionVersion,
          encryptionMeta: pending.envelope.encryptionMeta,
          createdAt: pending.envelope.createdAt,
          origin: "receiver",
          note: pending.envelope.note ?? null,
          ciphertext,
        });
        logRestoreDebug("direct-transfer", "persisted completed receiver transfer", {
          transferId,
          sessionToken: this.sessionToken,
          ownerTabId: this.ownerTabId,
          totalChunks,
          sizeBytes: ciphertext.byteLength,
        });
      }
    } catch {
      logRestoreDebug("direct-transfer", "failed to persist completed receiver transfer", {
        transferId,
        sessionToken: this.sessionToken ?? null,
        ownerTabId: this.ownerTabId ?? null,
      });
      this.markLocalTransferFailed(transferId);
      this.emit();
      return false;
    }

    if (localClip && localEntry) {
      localEntry.clip = {
        ...localClip,
        local_transfer_state: "complete",
        encrypted: pending.envelope.encrypted,
        encryption_version: pending.envelope.encryptionVersion,
        encryption_meta: pending.envelope.encryptionMeta,
      };
    }

    this.emit();
    return true;
  }

  attachClip(clip: Pick<Clip, "id" | "client_transfer_id">) {
    if (!clip.client_transfer_id) {
      return;
    }

    this.transferToClipId.set(clip.client_transfer_id, clip.id);
    this.clipToTransferId.set(clip.id, clip.client_transfer_id);
    const hadLocalClip = this.localClips.has(clip.client_transfer_id);
    this.removeLocalTransfer(clip.client_transfer_id, false, false, false);

    const cached = this.completed.get(clip.client_transfer_id);
    if (cached && cached.clipId !== clip.id) {
      cached.clipId = clip.id;
      this.emit();
      return;
    }

    if (hadLocalClip) {
      this.emit();
    }
  }

  getLocalClips(zone: ClipZone): Clip[] {
    return this.localClipSnapshot[zone] ?? this.emptyLocalClips;
  }

  getLocalClipGroups(): Record<string, Clip[]> {
    return this.localClipSnapshot;
  }

  removeLocalClip(clipIdOrTransferId: number | string) {
    const transferId = typeof clipIdOrTransferId === "string"
      ? clipIdOrTransferId
      : this.clipToTransferId.get(clipIdOrTransferId);
    if (!transferId) {
      return;
    }

    this.removeLocalTransfer(transferId, true, true, true);
  }

  clearLocalClips(zone?: ClipZone) {
    const transferIds = Array.from(this.localClips.values())
      .filter((entry) => !zone || entry.clip.zone === zone)
      .map((entry) => entry.transferId);

    if (transferIds.length === 0) {
      return;
    }

    for (const transferId of transferIds) {
      this.removeLocalTransfer(transferId, false, true, true);
    }

    this.emit();
  }

  getTransferStats(transferId: string): TransferStats | null {
    const pending = this.pending.get(transferId);
    if (!pending) {
      this.cachedStats.delete(transferId);
      return null;
    }

    const totalBytes = pending.envelope.sizeBytes;
    const progress = totalBytes > 0
      ? Math.min(pending.bytesReceived / totalBytes, 1)
      : 0;
    const durationSeconds = (pending.lastChunkAt - pending.startedAt) / 1000;
    const speedBps = durationSeconds > 0 ? pending.bytesReceived / durationSeconds : 0;

    const cached = this.cachedStats.get(transferId);
    if (
      cached &&
      cached.progress === progress &&
      cached.bytesReceived === pending.bytesReceived &&
      cached.totalBytes === totalBytes &&
      cached.speedBps === speedBps
    ) {
      return cached;
    }

    const stats: TransferStats = { progress, bytesReceived: pending.bytesReceived, totalBytes, speedBps };
    this.cachedStats.set(transferId, stats);
    return stats;
  }

  getClipCiphertext(clipId: number): Uint8Array | null {
    const transferId = this.clipToTransferId.get(clipId);
    if (!transferId) {
      return null;
    }
    return this.completed.get(transferId)?.ciphertext ?? null;
  }

  getLocalTransferState(transferId: string): "pending" | "complete" | "failed" | null {
    return this.localClips.get(transferId)?.clip.local_transfer_state ?? null;
  }

  private scheduleExpiry(transferId: string) {
    return setTimeout(() => {
      const pending = this.pending.get(transferId);
      if (pending) {
        this.markLocalTransferFailed(transferId);
      }
      this.pending.delete(transferId);
      this.cachedStats.delete(transferId);
      this.emit();
    }, this.timeoutMs);
  }

  private refreshPending(transferId: string, pending: PendingTransfer) {
    clearTimeout(pending.timeoutId);
    pending.timeoutId = this.scheduleExpiry(transferId);
  }

  private clearPending(transferId: string) {
    const pending = this.pending.get(transferId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(transferId);
  }

  private hydrateStoredReceiverClip(record: StoredBinaryClip) {
    const isEncrypted = record.encryptionVersion != null && record.encryptionMeta != null;
    const clip = this.upsertLocalClip(record.transferId, {
      zone: record.zone,
      kind: record.kind,
      client_transfer_id: record.transferId,
      mime_type: record.mimeType,
      original_name: record.originalName,
      size_bytes: record.sizeBytes,
      encrypted: isEncrypted,
      encryption_version: record.encryptionVersion,
      encryption_meta: record.encryptionMeta,
      created_at: record.createdAt,
      note: record.note,
      local_transfer_state: record.ciphertext ? "complete" : "pending",
    });

    this.transferToClipId.set(record.transferId, clip.id);
    this.clipToTransferId.set(clip.id, record.transferId);
    logRestoreDebug("direct-transfer", "hydrating stored receiver clip", {
      transferId: record.transferId,
      sessionToken: this.sessionToken ?? null,
      ownerTabId: this.ownerTabId ?? null,
      hasCiphertext: Boolean(record.ciphertext?.byteLength),
      clipId: clip.id,
      localState: clip.local_transfer_state,
    });

    if (record.ciphertext) {
      // Skip if already hydrated — replacing the ciphertext with a new .slice()
      // would create a different Uint8Array reference, causing useSyncExternalStore
      // to see a change and triggering the clip card effect to clear the preview blob.
      if (this.completed.has(record.transferId)) {
        logRestoreDebug("direct-transfer", "skipped duplicate completed hydration", {
          transferId: record.transferId,
          clipId: clip.id,
        });
        return;
      }
      this.completed.set(record.transferId, {
        clipId: clip.id,
        envelope: {
          transferId: record.transferId,
          zone: record.zone,
      kind: record.kind,
          mimeType: record.mimeType,
          originalName: record.originalName,
          encrypted: isEncrypted,
          encryptionVersion: record.encryptionVersion,
          encryptionMeta: record.encryptionMeta,
          sizeBytes: record.ciphertext.byteLength,
          createdAt: record.createdAt,
        },
        ciphertext: record.ciphertext.slice(),
      });
      logRestoreDebug("direct-transfer", "hydrated completed receiver ciphertext", {
        transferId: record.transferId,
        clipId: clip.id,
        sizeBytes: record.ciphertext.byteLength,
      });
      return;
    }

    this.completed.delete(record.transferId);
    logRestoreDebug("direct-transfer", "left receiver clip pending without ciphertext", {
      transferId: record.transferId,
      clipId: clip.id,
    });
  }

  private upsertLocalClip(
    transferId: string,
    fields: {
      zone: ClipZone;
      kind: ClipKind;
      client_transfer_id: string;
      mime_type: string;
      original_name: string;
      size_bytes: number;
      encrypted: boolean;
      encryption_version: number | null;
      encryption_meta: ClipEncryptionMeta | null;
      created_at: string;
      note?: string | null;
      local_transfer_state: "pending" | "complete" | "failed";
    },
    options: {
      preserveCompletedState?: boolean;
    } = {}
  ): Clip {
    const existing = this.localClips.get(transferId);
    if (existing) {
      const preserveState = (options.preserveCompletedState ?? true)
        && existing.clip.local_transfer_state === "complete"
        && fields.local_transfer_state !== "complete";
      Object.assign(existing.clip, fields);
      if (preserveState) {
        existing.clip.local_transfer_state = "complete";
      }
      return existing.clip;
    }

    const clipId = this.nextLocalClipId;
    this.nextLocalClipId -= 1;

    const clip: Clip = {
      id: clipId,
      session_id: 0,
      zone: fields.zone,
      kind: fields.kind,
      client_transfer_id: fields.client_transfer_id,
      mime_type: fields.mime_type,
      text_content: null,
      html_content: null,
      storage_key: null,
      original_name: fields.original_name,
      size_bytes: fields.size_bytes,
      encrypted: fields.encrypted,
      encryption_version: fields.encryption_version,
      encryption_meta: fields.encryption_meta,
      created_at: fields.created_at,
      note: fields.note || null,
      local_only: true,
      local_origin: "receiver",
      local_transfer_state: fields.local_transfer_state,
      local_file: null,
    };

    this.localClips.set(transferId, { transferId, clip });
    this.transferToClipId.set(transferId, clipId);
    this.clipToTransferId.set(clipId, transferId);
    return clip;
  }

  private resetTransferForReplacement(transferId: string) {
    this.clearPending(transferId);
    this.cachedStats.delete(transferId);
    this.completed.delete(transferId);

    const localEntry = this.localClips.get(transferId);
    if (localEntry) {
      localEntry.clip = {
        ...localEntry.clip,
        local_transfer_state: "pending",
      };
    }
  }

  private removeLocalTransfer(
    transferId: string,
    shouldEmit: boolean,
    clearCompleted: boolean,
    removePersisted: boolean
  ) {
    this.clearPending(transferId);
    this.cachedStats.delete(transferId);
    if (clearCompleted) {
      this.completed.delete(transferId);
    }

    const localClip = this.localClips.get(transferId)?.clip;
    if (localClip) {
      this.clipToTransferId.delete(localClip.id);
    }

    this.localClips.delete(transferId);

    const mappedClipId = this.transferToClipId.get(transferId);
    if (mappedClipId != null && mappedClipId < 0) {
      this.transferToClipId.delete(transferId);
    }

    if (removePersisted && this.sessionToken && this.ownerTabId) {
      void deleteStoredBinaryClip(transferId, this.ownerTabId);
    }
    if (removePersisted && this.sessionToken) {
      void addTombstone(transferId, this.sessionToken);
    }

    if (shouldEmit) {
      this.emit();
    }
  }

  private rebuildLocalClipSnapshot() {
    const all = Array.from(this.localClips.values()).map((e) => e.clip);
    const next: Record<string, Clip[]> = {};
    for (const clip of all) {
      (next[clip.zone] ??= []).push(clip);
    }
    for (const zone of Object.keys(next)) {
      next[zone].sort(sortClipsNewestFirst);
    }
    this.localClipSnapshot = next;
  }

  markLocalTransferFailed(transferId: string) {
    const localEntry = this.localClips.get(transferId);
    if (!localEntry || localEntry.clip.local_transfer_state === "complete") {
      return;
    }

    localEntry.clip = {
      ...localEntry.clip,
      local_transfer_state: "failed",
    };
    this.emit();
  }

  private emit() {
    this.rebuildLocalClipSnapshot();
    for (const listener of this.listeners) {
      listener();
    }
  }
}

interface DirectTransferChunkHeader {
  type: typeof CHUNK_HEADER_KIND;
  transferId: string;
  index: number;
}

function assembleChunks(
  chunks: Map<number, Uint8Array>,
  totalChunks: number
): Uint8Array | null {
  let totalBytes = 0;
  const ordered: Uint8Array[] = [];

  for (let index = 0; index < totalChunks; index += 1) {
    const chunk = chunks.get(index);
    if (!chunk) {
      return null;
    }
    ordered.push(chunk);
    totalBytes += chunk.byteLength;
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of ordered) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
