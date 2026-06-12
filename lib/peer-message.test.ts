import { describe, test, expect } from "vitest";
import { parseControlMessage } from "@/lib/peer-message";
import type { DirectClipEnvelope } from "@/lib/direct-transfer";
import type { ThreadRecord } from "@/lib/threads";

// ── builders ────────────────────────────────────────────────────────────────

function validEnvelope(overrides: Partial<DirectClipEnvelope> = {}): DirectClipEnvelope {
  return {
    transferId: "t-1",
    zone: "A",
    kind: "file",
    mimeType: "application/octet-stream",
    originalName: "doc.bin",
    encrypted: true,
    encryptionVersion: 2,
    encryptionMeta: null,
    sizeBytes: 1024,
    createdAt: "2026-06-12T00:00:00.000Z",
    note: null,
    ...overrides,
  };
}

function validThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return { id: "A", name: "Thread", position: 0, updatedAt: 1, ...overrides };
}

const enc = (msg: unknown) => JSON.stringify(msg);

// ── happy path: every variant round-trips ────────────────────────────────────

describe("parseControlMessage — valid messages", () => {
  test("clip:start with a valid envelope", () => {
    const env = validEnvelope();
    expect(parseControlMessage(enc({ type: "clip:start", envelope: env }))).toEqual({
      type: "clip:start",
      envelope: env,
    });
  });

  test("clip:update with a valid envelope", () => {
    const env = validEnvelope({ note: "hello" });
    expect(parseControlMessage(enc({ type: "clip:update", envelope: env }))).toEqual({
      type: "clip:update",
      envelope: env,
    });
  });

  test("clip:end", () => {
    expect(parseControlMessage(enc({ type: "clip:end", transferId: "t-1", totalChunks: 3 }))).toEqual({
      type: "clip:end",
      transferId: "t-1",
      totalChunks: 3,
    });
  });

  test("clip:delete", () => {
    expect(parseControlMessage(enc({ type: "clip:delete", transferId: "t-1" }))).toEqual({
      type: "clip:delete",
      transferId: "t-1",
    });
  });

  test("clips:clear with and without zone", () => {
    expect(parseControlMessage(enc({ type: "clips:clear", transferIds: ["a", "b"] }))).toEqual({
      type: "clips:clear",
      transferIds: ["a", "b"],
    });
    expect(parseControlMessage(enc({ type: "clips:clear", transferIds: ["a"], zone: "A" }))).toEqual({
      type: "clips:clear",
      transferIds: ["a"],
      zone: "A",
    });
  });

  test("catalog:offer", () => {
    const entry = {
      transferId: "t-1",
      zone: "A",
      kind: "image",
      mimeType: "image/png",
      originalName: "p.png",
      sizeBytes: 10,
      encryptionVersion: 2,
      encryptionMeta: null,
      createdAt: "2026-06-12T00:00:00.000Z",
      note: null,
    };
    expect(parseControlMessage(enc({ type: "catalog:offer", clips: [entry] }))).toEqual({
      type: "catalog:offer",
      clips: [entry],
    });
  });

  test("catalog:request / catalog:unavailable", () => {
    expect(parseControlMessage(enc({ type: "catalog:request", transferIds: ["a"] }))).toEqual({
      type: "catalog:request",
      transferIds: ["a"],
    });
    expect(parseControlMessage(enc({ type: "catalog:unavailable", transferIds: ["a"] }))).toEqual({
      type: "catalog:unavailable",
      transferIds: ["a"],
    });
  });

  test("peer:name / peer:identify / peer:names-sync", () => {
    expect(parseControlMessage(enc({ type: "peer:name", peerId: "p1", name: "Alice" }))).toEqual({
      type: "peer:name",
      peerId: "p1",
      name: "Alice",
    });
    expect(parseControlMessage(enc({ type: "peer:identify", fromPeerId: "p1" }))).toEqual({
      type: "peer:identify",
      fromPeerId: "p1",
    });
    expect(parseControlMessage(enc({ type: "peer:names-sync", names: { p1: "Alice", p2: "Bob" } }))).toEqual({
      type: "peer:names-sync",
      names: { p1: "Alice", p2: "Bob" },
    });
  });

  test("thread variants", () => {
    const thread = validThread();
    expect(parseControlMessage(enc({ type: "threads:sync", threads: [thread] }))).toEqual({
      type: "threads:sync",
      threads: [thread],
    });
    expect(parseControlMessage(enc({ type: "thread:created", thread }))).toEqual({
      type: "thread:created",
      thread,
    });
    expect(parseControlMessage(enc({ type: "thread:renamed", id: "A", name: "X", updatedAt: 5 }))).toEqual({
      type: "thread:renamed",
      id: "A",
      name: "X",
      updatedAt: 5,
    });
    expect(
      parseControlMessage(enc({ type: "thread:reordered", positions: [{ id: "A", position: 1, updatedAt: 5 }] }))
    ).toEqual({ type: "thread:reordered", positions: [{ id: "A", position: 1, updatedAt: 5 }] });
    expect(parseControlMessage(enc({ type: "thread:deleted", id: "A", deletedAt: 5 }))).toEqual({
      type: "thread:deleted",
      id: "A",
      deletedAt: 5,
    });
  });

  test("empty string name is allowed (clearing a name)", () => {
    expect(parseControlMessage(enc({ type: "peer:name", peerId: "p1", name: "" }))).toEqual({
      type: "peer:name",
      peerId: "p1",
      name: "",
    });
  });
});

// ── malformed input is rejected ──────────────────────────────────────────────

describe("parseControlMessage — malformed input rejected", () => {
  test("non-JSON returns null", () => {
    expect(parseControlMessage("not json")).toBeNull();
    expect(parseControlMessage("")).toBeNull();
    expect(parseControlMessage("[1,2,3]")).toBeNull();
    expect(parseControlMessage("42")).toBeNull();
    expect(parseControlMessage("null")).toBeNull();
  });

  test("unknown message type returns null", () => {
    expect(parseControlMessage(enc({ type: "evil:exec" }))).toBeNull();
    expect(parseControlMessage(enc({ type: 123 }))).toBeNull();
    expect(parseControlMessage(enc({}))).toBeNull();
  });

  test("missing or wrong-typed required fields return null", () => {
    expect(parseControlMessage(enc({ type: "clip:delete" }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clip:delete", transferId: 5 }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clip:delete", transferId: "" }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clip:end", transferId: "t", totalChunks: "3" }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clip:end", transferId: "t", totalChunks: -1 }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clip:end", transferId: "t", totalChunks: 1.5 }))).toBeNull();
    expect(parseControlMessage(enc({ type: "peer:name", peerId: "p", name: 5 }))).toBeNull();
    expect(parseControlMessage(enc({ type: "thread:deleted", id: "A", deletedAt: "soon" }))).toBeNull();
  });

  test("clip:start with invalid envelope returns null", () => {
    expect(parseControlMessage(enc({ type: "clip:start" }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clip:start", envelope: null }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clip:start", envelope: validEnvelope({ kind: "exe" as never }) }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clip:start", envelope: validEnvelope({ transferId: "" }) }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clip:start", envelope: validEnvelope({ sizeBytes: -1 }) }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clip:start", envelope: validEnvelope({ sizeBytes: Number.NaN }) }))).toBeNull();
  });

  test("invalid thread records are rejected", () => {
    expect(parseControlMessage(enc({ type: "thread:created", thread: { id: "", name: "x", position: 0, updatedAt: 1 } }))).toBeNull();
    expect(parseControlMessage(enc({ type: "thread:created", thread: { id: "A", name: 5, position: 0, updatedAt: 1 } }))).toBeNull();
    expect(parseControlMessage(enc({ type: "threads:sync", threads: [validThread(), { id: "B", name: "x", position: "nope", updatedAt: 1 }] }))).toBeNull();
  });
});

// ── bounds: oversized payloads rejected (H3 — memory exhaustion) ──────────────

describe("parseControlMessage — bounds enforced", () => {
  test("raw message over the size cap is rejected without parsing", () => {
    const huge = "x".repeat(1_000_001);
    expect(parseControlMessage(enc({ type: "peer:name", peerId: "p", name: huge }))).toBeNull();
  });

  test("over-long string fields are rejected", () => {
    expect(parseControlMessage(enc({ type: "peer:name", peerId: "p", name: "n".repeat(257) }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clip:delete", transferId: "t".repeat(257) }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clip:start", envelope: validEnvelope({ note: "z".repeat(100_001) }) }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clip:start", envelope: validEnvelope({ originalName: "f".repeat(1025) }) }))).toBeNull();
  });

  test("over-large arrays are rejected", () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
    expect(parseControlMessage(enc({ type: "catalog:request", transferIds: ids }))).toBeNull();
    expect(parseControlMessage(enc({ type: "clips:clear", transferIds: ids }))).toBeNull();
    const clips = Array.from({ length: 1001 }, () => ({
      transferId: "t", zone: "A", kind: "file", mimeType: "x", originalName: "n",
      sizeBytes: 1, encryptionVersion: null, encryptionMeta: null, createdAt: "t", note: null,
    }));
    expect(parseControlMessage(enc({ type: "catalog:offer", clips }))).toBeNull();
  });

  test("names-sync with too many entries is rejected", () => {
    const names: Record<string, string> = {};
    for (let i = 0; i < 501; i++) names[`p${i}`] = "n";
    expect(parseControlMessage(enc({ type: "peer:names-sync", names }))).toBeNull();
  });
});

// ── prototype pollution (L1) ─────────────────────────────────────────────────

describe("parseControlMessage — prototype pollution guarded", () => {
  test("names-sync with __proto__/constructor keys does not pollute and is dropped", () => {
    const polluted = '{"type":"peer:names-sync","names":{"__proto__":"x","constructor":"y","ok":"z"}}';
    const result = parseControlMessage(polluted);
    // The dangerous keys must not survive; a clean entry may remain.
    if (result && result.type === "peer:names-sync") {
      expect(Object.keys(result.names)).not.toContain("__proto__");
      expect(Object.keys(result.names)).not.toContain("constructor");
      expect(Object.keys(result.names)).not.toContain("prototype");
    }
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
