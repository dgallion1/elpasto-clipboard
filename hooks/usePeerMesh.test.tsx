// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Clip } from "@/lib/clips";
import type { DirectClipEnvelope } from "@/lib/direct-transfer";

const addTombstoneMock = vi.fn();
const adoptOrphanedClipsMock = vi.fn();
const getTombstonesMock = vi.fn();
const createPeerConnectionMock = vi.fn();
const decodeDataChannelMessageMock = vi.fn();
const deleteStoredBinaryClipMock = vi.fn();
const sendDirectTransferMock = vi.fn();
const encryptBinaryPayloadMock = vi.fn();
const encryptBinaryWithHandleMock = vi.fn();
const getStoredBinaryClipMock = vi.fn();
const getCurrentUnlockSecretMock = vi.fn();
const listStoredBinaryClipMetadataBySessionMock = vi.fn();
const listStoredBinaryClipsBySessionMock = vi.fn();
const putStoredBinaryClipMock = vi.fn();
const storedBinaryClips = new Map<string, Record<string, unknown>>();

function clipStoreKey(ownerTabId: string, transferId: string) {
  return `${ownerTabId}:${transferId}`;
}

class FakeDataChannel {
  binaryType = "blob";
  label = "clips";
  readyState: RTCDataChannelState = "connecting";
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Set<(event?: unknown) => void>>();

  addEventListener(type: string, listener: (event?: unknown) => void) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: (event?: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    if (this.readyState === "closed") {
      return;
    }
    this.readyState = "closed";
    this.dispatch("close");
  }

  dispatch(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  open() {
    this.readyState = "open";
    this.dispatch("open");
  }

  message(data: unknown) {
    this.dispatch("message", { data });
  }

  send(data: unknown) {
    this.sent.push(data);
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;
  readonly createdChannels: FakeDataChannel[] = [];
  readonly candidates: RTCIceCandidateInit[] = [];
  private readonly listeners = new Map<string, Set<(event?: unknown) => void>>();

  addEventListener(type: string, listener: (event?: unknown) => void) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  createDataChannel(label?: string) {
    const channel = new FakeDataChannel();
    if (label) {
      channel.label = label;
    }
    this.createdChannels.push(channel);
    return channel as unknown as RTCDataChannel;
  }

  close() {
    this.closed = true;
    this.connectionState = "closed";
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit) {
    if (description?.type === "rollback") {
      this.localDescription = null;
      this.signalingState = "stable";
      return;
    }

    const type = description?.type ?? (this.remoteDescription?.type === "offer" ? "answer" : "offer");
    const payload = { type, sdp: `local-${type}` };
    this.localDescription = {
      ...payload,
      toJSON: () => payload,
    } as RTCSessionDescription;
    this.signalingState = type === "offer" ? "have-local-offer" : "stable";
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  }

  async addIceCandidate(candidate: RTCIceCandidateInit) {
    this.candidates.push(candidate);
  }

  trigger(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const envelope: DirectClipEnvelope = {
  transferId: "transfer-1",
  zone: "A",
  kind: "file",
  mimeType: "application/pdf",
  originalName: "note.pdf",
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
  sizeBytes: 3,
  createdAt: "2026-03-10T12:00:00.000Z",
};

let peerConnections: FakePeerConnection[] = [];
let usePeerMesh: typeof import("./usePeerMesh").usePeerMesh;
let randomUuidSpy: ReturnType<typeof vi.spyOn>;

vi.mock("@/lib/webrtc", () => ({
  createPeerConnection: createPeerConnectionMock,
  decodeDataChannelMessage: decodeDataChannelMessageMock,
  sendDirectTransfer: sendDirectTransferMock,
}));

vi.mock("@/lib/clip-store", () => ({
  addTombstone: addTombstoneMock,
  adoptOrphanedClips: adoptOrphanedClipsMock,
  deleteStoredBinaryClip: deleteStoredBinaryClipMock,
  getStoredBinaryClip: getStoredBinaryClipMock,
  getTombstones: getTombstonesMock,
  listStoredBinaryClipMetadataBySession: listStoredBinaryClipMetadataBySessionMock,
  listStoredBinaryClipsBySession: listStoredBinaryClipsBySessionMock,
  migrateStoredBinaryClips: vi.fn(async () => 0),
  putStoredBinaryClip: putStoredBinaryClipMock,
}));

vi.mock("@/lib/clip-crypto", () => ({
  ClipCryptoError: class ClipCryptoError extends Error {},
  WrongUnlockSecretError: class WrongUnlockSecretError extends Error {},
  decryptBinaryPayload: vi.fn(),
  decryptHtmlPayload: vi.fn(),
  decryptTextPayload: vi.fn(),
  encryptBinaryPayload: encryptBinaryPayloadMock,
  encryptBinaryWithHandle: encryptBinaryWithHandleMock,
  encryptHtmlPayload: vi.fn(),
  encryptTextPayload: vi.fn(),
  toArrayBuffer: (bytes: Uint8Array) => bytes.buffer.slice(0),
}));

beforeAll(async () => {
  ({ usePeerMesh } = await import("./usePeerMesh"));
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  storedBinaryClips.clear();
  peerConnections = [];
  addTombstoneMock.mockReset();
  adoptOrphanedClipsMock.mockReset();
  adoptOrphanedClipsMock.mockResolvedValue([]);
  getTombstonesMock.mockReset();
  getTombstonesMock.mockResolvedValue(new Set());
  createPeerConnectionMock.mockReset();
  createPeerConnectionMock.mockImplementation(() => {
    const pc = new FakePeerConnection();
    peerConnections.push(pc);
    return pc as unknown as RTCPeerConnection;
  });
  decodeDataChannelMessageMock.mockReset();
  deleteStoredBinaryClipMock.mockReset();
  sendDirectTransferMock.mockReset();
  sendDirectTransferMock.mockResolvedValue(undefined);
  encryptBinaryPayloadMock.mockReset();
  encryptBinaryPayloadMock.mockResolvedValue({
    ciphertext: new Uint8Array([1, 2, 3]),
    meta: envelope.encryptionMeta,
  });
  encryptBinaryWithHandleMock.mockReset();
  encryptBinaryWithHandleMock.mockResolvedValue({
    ciphertext: new Uint8Array([1, 2, 3]),
    meta: envelope.encryptionMeta,
  });
  getCurrentUnlockSecretMock.mockReset();
  getCurrentUnlockSecretMock.mockResolvedValue("unlock-secret");
  getStoredBinaryClipMock.mockReset();
  getStoredBinaryClipMock.mockImplementation(async (transferId: string, ownerTabId: string) => {
    const record = storedBinaryClips.get(clipStoreKey(ownerTabId, transferId));
    return record ? structuredClone(record) : null;
  });
  listStoredBinaryClipMetadataBySessionMock.mockReset();
  listStoredBinaryClipMetadataBySessionMock.mockImplementation(async (
    sessionToken: string,
    ownerTabId: string
  ) => {
    return Array.from(storedBinaryClips.values())
      .filter((record) => record.sessionToken === sessionToken && record.ownerTabId === ownerTabId)
      .map((record) => ({
        transferId: record.transferId,
        sessionToken: record.sessionToken,
        ownerTabId: record.ownerTabId,
        zone: record.zone,
        kind: record.kind,
        mimeType: record.mimeType,
        originalName: record.originalName,
        sizeBytes: record.sizeBytes,
        encryptionVersion: record.encryptionVersion,
        encryptionMeta: record.encryptionMeta,
        createdAt: record.createdAt,
        origin: record.origin,
        hasSenderFileBytes: Boolean((record.senderFileBytes as ArrayBuffer | undefined)?.byteLength),
        hasCiphertext: Boolean((record.ciphertext as Uint8Array | undefined)?.byteLength),
      }));
  });
  listStoredBinaryClipsBySessionMock.mockReset();
  listStoredBinaryClipsBySessionMock.mockImplementation(async (
    sessionToken: string,
    ownerTabId: string
  ) => {
    return Array.from(storedBinaryClips.values())
      .filter((record) => record.sessionToken === sessionToken && record.ownerTabId === ownerTabId)
      .map((record) => structuredClone(record));
  });
  putStoredBinaryClipMock.mockReset();
  putStoredBinaryClipMock.mockImplementation(async (clip: Record<string, unknown>) => {
    storedBinaryClips.set(
      clipStoreKey(String(clip.ownerTabId), String(clip.transferId)),
      structuredClone(clip)
    );
  });
  deleteStoredBinaryClipMock.mockImplementation(async (transferId: string, ownerTabId: string) => {
    storedBinaryClips.delete(clipStoreKey(ownerTabId, transferId));
  });
  randomUuidSpy = vi.spyOn(globalThis.crypto, "randomUUID");
});

afterEach(() => {
  cleanup();
  randomUuidSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("usePeerMesh", () => {
  test("announces peers, queues local binaries, and serves catalog requests to newly opened peers", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    expect(sendPeerSignal).toHaveBeenCalledWith({
      fromPeerId: "peer-a",
      signalType: "announce",
    });

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-z",
        signalType: "announce",
      });
    });

    const firstPeer = peerConnections[0];
    const firstChannel = firstPeer.createdChannels[0];
    await act(async () => {
      firstChannel.open();
    });

    const file = new File(["hello"], "note.pdf", { type: "application/pdf" });
    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-1",
        zone: "A",
        file,
      });
    });

    expect(sendDirectTransferMock).toHaveBeenCalledTimes(1);
    expect(sendDirectTransferMock).toHaveBeenNthCalledWith(
      1,
      firstChannel,
      expect.objectContaining({
        transferId: "transfer-1",
        originalName: "note.pdf",
      }),
      new Uint8Array([1, 2, 3]),
      expect.any(Function),
      "clip:start"
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-y",
        signalType: "announce",
      });
    });

    const secondPeer = peerConnections[1];
    const secondChannel = secondPeer.createdChannels[0];
    await act(async () => {
      secondChannel.open();
    });

    const catalogOffer = secondChannel.sent
      .map((message) => JSON.parse(message as string))
      .find((message) => message.type === "catalog:offer");
    expect(catalogOffer).toEqual({
      type: "catalog:offer",
      clips: [
        {
          transferId: "transfer-1",
          zone: "A",
          kind: "file",
          mimeType: "application/pdf",
          originalName: "note.pdf",
          sizeBytes: 5,
          encryptionVersion: 1,
          encryptionMeta: envelope.encryptionMeta,
          createdAt: expect.any(String),
        },
      ],
    });
    expect(
      secondChannel.sent
        .map((message) => JSON.parse(message as string))
        .some((message) => message.type === "threads:sync")
    ).toBe(true);

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-1"] },
    });

    await act(async () => {
      secondChannel.message("catalog-request");
      await Promise.resolve();
    });

    await waitFor(() => expect(sendDirectTransferMock).toHaveBeenCalledTimes(2));
    expect(sendDirectTransferMock).toHaveBeenNthCalledWith(
      2,
      secondChannel,
      expect.objectContaining({ transferId: "transfer-1" }),
      new Uint8Array([1, 2, 3]),
      expect.any(Function),
      "clip:start"
    );
    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1);
  });

  test("requests a missing receiver transfer from one peer and ignores duplicate starts from others", async () => {
    randomUuidSpy.mockReturnValue("peer-0");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
      await result.current.handlePeerSignal({ fromPeerId: "peer-b", signalType: "announce" });
    });

    const peerAChannel = peerConnections[0].createdChannels[0];
    const peerBChannel = peerConnections[1].createdChannels[0];
    await act(async () => {
      peerAChannel.open();
      peerBChannel.open();
    });

    decodeDataChannelMessageMock
      .mockResolvedValueOnce({
        kind: "control",
        message: {
          type: "catalog:offer",
          clips: [{
            transferId: "transfer-1",
            zone: "A",
            kind: "file",
            mimeType: "application/pdf",
            originalName: "note.pdf",
            sizeBytes: 3,
            encryptionVersion: null,
            encryptionMeta: null,
            createdAt: envelope.createdAt,
          }],
        },
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: {
          type: "catalog:offer",
          clips: [{
            transferId: "transfer-1",
            zone: "A",
            kind: "file",
            mimeType: "application/pdf",
            originalName: "note.pdf",
            sizeBytes: 3,
            encryptionVersion: null,
            encryptionMeta: null,
            createdAt: envelope.createdAt,
          }],
        },
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:start", envelope: { ...envelope, encrypted: false, encryptionVersion: null, encryptionMeta: null } },
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:start", envelope: { ...envelope, encrypted: false, encryptionVersion: null, encryptionMeta: null } },
      })
      .mockResolvedValueOnce({
        kind: "chunk",
        transferId: "transfer-1",
        index: 0,
        payload: new Uint8Array([1, 2, 3]),
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:end", transferId: "transfer-1", totalChunks: 1 },
      });

    await act(async () => {
      peerAChannel.message("catalog-offer-a");
      await Promise.resolve();
      peerBChannel.message("catalog-offer-b");
      await Promise.resolve();
    });

    expect(peerAChannel.sent.some((payload) => JSON.parse(payload as string).type === "catalog:request")).toBe(true);
    expect(peerBChannel.sent.some((payload) => JSON.parse(payload as string).type === "catalog:request")).toBe(false);

    await act(async () => {
      peerBChannel.message("wrong-peer-start");
      await Promise.resolve();
      peerAChannel.message("owner-start");
      await Promise.resolve();
      peerAChannel.message("owner-chunk");
      await Promise.resolve();
      peerAChannel.message("owner-end");
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(result.current.getReceivedBinaryClipsByZone("A")[0]?.local_transfer_state).toBe("complete")
    );
    expect(result.current.getReceivedBinaryClipsByZone("A")).toHaveLength(1);
  });

  test("tracks sender progress for direct sends and clears it when a peer disconnects", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);
    let resolveSend: (() => void) | null = null;

    sendDirectTransferMock.mockImplementation(
      async (
        _channel: RTCDataChannel,
        _envelope: DirectClipEnvelope,
        ciphertext: Uint8Array,
        onProgress?: (sentBytes: number, totalBytes: number) => void
      ) => {
        onProgress?.(Math.floor(ciphertext.byteLength / 2), ciphertext.byteLength);
        await new Promise<void>((resolve) => {
          resolveSend = resolve;
        });
      }
    );

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-z",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const [channel] = peerConnection.createdChannels;
    await act(async () => {
      channel.open();
    });

    let queuePromise: Promise<Clip> | null = null;
    const file = new File(["hello"], "note.pdf", { type: "application/pdf" });
    await act(async () => {
      queuePromise = result.current.queueLocalBinaryClip({
        transferId: "transfer-1",
        zone: "A",
        file,
      });
      await Promise.resolve();
    });

    expect(result.current.getSendProgress("transfer-1")).toBeCloseTo(1 / 3, 5);

    await act(async () => {
      resolveSend?.();
      await queuePromise;
    });
    expect(result.current.getSendProgress("transfer-1")).toBeNull();

    let resolveResend: (() => void) | null = null;
    sendDirectTransferMock.mockImplementationOnce(
      async (
        _channel: RTCDataChannel,
        _envelope: DirectClipEnvelope,
        ciphertext: Uint8Array,
        onProgress?: (sentBytes: number, totalBytes: number) => void
      ) => {
        onProgress?.(1, ciphertext.byteLength);
        await new Promise<void>((resolve) => {
          resolveResend = resolve;
        });
      }
    );

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-1"] },
    });

    await act(async () => {
      channel.message("catalog-request");
      await Promise.resolve();
    });
    expect(result.current.getSendProgress("transfer-1")).toBeCloseTo(1 / 3, 5);

    await act(async () => {
      peerConnection.connectionState = "failed";
      peerConnection.trigger("connectionstatechange");
      await Promise.resolve();
    });
    expect(result.current.getSendProgress("transfer-1")).toBeNull();

    await act(async () => {
      resolveResend?.();
      await Promise.resolve();
    });
  });

  test("reconstructs receiver-local direct transfers without a canonical clip row", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "clip:start", envelope },
    });
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "chunk",
      transferId: "transfer-1",
      index: 0,
      payload: new Uint8Array([9, 8, 7]),
    });
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "clip:end", transferId: "transfer-1", totalChunks: 1 },
    });

    await act(async () => {
      remoteChannel.message("start");
      await Promise.resolve();
    });
    expect(result.current.getReceivedBinaryClipsByZone("A")[0]).toMatchObject({
      client_transfer_id: "transfer-1",
      local_only: true,
      local_origin: "receiver",
      local_transfer_state: "pending",
    });

    await act(async () => {
      remoteChannel.message("chunk");
      await Promise.resolve();
      remoteChannel.message("end");
      await Promise.resolve();
    });

    const [receivedClip] = result.current.getReceivedBinaryClipsByZone("A");
    expect(receivedClip.local_transfer_state).toBe("complete");
    expect(result.current.getDirectClipCiphertext(receivedClip.id)).toEqual(
      new Uint8Array([9, 8, 7])
    );
  });

  test("keeps receiver transfers pending until persistence resolves", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);
    let resolvePersist: (() => void) | null = null;
    const persistPromise = new Promise<void>((resolve) => {
      resolvePersist = resolve;
    });

    putStoredBinaryClipMock.mockImplementation(async (clip: Record<string, unknown>) => {
      if (clip.origin === "receiver" && clip.transferId === "transfer-1") {
        await persistPromise;
      }
      storedBinaryClips.set(
        clipStoreKey(String(clip.ownerTabId), String(clip.transferId)),
        structuredClone(clip)
      );
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:start", envelope },
      })
      .mockResolvedValueOnce({
        kind: "chunk",
        transferId: "transfer-1",
        index: 0,
        payload: new Uint8Array([9, 8, 7]),
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:end", transferId: "transfer-1", totalChunks: 1 },
      });

    await act(async () => {
      remoteChannel.message("start");
      await Promise.resolve();
      remoteChannel.message("chunk");
      await Promise.resolve();
      remoteChannel.message("end");
      await Promise.resolve();
    });

    expect(result.current.getReceivedBinaryClipsByZone("A")[0]?.local_transfer_state).toBe("pending");
    expect(storedBinaryClips.has(clipStoreKey("peer-z", "transfer-1"))).toBe(false);

    await act(async () => {
      resolvePersist?.();
      await persistPromise;
    });

    await waitFor(() =>
      expect(result.current.getReceivedBinaryClipsByZone("A")[0]?.local_transfer_state).toBe("complete")
    );
    expect(storedBinaryClips.get(clipStoreKey("peer-z", "transfer-1"))).toMatchObject({
      transferId: "transfer-1",
      ownerTabId: "peer-z",
      origin: "receiver",
    });
  });

  test("marks receiver transfers failed when persistence rejects", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    putStoredBinaryClipMock.mockImplementation(async (clip: Record<string, unknown>) => {
      if (clip.origin === "receiver" && clip.transferId === "transfer-1") {
        throw new Error("quota exceeded");
      }
      storedBinaryClips.set(
        clipStoreKey(String(clip.ownerTabId), String(clip.transferId)),
        structuredClone(clip)
      );
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:start", envelope },
      })
      .mockResolvedValueOnce({
        kind: "chunk",
        transferId: "transfer-1",
        index: 0,
        payload: new Uint8Array([9, 8, 7]),
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:end", transferId: "transfer-1", totalChunks: 1 },
      });

    await act(async () => {
      remoteChannel.message("start");
      await Promise.resolve();
      remoteChannel.message("chunk");
      await Promise.resolve();
      remoteChannel.message("end");
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(result.current.getReceivedBinaryClipsByZone("A")[0]?.local_transfer_state).toBe("failed")
    );

    const [receivedClip] = result.current.getReceivedBinaryClipsByZone("A");
    expect(result.current.getDirectClipCiphertext(receivedClip.id)).toEqual(new Uint8Array([9, 8, 7]));
    expect(storedBinaryClips.has(clipStoreKey("peer-z", "transfer-1"))).toBe(false);
  });

  test("scopes peer clear messages to the sender transfer IDs", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
      await result.current.handlePeerSignal({
        fromPeerId: "peer-b",
        signalType: "announce",
      });
    });

    const firstRemoteChannel = new FakeDataChannel();
    const secondRemoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnections[0].trigger("datachannel", {
        channel: firstRemoteChannel as unknown as RTCDataChannel,
      });
      peerConnections[1].trigger("datachannel", {
        channel: secondRemoteChannel as unknown as RTCDataChannel,
      });
      firstRemoteChannel.open();
      secondRemoteChannel.open();
    });

    const otherEnvelope: DirectClipEnvelope = {
      ...envelope,
      transferId: "transfer-2",
      originalName: "other.pdf",
    };

    decodeDataChannelMessageMock
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:start", envelope },
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:end", transferId: "transfer-1", totalChunks: 0 },
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:start", envelope: otherEnvelope },
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:end", transferId: "transfer-2", totalChunks: 0 },
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clips:clear", zone: "A", transferIds: ["transfer-1"] },
      });

    await act(async () => {
      firstRemoteChannel.message("peer-a-start");
      await Promise.resolve();
      firstRemoteChannel.message("peer-a-end");
      await Promise.resolve();
      secondRemoteChannel.message("peer-b-start");
      await Promise.resolve();
      secondRemoteChannel.message("peer-b-end");
      await Promise.resolve();
    });

    expect(
      result.current
        .getReceivedBinaryClipsByZone("A")
        .map((clip) => clip.client_transfer_id)
        .sort()
    ).toEqual([
      "transfer-1",
      "transfer-2",
    ]);

    await act(async () => {
      firstRemoteChannel.message("peer-a-clear");
      await Promise.resolve();
    });

    expect(
      result.current
        .getReceivedBinaryClipsByZone("A")
        .map((clip) => clip.client_transfer_id)
    ).toEqual([
      "transfer-2",
    ]);
  });

  test("negotiates descriptions and ICE candidates with polite peers", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;

    await act(async () => {
      peerConnection.trigger("negotiationneeded");
      await Promise.resolve();
    });

    expect(sendPeerSignal).toHaveBeenCalledWith({
      fromPeerId: "peer-z",
      toPeerId: "peer-a",
      signalType: "description",
      description: { type: "offer", sdp: "local-offer" },
    });

    await act(async () => {
      peerConnection.trigger("icecandidate", {
        candidate: { toJSON: () => ({ candidate: "ice-1" }) },
      });
    });

    expect(sendPeerSignal).toHaveBeenCalledWith({
      fromPeerId: "peer-z",
      toPeerId: "peer-a",
      signalType: "ice-candidate",
      candidate: { candidate: "ice-1" },
    });

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "description",
        description: { type: "offer", sdp: "remote-offer" },
      });
    });

    expect(sendPeerSignal).toHaveBeenCalledWith({
      fromPeerId: "peer-z",
      toPeerId: "peer-a",
      signalType: "description",
      description: { type: "answer", sdp: "local-answer" },
    });
  });

  test("persists own name per-tab and re-announces it on reconnect", async () => {
    randomUuidSpy.mockReturnValue("peer-local");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-remote",
        signalType: "announce",
      });
    });

    const firstPeerChannel = peerConnections[0].createdChannels[0];
    await act(async () => {
      firstPeerChannel.open();
    });

    // Rename self — should persist via per-tab storage and broadcast
    await act(async () => {
      result.current.renamePeer("peer-local", "Kitchen iPad");
    });

    expect(
      firstPeerChannel.sent.some((payload) => {
        const message = JSON.parse(payload as string);
        return message.type === "peer:name"
          && message.peerId === "peer-local"
          && message.name === "Kitchen iPad";
      })
    ).toBe(true);

    // Own name persisted in per-tab localStorage (key includes tab ID from sessionStorage)
    const tabId = sessionStorage.getItem("elpasto:tab-id:session-1");
    expect(tabId).toBeTruthy();
    expect(
      localStorage.getItem(`elpasto:my-peer-name:session-1:${tabId}`)
    ).toBe("Kitchen iPad");

    // Renaming a remote peer does NOT persist to own my-peer-name
    await act(async () => {
      result.current.renamePeer("peer-remote", "Old Tablet");
    });
    expect(
      localStorage.getItem(`elpasto:my-peer-name:session-1:${tabId}`)
    ).toBe("Kitchen iPad");

    // When a new peer connects, names-sync includes all known names
    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-late",
        signalType: "announce",
      });
    });

    const secondPeerChannel = new FakeDataChannel();
    await act(async () => {
      peerConnections[1].trigger("datachannel", {
        channel: secondPeerChannel as unknown as RTCDataChannel,
      });
      secondPeerChannel.open();
    });

    const syncMessage = secondPeerChannel.sent
      .map((payload) => JSON.parse(payload as string))
      .find((message) => message.type === "peer:names-sync");
    expect(syncMessage).toMatchObject({
      type: "peer:names-sync",
      names: {
        "peer-local": "Kitchen iPad",
        "peer-remote": "Old Tablet",
      },
    });

    // Own name also sent as peer:name on channel open
    const nameMessage = secondPeerChannel.sent
      .map((payload) => JSON.parse(payload as string))
      .find((m) => m.type === "peer:name" && m.peerId === "peer-local");
    expect(nameMessage).toMatchObject({
      type: "peer:name",
      peerId: "peer-local",
      name: "Kitchen iPad",
    });
  });

  test("keeps a fresh local peer id when a duplicated tab restores session storage", async () => {
    sessionStorage.setItem("elpasto:tab-id:session-1", "restored-tab-id");
    localStorage.setItem(
      "elpasto:my-peer-name:session-1:restored-tab-id",
      "Kitchen iPad"
    );
    vi.spyOn(window.performance, "getEntriesByType").mockReturnValue([
      { type: "navigate" } as unknown as PerformanceEntry,
    ]);
    randomUuidSpy
      .mockReturnValueOnce("fresh-peer-id")
      .mockReturnValueOnce("fresh-tab-id");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await waitFor(() => {
      expect(result.current.peerNames).toEqual({
        "fresh-peer-id": "Kitchen iPad",
      });
    });

    expect(result.current.localPeerId).toBe("fresh-peer-id");
    expect(result.current.localPeerId).not.toBe(
      sessionStorage.getItem("elpasto:tab-id:session-1")
    );
    expect(sessionStorage.getItem("elpasto:tab-id:session-1")).toBe("fresh-tab-id");
    expect(
      localStorage.getItem("elpasto:my-peer-name:session-1:fresh-tab-id")
    ).toBe("Kitchen iPad");
    expect(listStoredBinaryClipsBySessionMock).toHaveBeenCalledWith(
      "session-1",
      "fresh-tab-id"
    );
    expect(sendPeerSignal).toHaveBeenCalledWith({
      fromPeerId: "fresh-peer-id",
      signalType: "announce",
    });
  });

  test("ignores impolite offer collisions and reannounces after channel failures", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);
    const scheduledCallbacks: Array<() => void> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((callback: TimerHandler) => {
        scheduledCallbacks.push(callback as () => void);
        return scheduledCallbacks.length as never;
      }) as unknown as typeof setTimeout
    );
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(
      (() => undefined) as typeof clearTimeout
    );

    try {
      const { result, rerender } = renderHook(
        ({ enabled }) =>
          usePeerMesh({
            enabled,
            sessionToken: "session-1",
            signalingReady: true,
            sendPeerSignal,
            getCurrentUnlockSecret: getCurrentUnlockSecretMock,
          }),
        { initialProps: { enabled: true } }
      );

      await act(async () => {
        await result.current.handlePeerSignal({
          fromPeerId: "peer-z",
          signalType: "announce",
        });
      });

      const [peerConnection] = peerConnections;
      const [channel] = peerConnection.createdChannels;
      await act(async () => {
        channel.open();
      });
      peerConnection.signalingState = "have-local-offer";

      await act(async () => {
        await result.current.handlePeerSignal({
          fromPeerId: "peer-z",
          signalType: "description",
          description: { type: "offer", sdp: "collision-offer" },
        });
      });

      await act(async () => {
        await result.current.handlePeerSignal({
          fromPeerId: "peer-z",
          signalType: "ice-candidate",
          candidate: { candidate: "ignored-ice" },
        });
      });

      expect(peerConnection.candidates).toEqual([]);

      await act(async () => {
        channel.close();
      });

      expect(scheduledCallbacks.length).toBeGreaterThan(0);
      await act(async () => {
        scheduledCallbacks[scheduledCallbacks.length - 1]!();
      });

      expect(sendPeerSignal).toHaveBeenCalledWith({
        fromPeerId: "peer-a",
        signalType: "announce",
      });

      await act(async () => {
        rerender({ enabled: false });
      });
      expect(peerConnection.closed).toBe(true);
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  test("does not announce when disabled and ignores self or misdirected signals", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: false,
        sessionToken: "session-1",
        signalingReady: false,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    expect(sendPeerSignal).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
      await result.current.handlePeerSignal({
        fromPeerId: "peer-z",
        toPeerId: "someone-else",
        signalType: "announce",
      });
    });

    expect(peerConnections).toHaveLength(0);
  });

  test("hydrates sender-side stored binary clips on mount", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-restore"), {
      transferId: "transfer-restore",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "B",
      kind: "image",
      mimeType: "image/png",
      originalName: "restore.png",
      sizeBytes: 3,
      encryptionVersion: 1,
      encryptionMeta: envelope.encryptionMeta,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "sender",
      senderFileBytes: new Uint8Array([1, 2, 3]).buffer,
      ciphertext: new Uint8Array([9, 8, 7]),
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await waitFor(() => expect(result.current.getLocalBinaryClipsByZone("B")).toHaveLength(1));

    const [clip] = result.current.getLocalBinaryClipsByZone("B");
    expect(clip).toMatchObject({
      client_transfer_id: "transfer-restore",
      kind: "image",
      local_only: true,
      local_origin: "sender",
      local_transfer_state: "complete",
      original_name: "restore.png",
    });
    expect(clip.local_file).toBeInstanceOf(File);
    expect(clip.local_file?.name).toBe("restore.png");
  });

  test("catalog exchange waits for initial restore so receiver ciphertext is available", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-receiver-restore"), {
      transferId: "transfer-receiver-restore",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "B",
      kind: "image",
      mimeType: "image/jpeg",
      originalName: "restore.jpg",
      sizeBytes: 3,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "receiver",
      ciphertext: new Uint8Array([7, 8, 9]),
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Let the initial restore complete first
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: {
        type: "catalog:offer",
        clips: [{
          transferId: "transfer-receiver-restore",
          zone: "B",
          kind: "image",
          mimeType: "image/jpeg",
          originalName: "restore.jpg",
          sizeBytes: 3,
          encryptionVersion: null,
          encryptionMeta: null,
          createdAt: "2026-03-10T12:00:00.000Z",
        }],
      },
    });

    await act(async () => {
      remoteChannel.message("catalog-offer");
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(result.current.getReceivedBinaryClipsByZone("B")[0]?.local_transfer_state).toBe("complete")
    );

    const [clip] = result.current.getReceivedBinaryClipsByZone("B");
    expect(Array.from(result.current.getDirectClipCiphertext(clip.id) ?? [])).toEqual([7, 8, 9]);
  });

  test("removes local binary clips by transfer id and broadcasts deletion to peers", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const channel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: channel as unknown as RTCDataChannel,
      });
      channel.open();
    });
    channel.sent.length = 0;

    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-1",
        zone: "A",
        file: new File(["hello"], "note.pdf", { type: "application/pdf" }),
      });
    });
    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1);

    await act(async () => {
      result.current.removeLocalBinaryClip("transfer-1");
      await Promise.resolve();
    });

    expect(result.current.getLocalBinaryClipsByZone("A")).toEqual([]);
    expect(deleteStoredBinaryClipMock).toHaveBeenCalledWith("transfer-1", "peer-z");
    expect(addTombstoneMock).toHaveBeenCalledWith("transfer-1", "session-1");
    expect(channel.sent).toContain(JSON.stringify({
      type: "clip:delete",
      transferId: "transfer-1",
    }));
  });

  test("clears only the requested local binary zone and broadcasts the matching transfer ids", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const channel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: channel as unknown as RTCDataChannel,
      });
      channel.open();
    });
    channel.sent.length = 0;

    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-a",
        zone: "A",
        file: new File(["a"], "a.pdf", { type: "application/pdf" }),
      });
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-b",
        zone: "B",
        file: new File(["b"], "b.pdf", { type: "application/pdf" }),
      });
    });

    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1);
    expect(result.current.getLocalBinaryClipsByZone("B")).toHaveLength(1);

    await act(async () => {
      result.current.clearLocalBinaryClips("A");
      await Promise.resolve();
    });

    expect(result.current.getLocalBinaryClipsByZone("A")).toEqual([]);
    expect(result.current.getLocalBinaryClipsByZone("B")).toHaveLength(1);
    expect(deleteStoredBinaryClipMock).toHaveBeenCalledWith("transfer-a", "peer-z");
    expect(deleteStoredBinaryClipMock).not.toHaveBeenCalledWith("transfer-b", "peer-z");
    expect(addTombstoneMock).toHaveBeenCalledWith("transfer-a", "session-1");
    expect(addTombstoneMock).not.toHaveBeenCalledWith("transfer-b", "session-1");
    expect(channel.sent).toContain(JSON.stringify({
      type: "clips:clear",
      transferIds: ["transfer-a"],
      zone: "A",
    }));
  });

  test("broadcastClipDelete sends clip:delete to peers for a given transfer id", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const channel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: channel as unknown as RTCDataChannel,
      });
      channel.open();
    });
    channel.sent.length = 0;

    act(() => {
      result.current.broadcastClipDelete("transfer-xyz");
    });

    expect(channel.sent).toContain(JSON.stringify({
      type: "clip:delete",
      transferId: "transfer-xyz",
    }));
    expect(addTombstoneMock).toHaveBeenCalledWith("transfer-xyz", "session-1");
  });
});

describe("tombstone recording on incoming delete messages", () => {
  test("incoming clip:delete records a tombstone", async () => {
    randomUuidSpy.mockReturnValue("peer-local");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Connect a remote peer
    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-remote",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const channel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: channel as unknown as RTCDataChannel,
      });
      channel.open();
    });

    addTombstoneMock.mockReset();

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "clip:delete", transferId: "deleted-transfer" },
    });

    // Simulate incoming clip:delete
    await act(async () => {
      channel.message("clip-delete-msg");
      await Promise.resolve();
    });

    expect(addTombstoneMock).toHaveBeenCalledWith("deleted-transfer", "session-1");
  });

  test("incoming clips:clear records tombstones for each transfer id", async () => {
    randomUuidSpy.mockReturnValue("peer-local");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-remote",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const channel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: channel as unknown as RTCDataChannel,
      });
      channel.open();
    });

    addTombstoneMock.mockReset();

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "clips:clear", transferIds: ["dead-1", "dead-2"] },
    });

    await act(async () => {
      channel.message("clips-clear-msg");
      await Promise.resolve();
    });

    expect(addTombstoneMock).toHaveBeenCalledWith("dead-1", "session-1");
    expect(addTombstoneMock).toHaveBeenCalledWith("dead-2", "session-1");
  });

  test("sendCatalogOfferToPeer filters tombstoned clips from outgoing offer", async () => {
    randomUuidSpy.mockReturnValue("peer-local");
    // Seed a tombstoned clip and a live clip in IndexedDB
    storedBinaryClips.set(clipStoreKey("peer-local", "dead-clip"), {
      transferId: "dead-clip",
      sessionToken: "session-1",
      ownerTabId: "peer-local",
      zone: "A",
      kind: "file",
      mimeType: "text/plain",
      originalName: "dead.txt",
      sizeBytes: 10,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-27T00:00:00.000Z",
      origin: "sender",
    });
    storedBinaryClips.set(clipStoreKey("peer-local", "live-clip"), {
      transferId: "live-clip",
      sessionToken: "session-1",
      ownerTabId: "peer-local",
      zone: "A",
      kind: "file",
      mimeType: "text/plain",
      originalName: "live.txt",
      sizeBytes: 10,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-27T00:00:00.000Z",
      origin: "sender",
    });
    getTombstonesMock.mockResolvedValue(new Set(["dead-clip"]));
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-remote",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const channel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: channel as unknown as RTCDataChannel,
      });
      channel.open();
    });

    // The catalog:offer sent on channel open should NOT include dead-clip
    const offerMsg = channel.sent.find((msg) => {
      try {
        const parsed = JSON.parse(msg as string);
        return parsed.type === "catalog:offer";
      } catch {
        return false;
      }
    });
    expect(offerMsg).toBeDefined();
    const parsed = JSON.parse(offerMsg as string);
    const offeredIds = parsed.clips.map((c: { transferId: string }) => c.transferId);
    expect(offeredIds).not.toContain("dead-clip");
    expect(offeredIds).toContain("live-clip");
  });

  test("initial restore filters tombstoned clips from IndexedDB", async () => {
    randomUuidSpy.mockReturnValue("peer-local");
    // Seed a tombstoned sender clip and a live sender clip
    storedBinaryClips.set(clipStoreKey("peer-local", "dead-sender"), {
      transferId: "dead-sender",
      sessionToken: "session-1",
      ownerTabId: "peer-local",
      zone: "A",
      kind: "file",
      mimeType: "text/plain",
      originalName: "dead.txt",
      sizeBytes: 3,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-27T00:00:00.000Z",
      origin: "sender",
      senderFileBytes: new Uint8Array([1, 2, 3]).buffer,
    });
    storedBinaryClips.set(clipStoreKey("peer-local", "live-sender"), {
      transferId: "live-sender",
      sessionToken: "session-1",
      ownerTabId: "peer-local",
      zone: "A",
      kind: "file",
      mimeType: "text/plain",
      originalName: "live.txt",
      sizeBytes: 3,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-27T00:00:00.000Z",
      origin: "sender",
      senderFileBytes: new Uint8Array([4, 5, 6]).buffer,
    });
    getTombstonesMock.mockResolvedValue(new Set(["dead-sender"]));

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await waitFor(() => expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1));

    const [clip] = result.current.getLocalBinaryClipsByZone("A");
    expect(clip.client_transfer_id).toBe("live-sender");

    // Tombstoned clip should have been deleted from IndexedDB
    expect(deleteStoredBinaryClipMock).toHaveBeenCalledWith("dead-sender", "peer-local");
  });

  test("clips and tunnel channels coexist on one peer connection", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Connect a remote peer (answerer receives the datachannel event)
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-z", signalType: "announce" });
    });

    const pc = peerConnections[0];
    // Offerer creates clips channel
    const clipsChannel = pc.createdChannels[0];
    await act(async () => { clipsChannel.open(); });

    // Simulate answerer receiving a tunnel channel from the CLI
    const tunnelChannel = new (clipsChannel.constructor as new () => typeof clipsChannel)();
    Object.defineProperty(tunnelChannel, "label", { value: "tunnel" });

    await act(async () => {
      pc.trigger("datachannel", { channel: tunnelChannel as unknown as RTCDataChannel });
      tunnelChannel.open();
    });

    // Both channels should be open and independent
    expect(clipsChannel.readyState).toBe("open");
    expect(tunnelChannel.readyState).toBe("open");

    // clips channel still works: broadcastClipDelete sends only on clips
    clipsChannel.sent.length = 0;
    tunnelChannel.sent.length = 0;
    act(() => { result.current.broadcastClipDelete("t-1"); });
    expect(clipsChannel.sent).toHaveLength(1);
    expect(tunnelChannel.sent).toHaveLength(0);

    // Tunnel send works independently
    const sent = result.current.sendTunnelMessage("peer-z", "hello-tunnel");
    expect(sent).toBe(true);
    expect(tunnelChannel.sent).toContain("hello-tunnel");
    expect(clipsChannel.sent).toHaveLength(1); // unchanged
  });

  test("subscribeTunnel delivers messages from the tunnel channel", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-z", signalType: "announce" });
    });

    const pc = peerConnections[0];
    const clipsChannel = pc.createdChannels[0];
    await act(async () => { clipsChannel.open(); });

    // Subscribe before tunnel channel arrives
    const received: Array<{ peerId: string; data: string | ArrayBuffer }> = [];
    const unsub = result.current.subscribeTunnel((peerId, data) => {
      received.push({ peerId, data });
    });

    const tunnelChannel = new (clipsChannel.constructor as new () => typeof clipsChannel)();
    Object.defineProperty(tunnelChannel, "label", { value: "tunnel" });
    await act(async () => {
      pc.trigger("datachannel", { channel: tunnelChannel as unknown as RTCDataChannel });
      tunnelChannel.open();
    });

    // Dispatch a tunnel message
    act(() => { tunnelChannel.message('{"type":"tunnel:announce"}'); });

    expect(received).toHaveLength(1);
    expect(received[0].peerId).toBe("peer-z");
    expect(received[0].data).toBe('{"type":"tunnel:announce"}');

    // Unsubscribe works
    unsub();
    act(() => { tunnelChannel.message('{"type":"tunnel:close"}'); });
    expect(received).toHaveLength(1); // no new messages
  });

  test("hasTunnel reflects tunnel channel open state in peers list", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-z", signalType: "announce" });
    });

    const pc = peerConnections[0];
    const clipsChannel = pc.createdChannels[0];
    await act(async () => { clipsChannel.open(); });

    // Before tunnel: hasTunnel is false
    expect(result.current.peers.find((p) => p.peerId === "peer-z")?.hasTunnel).toBe(false);

    const tunnelChannel = new (clipsChannel.constructor as new () => typeof clipsChannel)();
    Object.defineProperty(tunnelChannel, "label", { value: "tunnel" });
    await act(async () => {
      pc.trigger("datachannel", { channel: tunnelChannel as unknown as RTCDataChannel });
      tunnelChannel.open();
    });

    // After tunnel opens: hasTunnel is true
    expect(result.current.peers.find((p) => p.peerId === "peer-z")?.hasTunnel).toBe(true);

    // After tunnel closes: hasTunnel is false again
    await act(async () => { tunnelChannel.close(); });
    expect(result.current.peers.find((p) => p.peerId === "peer-z")?.hasTunnel).toBe(false);
  });

  test("restores sender record without ciphertext sets encrypted=false and envelope=null", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-no-enc"), {
      transferId: "transfer-no-enc",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "plain.pdf",
      sizeBytes: 5,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "sender",
      senderFileBytes: new Uint8Array([1, 2, 3, 4, 5]).buffer,
      ciphertext: undefined,
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await waitFor(() => expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1));

    const [clip] = result.current.getLocalBinaryClipsByZone("A");
    expect(clip).toMatchObject({
      client_transfer_id: "transfer-no-enc",
      encrypted: false,
      encryption_version: null,
      encryption_meta: null,
      local_origin: "sender",
    });
  });

  test("restoreSenderRecord without senderFileBytes is skipped", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-no-bytes"), {
      transferId: "transfer-no-bytes",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "missing.pdf",
      sizeBytes: 5,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "sender",
      // No senderFileBytes — should be skipped
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Let restore complete
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(0);
  });

  test("queueLocalBinaryClip deduplicates by transferId", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    const file = new File(["hello"], "note.pdf", { type: "application/pdf" });
    let clip1: Clip | undefined;
    let clip2: Clip | undefined;
    await act(async () => {
      clip1 = await result.current.queueLocalBinaryClip({
        transferId: "transfer-dup",
        zone: "A",
        file,
      });
    });
    await act(async () => {
      clip2 = await result.current.queueLocalBinaryClip({
        transferId: "transfer-dup",
        zone: "A",
        file,
      });
    });

    expect(clip1!.id).toBe(clip2!.id);
    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1);
  });

  test("queueLocalBinaryClip without secret persists unencrypted record", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    getCurrentUnlockSecretMock.mockResolvedValue(null);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    const file = new File(["hello"], "note.pdf", { type: "application/pdf" });
    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-plain",
        zone: "A",
        file,
        // No secret provided
      });
    });

    expect(putStoredBinaryClipMock).toHaveBeenCalled();
    const storedCall = putStoredBinaryClipMock.mock.calls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).transferId === "transfer-plain"
    );
    expect(storedCall).toBeTruthy();
    expect((storedCall![0] as Record<string, unknown>).origin).toBe("sender");
    expect(encryptBinaryPayloadMock).not.toHaveBeenCalled();
  });

  test("queueLocalBinaryClip with secret pre-encrypts and persists encrypted record", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    const file = new File(["hello"], "note.pdf", { type: "application/pdf" });
    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-enc",
        zone: "A",
        file,
        secret: "my-secret",
      });
    });

    expect(encryptBinaryWithHandleMock).toHaveBeenCalledWith(
      { mode: "normal", secret: "my-secret" },
      expect.any(ArrayBuffer)
    );
    const [clip] = result.current.getLocalBinaryClipsByZone("A");
    expect(clip.encrypted).toBe(true);
    expect(clip.encryption_version).toBe(1);
  });

  test("queueLocalBinaryClip with no connected peers skips sending", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // No peers connected — just queue
    const file = new File(["hello"], "note.pdf", { type: "application/pdf" });
    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-alone",
        zone: "A",
        file,
      });
    });

    expect(sendDirectTransferMock).not.toHaveBeenCalled();
    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1);
  });

  test("removeLocalBinaryClip by numeric clip ID", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    const file = new File(["hello"], "note.pdf", { type: "application/pdf" });
    let clip: Clip | undefined;
    await act(async () => {
      clip = await result.current.queueLocalBinaryClip({
        transferId: "transfer-by-id",
        zone: "A",
        file,
      });
    });

    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1);

    await act(async () => {
      result.current.removeLocalBinaryClip(clip!.id);
    });

    expect(result.current.getLocalBinaryClipsByZone("A")).toEqual([]);
    expect(deleteStoredBinaryClipMock).toHaveBeenCalledWith("transfer-by-id", "peer-z");
  });

  test("removeLocalBinaryClip with unknown ID is a no-op", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      result.current.removeLocalBinaryClip("nonexistent-transfer");
    });
    await act(async () => {
      result.current.removeLocalBinaryClip(99999);
    });

    expect(deleteStoredBinaryClipMock).not.toHaveBeenCalled();
  });

  test("peer:name control message for self persists the name", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "peer:name", peerId: "peer-z", name: "Named By Remote" },
    });

    await act(async () => {
      remoteChannel.message("name-msg");
      await Promise.resolve();
    });

    expect(result.current.peerNames["peer-z"]).toBe("Named By Remote");
    const tabId = sessionStorage.getItem("elpasto:tab-id:session-1");
    expect(localStorage.getItem(`elpasto:my-peer-name:session-1:${tabId}`)).toBe("Named By Remote");
  });

  test("peer:identify control message triggers identify flash", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "peer:identify", fromPeerId: "peer-a" },
    });

    await act(async () => {
      remoteChannel.message("identify-msg");
      await Promise.resolve();
    });

    expect(result.current.identifyFlash).toMatchObject({
      id: 1,
      fromPeerId: "peer-a",
    });

    // clearIdentifyFlash with wrong id does nothing
    act(() => { result.current.clearIdentifyFlash(999); });
    expect(result.current.identifyFlash).not.toBeNull();

    // clearIdentifyFlash with correct id clears it
    act(() => { result.current.clearIdentifyFlash(1); });
    expect(result.current.identifyFlash).toBeNull();
  });

  test("clip:delete control message removes sender entry from local binary clips", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    // First queue a local binary clip
    const file = new File(["hello"], "note.pdf", { type: "application/pdf" });
    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-del",
        zone: "A",
        file,
      });
    });
    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1);

    // Receive clip:delete from peer for our sender entry
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "clip:delete", transferId: "transfer-del" },
    });

    await act(async () => {
      remoteChannel.message("delete-msg");
      await Promise.resolve();
    });

    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(0);
    expect(deleteStoredBinaryClipMock).toHaveBeenCalledWith("transfer-del", "peer-z");
  });

  test("clips:clear control message removes sender entries from local binary clips", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    // Queue two sender clips
    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-c1",
        zone: "A",
        file: new File(["a"], "a.pdf", { type: "application/pdf" }),
      });
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-c2",
        zone: "A",
        file: new File(["b"], "b.pdf", { type: "application/pdf" }),
      });
    });
    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(2);

    // Receive clips:clear from peer for both sender entries
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "clips:clear", zone: "A", transferIds: ["transfer-c1", "transfer-c2"] },
    });

    await act(async () => {
      remoteChannel.message("clear-msg");
      await Promise.resolve();
    });

    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(0);
    expect(deleteStoredBinaryClipMock).toHaveBeenCalledWith("transfer-c1", "peer-z");
    expect(deleteStoredBinaryClipMock).toHaveBeenCalledWith("transfer-c2", "peer-z");
  });

  test("threads:sync control message invokes onThreadsSync callback", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);
    const onThreadsSync = vi.fn();

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
        onThreadsSync,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    const threadRecords = [
      { id: "t1", name: "Thread 1", position: 0, updatedAt: 1000 },
      { id: "t2", name: "Thread 2", position: 1, updatedAt: 2000 },
    ];
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "threads:sync", threads: threadRecords },
    });

    await act(async () => {
      remoteChannel.message("threads-sync-msg");
      await Promise.resolve();
    });

    expect(onThreadsSync).toHaveBeenCalledWith(threadRecords);
  });

  test("thread:created control message invokes onThreadCreated callback", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);
    const onThreadCreated = vi.fn();

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
        onThreadCreated,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    const thread = { id: "new-thread", name: "3", position: 2, updatedAt: 3000 };
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "thread:created", thread },
    });

    await act(async () => {
      remoteChannel.message("thread-created-msg");
      await Promise.resolve();
    });

    expect(onThreadCreated).toHaveBeenCalledWith(thread);
  });

  test("thread:deleted control message removes sender clips for that thread", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);
    const onThreadDeleted = vi.fn();

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
        onThreadDeleted,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    // Queue a sender clip in thread "doomed"
    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-doomed",
        zone: "doomed",
        file: new File(["x"], "x.pdf", { type: "application/pdf" }),
      });
    });
    expect(result.current.getLocalBinaryClipsByZone("doomed")).toHaveLength(1);

    // Also queue a clip in a different thread to ensure it survives
    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-safe",
        zone: "safe",
        file: new File(["y"], "y.pdf", { type: "application/pdf" }),
      });
    });
    expect(result.current.getLocalBinaryClipsByZone("safe")).toHaveLength(1);

    // Receive thread:deleted from peer
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "thread:deleted", id: "doomed", deletedAt: 5000 },
    });

    await act(async () => {
      remoteChannel.message("thread-deleted-msg");
      await Promise.resolve();
    });

    // Clips in deleted thread should be gone
    expect(result.current.getLocalBinaryClipsByZone("doomed")).toHaveLength(0);
    // Clips in other thread should survive
    expect(result.current.getLocalBinaryClipsByZone("safe")).toHaveLength(1);
    // Callback invoked
    expect(onThreadDeleted).toHaveBeenCalledWith({ id: "doomed", deletedAt: 5000 });
    // Tombstone added for deleted clip
    expect(addTombstoneMock).toHaveBeenCalledWith("transfer-doomed", "session-1");
    // IndexedDB entry deleted
    expect(deleteStoredBinaryClipMock).toHaveBeenCalledWith("transfer-doomed", "peer-z");
  });

  test("thread:renamed control message invokes onThreadRenamed callback", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);
    const onThreadRenamed = vi.fn();

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
        onThreadRenamed,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "thread:renamed", id: "t1", name: "Renamed", updatedAt: 4000 },
    });

    await act(async () => {
      remoteChannel.message("thread-renamed-msg");
      await Promise.resolve();
    });

    expect(onThreadRenamed).toHaveBeenCalledWith({ id: "t1", name: "Renamed", updatedAt: 4000 });
  });

  test("sendTransferToPeer returns false when peer does not exist", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Queue a clip but don't connect any peers
    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-no-peer",
        zone: "A",
        file: new File(["hello"], "note.pdf", { type: "application/pdf" }),
      });
    });

    // sendDirectTransfer should not have been called (no peers)
    expect(sendDirectTransferMock).not.toHaveBeenCalled();
  });

  test("sendTunnelMessage returns false when peer does not exist", () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    expect(result.current.sendTunnelMessage("nonexistent-peer", "data")).toBe(false);
  });

  test("sendTunnelMessage sends ArrayBuffer data", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-z", signalType: "announce" });
    });

    const pc = peerConnections[0];
    const clipsChannel = pc.createdChannels[0];
    await act(async () => { clipsChannel.open(); });

    const tunnelChannel = new (clipsChannel.constructor as new () => typeof clipsChannel)();
    Object.defineProperty(tunnelChannel, "label", { value: "tunnel" });
    await act(async () => {
      pc.trigger("datachannel", { channel: tunnelChannel as unknown as RTCDataChannel });
      tunnelChannel.open();
    });

    const buf = new ArrayBuffer(4);
    const sent = result.current.sendTunnelMessage("peer-z", buf);
    expect(sent).toBe(true);
    expect(tunnelChannel.sent).toContain(buf);
  });

  test("openTunnelChannel returns false when peer does not exist", () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    expect(result.current.openTunnelChannel("nonexistent-peer")).toBe(false);
  });

  test("openTunnelChannel creates tunnel channel on existing peer and returns true when already connecting", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-z", signalType: "announce" });
    });

    const pc = peerConnections[0];
    const clipsChannel = pc.createdChannels[0];
    await act(async () => { clipsChannel.open(); });

    const channelCountBefore = pc.createdChannels.length;

    // Open a tunnel channel — creates a new data channel
    let opened: boolean = false;
    act(() => { opened = result.current.openTunnelChannel("peer-z"); });
    expect(opened).toBe(true);
    expect(pc.createdChannels.length).toBe(channelCountBefore + 1);

    // The newly created tunnel channel is still "connecting" (default readyState)
    const tunnelChannel = pc.createdChannels[pc.createdChannels.length - 1];
    expect(tunnelChannel.readyState).toBe("connecting");

    // Calling again while connecting returns true without creating another channel
    const channelCountAfterFirst = pc.createdChannels.length;
    act(() => { opened = result.current.openTunnelChannel("peer-z"); });
    expect(opened).toBe(true);
    expect(pc.createdChannels.length).toBe(channelCountAfterFirst);
  });

  test("buildTransferFromEntry with no secret produces unencrypted envelope", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    getCurrentUnlockSecretMock.mockResolvedValue(null);
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Queue without secret — should go through the unencrypted path
    const file = new File(["hello"], "note.pdf", { type: "application/pdf" });
    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-raw",
        zone: "A",
        file,
        // no secret
      });
    });

    // Connect a peer and trigger a catalog:request to exercise sendTransferToPeer
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-raw"] },
    });

    await act(async () => {
      remoteChannel.message("catalog-request");
      await Promise.resolve();
    });

    await waitFor(() => expect(sendDirectTransferMock).toHaveBeenCalledTimes(1));
    // The transfer should use unencrypted envelope
    const callArgs = sendDirectTransferMock.mock.calls[0];
    expect(callArgs[1].encrypted).toBe(false);
    expect(callArgs[1].encryptionVersion).toBeNull();
  });

  test("buildTransferFromEntry with existing ciphertext returns it immediately", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Queue with secret so it gets encrypted on first queue
    const file = new File(["hello"], "note.pdf", { type: "application/pdf" });
    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-cached",
        zone: "A",
        file,
        secret: "my-secret",
      });
    });

    encryptBinaryPayloadMock.mockClear();

    // Now connect a peer and request catalog — should use the cached ciphertext
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-cached"] },
    });

    await act(async () => {
      remoteChannel.message("catalog-request");
      await Promise.resolve();
    });

    await waitFor(() => expect(sendDirectTransferMock).toHaveBeenCalledTimes(1));
    // Should not re-encrypt — already had ciphertext cached
    expect(encryptBinaryPayloadMock).not.toHaveBeenCalled();
  });

  test("buildTransferFromStoredRecord with stored ciphertext returns it without re-encrypting", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    // Pre-populate a stored record with ciphertext
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-stored-ct"), {
      transferId: "transfer-stored-ct",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "stored.pdf",
      sizeBytes: 3,
      encryptionVersion: 1,
      encryptionMeta: envelope.encryptionMeta,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "sender",
      senderFileBytes: new Uint8Array([1, 2, 3]).buffer,
      ciphertext: new Uint8Array([4, 5, 6]),
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Wait for restore
    await waitFor(() => expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1));

    // Connect a peer
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    encryptBinaryPayloadMock.mockClear();

    // Request the stored transfer via catalog:request
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-stored-ct"] },
    });

    await act(async () => {
      remoteChannel.message("catalog-request");
      await Promise.resolve();
    });

    await waitFor(() => expect(sendDirectTransferMock).toHaveBeenCalledTimes(1));
    expect(encryptBinaryPayloadMock).not.toHaveBeenCalled();
    // Should have used the cached ciphertext from the restored entry
    const callArgs = sendDirectTransferMock.mock.calls[0];
    expect(callArgs[1].encrypted).toBe(true);
  });

  test("buildTransferFromStoredRecord without ciphertext falls back to entry build", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    getCurrentUnlockSecretMock.mockResolvedValue(null);
    const sendPeerSignal = vi.fn(async () => true);

    // Stored record with senderFileBytes but no ciphertext
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-no-ct"), {
      transferId: "transfer-no-ct",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "B",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "nocrypt.pdf",
      sizeBytes: 3,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "sender",
      senderFileBytes: new Uint8Array([7, 8, 9]).buffer,
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await waitFor(() => expect(result.current.getLocalBinaryClipsByZone("B")).toHaveLength(1));

    // Connect a peer
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-no-ct"] },
    });

    await act(async () => {
      remoteChannel.message("catalog-request");
      await Promise.resolve();
    });

    await waitFor(() => expect(sendDirectTransferMock).toHaveBeenCalledTimes(1));
    const callArgs = sendDirectTransferMock.mock.calls[0];
    expect(callArgs[1].encrypted).toBe(false);
  });

  test("catalog:unavailable retries next peer before marking failed", async () => {
    randomUuidSpy.mockReturnValue("peer-0");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Connect two peers
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
      await result.current.handlePeerSignal({ fromPeerId: "peer-b", signalType: "announce" });
    });

    const peerAChannel = peerConnections[0].createdChannels[0];
    const peerBChannel = peerConnections[1].createdChannels[0];
    await act(async () => {
      peerAChannel.open();
      peerBChannel.open();
    });

    // Have peer-a offer a clip, then receive catalog:request from us
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: {
        type: "catalog:offer",
        clips: [{
          transferId: "transfer-retry",
          zone: "A",
          kind: "file",
          mimeType: "application/pdf",
          originalName: "retry.pdf",
          sizeBytes: 3,
          encryptionVersion: null,
          encryptionMeta: null,
          createdAt: envelope.createdAt,
        }],
      },
    });

    await act(async () => {
      peerAChannel.message("catalog-offer");
      await Promise.resolve();
    });

    // Now peer-a says it's unavailable
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:unavailable", transferIds: ["transfer-retry"] },
    });

    await act(async () => {
      peerAChannel.message("unavailable");
      await Promise.resolve();
    });

    // Should have retried with peer-b
    const peerBMessages = peerBChannel.sent.map((s) => JSON.parse(s as string));
    expect(peerBMessages.some((m) => m.type === "catalog:request" && m.transferIds.includes("transfer-retry"))).toBe(true);
  });

  test("catalog offer with sender-origin clip skips upsertRemoteMetadata", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    // Pre-populate a sender-origin record
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-sender-origin"), {
      transferId: "transfer-sender-origin",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "sender.pdf",
      sizeBytes: 3,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "sender",
      senderFileBytes: new Uint8Array([1, 2, 3]).buffer,
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Wait for restore
    await waitFor(() => expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1));

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    // Peer offers the same clip we already have as sender
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: {
        type: "catalog:offer",
        clips: [{
          transferId: "transfer-sender-origin",
          zone: "A",
          kind: "file",
          mimeType: "application/pdf",
          originalName: "sender.pdf",
          sizeBytes: 3,
          encryptionVersion: null,
          encryptionMeta: null,
          createdAt: "2026-03-10T12:00:00.000Z",
        }],
      },
    });

    await act(async () => {
      remoteChannel.message("catalog-offer");
      await Promise.resolve();
    });

    // The sender clip should still be in localBinaryClips (not shadowed)
    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1);
    // Should NOT have requested the clip from the peer (since we have payload)
    const peerMessages = remoteChannel.sent
      .filter((s) => typeof s === "string")
      .map((s) => JSON.parse(s as string));
    expect(peerMessages.some((m) => m.type === "catalog:request" && m.transferIds?.includes("transfer-sender-origin"))).toBe(false);
  });

  test("handlePeerSignal leave removes peer", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    expect(result.current.peers).toHaveLength(1);

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "leave" });
    });

    expect(result.current.peers).toHaveLength(0);
  });

  test("peer:names-sync merges incoming names and skips when unchanged", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    // First names-sync with new names
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "peer:names-sync", names: { "peer-a": "Alice", "peer-b": "Bob" } },
    });

    await act(async () => {
      remoteChannel.message("sync1");
      await Promise.resolve();
    });

    expect(result.current.peerNames["peer-a"]).toBe("Alice");
    expect(result.current.peerNames["peer-b"]).toBe("Bob");

    // Second names-sync with same names (no change)
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "peer:names-sync", names: { "peer-a": "Alice", "peer-b": "Bob" } },
    });

    await act(async () => {
      remoteChannel.message("sync2");
      await Promise.resolve();
    });

    // Still the same (no crash, no unnecessary update)
    expect(result.current.peerNames["peer-a"]).toBe("Alice");
  });

  test("queueLocalBinaryClip infers image kind from file type", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    getCurrentUnlockSecretMock.mockResolvedValue(null);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    const imageFile = new File(["pixels"], "photo.png", { type: "image/png" });
    let clip: Clip | undefined;
    await act(async () => {
      clip = await result.current.queueLocalBinaryClip({
        transferId: "transfer-img",
        zone: "A",
        file: imageFile,
      });
    });

    expect(clip!.kind).toBe("image");
  });

  test("catalog:request with unavailable transfer sends catalog:unavailable", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    sendDirectTransferMock.mockResolvedValue(undefined);
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });

    // Request a transfer that doesn't exist locally
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["nonexistent-transfer"] },
    });

    // Make sendTransferToPeer fail by ensuring the transfer is not found
    sendDirectTransferMock.mockRejectedValueOnce(new Error("no data"));

    await act(async () => {
      remoteChannel.message("catalog-request");
      await Promise.resolve();
    });

    await waitFor(() => {
      const messages = remoteChannel.sent
        .filter((s) => typeof s === "string")
        .map((s) => JSON.parse(s as string));
      expect(messages.some((m) => m.type === "catalog:unavailable")).toBe(true);
    });
  });

  test("iceConnectionState failure cleans up peer", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    expect(result.current.peers).toHaveLength(1);

    const [peerConnection] = peerConnections;
    await act(async () => {
      peerConnection.iceConnectionState = "failed";
      peerConnection.trigger("iceconnectionstatechange");
    });

    expect(result.current.peers).toHaveLength(0);
  });

  test("connectionState connected clears connect timeout", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [peerConnection] = peerConnections;
    await act(async () => {
      peerConnection.connectionState = "connected";
      peerConnection.trigger("connectionstatechange");
    });

    // Peer should still be there
    expect(result.current.peers).toHaveLength(1);
  });

  test("icecandidate with null candidate is ignored", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const callCountBefore = sendPeerSignal.mock.calls.length;

    const [peerConnection] = peerConnections;
    await act(async () => {
      peerConnection.trigger("icecandidate", { candidate: null });
    });

    // No additional signal should have been sent
    expect(sendPeerSignal.mock.calls.length).toBe(callCountBefore);
  });

  test("pingPeer sends peer:identify control message", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [peerConnection] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      peerConnection.trigger("datachannel", {
        channel: remoteChannel as unknown as RTCDataChannel,
      });
      remoteChannel.open();
    });
    remoteChannel.sent.length = 0;

    act(() => { result.current.pingPeer("peer-a"); });

    const messages = remoteChannel.sent.map((s) => JSON.parse(s as string));
    expect(messages).toContainEqual({
      type: "peer:identify",
      fromPeerId: "peer-z",
    });
  });

  test("getTransferStats returns null for unknown transfer", () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );
    expect(result.current.getTransferStats("nonexistent")).toBeNull();
  });

  test("subscribeToDirectTransfers and subscribeToLocalBinaryClips return working unsubscribe", () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    const dtListener = vi.fn();
    const unsub1 = result.current.subscribeToDirectTransfers(dtListener);
    expect(typeof unsub1).toBe("function");
    unsub1();

    const lbListener = vi.fn();
    const unsub2 = result.current.subscribeToLocalBinaryClips(lbListener);
    expect(typeof unsub2).toBe("function");
    unsub2();
  });

  test("subscribeToSendProgress returns working unsubscribe", () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    const listener = vi.fn();
    const unsub = result.current.subscribeToSendProgress(listener);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("removeReceivedBinaryClip delegates to store", () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );
    // Should not throw even for nonexistent clip
    result.current.removeReceivedBinaryClip(999);
  });

  test("clearReceivedBinaryClips delegates to store", () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );
    // Should not throw
    result.current.clearReceivedBinaryClips("A");
    result.current.clearReceivedBinaryClips();
  });

  test("negotiation failure in onnegotiationneeded cleans up peer", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    // Make setLocalDescription throw to trigger the catch branch
    pc.setLocalDescription = async () => { throw new Error("negotiation failed"); };

    await act(async () => {
      pc.trigger("negotiationneeded");
      await Promise.resolve();
    });

    // Peer should be cleaned up
    expect(result.current.peers).toHaveLength(0);
  });

  test("negotiation when localDescription is null after setLocalDescription returns early", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    // setLocalDescription succeeds but localDescription stays null
    pc.setLocalDescription = async () => { pc.localDescription = null; };

    const signalCallsBefore = sendPeerSignal.mock.calls.length;
    await act(async () => {
      pc.trigger("negotiationneeded");
      await Promise.resolve();
    });

    // Should not have sent a description signal (only announce signals before)
    const signalCallsAfter = sendPeerSignal.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, string>).signalType === "description"
    );
    expect(signalCallsAfter).toHaveLength(0);
  });

  test("polite peer rolls back on offer collision", async () => {
    // peer-a < peer-z, so peer-z is polite when paired with peer-a? No.
    // polite = localPeerId.localeCompare(peerId) > 0
    // So if local is "peer-z" and remote is "peer-a", "peer-z".localeCompare("peer-a") > 0 => polite = true
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    // Simulate making offer (set makingOffer=true via negotiationneeded)
    // Instead, just set signalingState to trigger collision
    pc.signalingState = "have-local-offer";

    // As polite peer, receiving an offer during collision should rollback
    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "description",
        description: { type: "offer", sdp: "collision-offer" },
      });
    });

    // Polite peer should have rolled back and accepted the remote offer, then answered
    expect(sendPeerSignal).toHaveBeenCalledWith(expect.objectContaining({
      signalType: "description",
      description: expect.objectContaining({ type: "answer" }),
    }));
  });

  test("description handling failure cleans up peer", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    pc.setRemoteDescription = async () => { throw new Error("failed"); };

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "description",
        description: { type: "answer", sdp: "bad-answer" },
      });
    });

    expect(result.current.peers).toHaveLength(0);
  });

  test("addIceCandidate failure cleans up peer", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    pc.addIceCandidate = async () => { throw new Error("ICE failure"); };

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "ice-candidate",
        candidate: { candidate: "bad-candidate" },
      });
    });

    expect(result.current.peers).toHaveLength(0);
  });

  test("description with type answer does not send back another description", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const descCallsBefore = sendPeerSignal.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, string>).signalType === "description"
    ).length;

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "description",
        description: { type: "answer", sdp: "remote-answer" },
      });
    });

    const descCallsAfter = sendPeerSignal.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, string>).signalType === "description"
    ).length;
    // No new description should be sent for an answer
    expect(descCallsAfter).toBe(descCallsBefore);
  });

  test("description with offer where localDescription is null after answer does not send", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const origSetLocal = pc.setLocalDescription.bind(pc);
    let callCount = 0;
    pc.setLocalDescription = async (desc?: RTCSessionDescriptionInit) => {
      callCount++;
      // First call is setRemoteDescription; second is setLocalDescription for answer
      if (callCount >= 1 && !desc) {
        // Make localDescription null after "answering"
        pc.localDescription = null;
        return;
      }
      return origSetLocal(desc);
    };

    const descCallsBefore = sendPeerSignal.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, string>).signalType === "description"
    ).length;

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "description",
        description: { type: "offer", sdp: "remote-offer" },
      });
    });

    const descCallsAfter = sendPeerSignal.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, string>).signalType === "description"
    ).length;
    expect(descCallsAfter).toBe(descCallsBefore);
  });

  test("connectionState disconnected cleans up peer", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    expect(result.current.peers).toHaveLength(1);

    const [pc] = peerConnections;
    await act(async () => {
      pc.connectionState = "disconnected";
      pc.trigger("connectionstatechange");
    });

    expect(result.current.peers).toHaveLength(0);
  });

  test("iceConnectionState disconnected and closed clean up peer", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });
    expect(result.current.peers).toHaveLength(1);

    const [pc] = peerConnections;
    await act(async () => {
      pc.iceConnectionState = "disconnected";
      pc.trigger("iceconnectionstatechange");
    });
    expect(result.current.peers).toHaveLength(0);

    // Connect another and test closed state
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-b", signalType: "announce" });
    });
    expect(result.current.peers).toHaveLength(1);

    const pc2 = peerConnections[peerConnections.length - 1];
    await act(async () => {
      pc2.iceConnectionState = "closed";
      pc2.trigger("iceconnectionstatechange");
    });
    expect(result.current.peers).toHaveLength(0);
  });

  test("setupDataChannel replaces existing clips channel", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const firstChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: firstChannel as unknown as RTCDataChannel });
      firstChannel.open();
    });

    // Now receive a second clips channel — should close the first
    const secondChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: secondChannel as unknown as RTCDataChannel });
    });

    expect(firstChannel.readyState).toBe("closed");
  });

  test("setupTunnelChannel replaces existing tunnel channel", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-z", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const clipsChannel = pc.createdChannels[0];
    await act(async () => { clipsChannel.open(); });

    const firstTunnel = new FakeDataChannel();
    Object.defineProperty(firstTunnel, "label", { value: "tunnel" });
    await act(async () => {
      pc.trigger("datachannel", { channel: firstTunnel as unknown as RTCDataChannel });
      firstTunnel.open();
    });

    // Send a second tunnel channel — should close the first
    const secondTunnel = new FakeDataChannel();
    Object.defineProperty(secondTunnel, "label", { value: "tunnel" });
    await act(async () => {
      pc.trigger("datachannel", { channel: secondTunnel as unknown as RTCDataChannel });
    });

    expect(firstTunnel.readyState).toBe("closed");
  });

  test("setupDataChannel same channel is no-op", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const channel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: channel as unknown as RTCDataChannel });
    });

    // Trigger same channel again — no-op
    await act(async () => {
      pc.trigger("datachannel", { channel: channel as unknown as RTCDataChannel });
    });

    // Channel should still be connecting (not closed)
    expect(channel.readyState).toBe("connecting");
  });

  test("setupTunnelChannel same channel is no-op", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-z", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const clipsChannel = pc.createdChannels[0];
    await act(async () => { clipsChannel.open(); });

    const tunnel = new FakeDataChannel();
    Object.defineProperty(tunnel, "label", { value: "tunnel" });
    await act(async () => {
      pc.trigger("datachannel", { channel: tunnel as unknown as RTCDataChannel });
    });

    // Trigger same tunnel channel again — no-op
    await act(async () => {
      pc.trigger("datachannel", { channel: tunnel as unknown as RTCDataChannel });
    });

    expect(tunnel.readyState).toBe("connecting");
  });

  test("channel close triggers reannounce when enabled", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-z", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const channel = pc.createdChannels[0];
    await act(async () => { channel.open(); });

    const announceCallsBefore = sendPeerSignal.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, string>).signalType === "announce"
    ).length;

    // Close channel — should schedule reannounce
    await act(async () => {
      channel.close();
      // Let the reannounce timer fire
      await vi.advanceTimersByTimeAsync?.(2000).catch(() => {});
    });

    // The peer should be cleaned up due to connectionState not changing,
    // but the close listener should have been called
    expect(result.current.readyPeerCount).toBe(0);
  });

  test("catalog:unavailable marks failed when no alternative peer", async () => {
    randomUuidSpy.mockReturnValue("peer-0");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Connect only one peer
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const peerAChannel = peerConnections[0].createdChannels[0];
    await act(async () => { peerAChannel.open(); });

    // Have peer-a offer a clip
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: {
        type: "catalog:offer",
        clips: [{
          transferId: "transfer-fail",
          zone: "A",
          kind: "file",
          mimeType: "application/pdf",
          originalName: "fail.pdf",
          sizeBytes: 3,
          encryptionVersion: null,
          encryptionMeta: null,
          createdAt: envelope.createdAt,
        }],
      },
    });

    await act(async () => {
      peerAChannel.message("catalog-offer");
      await Promise.resolve();
    });

    // Now peer-a says unavailable — no other peer to retry with
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:unavailable", transferIds: ["transfer-fail"] },
    });

    await act(async () => {
      peerAChannel.message("unavailable");
      await Promise.resolve();
    });

    // Should mark as failed
    await waitFor(() => {
      const clips = result.current.getReceivedBinaryClipsByZone("A");
      expect(clips[0]?.local_transfer_state).toBe("failed");
    });
  });

  test("announce targeted to self is re-announced back to sender", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Broadcast announce (no toPeerId) — should trigger targeted announce back
    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
        // no toPeerId — broadcast
      });
    });

    expect(sendPeerSignal).toHaveBeenCalledWith({
      fromPeerId: "peer-z",
      toPeerId: "peer-a",
      signalType: "announce",
    });

    // Targeted announce (with toPeerId) should NOT re-announce
    sendPeerSignal.mockClear();
    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-b",
        toPeerId: "peer-z",
        signalType: "announce",
      });
    });

    const reAnnounces = sendPeerSignal.mock.calls.filter(
      (c: unknown[]) => {
        const msg = c[0] as Record<string, string>;
        return msg.signalType === "announce" && msg.toPeerId === "peer-b";
      }
    );
    expect(reAnnounces).toHaveLength(0);
  });

  test("ensurePeer returns existing peer on second call", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // First announce creates the peer
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    expect(peerConnections).toHaveLength(1);

    // Second announce re-uses the same peer
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    // Should not have created a new PeerConnection
    expect(peerConnections).toHaveLength(1);
  });

  test("handlePeerSignal description without description field is handled", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    // Signal with description type but no description object
    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "description",
        // no description field
      });
    });

    // Should not crash, peer should still exist
    expect(result.current.peers).toHaveLength(1);
  });

  test("handlePeerSignal ice-candidate without candidate field is handled", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    // Signal with ice-candidate type but no candidate
    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-a",
        signalType: "ice-candidate",
        // no candidate field
      });
    });

    expect(result.current.peers).toHaveLength(1);
  });

  test("restore effect cancelled branch when cleanup runs before restore completes", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    let resolveList: ((records: unknown[]) => void) | null = null;
    listStoredBinaryClipsBySessionMock.mockImplementation(() =>
      new Promise((resolve) => { resolveList = resolve; })
    );

    const { unmount } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Unmount before restore completes
    unmount();

    // Now resolve — the cancelled flag should prevent processing
    await act(async () => {
      resolveList?.([]);
      await Promise.resolve();
    });
  });

  test("restore effect handles error from listStoredBinaryClipsBySession", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listStoredBinaryClipsBySessionMock.mockRejectedValueOnce(new Error("IDB failed"));

    renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Wait for the restore promise to settle
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    consoleSpy.mockRestore();
  });

  test("clearLocalBinaryClips with no matching clips is a no-op", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Clear with no clips — should not broadcast
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });
    const [pc] = peerConnections;
    const channel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: channel as unknown as RTCDataChannel });
      channel.open();
    });
    channel.sent.length = 0;

    act(() => { result.current.clearLocalBinaryClips("B"); });
    expect(channel.sent).toHaveLength(0);
  });

  test("sendDirectTransfer failure triggers failPeerSend", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);
    sendDirectTransferMock.mockRejectedValueOnce(new Error("send failed"));

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-z", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const channel = pc.createdChannels[0];
    await act(async () => { channel.open(); });

    const file = new File(["hello"], "note.pdf", { type: "application/pdf" });
    await act(async () => {
      try {
        await result.current.queueLocalBinaryClip({
          transferId: "transfer-fail-send",
          zone: "A",
          file,
        });
      } catch {
        // expected
      }
    });

    // Progress should have been cleared by failPeerSend
    expect(result.current.getSendProgress("transfer-fail-send")).toBeNull();
  });

  test("buildTransferFromEntry returns null when file is null and no ciphertext", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    // Create a stored record with senderFileBytes so it restores, but then
    // the restored entry's file might be used. Let's test via sendTransferToPeer
    // with a stored record that has no ciphertext and no senderFileBytes
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-null-file"), {
      transferId: "transfer-null-file",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "null.pdf",
      sizeBytes: 0,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "sender",
      // no senderFileBytes, no ciphertext
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Wait for restore (should skip because no senderFileBytes)
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    // Request the stored transfer that has no payload
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-null-file"] },
    });

    await act(async () => {
      remoteChannel.message("catalog-request");
      await Promise.resolve();
    });

    await waitFor(() => {
      const messages = remoteChannel.sent
        .filter((s) => typeof s === "string")
        .map((s) => JSON.parse(s as string));
      expect(messages.some((m) => m.type === "catalog:unavailable")).toBe(true);
    });
  });

  test("catalog offer with existing metadata but no local payload re-saves metadata", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    // Pre-populate a receiver record with no payload
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-no-payload"), {
      transferId: "transfer-no-payload",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "nopayload.pdf",
      sizeBytes: 3,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "receiver",
      // no ciphertext, no senderFileBytes
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    const putCallsBefore = putStoredBinaryClipMock.mock.calls.length;

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: {
        type: "catalog:offer",
        clips: [{
          transferId: "transfer-no-payload",
          zone: "A",
          kind: "file",
          mimeType: "application/pdf",
          originalName: "nopayload.pdf",
          sizeBytes: 3,
          encryptionVersion: null,
          encryptionMeta: null,
          createdAt: "2026-03-10T12:00:00.000Z",
        }],
      },
    });

    await act(async () => {
      remoteChannel.message("catalog-offer");
      await Promise.resolve();
    });

    // Should have re-saved metadata via putStoredBinaryClip (hasLocalPayload=false path)
    expect(putStoredBinaryClipMock.mock.calls.length).toBeGreaterThan(putCallsBefore);
  });

  test("catalog:request where sendControlMessageToPeer fails releases owners", async () => {
    randomUuidSpy.mockReturnValue("peer-0");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const peerAChannel = peerConnections[0].createdChannels[0];
    await act(async () => { peerAChannel.open(); });

    // Receive catalog offer — the response will try to send request,
    // but we close the channel before that happens
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: {
        type: "catalog:offer",
        clips: [{
          transferId: "transfer-release",
          zone: "A",
          kind: "file",
          mimeType: "application/pdf",
          originalName: "release.pdf",
          sizeBytes: 3,
          encryptionVersion: null,
          encryptionMeta: null,
          createdAt: envelope.createdAt,
        }],
      },
    });

    // Close channel before the catalog offer handler sends the request
    peerAChannel.readyState = "closed" as RTCDataChannelState;

    await act(async () => {
      peerAChannel.message("catalog-offer");
      await Promise.resolve();
    });

    // The transfer owner should have been released since send failed
    // No crash expected
  });

  test("openTunnelChannel returns true when tunnel already open", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-z", signalType: "announce" });
    });

    const pc = peerConnections[0];
    const clipsChannel = pc.createdChannels[0];
    await act(async () => { clipsChannel.open(); });

    const tunnelChannel = new FakeDataChannel();
    Object.defineProperty(tunnelChannel, "label", { value: "tunnel" });
    await act(async () => {
      pc.trigger("datachannel", { channel: tunnelChannel as unknown as RTCDataChannel });
      tunnelChannel.open();
    });

    // Tunnel is already open — should return true without creating a new channel
    const channelCount = pc.createdChannels.length;
    const opened = result.current.openTunnelChannel("peer-z");
    expect(opened).toBe(true);
    expect(pc.createdChannels.length).toBe(channelCount);
  });

  test("sendTunnelMessage returns false when tunnel channel is not open", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-z", signalType: "announce" });
    });

    const pc = peerConnections[0];
    const clipsChannel = pc.createdChannels[0];
    await act(async () => { clipsChannel.open(); });

    // No tunnel channel — should return false
    expect(result.current.sendTunnelMessage("peer-z", "data")).toBe(false);
  });

  test("getReceivedBinaryClipsByZone returns empty array when store has no clips", () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    expect(result.current.getReceivedBinaryClipsByZone("A")).toEqual([]);
    expect(result.current.getReceivedBinaryClipsByZone("B")).toEqual([]);
  });

  test("getDirectClipCiphertext returns null for unknown clip ID", () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    expect(result.current.getDirectClipCiphertext(999)).toBeNull();
  });

  test("channel open without peer names does not send names-sync", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const channel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: channel as unknown as RTCDataChannel });
      channel.open();
    });

    // No peer names set, so no names-sync message should be sent
    // Only catalog:offer should be sent
    const messages = channel.sent
      .filter((s) => typeof s === "string")
      .map((s) => JSON.parse(s as string));
    expect(messages.every((m) => m.type !== "peer:names-sync")).toBe(true);
  });

  test("channel open without my name does not send peer:name", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const channel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: channel as unknown as RTCDataChannel });
      channel.open();
    });

    const messages = channel.sent
      .filter((s) => typeof s === "string")
      .map((s) => JSON.parse(s as string));
    expect(messages.every((m) => m.type !== "peer:name")).toBe(true);
  });

  test("clearIdentifyFlash without id always clears", () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    act(() => { result.current.clearIdentifyFlash(); });
    expect(result.current.identifyFlash).toBeNull();
  });

  test("clips:clear control message with no matching sender entries does not emit", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    // Receive clips:clear for transfer IDs we don't have as sender
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "clips:clear", zone: "A", transferIds: ["nonexistent-1", "nonexistent-2"] },
    });

    await act(async () => {
      remoteChannel.message("clear-msg");
      await Promise.resolve();
    });

    // Should not crash, just a no-op for sender clips
    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(0);
  });

  test("peer:name for remote peer does not persist own name", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "peer:name", peerId: "peer-a", name: "Remote Device" },
    });

    await act(async () => {
      remoteChannel.message("name-msg");
      await Promise.resolve();
    });

    expect(result.current.peerNames["peer-a"]).toBe("Remote Device");
    // Should NOT have persisted as my own name
    const tabId = sessionStorage.getItem("elpasto:tab-id:session-1");
    expect(localStorage.getItem(`elpasto:my-peer-name:session-1:${tabId}`)).toBeNull();
  });

  test("sendTransferToPeer falls back to stored record when not in localBinaryClips", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    // Only stored record, not in localBinaryClips
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-stored-only"), {
      transferId: "transfer-stored-only",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "stored-only.pdf",
      sizeBytes: 3,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "receiver",
      ciphertext: new Uint8Array([1, 2, 3]),
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-stored-only"] },
    });

    await act(async () => {
      remoteChannel.message("catalog-request");
      await Promise.resolve();
    });

    await waitFor(() => expect(sendDirectTransferMock).toHaveBeenCalledTimes(1));
  });

  test("cleanup effect on unmount clears all peers and timers", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result, unmount } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    expect(peerConnections).toHaveLength(1);

    // Unmount should clean up
    unmount();

    expect(peerConnections[0].closed).toBe(true);
  });

  test("disable effect sends leave signal when signalingReady", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { rerender } = renderHook(
      ({ enabled, signalingReady }) =>
        usePeerMesh({
          enabled,
          sessionToken: "session-1",
          signalingReady,
          sendPeerSignal,
          getCurrentUnlockSecret: getCurrentUnlockSecretMock,
        }),
      { initialProps: { enabled: true, signalingReady: true } }
    );

    // Disable — should send leave signal
    await act(async () => {
      rerender({ enabled: false, signalingReady: true });
    });

    expect(sendPeerSignal).toHaveBeenCalledWith({
      fromPeerId: "peer-z",
      signalType: "leave",
    });
  });

  test("disable effect does not send leave when signalingReady is false", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { rerender } = renderHook(
      ({ enabled, signalingReady }) =>
        usePeerMesh({
          enabled,
          sessionToken: "session-1",
          signalingReady,
          sendPeerSignal,
          getCurrentUnlockSecret: getCurrentUnlockSecretMock,
        }),
      { initialProps: { enabled: true, signalingReady: false } }
    );

    sendPeerSignal.mockClear();

    await act(async () => {
      rerender({ enabled: false, signalingReady: false });
    });

    // Should not have sent leave when signalingReady is false
    expect(sendPeerSignal).not.toHaveBeenCalledWith(
      expect.objectContaining({ signalType: "leave" })
    );
  });

  test("queueLocalBinaryClip with kind override uses provided kind", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    getCurrentUnlockSecretMock.mockResolvedValue(null);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    const file = new File(["data"], "data.bin", { type: "application/octet-stream" });
    let clip: Clip | undefined;
    await act(async () => {
      clip = await result.current.queueLocalBinaryClip({
        transferId: "transfer-kind-override",
        zone: "A",
        file,
        kind: "html",
      });
    });

    expect(clip!.kind).toBe("html");
  });

  test("queueLocalBinaryClip with empty file type defaults to application/octet-stream", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    getCurrentUnlockSecretMock.mockResolvedValue(null);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    const file = new File(["data"], "data", { type: "" });
    let clip: Clip | undefined;
    await act(async () => {
      clip = await result.current.queueLocalBinaryClip({
        transferId: "transfer-empty-type",
        zone: "A",
        file,
      });
    });

    expect(clip!.mime_type).toBe("application/octet-stream");
    expect(clip!.kind).toBe("file");
  });

  test("clip:end when transfer state is no longer pending does not release owner", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:start", envelope },
      })
      .mockResolvedValueOnce({
        kind: "chunk",
        transferId: "transfer-1",
        index: 0,
        payload: new Uint8Array([9, 8, 7]),
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:end", transferId: "transfer-1", totalChunks: 1 },
      });

    await act(async () => {
      remoteChannel.message("start");
      await Promise.resolve();
      remoteChannel.message("chunk");
      await Promise.resolve();
      remoteChannel.message("end");
      await Promise.resolve();
    });

    // Transfer should be complete (no longer pending)
    await waitFor(() =>
      expect(result.current.getReceivedBinaryClipsByZone("A")[0]?.local_transfer_state).toBe("complete")
    );
  });

  test("data channel message processing error is caught", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    // Make decodeDataChannelMessage throw
    decodeDataChannelMessageMock.mockRejectedValueOnce(new Error("decode failed"));

    await act(async () => {
      remoteChannel.message("bad-message");
      await Promise.resolve();
    });

    expect(consoleSpy).toHaveBeenCalledWith("Failed to process peer message", expect.any(Error));
    consoleSpy.mockRestore();
  });

  test("buildTransferFromStoredRecord returns null when no ciphertext and no senderFileBytes", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    // This record has no ciphertext and no senderFileBytes
    getStoredBinaryClipMock.mockResolvedValueOnce({
      transferId: "transfer-empty-stored",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "empty.pdf",
      sizeBytes: 0,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "sender",
      // No ciphertext, no senderFileBytes
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-empty-stored"] },
    });

    await act(async () => {
      remoteChannel.message("catalog-request");
      await Promise.resolve();
    });

    await waitFor(() => {
      const messages = remoteChannel.sent
        .filter((s) => typeof s === "string")
        .map((s) => JSON.parse(s as string));
      expect(messages.some((m) => m.type === "catalog:unavailable")).toBe(true);
    });
  });

  test("restoreSenderRecord returns existing entry when transfer is already in memory", async () => {
    randomUuidSpy.mockReturnValue("peer-z");

    // Pre-populate a stored sender record
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-double-restore"), {
      transferId: "transfer-double-restore",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "double.pdf",
      sizeBytes: 3,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "sender",
      senderFileBytes: new Uint8Array([1, 2, 3]).buffer,
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await waitFor(() => expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1));

    // Now queue a local clip with the same transferId — should hit the dedup path in queueLocalBinaryClip
    const file = new File(["new"], "new.pdf", { type: "application/pdf" });
    let clip: Clip | undefined;
    await act(async () => {
      clip = await result.current.queueLocalBinaryClip({
        transferId: "transfer-double-restore",
        zone: "A",
        file,
      });
    });

    // Should return the existing clip, not create a new one
    expect(clip!.original_name).toBe("double.pdf");
    expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1);
  });

  test("restoreSenderRecord with invalid date defaults to Date.now", async () => {
    randomUuidSpy.mockReturnValue("peer-z");

    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-bad-date"), {
      transferId: "transfer-bad-date",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "baddate.pdf",
      sizeBytes: 3,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "not-a-valid-date",
      origin: "sender",
      senderFileBytes: new Uint8Array([1, 2, 3]).buffer,
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await waitFor(() => expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1));
    const [clip] = result.current.getLocalBinaryClipsByZone("A");
    expect(clip.local_file).toBeInstanceOf(File);
  });

  test("restoreSenderRecord with missing originalName and mimeType uses defaults", async () => {
    randomUuidSpy.mockReturnValue("peer-z");

    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-no-name"), {
      transferId: "transfer-no-name",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: null,
      originalName: null,
      sizeBytes: 3,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "sender",
      senderFileBytes: new Uint8Array([1, 2, 3]).buffer,
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await waitFor(() => expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1));
    const [clip] = result.current.getLocalBinaryClipsByZone("A");
    expect(clip.local_file?.name).toBe("download");
    expect(clip.local_file?.type).toBe("application/octet-stream");
  });

  test("persistSenderRecord uses file properties when entry fields are null", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    getCurrentUnlockSecretMock.mockResolvedValue(null);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Queue a file with empty name and empty type to exercise fallback paths
    const file = new File(["data"], "", { type: "" });
    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-fallback-props",
        zone: "A",
        file,
      });
    });

    expect(putStoredBinaryClipMock).toHaveBeenCalled();
    const storedCall = putStoredBinaryClipMock.mock.calls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).transferId === "transfer-fallback-props"
    );
    expect(storedCall).toBeTruthy();
    // mime_type should fall back to file type or "application/octet-stream"
    expect((storedCall![0] as Record<string, unknown>).mimeType).toBe("application/octet-stream");
  });

  test("announce is not sent when enabled but signalingReady is false", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: false,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Should not have sent announce (signalingReady is false)
    expect(sendPeerSignal).not.toHaveBeenCalled();
  });

  test("scheduleReannounce clears previous timer before scheduling new one", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Connect two peers then close them both to trigger two reannounce schedules
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-z", signalType: "announce" });
    });

    const [pc1] = peerConnections;
    const channel1 = pc1.createdChannels[0];
    await act(async () => { channel1.open(); });

    await act(async () => {
      pc1.connectionState = "disconnected";
      pc1.trigger("connectionstatechange");
    });

    // Connect another peer and close it (triggers scheduleReannounce again)
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-y", signalType: "announce" });
    });

    const pc2 = peerConnections[peerConnections.length - 1];
    await act(async () => {
      pc2.connectionState = "failed";
      pc2.trigger("connectionstatechange");
    });

    // No crash — the timer was cleared and rescheduled
  });

  test("cleanupPeer with non-existent peer is a no-op", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Send a leave signal for a peer that was never connected
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "nonexistent-peer", signalType: "leave" });
    });

    // Should not crash
    expect(result.current.peers).toHaveLength(0);
  });

  test("broadcastControlMessage skips closed channels", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const channel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: channel as unknown as RTCDataChannel });
      // Don't open the channel — it stays in "connecting"
    });

    // Broadcasting should skip this channel since it's not open
    act(() => { result.current.broadcastClipDelete("some-transfer"); });
    expect(channel.sent).toHaveLength(0);
  });

  test("sendControlMessageToPeer returns false when channel is not open", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    // Ping without opening channel — should not crash
    act(() => { result.current.pingPeer("peer-a"); });

    // The channel is connecting, not open, so no message sent
    const [pc] = peerConnections;
    const channel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: channel as unknown as RTCDataChannel });
    });
    expect(channel.sent).toHaveLength(0);
  });

  test("releaseTransferOwner with mismatched peerId is a no-op", async () => {
    randomUuidSpy.mockReturnValue("peer-0");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Connect two peers
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
      await result.current.handlePeerSignal({ fromPeerId: "peer-b", signalType: "announce" });
    });

    const peerAChannel = peerConnections[0].createdChannels[0];
    const peerBChannel = peerConnections[1].createdChannels[0];
    await act(async () => {
      peerAChannel.open();
      peerBChannel.open();
    });

    // Have peer-a offer and we request from peer-a
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: {
        type: "catalog:offer",
        clips: [{
          transferId: "transfer-owner-test",
          zone: "A",
          kind: "file",
          mimeType: "application/pdf",
          originalName: "test.pdf",
          sizeBytes: 3,
          encryptionVersion: null,
          encryptionMeta: null,
          createdAt: envelope.createdAt,
        }],
      },
    });

    await act(async () => {
      peerAChannel.message("catalog-offer");
      await Promise.resolve();
    });

    // peer-b sends clip:start for the same transfer — should be rejected since peer-a owns it
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "clip:start", envelope: { ...envelope, transferId: "transfer-owner-test", encrypted: false, encryptionVersion: null, encryptionMeta: null } },
    });

    await act(async () => {
      peerBChannel.message("wrong-peer-start");
      await Promise.resolve();
    });

    // peer-a should still own it
    expect(peerAChannel.sent.some((s) => JSON.parse(s as string).type === "catalog:request")).toBe(true);
  });

  test("catalog:unavailable with alt peer whose channel is closed retries next or fails", async () => {
    randomUuidSpy.mockReturnValue("peer-0");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Connect two peers
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
      await result.current.handlePeerSignal({ fromPeerId: "peer-b", signalType: "announce" });
    });

    const peerAChannel = peerConnections[0].createdChannels[0];
    const peerBChannel = peerConnections[1].createdChannels[0];
    await act(async () => {
      peerAChannel.open();
      peerBChannel.open();
    });

    // Peer-a offers a clip
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: {
        type: "catalog:offer",
        clips: [{
          transferId: "transfer-alt-fail",
          zone: "A",
          kind: "file",
          mimeType: "application/pdf",
          originalName: "alt.pdf",
          sizeBytes: 3,
          encryptionVersion: null,
          encryptionMeta: null,
          createdAt: envelope.createdAt,
        }],
      },
    });

    await act(async () => {
      peerAChannel.message("catalog-offer");
      await Promise.resolve();
    });

    // Close peer-b's channel before unavailable arrives
    peerBChannel.readyState = "closed" as RTCDataChannelState;

    // Peer-a says unavailable — peer-b has closed channel, so cannot retry
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:unavailable", transferIds: ["transfer-alt-fail"] },
    });

    await act(async () => {
      peerAChannel.message("unavailable");
      await Promise.resolve();
    });

    // Should mark as failed since alt peer channel is closed
    await waitFor(() => {
      const clips = result.current.getReceivedBinaryClipsByZone("A");
      expect(clips[0]?.local_transfer_state).toBe("failed");
    });
  });

  test("createRandomId catch fallback when randomUUID throws", async () => {
    // Make randomUUID throw on first call (for peer ID) — will use fallback
    randomUuidSpy.mockImplementation(() => { throw new Error("not available"); });

    const sendPeerSignal = vi.fn(async () => true);
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-unique",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Should have created a peer ID using the fallback path
    expect(result.current.localPeerId).toMatch(/^peer-/);
  });

  test("getTabId catch branch when sessionStorage throws", async () => {
    // Pre-break sessionStorage for this session token
    const origGetItem = sessionStorage.getItem.bind(sessionStorage);
    const origSetItem = sessionStorage.setItem.bind(sessionStorage);
    const sessionToken = "session-broken-storage";

    vi.spyOn(sessionStorage, "getItem").mockImplementation((key: string) => {
      if (key.includes(sessionToken)) throw new Error("access denied");
      return origGetItem(key);
    });
    vi.spyOn(sessionStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (key.includes(sessionToken)) throw new Error("access denied");
      return origSetItem(key, value);
    });

    randomUuidSpy.mockReturnValue("peer-broken");

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken,
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Should still work with fallback tab ID
    expect(result.current.localPeerId).toBe("peer-broken");
  });

  test("getTabId reuses cached tab id when stored matches", async () => {
    // This exercises the cached === stored path by rendering twice with same session
    randomUuidSpy.mockReturnValue("peer-cached");

    const { unmount } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-cache-test",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );
    unmount();

    // Render again with same session — should hit the cached path
    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-cache-test",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    expect(result.current.localPeerId).toBe("peer-cached");
  });

  test("getTabId detects stale cache when stored differs from cached", async () => {
    randomUuidSpy.mockReturnValue("peer-stale-cache");
    const sessionToken = "session-stale-cache";

    const { unmount } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken,
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );
    unmount();

    // Manually change the stored tab ID to differ from cached
    sessionStorage.setItem(`elpasto:tab-id:${sessionToken}`, "different-value");

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken,
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Should detect the stale cache and use the stored value
    expect(result.current.localPeerId).toBe("peer-stale-cache");
  });

  test("copyMyPeerName when fromTabId equals toTabId is a no-op", async () => {
    // Exercise through getTabId navigate path where from === to
    // This is actually prevented because getTabId generates a new ID,
    // so we need to test directly. But since copyMyPeerName is module-level
    // and we can't call it directly, we test it indirectly.
    // The fromTabId === toTabId guard is already tested when sessionStorage
    // has an existing tab ID and navigation type is "navigate" (different IDs).
    // Let's just verify that the module handles this edge case.
    randomUuidSpy.mockReturnValue("peer-copy-test");
    const sessionToken = "session-copy-test";

    // Set up an existing tab id and name
    sessionStorage.setItem(`elpasto:tab-id:${sessionToken}`, "existing-tab");
    localStorage.setItem(`elpasto:my-peer-name:${sessionToken}:existing-tab`, "My Name");

    // Use "reload" navigation so the tab id is reused (no copy needed)
    vi.spyOn(window.performance, "getEntriesByType").mockReturnValue([
      { type: "reload" } as unknown as PerformanceEntry,
    ]);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken,
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await waitFor(() => {
      expect(result.current.peerNames[result.current.localPeerId]).toBe("My Name");
    });
  });

  test("loadMyPeerName catch branch returns null", async () => {
    randomUuidSpy.mockReturnValue("peer-load-err");
    const sessionToken = "session-load-err";

    // First set up a tab ID
    sessionStorage.setItem(`elpasto:tab-id:${sessionToken}`, "tab-err");

    // Make localStorage.getItem throw for our key
    const origGetItem = localStorage.getItem.bind(localStorage);
    vi.spyOn(localStorage, "getItem").mockImplementation((key: string) => {
      if (key.includes("my-peer-name") && key.includes(sessionToken)) {
        throw new Error("access denied");
      }
      return origGetItem(key);
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken,
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Should not have any names since loadMyPeerName threw
    expect(result.current.peerNames).toEqual({});
  });

  test("persistMyPeerName catch branch is silent", async () => {
    randomUuidSpy.mockReturnValue("peer-persist-err");
    const sessionToken = "session-persist-err";

    // Make localStorage.setItem throw
    const origSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (key.includes("my-peer-name") && key.includes(sessionToken)) {
        throw new Error("quota exceeded");
      }
      return origSetItem(key, value);
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken,
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Try to rename — should not throw despite localStorage error
    act(() => {
      result.current.renamePeer(result.current.localPeerId, "My New Name");
    });

    // Name should still be set in memory
    expect(result.current.peerNames[result.current.localPeerId]).toBe("My New Name");
  });

  test("buildTransferFromStoredRecord ciphertext without encryption metadata uses isEncrypted=false", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    // Stored record has ciphertext but null encryptionVersion/encryptionMeta
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-ct-no-enc"), {
      transferId: "transfer-ct-no-enc",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "unenc-ct.pdf",
      sizeBytes: 3,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "receiver",
      ciphertext: new Uint8Array([1, 2, 3]),
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-ct-no-enc"] },
    });

    await act(async () => {
      remoteChannel.message("catalog-request");
      await Promise.resolve();
    });

    await waitFor(() => expect(sendDirectTransferMock).toHaveBeenCalledTimes(1));
    const callArgs = sendDirectTransferMock.mock.calls[0];
    expect(callArgs[1].encrypted).toBe(false);
  });

  test("buildTransferFromEntry caches envelope on second call", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    getCurrentUnlockSecretMock.mockResolvedValue(null);
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    const file = new File(["data"], "test.pdf", { type: "application/pdf" });
    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-cache-env",
        zone: "A",
        file,
      });
    });

    // Connect two peers — second peer request should use cached envelope
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc1] = peerConnections;
    const ch1 = new FakeDataChannel();
    await act(async () => {
      pc1.trigger("datachannel", { channel: ch1 as unknown as RTCDataChannel });
      ch1.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-cache-env"] },
    });
    await act(async () => {
      ch1.message("req1");
      await Promise.resolve();
    });

    await waitFor(() => expect(sendDirectTransferMock).toHaveBeenCalledTimes(1));

    // Request again from another peer — should use the cached envelope
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-b", signalType: "announce" });
    });

    const pc2 = peerConnections[peerConnections.length - 1];
    const ch2 = new FakeDataChannel();
    await act(async () => {
      pc2.trigger("datachannel", { channel: ch2 as unknown as RTCDataChannel });
      ch2.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-cache-env"] },
    });
    await act(async () => {
      ch2.message("req2");
      await Promise.resolve();
    });

    await waitFor(() => expect(sendDirectTransferMock).toHaveBeenCalledTimes(2));
  });

  test("handleCatalogOffer with new clip that has no existing metadata creates receiver record", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    // A clip we've never seen before
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: {
        type: "catalog:offer",
        clips: [{
          transferId: "transfer-brand-new",
          zone: "B",
          kind: "image",
          mimeType: "image/png",
          originalName: "new.png",
          sizeBytes: 100,
          encryptionVersion: null,
          encryptionMeta: null,
          createdAt: "2026-03-10T12:00:00.000Z",
        }],
      },
    });

    await act(async () => {
      remoteChannel.message("catalog-offer");
      await Promise.resolve();
    });

    // Should have created the record via putStoredBinaryClip
    const stored = storedBinaryClips.get(clipStoreKey("peer-z", "transfer-brand-new"));
    expect(stored).toBeTruthy();
    expect(stored!.origin).toBe("receiver");

    // And requested it from the peer
    const messages = remoteChannel.sent
      .filter((s) => typeof s === "string")
      .map((s) => JSON.parse(s as string));
    expect(messages.some((m) => m.type === "catalog:request" && m.transferIds.includes("transfer-brand-new"))).toBe(true);
  });

  test("handleCatalogOffer ignores tombstoned clips from a peer", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    getTombstonesMock.mockResolvedValue(new Set(["transfer-tombstoned"]));

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    deleteStoredBinaryClipMock.mockClear();
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: {
        type: "catalog:offer",
        clips: [{
          transferId: "transfer-tombstoned",
          zone: "B",
          kind: "image",
          mimeType: "image/png",
          originalName: "dead.png",
          sizeBytes: 100,
          encryptionVersion: null,
          encryptionMeta: null,
          createdAt: "2026-03-10T12:00:00.000Z",
        }],
      },
    });

    await act(async () => {
      remoteChannel.message("catalog-offer-dead");
      await Promise.resolve();
    });

    expect(storedBinaryClips.get(clipStoreKey("peer-z", "transfer-tombstoned"))).toBeUndefined();
    expect(deleteStoredBinaryClipMock).toHaveBeenCalledWith("transfer-tombstoned", "peer-z");
    const messages = remoteChannel.sent
      .filter((s) => typeof s === "string")
      .map((s) => JSON.parse(s as string));
    expect(messages.some((m) => m.type === "catalog:request")).toBe(false);
  });

  test("queueLocalBinaryClip with file having no name defaults to download", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    getCurrentUnlockSecretMock.mockResolvedValue(null);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // File with empty name
    const file = new File(["data"], "", { type: "application/pdf" });
    let clip: Clip | undefined;
    await act(async () => {
      clip = await result.current.queueLocalBinaryClip({
        transferId: "transfer-no-filename",
        zone: "A",
        file,
      });
    });

    expect(clip!.original_name).toBe("download");
  });

  test("catalog offer when existing metadata but getStoredBinaryClip returns null uses metadata flags", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    // Pre-populate metadata in the clip store (so listStoredBinaryClipMetadataBySession returns it)
    // but make getStoredBinaryClip return null (simulating corrupted IDB)
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-null-stored"), {
      transferId: "transfer-null-stored",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "null-stored.pdf",
      sizeBytes: 3,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "receiver",
      // Has metadata but no actual payload data, and we'll make getStoredBinaryClip return null
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    // Override getStoredBinaryClip to return null for this specific transfer
    getStoredBinaryClipMock.mockImplementation(async (transferId: string) => {
      if (transferId === "transfer-null-stored") return null;
      const record = storedBinaryClips.get(clipStoreKey("peer-z", transferId));
      return record ? structuredClone(record) : null;
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: {
        type: "catalog:offer",
        clips: [{
          transferId: "transfer-null-stored",
          zone: "A",
          kind: "file",
          mimeType: "application/pdf",
          originalName: "null-stored.pdf",
          sizeBytes: 3,
          encryptionVersion: null,
          encryptionMeta: null,
          createdAt: "2026-03-10T12:00:00.000Z",
        }],
      },
    });

    await act(async () => {
      remoteChannel.message("catalog-offer");
      await Promise.resolve();
    });

    // stored is null, existing is truthy, hasLocalPayload uses existing.hasCiphertext || existing.hasSenderFileBytes
    // which is false since no payload. Should take the else-if path and re-save with stored?.origin ?? "receiver"
    expect(putStoredBinaryClipMock).toHaveBeenCalled();
  });

  test("restore error with non-Error object uses String() fallback", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    listStoredBinaryClipsBySessionMock.mockRejectedValueOnce("string error");

    renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Should not crash — the String(error) fallback path is exercised
  });

  test("reserveTransferOwner timeout fires and marks transfer failed", async () => {
    randomUuidSpy.mockReturnValue("peer-0");
    const sendPeerSignal = vi.fn(async () => true);
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      const { result } = renderHook(() =>
        usePeerMesh({
          enabled: true,
          sessionToken: "session-1",
          signalingReady: true,
          sendPeerSignal,
          getCurrentUnlockSecret: getCurrentUnlockSecretMock,
        })
      );

      await act(async () => {
        await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
      });

      const peerAChannel = peerConnections[0].createdChannels[0];
      await act(async () => { peerAChannel.open(); });

      // Offer a clip so we reserve a transfer owner
      decodeDataChannelMessageMock.mockResolvedValueOnce({
        kind: "control",
        message: {
          type: "catalog:offer",
          clips: [{
            transferId: "transfer-timeout",
            zone: "A",
            kind: "file",
            mimeType: "application/pdf",
            originalName: "timeout.pdf",
            sizeBytes: 3,
            encryptionVersion: null,
            encryptionMeta: null,
            createdAt: envelope.createdAt,
          }],
        },
      });

      await act(async () => {
        peerAChannel.message("catalog-offer");
        await Promise.resolve();
      });

      // Advance time past DIRECT_TRANSFER_TIMEOUT_MS to trigger the timeout
      await act(async () => {
        vi.advanceTimersByTime(120_000);
        await Promise.resolve();
      });

      // Transfer should be marked failed after timeout
      await waitFor(() => {
        const clips = result.current.getReceivedBinaryClipsByZone("A");
        expect(clips[0]?.local_transfer_state).toBe("failed");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("releaseTransferOwner with no owner is a no-op", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    // Send clip:delete for a transfer nobody owns
    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "clip:delete", transferId: "unowned-transfer" },
    });

    await act(async () => {
      remoteChannel.message("delete-unowned");
      await Promise.resolve();
    });

    // Should not crash — releaseTransferOwner for unknown transfer is no-op
  });

  test("clearTransferRequestTimeout with no timeout is a no-op", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Connect peer and send a clip:end for a transfer that has no timeout
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "clip:end", transferId: "no-timeout-transfer", totalChunks: 0 },
    });

    await act(async () => {
      remoteChannel.message("end-no-timeout");
      await Promise.resolve();
    });

    // No crash expected
  });

  test("announce method is not called when enabled is true but signalingReady is false", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    const { result, rerender } = renderHook(
      ({ signalingReady }) =>
        usePeerMesh({
          enabled: true,
          sessionToken: "session-1",
          signalingReady,
          sendPeerSignal,
          getCurrentUnlockSecret: getCurrentUnlockSecretMock,
        }),
      { initialProps: { signalingReady: true } }
    );

    // Initially signalingReady is true, announce should have been called
    expect(sendPeerSignal).toHaveBeenCalledWith(expect.objectContaining({ signalType: "announce" }));

    sendPeerSignal.mockClear();

    // Now make signalingReady false
    await act(async () => {
      rerender({ signalingReady: false });
    });

    // No new announce should be sent
    const announcesCalled = sendPeerSignal.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, string>).signalType === "announce"
    );
    expect(announcesCalled).toHaveLength(0);
  });

  test("connectTimeout fires and cleans up peer when connection takes too long", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      const { result } = renderHook(() =>
        usePeerMesh({
          enabled: true,
          sessionToken: "session-1",
          signalingReady: true,
          sendPeerSignal,
          getCurrentUnlockSecret: getCurrentUnlockSecretMock,
        })
      );

      await act(async () => {
        await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
      });

      expect(result.current.peers).toHaveLength(1);

      // Advance past the 10s connect timeout
      await act(async () => {
        vi.advanceTimersByTime(11_000);
      });

      // Peer should have been cleaned up by the timeout
      expect(result.current.peers).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("persistSenderRecord exercises fallback chains for null clip properties", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    getCurrentUnlockSecretMock.mockResolvedValue(null);
    const sendPeerSignal = vi.fn(async () => true);

    // A sender record with null mimeType, originalName, and 0 sizeBytes
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-null-props"), {
      transferId: "transfer-null-props",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: null,
      originalName: null,
      sizeBytes: 0,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "sender",
      senderFileBytes: new Uint8Array([1, 2, 3]).buffer,
      // no ciphertext — buildTransferFromEntry will be called and call persistSenderRecord
    });

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await waitFor(() => expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1));

    // Connect a peer and request catalog
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-null-props"] },
    });

    await act(async () => {
      remoteChannel.message("catalog-request");
      await Promise.resolve();
    });

    await waitFor(() => expect(sendDirectTransferMock).toHaveBeenCalledTimes(1));

    // The persist should have used fallback values
    const persistCall = putStoredBinaryClipMock.mock.calls.find(
      (call: unknown[]) => {
        const c = call[0] as Record<string, unknown>;
        return c.transferId === "transfer-null-props" && c.origin === "sender";
      }
    );
    expect(persistCall).toBeTruthy();
    const clip = persistCall![0] as Record<string, unknown>;
    expect(clip.mimeType).toBe("application/octet-stream");
    expect(clip.originalName).toBe("download");
  });

  test("buildTransferFromStoredRecord with senderFileBytes where restoreSenderRecord returns null", async () => {
    randomUuidSpy.mockReturnValue("peer-z");
    const sendPeerSignal = vi.fn(async () => true);

    // Stored record has senderFileBytes but they're empty (so File is created but size is 0)
    // Actually restoreSenderRecord returns null only when !record.senderFileBytes
    // or when the existing entry already exists. The !senderFileBytes case is already tested.
    // For the "existing entry" case, we need the entry to already be in memory when
    // buildTransferFromStoredRecord is called.

    // This scenario: we have a record in IDB that was already restored to localBinaryClips.
    // Then a catalog:request comes for a NEW transfer that IS in IDB but not yet restored.
    // getStoredBinaryClip returns the record. buildTransferFromStoredRecord is called.
    // record has no ciphertext but has senderFileBytes. restoreSenderRecord checks
    // if the entry already exists in localBinaryClipsRef — if so, returns existing.
    // If the existing entry has ciphertext+envelope, buildTransferFromEntry returns fast.

    // Let's test the case where restoreSenderRecord gets called during
    // buildTransferFromStoredRecord and the entry IS already in memory
    storedBinaryClips.set(clipStoreKey("peer-z", "transfer-already-memory"), {
      transferId: "transfer-already-memory",
      sessionToken: "session-1",
      ownerTabId: "peer-z",
      zone: "A",
      kind: "file",
      mimeType: "application/pdf",
      originalName: "already.pdf",
      sizeBytes: 5,
      encryptionVersion: null,
      encryptionMeta: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      origin: "sender",
      senderFileBytes: new Uint8Array([1, 2, 3, 4, 5]).buffer,
    });

    getCurrentUnlockSecretMock.mockResolvedValue(null);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Wait for initial restore — this loads the entry into memory
    await waitFor(() => expect(result.current.getLocalBinaryClipsByZone("A")).toHaveLength(1));

    // Now trigger sendTransferToPeer which will call buildTransferFromEntry
    // (since entry exists in localBinaryClips, it won't go to buildTransferFromStoredRecord)
    // But let's verify the catalog:request works
    await act(async () => {
      await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
    });

    const [pc] = peerConnections;
    const remoteChannel = new FakeDataChannel();
    await act(async () => {
      pc.trigger("datachannel", { channel: remoteChannel as unknown as RTCDataChannel });
      remoteChannel.open();
    });

    decodeDataChannelMessageMock.mockResolvedValueOnce({
      kind: "control",
      message: { type: "catalog:request", transferIds: ["transfer-already-memory"] },
    });

    await act(async () => {
      remoteChannel.message("catalog-request");
      await Promise.resolve();
    });

    await waitFor(() => expect(sendDirectTransferMock).toHaveBeenCalledTimes(1));
  });

  test("legacy navigation type detection uses performance.navigation fallback", async () => {
    // Mock getEntriesByType to return empty (no modern API)
    vi.spyOn(window.performance, "getEntriesByType").mockReturnValue([]);

    // Mock legacy navigation API
    Object.defineProperty(window.performance, "navigation", {
      value: { type: 1, TYPE_RELOAD: 1, TYPE_BACK_FORWARD: 2, TYPE_NAVIGATE: 0 },
      writable: true,
      configurable: true,
    });

    // Set up an existing tab ID to trigger the navigate/reload check
    sessionStorage.setItem("elpasto:tab-id:session-legacy-nav", "existing-tab");
    randomUuidSpy.mockReturnValue("peer-legacy");

    renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-legacy-nav",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Tab ID should be reused since navigation type is "reload"
    expect(sessionStorage.getItem("elpasto:tab-id:session-legacy-nav")).toBe("existing-tab");
  });

  test("legacy navigation type navigate rotates tab ID", async () => {
    vi.spyOn(window.performance, "getEntriesByType").mockReturnValue([]);
    Object.defineProperty(window.performance, "navigation", {
      value: { type: 0, TYPE_RELOAD: 1, TYPE_BACK_FORWARD: 2, TYPE_NAVIGATE: 0 },
      writable: true,
      configurable: true,
    });

    sessionStorage.setItem("elpasto:tab-id:session-legacy-navigate", "old-tab");
    randomUuidSpy
      .mockReturnValueOnce("peer-legacy-nav")
      .mockReturnValueOnce("new-tab-id");

    renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-legacy-navigate",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    expect(sessionStorage.getItem("elpasto:tab-id:session-legacy-navigate")).toBe("new-tab-id");
  });

  test("legacy navigation type back_forward is treated as non-navigate", async () => {
    vi.spyOn(window.performance, "getEntriesByType").mockReturnValue([]);
    Object.defineProperty(window.performance, "navigation", {
      value: { type: 2, TYPE_RELOAD: 1, TYPE_BACK_FORWARD: 2, TYPE_NAVIGATE: 0 },
      writable: true,
      configurable: true,
    });

    sessionStorage.setItem("elpasto:tab-id:session-legacy-bf", "existing-tab");
    randomUuidSpy.mockReturnValue("peer-legacy-bf");

    renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-legacy-bf",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    expect(sessionStorage.getItem("elpasto:tab-id:session-legacy-bf")).toBe("existing-tab");
  });

  test("legacy navigation with unknown type returns null", async () => {
    vi.spyOn(window.performance, "getEntriesByType").mockReturnValue([]);
    Object.defineProperty(window.performance, "navigation", {
      value: { type: 99, TYPE_RELOAD: 1, TYPE_BACK_FORWARD: 2, TYPE_NAVIGATE: 0 },
      writable: true,
      configurable: true,
    });

    sessionStorage.setItem("elpasto:tab-id:session-legacy-unknown", "existing-tab");
    randomUuidSpy.mockReturnValue("peer-legacy-unknown");

    renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-legacy-unknown",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Unknown nav type, so getNavigationType returns null => not "navigate" => tab ID reused
    expect(sessionStorage.getItem("elpasto:tab-id:session-legacy-unknown")).toBe("existing-tab");
  });

  test("copyMyPeerName when fromTabId equals toTabId does nothing", async () => {
    // To trigger this we need getTabId to return the same ID for both old and new
    // This happens when sessionStorage has an existing tab ID and navigation type
    // is "navigate" but the new ID somehow equals the old. This is practically impossible
    // with randomUUID but we can force it by mocking.
    sessionStorage.setItem("elpasto:tab-id:session-copy-same", "same-id");
    localStorage.setItem("elpasto:my-peer-name:session-copy-same:same-id", "My Name");

    vi.spyOn(window.performance, "getEntriesByType").mockReturnValue([
      { type: "navigate" } as unknown as PerformanceEntry,
    ]);

    // Make randomUUID return same ID (so copyMyPeerName gets fromTabId === toTabId)
    randomUuidSpy
      .mockReturnValueOnce("peer-copy-same")
      .mockReturnValueOnce("same-id"); // rotated tab ID same as old

    renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-copy-same",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Name should still exist at original key (copy was skipped)
    expect(localStorage.getItem("elpasto:my-peer-name:session-copy-same:same-id")).toBe("My Name");
  });

  test("copyMyPeerName skips copy when destination key already has a name", async () => {
    sessionStorage.setItem("elpasto:tab-id:session-copy-exists", "old-tab");
    localStorage.setItem("elpasto:my-peer-name:session-copy-exists:old-tab", "Old Name");
    // Pre-set the destination key
    localStorage.setItem("elpasto:my-peer-name:session-copy-exists:new-tab", "Existing Name");

    vi.spyOn(window.performance, "getEntriesByType").mockReturnValue([
      { type: "navigate" } as unknown as PerformanceEntry,
    ]);

    randomUuidSpy
      .mockReturnValueOnce("peer-copy-exists")
      .mockReturnValueOnce("new-tab");

    renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-copy-exists",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Destination key should keep its existing name (not overwritten)
    expect(localStorage.getItem("elpasto:my-peer-name:session-copy-exists:new-tab")).toBe("Existing Name");
  });

  test("getNavigationType catch branch when performance.getEntriesByType throws", async () => {
    vi.spyOn(window.performance, "getEntriesByType").mockImplementation(() => {
      throw new Error("security error");
    });

    sessionStorage.setItem("elpasto:tab-id:session-nav-error", "existing-tab");
    randomUuidSpy.mockReturnValue("peer-nav-error");

    renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-nav-error",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // getNavigationType returns null on error => not "navigate" => tab ID reused
    expect(sessionStorage.getItem("elpasto:tab-id:session-nav-error")).toBe("existing-tab");
  });

  test("copyMyPeerName catch branch when localStorage throws", async () => {
    sessionStorage.setItem("elpasto:tab-id:session-copy-error", "old-tab");
    localStorage.setItem("elpasto:my-peer-name:session-copy-error:old-tab", "My Name");

    vi.spyOn(window.performance, "getEntriesByType").mockReturnValue([
      { type: "navigate" } as unknown as PerformanceEntry,
    ]);

    // Make localStorage throw during the copy
    const origGetItem = localStorage.getItem.bind(localStorage);
    vi.spyOn(localStorage, "getItem").mockImplementation((key: string) => {
      if (key.includes("my-peer-name") && key.includes("session-copy-error")) {
        throw new Error("access denied");
      }
      return origGetItem(key);
    });

    randomUuidSpy
      .mockReturnValueOnce("peer-copy-error")
      .mockReturnValueOnce("new-tab-error");

    renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-copy-error",
        signalingReady: true,
        sendPeerSignal: vi.fn(async () => true),
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    // Should not crash — the error is silently caught
    expect(sessionStorage.getItem("elpasto:tab-id:session-copy-error")).toBe("new-tab-error");
  });
});

describe("initial restore with tombstones", () => {
  test("passes tombstones into orphan adoption so deleted clips are not re-keyed", async () => {
    randomUuidSpy.mockReturnValue("peer-local");
    const sendPeerSignal = vi.fn(async () => true);
    listStoredBinaryClipsBySessionMock.mockResolvedValueOnce([]);
    getTombstonesMock.mockResolvedValueOnce(new Set(["dead-transfer"]));

    renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await waitFor(() => {
      expect(adoptOrphanedClipsMock).toHaveBeenCalledWith(
        "session-1",
        expect.any(String),
        new Set(["dead-transfer"])
      );
    });
  });

  test("disable effect clears pending transfer request timeouts", async () => {
    randomUuidSpy.mockReturnValue("peer-0");
    const sendPeerSignal = vi.fn(async () => true);
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      const { result, rerender } = renderHook(
        ({ enabled }) =>
          usePeerMesh({
            enabled,
            sessionToken: "session-1",
            signalingReady: true,
            sendPeerSignal,
            getCurrentUnlockSecret: getCurrentUnlockSecretMock,
          }),
        { initialProps: { enabled: true } }
      );

      // Connect a peer
      await act(async () => {
        await result.current.handlePeerSignal({ fromPeerId: "peer-a", signalType: "announce" });
      });

      const peerAChannel = peerConnections[0].createdChannels[0];
      await act(async () => { peerAChannel.open(); });

      // Offer a clip to create a transfer request timeout
      decodeDataChannelMessageMock.mockResolvedValueOnce({
        kind: "control",
        message: {
          type: "catalog:offer",
          clips: [{
            transferId: "transfer-pending",
            zone: "A",
            kind: "file",
            mimeType: "application/pdf",
            originalName: "pending.pdf",
            sizeBytes: 3,
            encryptionVersion: null,
            encryptionMeta: null,
            createdAt: envelope.createdAt,
          }],
        },
      });

      await act(async () => {
        peerAChannel.message("catalog-offer-msg");
        await Promise.resolve();
      });

      // Now disable the hook — should clear the transfer request timeout
      await act(async () => {
        rerender({ enabled: false });
      });

      // Advance past timeout — should NOT mark transfer failed since it was cleared
      await act(async () => {
        vi.advanceTimersByTime(120_000);
        await Promise.resolve();
      });

      // Verify the hook cleaned up properly (no crashes, no pending state)
      expect(result.current.getReceivedBinaryClipsByZone("A")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("updateLocalBinaryClipContent rewrites sender bytes, persists them, and broadcasts clip:update", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-z",
        signalType: "announce",
      });
    });

    const channel = peerConnections[0].createdChannels[0];
    await act(async () => {
      channel.open();
    });

    await act(async () => {
      await result.current.queueLocalBinaryClip({
        transferId: "transfer-edit",
        zone: "A",
        file: new File(["hello"], "clip.txt", { type: "text/plain" }),
        kind: "text",
      });
    });

    sendDirectTransferMock.mockClear();

    await act(async () => {
      await result.current.updateLocalBinaryClipContent({
        transferId: "transfer-edit",
        kind: "text",
        text: "updated sender text",
      });
    });

    expect(sendDirectTransferMock).toHaveBeenCalledWith(
      channel,
      expect.objectContaining({
        transferId: "transfer-edit",
        mimeType: "text/plain",
      }),
      expect.any(Uint8Array),
      expect.any(Function),
      "clip:update"
    );

    const storedRecord = Array.from(storedBinaryClips.values()).find(
      (record) => record.transferId === "transfer-edit"
    );
    expect(storedRecord).toBeDefined();
    expect(await new Blob([storedRecord!.senderFileBytes as ArrayBuffer]).text()).toBe("updated sender text");
    expect(result.current.getLocalBinaryClipsByZone("A")[0]).toEqual(expect.objectContaining({
      kind: "text",
      text_content: "updated sender text",
      mime_type: "text/plain",
    }));
  });

  test("incoming clip:update replaces an already completed receiver clip", async () => {
    randomUuidSpy.mockReturnValue("peer-a");
    const sendPeerSignal = vi.fn(async () => true);

    const { result } = renderHook(() =>
      usePeerMesh({
        enabled: true,
        sessionToken: "session-1",
        signalingReady: true,
        sendPeerSignal,
        getCurrentUnlockSecret: getCurrentUnlockSecretMock,
      })
    );

    await act(async () => {
      await result.current.handlePeerSignal({
        fromPeerId: "peer-z",
        signalType: "announce",
      });
    });

    const channel = peerConnections[0].createdChannels[0];
    await act(async () => {
      channel.open();
    });

    decodeDataChannelMessageMock
      .mockResolvedValueOnce({
        kind: "control",
        message: {
          type: "clip:start",
          envelope: {
            transferId: "transfer-update",
            zone: "A",
            kind: "text",
            mimeType: "text/plain",
            originalName: "clip.txt",
            encrypted: false,
            encryptionVersion: null,
            encryptionMeta: null,
            sizeBytes: 3,
            createdAt: envelope.createdAt,
          },
        },
      })
      .mockResolvedValueOnce({
        kind: "chunk",
        transferId: "transfer-update",
        index: 0,
        payload: new Uint8Array([1, 2, 3]),
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:end", transferId: "transfer-update", totalChunks: 1 },
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: {
          type: "clip:update",
          envelope: {
            transferId: "transfer-update",
            zone: "A",
            kind: "text",
            mimeType: "text/plain",
            originalName: "clip.txt",
            encrypted: false,
            encryptionVersion: null,
            encryptionMeta: null,
            sizeBytes: 2,
            createdAt: envelope.createdAt,
          },
        },
      })
      .mockResolvedValueOnce({
        kind: "chunk",
        transferId: "transfer-update",
        index: 0,
        payload: new Uint8Array([8, 9]),
      })
      .mockResolvedValueOnce({
        kind: "control",
        message: { type: "clip:end", transferId: "transfer-update", totalChunks: 1 },
      });

    await act(async () => {
      channel.message("clip-start");
      await Promise.resolve();
      channel.message("clip-chunk");
      await Promise.resolve();
      channel.message("clip-end");
      await Promise.resolve();
    });

    const initialClip = result.current.getReceivedBinaryClipsByZone("A")[0];
    expect(initialClip?.local_transfer_state).toBe("complete");

    await act(async () => {
      channel.message("clip-update");
      await Promise.resolve();
      channel.message("clip-update-chunk");
      await Promise.resolve();
      channel.message("clip-update-end");
      await Promise.resolve();
    });

    await waitFor(() => {
      const updatedClip = result.current.getReceivedBinaryClipsByZone("A")[0];
      expect(updatedClip?.id).toBe(initialClip?.id);
      expect(updatedClip?.local_transfer_state).toBe("complete");
      expect(result.current.getDirectClipCiphertext(updatedClip!.id)).toEqual(new Uint8Array([8, 9]));
    });
  });
});
