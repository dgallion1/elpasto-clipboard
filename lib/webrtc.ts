"use client";

import {
  DIRECT_TRANSFER_CHUNK_SIZE,
  createChunkFrame,
  parseChunkFrame,
  type DirectClipEnvelope,
} from "@/lib/direct-transfer";
import type { BinaryClipCatalogEntry } from "@/lib/clip-store";
import type { ClipZone } from "@/lib/clips";
import type { ThreadRecord } from "@/lib/threads";
import type { TurnCredentials } from "@/app/[token]/session-page-types";

export const DIRECT_TRANSFER_BUFFERED_AMOUNT_HIGH_WATERMARK = 256 * 1024;
const DIRECT_TRANSFER_BUFFERED_AMOUNT_LOW_WATERMARK = 64 * 1024;

export type DirectTransferControlMessage =
  | { type: "clip:start"; envelope: DirectClipEnvelope }
  | { type: "clip:update"; envelope: DirectClipEnvelope }
  | { type: "clip:end"; transferId: string; totalChunks: number }
  | { type: "clip:delete"; transferId: string }
  | { type: "clips:clear"; transferIds: string[]; zone?: ClipZone }
  | { type: "catalog:offer"; clips: BinaryClipCatalogEntry[] }
  | { type: "catalog:request"; transferIds: string[] }
  | { type: "catalog:unavailable"; transferIds: string[] }
  | { type: "peer:name"; peerId: string; name: string }
  | { type: "peer:names-sync"; names: Record<string, string> }
  | { type: "peer:identify"; fromPeerId: string }
  | { type: "threads:sync"; threads: ThreadRecord[] }
  | { type: "thread:created"; thread: ThreadRecord }
  | { type: "thread:renamed"; id: string; name: string; updatedAt: number }
  | { type: "thread:reordered"; positions: { id: string; position: number; updatedAt: number }[] }
  | { type: "thread:deleted"; id: string; deletedAt: number };

export function createPeerConnection(turnCredentials?: TurnCredentials): RTCPeerConnection {
  const iceServers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
  ];

  if (turnCredentials) {
    iceServers.push({
      urls: turnCredentials.urls,
      username: turnCredentials.username,
      credential: turnCredentials.credential,
    });
  }

  return new RTCPeerConnection({ iceServers });
}

export async function sendDirectTransfer(
  channel: RTCDataChannel,
  envelope: DirectClipEnvelope,
  ciphertext: Uint8Array,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
  startMessageType: "clip:start" | "clip:update" = "clip:start"
) {
  channel.send(JSON.stringify({ type: startMessageType, envelope } satisfies DirectTransferControlMessage));

  let chunkIndex = 0;
  let sentBytes = 0;
  for (let offset = 0; offset < ciphertext.byteLength; offset += DIRECT_TRANSFER_CHUNK_SIZE) {
    await waitForBufferedAmount(channel);
    const chunk = ciphertext.subarray(offset, offset + DIRECT_TRANSFER_CHUNK_SIZE);
    channel.send(createChunkFrame(envelope.transferId, chunkIndex, chunk));
    sentBytes += chunk.byteLength;
    onProgress?.(sentBytes, ciphertext.byteLength);
    chunkIndex += 1;
  }

  channel.send(JSON.stringify({
    type: "clip:end",
    transferId: envelope.transferId,
    totalChunks: chunkIndex,
  } satisfies DirectTransferControlMessage));
}

export async function decodeDataChannelMessage(
  data: string | ArrayBuffer | Blob | ArrayBufferView
): Promise<
  | { kind: "control"; message: DirectTransferControlMessage }
  | { kind: "chunk"; transferId: string; index: number; payload: Uint8Array }
> {
  if (typeof data === "string") {
    const message = JSON.parse(data) as DirectTransferControlMessage;
    return { kind: "control", message };
  }

  const buffer = await toArrayBuffer(data);
  return { kind: "chunk", ...parseChunkFrame(buffer) };
}

async function waitForBufferedAmount(channel: RTCDataChannel) {
  if (channel.bufferedAmount <= DIRECT_TRANSFER_BUFFERED_AMOUNT_HIGH_WATERMARK) {
    return;
  }

  channel.bufferedAmountLowThreshold = DIRECT_TRANSFER_BUFFERED_AMOUNT_LOW_WATERMARK;
  await new Promise<void>((resolve, reject) => {
    const handleLow = () => {
      cleanup();
      resolve();
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("Data channel closed during transfer"));
    };
    const cleanup = () => {
      channel.removeEventListener("bufferedamountlow", handleLow);
      channel.removeEventListener("close", handleClose);
      channel.removeEventListener("error", handleClose as EventListener);
    };

    channel.addEventListener("bufferedamountlow", handleLow, { once: true });
    channel.addEventListener("close", handleClose, { once: true });
    channel.addEventListener("error", handleClose as EventListener, { once: true });
  });
}

async function toArrayBuffer(
  data: ArrayBuffer | Blob | ArrayBufferView
): Promise<ArrayBuffer> {
  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (data instanceof Blob) {
    return data.arrayBuffer();
  }

  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
