import { describe, expect, test, vi } from "vitest";
import {
  DIRECT_TRANSFER_BUFFERED_AMOUNT_HIGH_WATERMARK,
  createPeerConnection,
  decodeDataChannelMessage,
  sendDirectTransfer,
} from "./webrtc";
import { createChunkFrame } from "./direct-transfer";

class FakeDataChannel {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  send(payload: unknown) {
    this.sent.push(payload);
  }

  trigger(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

describe("createPeerConnection", () => {
  test("delegates to the browser RTCPeerConnection constructor", () => {
    const original = globalThis.RTCPeerConnection;
    const created = { created: true };
    let calls = 0;

    globalThis.RTCPeerConnection = class {
      constructor() {
        calls += 1;
        return created as never;
      }
    } as unknown as typeof RTCPeerConnection;

    try {
      expect(createPeerConnection() as unknown).toEqual(created);
      expect(calls).toBe(1);
    } finally {
      globalThis.RTCPeerConnection = original;
    }
  });

  test("uses STUN only when no TURN credentials provided", () => {
    const original = globalThis.RTCPeerConnection;
    let receivedConfig: RTCConfiguration | undefined;

    globalThis.RTCPeerConnection = class {
      constructor(config?: RTCConfiguration) {
        receivedConfig = config;
        return {} as never;
      }
    } as unknown as typeof RTCPeerConnection;

    try {
      createPeerConnection();
      expect(receivedConfig?.iceServers).toEqual([
        { urls: "stun:stun.l.google.com:19302" },
      ]);
    } finally {
      globalThis.RTCPeerConnection = original;
    }
  });

  test("adds TURN server when credentials provided", () => {
    const original = globalThis.RTCPeerConnection;
    let receivedConfig: RTCConfiguration | undefined;

    globalThis.RTCPeerConnection = class {
      constructor(config?: RTCConfiguration) {
        receivedConfig = config;
        return {} as never;
      }
    } as unknown as typeof RTCPeerConnection;

    try {
      createPeerConnection({
        urls: [
          "turn:turn.test.example:3478?transport=udp",
          "turn:turn.test.example:3478?transport=tcp",
        ],
        username: "1710500000:test-token",
        credential: "base64secret",
      });
      expect(receivedConfig?.iceServers).toEqual([
        { urls: "stun:stun.l.google.com:19302" },
        {
          urls: [
            "turn:turn.test.example:3478?transport=udp",
            "turn:turn.test.example:3478?transport=tcp",
          ],
          username: "1710500000:test-token",
          credential: "base64secret",
        },
      ]);
    } finally {
      globalThis.RTCPeerConnection = original;
    }
  });
});

describe("decodeDataChannelMessage", () => {
  test("parses control and chunk payloads", async () => {
    const control = await decodeDataChannelMessage(
      JSON.stringify({ type: "clip:end", transferId: "transfer-1", totalChunks: 2 })
    );
    expect(control).toEqual({
      kind: "control",
      message: {
        type: "clip:end",
        transferId: "transfer-1",
        totalChunks: 2,
      },
    });

    const chunkPayload = new Uint8Array([1, 2, 3]);
    const chunkFrame = createChunkFrame("transfer-1", 0, chunkPayload);
    const chunk = await decodeDataChannelMessage(chunkFrame);
    expect(chunk).toEqual({
      kind: "chunk",
      transferId: "transfer-1",
      index: 0,
      payload: chunkPayload,
    });
  });

  test("accepts ArrayBufferView (Uint8Array with offset) payloads", async () => {
    const frame = createChunkFrame("transfer-view", 3, new Uint8Array([5, 6]));
    const frameBytes = new Uint8Array(frame);
    const padded = new Uint8Array(2 + frameBytes.length);
    padded.set(frameBytes, 2);
    const view = new Uint8Array(padded.buffer, 2, frameBytes.length);

    const chunk = await decodeDataChannelMessage(view);
    expect(chunk).toEqual({
      kind: "chunk",
      transferId: "transfer-view",
      index: 3,
      payload: new Uint8Array([5, 6]),
    });
  });

  test("accepts blob payloads", async () => {
    const chunk = await decodeDataChannelMessage(
      new Blob([createChunkFrame("transfer-blob", 1, new Uint8Array([8, 9]))])
    );

    expect(chunk).toEqual({
      kind: "chunk",
      transferId: "transfer-blob",
      index: 1,
      payload: new Uint8Array([8, 9]),
    });
  });
});

describe("sendDirectTransfer", () => {
  test("sends start, chunk, and end frames in order", async () => {
    const channel = new FakeDataChannel();
    const progress = vi.fn();
    await sendDirectTransfer(
      channel as unknown as RTCDataChannel,
      {
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
      },
      new Uint8Array([4, 5, 6]),
      progress
    );

    expect(channel.sent).toHaveLength(3);
    expect(channel.sent[0]).toBe(
      JSON.stringify({
        type: "clip:start",
        envelope: {
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
        },
      })
    );
    expect(channel.sent[1]).toBeInstanceOf(ArrayBuffer);
    expect(channel.sent[2]).toBe(
      JSON.stringify({
        type: "clip:end",
        transferId: "transfer-1",
        totalChunks: 1,
      })
    );
    expect(progress).toHaveBeenCalledWith(3, 3);
  });

  test("sends clip:update when requested for replacement transfers", async () => {
    const channel = new FakeDataChannel();

    await sendDirectTransfer(
      channel as unknown as RTCDataChannel,
      {
        transferId: "transfer-update",
        zone: "A",
        kind: "text",
        mimeType: "text/plain",
        originalName: "clip.txt",
        encrypted: false,
        encryptionVersion: null,
        encryptionMeta: null,
        sizeBytes: 4,
        createdAt: "2026-03-10T12:00:00.000Z",
      },
      new Uint8Array([1, 2, 3, 4]),
      undefined,
      "clip:update"
    );

    expect(channel.sent[0]).toBe(
      JSON.stringify({
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
          sizeBytes: 4,
          createdAt: "2026-03-10T12:00:00.000Z",
        },
      })
    );
  });

  test("waits for buffered data to drain before sending chunks", async () => {
    const channel = new FakeDataChannel();
    channel.bufferedAmount = DIRECT_TRANSFER_BUFFERED_AMOUNT_HIGH_WATERMARK + 1;

    const transferPromise = sendDirectTransfer(
      channel as unknown as RTCDataChannel,
      {
        transferId: "transfer-2",
        zone: "B",
        kind: "image",
        mimeType: "image/png",
        originalName: "image.png",
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
      },
      new Uint8Array([7, 8, 9])
    );

    expect(JSON.parse(channel.sent[0] as string)).toMatchObject({
      type: "clip:start",
      envelope: {
        transferId: "transfer-2",
        zone: "B",
        kind: "image",
      },
    });

    channel.bufferedAmount = 0;
    channel.trigger("bufferedamountlow");

    await transferPromise;
    expect(channel.sent).toHaveLength(3);
  });

  test("fails the transfer if the data channel closes while waiting", async () => {
    const channel = new FakeDataChannel();
    channel.bufferedAmount = DIRECT_TRANSFER_BUFFERED_AMOUNT_HIGH_WATERMARK + 1;

    const transferPromise = sendDirectTransfer(
      channel as unknown as RTCDataChannel,
      {
        transferId: "transfer-3",
        zone: "A",
        kind: "file",
        mimeType: "text/plain",
        originalName: "note.txt",
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
      },
      new Uint8Array([1, 2, 3])
    );

    channel.trigger("close");

    await expect(transferPromise).rejects.toThrow("Data channel closed during transfer");
  });
});
