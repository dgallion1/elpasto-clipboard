"use client";

// Tunnel protocol message types — mirrors backend/internal/tunnel/protocol.go
export type TunnelMsgType =
  | "tunnel:announce"
  | "tunnel:close"
  | "tunnel:request"
  | "tunnel:request-body"
  | "tunnel:request-end"
  | "tunnel:response"
  | "tunnel:response-body"
  | "tunnel:response-end"
  | "tunnel:error";

export interface TunnelAnnounce {
  type: "tunnel:announce";
  label?: string;
  port?: number;
  serverRelay?: boolean;  // true when tunnel is via server WebSocket relay
  prefix?: string;         // URL prefix, present when serverRelay is true
}
export interface TunnelClose { type: "tunnel:close" }
export interface TunnelRequest {
  type: "tunnel:request";
  requestId: string;
  method: string;
  url: string;
  headers: Record<string, string>;
}
export interface TunnelRequestBody {
  type: "tunnel:request-body";
  requestId: string;
  data: string; // base64
}
export interface TunnelRequestEnd {
  type: "tunnel:request-end";
  requestId: string;
}
export interface TunnelResponse {
  type: "tunnel:response";
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}
export interface TunnelResponseBody {
  type: "tunnel:response-body";
  requestId: string;
  data: string; // base64
}
export interface TunnelResponseEnd {
  type: "tunnel:response-end";
  requestId: string;
}
export interface TunnelError {
  type: "tunnel:error";
  requestId?: string;
  message: string;
}

export type TunnelMessage =
  | TunnelAnnounce
  | TunnelClose
  | TunnelRequest
  | TunnelRequestBody
  | TunnelRequestEnd
  | TunnelResponse
  | TunnelResponseBody
  | TunnelResponseEnd
  | TunnelError;

export function parseTunnelMessage(data: string | ArrayBuffer): TunnelMessage | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as TunnelMessage;
  } catch {
    return null;
  }
}

// BroadcastChannel name shared between the tunnel relay hook and the service worker.
export const TUNNEL_BC_NAME = "elpasto-tunnel";

// Messages sent FROM the service worker TO the page.
export interface SwFetchRequest {
  kind: "sw-fetch-request";
  requestId: string;
  peerId: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyBase64?: string;
}

// Messages sent FROM the page TO the service worker.
export interface SwFetchResponse {
  kind: "sw-fetch-response";
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64: string;
}

export interface SwFetchError {
  kind: "sw-fetch-error";
  requestId: string;
  message: string;
}

export type SwMessage = SwFetchRequest | SwFetchResponse | SwFetchError;
