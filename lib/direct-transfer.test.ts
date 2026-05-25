import { beforeEach, describe, expect, test, vi } from "vitest";
import type { StoredBinaryClip } from "./clip-store";
import {
  DirectTransferStore,
  createChunkFrame,
  parseChunkFrame,
  type DirectClipEnvelope,
} from "./direct-transfer";

const {
  addTombstoneMock,
  deleteStoredBinaryClipMock,
  putStoredBinaryClipMock,
} = vi.hoisted(() => ({
  addTombstoneMock: vi.fn(),
  deleteStoredBinaryClipMock: vi.fn(),
  putStoredBinaryClipMock: vi.fn(),
}));

vi.mock("./clip-store", () => ({
  addTombstone: addTombstoneMock,
  deleteStoredBinaryClip: deleteStoredBinaryClipMock,
  putStoredBinaryClip: putStoredBinaryClipMock,
}));

const envelope: DirectClipEnvelope = {
  transferId: "transfer-1",
  zone: "A",
  kind: "file",
  mimeType: "application/pdf",
  originalName: "notes.pdf",
  encrypted: true,
  encryptionVersion: 1,
  encryptionMeta: {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iterations: 210000,
    salt: "salt",
    iv: "iv",
    payload: "binary",
  },
  sizeBytes: 6,
  createdAt: "2026-03-10T12:00:00.000Z",
};

function makeStoredReceiverClip(
  overrides: Partial<StoredBinaryClip> = {}
): StoredBinaryClip {
  return {
    transferId: "stored-transfer",
    sessionToken: "session-1",
    ownerTabId: "tab-a",
    zone: "A",
    kind: "file",
    mimeType: "application/pdf",
    originalName: "stored.pdf",
    sizeBytes: 3,
    encryptionVersion: null,
    encryptionMeta: null,
    createdAt: "2026-03-10T12:05:00.000Z",
    origin: "receiver",
    ...overrides,
  };
}

beforeEach(() => {
  addTombstoneMock.mockReset();
  addTombstoneMock.mockResolvedValue(undefined);
  deleteStoredBinaryClipMock.mockReset();
  deleteStoredBinaryClipMock.mockResolvedValue(undefined);
  putStoredBinaryClipMock.mockReset();
  putStoredBinaryClipMock.mockResolvedValue(undefined);
});

describe("direct transfer framing", () => {
  test("round-trips a chunk frame", () => {
    const frame = createChunkFrame("transfer-1", 2, new Uint8Array([1, 2, 3]));
    expect(parseChunkFrame(frame)).toEqual({
      transferId: "transfer-1",
      index: 2,
      payload: new Uint8Array([1, 2, 3]),
    });
  });

  test("rejects malformed chunk frames", () => {
    expect(() => parseChunkFrame(new Uint8Array([1, 2, 3]))).toThrow("Chunk frame is too small");

    const invalidHeaderLength = new Uint8Array(8);
    new DataView(invalidHeaderLength.buffer).setUint32(0, 16);
    expect(() => parseChunkFrame(invalidHeaderLength)).toThrow("Chunk frame header is invalid");

    const wrongTypeHeader = new TextEncoder().encode(
      JSON.stringify({ type: "wrong", transferId: "transfer-1", index: 0 })
    );
    const wrongTypeFrame = new Uint8Array(4 + wrongTypeHeader.length);
    new DataView(wrongTypeFrame.buffer).setUint32(0, wrongTypeHeader.length);
    wrongTypeFrame.set(wrongTypeHeader, 4);
    expect(() => parseChunkFrame(wrongTypeFrame)).toThrow("Chunk frame header is invalid");
  });
});

describe("DirectTransferStore", () => {
  test("reconciles a finished transfer against a later canonical clip", () => {
    const store = new DirectTransferStore(1_000);
    store.startTransfer(envelope);
    store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));
    store.appendChunk("transfer-1", 1, new Uint8Array([4, 5, 6]));
    store.finishTransfer("transfer-1", 2);

    expect(store.getClipCiphertext(55)).toBeNull();

    store.attachClip({ id: 55, client_transfer_id: "transfer-1" } as const);
    expect(store.getClipCiphertext(55)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  test("reconciles when the canonical clip arrives before completion", () => {
    const store = new DirectTransferStore(1_000);
    store.attachClip({ id: 88, client_transfer_id: "transfer-1" } as const);
    store.startTransfer(envelope);
    store.appendChunk("transfer-1", 0, new Uint8Array([7, 8]));
    store.appendChunk("transfer-1", 1, new Uint8Array([9]));
    store.finishTransfer("transfer-1", 2);

    expect(store.getClipCiphertext(88)).toEqual(new Uint8Array([7, 8, 9]));
  });

  test("subscribe notifies listeners and unsubscribe removes them", () => {
    const store = new DirectTransferStore(1_000);
    let callCount = 0;
    const unsub = store.subscribe(() => {
      callCount += 1;
    });

    store.startTransfer(envelope);
    store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));
    store.finishTransfer("transfer-1", 1);

    // Listener should have been called for start, append, and finish
    expect(callCount).toBeGreaterThan(0);

    const countAfterUnsub = callCount;
    unsub();

    // After unsubscribe, new operations should not notify
    store.startTransfer({ ...envelope, transferId: "transfer-2" });
    expect(callCount).toBe(countAfterUnsub);
  });

  test("expires incomplete transfers", async () => {
    const store = new DirectTransferStore(20);
    store.startTransfer(envelope);
    store.appendChunk("transfer-1", 0, new Uint8Array([1]));

    const [startedClip] = store.getLocalClips("A");
    expect(startedClip?.local_transfer_state).toBe("pending");

    await new Promise((resolve) => setTimeout(resolve, 40));

    const [localClip] = store.getLocalClips("A");
    expect(localClip?.local_transfer_state).toBe("failed");
    store.finishTransfer("transfer-1", 1);
    expect(store.getClipCiphertext(startedClip!.id)).toBeNull();
  });

  test("expires transfers that never receive a first chunk", async () => {
    const store = new DirectTransferStore(20);
    store.startTransfer(envelope);

    expect(store.getLocalClips("A")[0]?.local_transfer_state).toBe("pending");

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(store.getLocalClips("A")[0]?.local_transfer_state).toBe("failed");
  });

  test("creates stable local receiver clips before ciphertext completes", () => {
    const store = new DirectTransferStore(1_000);

    store.startTransfer(envelope);

    const [localClip] = store.getLocalClips("A");
    expect(localClip).toBeDefined();
    const localClipId = localClip!.id;
    expect(typeof localClipId).toBe("number");
    expect(localClip!.client_transfer_id).toBe("transfer-1");
    expect(localClip!.local_only).toBe(true);
    expect(localClip!.local_origin).toBe("receiver");
    expect(localClip!.local_transfer_state).toBe("pending");
    expect(store.getClipCiphertext(localClipId)).toBeNull();

    store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));
    store.finishTransfer("transfer-1", 1);

    const [completedClip] = store.getLocalClips("A");
    expect(completedClip.id).toBe(localClipId);
    expect(completedClip.local_transfer_state).toBe("complete");
    expect(store.getClipCiphertext(localClipId)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("removes local receiver clips when cleared", () => {
    const store = new DirectTransferStore(1_000);

    store.startTransfer(envelope);
    expect(store.getLocalClips("A")).toHaveLength(1);

    store.clearLocalClips("A");
    expect(store.getLocalClips("A")).toEqual([]);
  });

  test("reports byte-based stats and ignores duplicate chunk retries", () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_500)
      .mockReturnValueOnce(2_500);

    try {
      const store = new DirectTransferStore(1_000);
      store.startTransfer(envelope);
      store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));

      expect(store.getTransferStats("transfer-1")).toEqual({
        progress: 0.5,
        bytesReceived: 3,
        totalBytes: 6,
        speedBps: 6,
      });

      store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));
      expect(store.getTransferStats("transfer-1")).toEqual({
        progress: 0.5,
        bytesReceived: 3,
        totalBytes: 6,
        speedBps: 2,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("handles invalid completion requests and missing chunks", async () => {
    const store = new DirectTransferStore(1_000);

    store.startTransfer(envelope);
    await expect(store.finishTransfer("transfer-1", 0)).resolves.toBe(false);
    expect(store.getLocalClips("A")[0]?.local_transfer_state).toBe("failed");

    store.startTransfer({ ...envelope, transferId: "transfer-2" });
    store.appendChunk("transfer-2", 0, new Uint8Array([1, 2, 3]));
    await expect(store.finishTransfer("transfer-2", 2)).resolves.toBe(false);
    expect(store.getLocalClips("A").find((clip) => clip.client_transfer_id === "transfer-2")?.local_transfer_state).toBe("failed");
  });

  test("hydrates receiver clips, ignores sender-only records, and exposes cached ciphertext", () => {
    const store = new DirectTransferStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.hydrateStoredReceiverClips([
      makeStoredReceiverClip({ transferId: "sender-record", origin: "sender" }),
    ]);
    expect(notifications).toBe(0);

    store.hydrateStoredReceiverClips([
      makeStoredReceiverClip({
        transferId: "pending-transfer",
        ciphertext: undefined,
      }),
      makeStoredReceiverClip({
        transferId: "complete-transfer",
        zone: "B",
        encryptionVersion: 1,
        encryptionMeta: envelope.encryptionMeta,
        ciphertext: new Uint8Array([9, 8, 7]),
      }),
    ]);

    const [pendingClip] = store.getLocalClips("A");
    const [completeClip] = store.getLocalClips("B");
    expect(pendingClip.local_transfer_state).toBe("pending");
    expect(completeClip.local_transfer_state).toBe("complete");
    expect(store.getClipCiphertext(completeClip.id)).toEqual(new Uint8Array([9, 8, 7]));
    expect(notifications).toBe(1);
  });

  test("reconciles remote metadata and preserves completed local state", async () => {
    const store = new DirectTransferStore();

    store.startTransfer(envelope);
    store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));
    store.appendChunk("transfer-1", 1, new Uint8Array([4, 5, 6]));
    await store.finishTransfer("transfer-1", 2);

    store.upsertRemoteMetadata({
      transferId: "transfer-1",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "renamed.pdf",
      sizeBytes: 6,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
    });

    const [clip] = store.getLocalClips("A");
    expect(clip.original_name).toBe("renamed.pdf");
    expect(clip.local_transfer_state).toBe("complete");
  });

  test("ignores duplicate transfer starts for the same transfer id", () => {
    const store = new DirectTransferStore();

    expect(store.startTransfer(envelope)).toBe(true);
    const localClipId = store.getLocalClips("A")[0]?.id;

    expect(store.startTransfer({ ...envelope, mimeType: "text/plain" })).toBe(false);
    expect(store.getLocalClips("A")[0]?.id).toBe(localClipId);
  });

  test("replacement transfers reuse completed local receiver clips", async () => {
    const store = new DirectTransferStore();

    expect(store.startTransfer(envelope)).toBe(true);
    store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));
    await store.finishTransfer("transfer-1", 1);

    const completedClip = store.getLocalClips("A")[0];
    expect(completedClip.local_transfer_state).toBe("complete");

    expect(store.startTransfer({
      ...envelope,
      mimeType: "text/plain",
      originalName: "updated.txt",
      sizeBytes: 2,
    }, { replaceExisting: true })).toBe(true);

    const replacementClip = store.getLocalClips("A")[0];
    expect(replacementClip.id).toBe(completedClip.id);
    expect(replacementClip.local_transfer_state).toBe("pending");
    expect(replacementClip.mime_type).toBe("text/plain");

    store.appendChunk("transfer-1", 0, new Uint8Array([8, 9]));
    await store.finishTransfer("transfer-1", 1);

    expect(store.getLocalClips("A")[0]?.id).toBe(completedClip.id);
    expect(store.getLocalClips("A")[0]?.local_transfer_state).toBe("complete");
    expect(store.getClipCiphertext(completedClip.id)).toEqual(new Uint8Array([8, 9]));
  });

  test("replacement transfers clear stale pending chunks before accepting new data", () => {
    const store = new DirectTransferStore();

    expect(store.startTransfer(envelope)).toBe(true);
    store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));

    expect(store.startTransfer({ ...envelope, sizeBytes: 2 }, { replaceExisting: true })).toBe(true);
    store.appendChunk("transfer-1", 0, new Uint8Array([7, 8]));

    expect(store.getTransferStats("transfer-1")).toEqual({
      progress: 1,
      bytesReceived: 2,
      totalBytes: 2,
      speedBps: 0,
    });
  });

  test("finishTransfer overwrites the persisted receiver ciphertext for replacement transfers", async () => {
    const store = new DirectTransferStore({ sessionToken: "session-1", ownerTabId: "tab-a" });

    expect(store.startTransfer(envelope)).toBe(true);
    store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));
    await store.finishTransfer("transfer-1", 1);

    putStoredBinaryClipMock.mockClear();

    expect(store.startTransfer({ ...envelope, sizeBytes: 2 }, { replaceExisting: true })).toBe(true);
    store.appendChunk("transfer-1", 0, new Uint8Array([5, 6]));
    await store.finishTransfer("transfer-1", 1);

    expect(putStoredBinaryClipMock).toHaveBeenCalledWith(expect.objectContaining({
      transferId: "transfer-1",
      ownerTabId: "tab-a",
      origin: "receiver",
      ciphertext: new Uint8Array([5, 6]),
    }));
  });

  test("persists completed transfers when session storage is enabled", async () => {
    const store = new DirectTransferStore({
      sessionToken: "session-1",
      ownerTabId: "tab-a",
      timeoutMs: 1_000,
    });
    store.startTransfer(envelope);
    store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));
    store.appendChunk("transfer-1", 1, new Uint8Array([4, 5, 6]));

    await expect(store.finishTransfer("transfer-1", 2)).resolves.toBe(true);
    expect(putStoredBinaryClipMock).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "transfer-1",
        sessionToken: "session-1",
        ownerTabId: "tab-a",
        origin: "receiver",
        ciphertext: new Uint8Array([1, 2, 3, 4, 5, 6]),
      })
    );
  });

  test("marks transfers as failed when persistence fails", async () => {
    putStoredBinaryClipMock.mockRejectedValueOnce(new Error("write failed"));
    const store = new DirectTransferStore({
      sessionToken: "session-1",
      ownerTabId: "tab-a",
      timeoutMs: 1_000,
    });
    store.startTransfer(envelope);
    store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));
    store.appendChunk("transfer-1", 1, new Uint8Array([4, 5, 6]));

    await expect(store.finishTransfer("transfer-1", 2)).resolves.toBe(false);
    expect(store.getLocalClips("A")[0]?.local_transfer_state).toBe("failed");
  });

  test("supports clip attachment edge cases and local removal paths", async () => {
    const store = new DirectTransferStore({
      sessionToken: "session-1",
      ownerTabId: "tab-a",
      timeoutMs: 1_000,
    });

    store.attachClip({ id: 10, client_transfer_id: null });
    expect(store.getClipCiphertext(10)).toBeNull();

    store.startTransfer(envelope);
    store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));
    store.appendChunk("transfer-1", 1, new Uint8Array([4, 5, 6]));
    await store.finishTransfer("transfer-1", 2);

    store.attachClip({ id: 55, client_transfer_id: "transfer-1" });
    expect(store.getClipCiphertext(55)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));

    store.removeLocalClip("missing-transfer");
    store.removeLocalClip(999999);
    store.removeLocalClip("transfer-1");
    expect(deleteStoredBinaryClipMock).toHaveBeenCalledWith("transfer-1", "tab-a");
    expect(store.getClipCiphertext(55)).toBeNull();
  });

  test("clears local clips by zone and disposes remaining state", () => {
    const store = new DirectTransferStore({
      sessionToken: "session-1",
      ownerTabId: "tab-a",
      timeoutMs: 1_000,
    });
    store.startTransfer(envelope);
    store.startTransfer({ ...envelope, transferId: "transfer-2", zone: "B" });

    store.clearLocalClips("A");
    expect(store.getLocalClips("A")).toEqual([]);
    expect(store.getLocalClips("B")).toHaveLength(1);
    expect(deleteStoredBinaryClipMock).toHaveBeenCalledWith("transfer-1", "tab-a");

    store.clearLocalClips("A");
    store.dispose();
    expect(store.getLocalClips("B")).toEqual([]);
  });

  test("returns cached transfer stats and clears them when the transfer disappears", () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);

    try {
      const store = new DirectTransferStore(1_000);
      store.startTransfer({ ...envelope, transferId: "transfer-2", sizeBytes: 0 });

      nowSpy.mockReturnValue(1_000);
      store.appendChunk("transfer-2", 0, new Uint8Array([1, 2, 3]));
      const firstStats = store.getTransferStats("transfer-2");
      const secondStats = store.getTransferStats("transfer-2");
      expect(firstStats).toBe(secondStats);
      expect(firstStats).toEqual({
        progress: 0,
        bytesReceived: 3,
        totalBytes: 0,
        speedBps: 0,
      });

      store.removeLocalClip("transfer-2");
      expect(store.getTransferStats("transfer-2")).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("does not downgrade complete clips to failed after timeout or manual failure marking", async () => {
    const store = new DirectTransferStore(20);
    store.startTransfer(envelope);
    store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));
    store.appendChunk("transfer-1", 1, new Uint8Array([4, 5, 6]));
    await store.finishTransfer("transfer-1", 2);

    store.markLocalTransferFailed("transfer-1");
    expect(store.getLocalClips("A")[0]?.local_transfer_state).toBe("complete");

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getLocalClips("A")[0]?.local_transfer_state).toBe("complete");
  });
});

describe("edge cases", () => {
  test("appendChunk is a no-op for unknown transferId", () => {
    const store = new DirectTransferStore(1_000);
    const listener = vi.fn();
    store.subscribe(listener);

    store.appendChunk("nonexistent", 0, new Uint8Array([1]));
    expect(listener).not.toHaveBeenCalled();
  });

  test("finishTransfer is a no-op for unknown transferId", async () => {
    const store = new DirectTransferStore(1_000);
    await expect(store.finishTransfer("nonexistent", 1)).resolves.toBe(false);
  });

  test("attachClip emits when local clip existed before attach", async () => {
    const store = new DirectTransferStore(1_000);

    // Start a transfer to create a local clip
    store.startTransfer(envelope);
    store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));
    store.appendChunk("transfer-1", 1, new Uint8Array([4, 5, 6]));
    await store.finishTransfer("transfer-1", 2);

    // Now attach a clip that references this completed transfer
    // The local clip already exists, so attachClip should still emit
    let emitCount = 0;
    store.subscribe(() => { emitCount += 1; });

    // Start a new transfer and attach before completion to test the hadLocalClip path
    store.startTransfer({ ...envelope, transferId: "transfer-3" });
    store.attachClip({ id: 77, client_transfer_id: "transfer-3" } as const);
    expect(emitCount).toBeGreaterThan(0);
  });

  test("hydrating same clip twice preserves complete state on second pending hydration", () => {
    const store = new DirectTransferStore();

    // First hydration with ciphertext → complete
    store.hydrateStoredReceiverClips([
      makeStoredReceiverClip({
        transferId: "rehydrate",
        ciphertext: new Uint8Array([1, 2, 3]),
        encryptionVersion: 1,
        encryptionMeta: envelope.encryptionMeta,
      }),
    ]);
    const [clip1] = store.getLocalClips("A");
    expect(clip1.local_transfer_state).toBe("complete");

    // Second hydration without ciphertext → would be "pending" but preserveState guard keeps it "complete"
    store.hydrateStoredReceiverClips([
      makeStoredReceiverClip({
        transferId: "rehydrate",
        ciphertext: undefined,
      }),
    ]);
    const [clip2] = store.getLocalClips("A");
    expect(clip2.local_transfer_state).toBe("complete");
  });

  test("upsertRemoteMetadata preserves complete state when upserting pending fields", async () => {
    const store = new DirectTransferStore(1_000);

    store.startTransfer(envelope);
    store.appendChunk("transfer-1", 0, new Uint8Array([1, 2, 3]));
    store.appendChunk("transfer-1", 1, new Uint8Array([4, 5, 6]));
    await store.finishTransfer("transfer-1", 2);

    // upsertRemoteMetadata triggers upsertLocalClip with the existing transferId,
    // which exercises the preserveState branch (complete → pending would be downgrade)
    store.upsertRemoteMetadata({
      transferId: "transfer-1",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "updated.pdf",
      sizeBytes: 6,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
    });

    const [clip] = store.getLocalClips("A");
    expect(clip.local_transfer_state).toBe("complete");
    expect(clip.original_name).toBe("updated.pdf");
  });
});

describe("tombstone recording", () => {
  test("removeLocalClip records a tombstone when sessionToken is set", () => {
    const store = new DirectTransferStore({ sessionToken: "session-1" });
    store.startTransfer(envelope);
    store.removeLocalClip("transfer-1");

    expect(addTombstoneMock).toHaveBeenCalledWith("transfer-1", "session-1");
  });

  test("removeLocalClip does not record tombstone without sessionToken", () => {
    const store = new DirectTransferStore();
    store.startTransfer(envelope);
    store.removeLocalClip("transfer-1");

    expect(addTombstoneMock).not.toHaveBeenCalled();
  });

  test("clearLocalClips records tombstones for all removed clips", () => {
    const store = new DirectTransferStore({ sessionToken: "session-1" });
    const envelope2 = { ...envelope, transferId: "transfer-2", zone: "B" as const };
    store.startTransfer(envelope);
    store.startTransfer(envelope2);
    store.clearLocalClips();

    expect(addTombstoneMock).toHaveBeenCalledWith("transfer-1", "session-1");
    expect(addTombstoneMock).toHaveBeenCalledWith("transfer-2", "session-1");
  });

  test("clearLocalClips with zone only records tombstones for that zone", () => {
    const store = new DirectTransferStore({ sessionToken: "session-1" });
    const envelope2 = { ...envelope, transferId: "transfer-2", zone: "B" as const };
    store.startTransfer(envelope);
    store.startTransfer(envelope2);
    store.clearLocalClips("A");

    expect(addTombstoneMock).toHaveBeenCalledWith("transfer-1", "session-1");
    expect(addTombstoneMock).not.toHaveBeenCalledWith("transfer-2", "session-1");
  });
});
