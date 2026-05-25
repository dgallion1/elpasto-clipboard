"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildApiUrl } from "@/lib/api";
import {
  TUNNEL_BC_NAME,
  parseTunnelMessage,
  type SwFetchResponse,
  type SwFetchError,
  type SwMessage,
} from "@/lib/tunnel-protocol";

export interface TunnelInfo {
  peerId: string;
  label?: string;
  port?: number;
  serverRelay?: boolean;
  prefix?: string;
}

export interface UseTunnelRelayOptions {
  sessionToken: string;
  sendTunnelMessage: (peerId: string, data: string | ArrayBuffer) => boolean;
  subscribeTunnel: (listener: (peerId: string, data: string | ArrayBuffer) => void) => () => void;
  /** Set of currently connected peer IDs — tunnels from disconnected peers are pruned automatically. */
  connectedPeerIds: ReadonlySet<string>;
}

// Maximum number of concurrent tunnel relay requests forwarded to a peer.
const MAX_CONCURRENT_RELAY_REQUESTS = 8;
// Timeout for relay requests — if no response arrives, free the slot.
const RELAY_REQUEST_TIMEOUT_MS = 35_000;
export function useTunnelRelay({ sessionToken, sendTunnelMessage, subscribeTunnel, connectedPeerIds }: UseTunnelRelayOptions) {
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [swReady, setSwReady] = useState(false);

  // Stable refs so the main effect doesn't tear down/re-subscribe on every
  // peer-state change (which would create a window where tunnel:announce is lost).
  const sendRef = useRef(sendTunnelMessage);
  sendRef.current = sendTunnelMessage;
  const subscribeRef = useRef(subscribeTunnel);
  subscribeRef.current = subscribeTunnel;
  const tunnelsRef = useRef(tunnels);
  tunnelsRef.current = tunnels;

  // Buffer per-requestId response state: collect body chunks, then send combined to SW.
  const pendingResponses = useRef(new Map<string, {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyChunks: string[];
    timer: ReturnType<typeof setTimeout>;
  }>());

  const bc = useRef<BroadcastChannel | null>(null);

  // Subscribe to tunnel messages from peer data channels.
  // Uses refs for sendTunnelMessage/subscribeTunnel so this effect runs once
  // and the listener is never torn down between peer-state re-renders.
  useEffect(() => {
    const channel = new BroadcastChannel(TUNNEL_BC_NAME);
    bc.current = channel;

    // Bridge SW fetch requests → tunnel channel messages.
    channel.onmessage = (event: MessageEvent<SwMessage>) => {
      const msg = event.data;
      if (msg.kind !== "sw-fetch-request") return;
      const { peerId, requestId, method, url, headers, bodyBase64 } = msg;


      // Skip if this tab is at capacity — in multi-tab scenarios another tab's
      // relay may have room. If no tab can handle it, the SW's 30s timeout catches it.
      if (pendingResponses.current.size >= MAX_CONCURRENT_RELAY_REQUESTS) {
        return;
      }

      // Reserve a slot immediately so parallel SW requests don't race past the limit.
      // Set a timeout to free the slot if no response ever arrives (e.g. peer disconnected).
      const timer = setTimeout(() => {
        if (pendingResponses.current.has(requestId)) {
          pendingResponses.current.delete(requestId);
          const errResp: SwFetchError = {
            kind: "sw-fetch-error",
            requestId,
            message: "tunnel relay timeout",
          };
          channel.postMessage(errResp);
        }
      }, RELAY_REQUEST_TIMEOUT_MS);
      pendingResponses.current.set(requestId, { status: 0, statusText: "", headers: {}, bodyChunks: [], timer });

      const sent = sendRef.current(peerId, JSON.stringify({ type: "tunnel:request", requestId, method, url, headers }));
      if (!sent) {
        // Silently free the slot — in multi-tab scenarios another tab's relay
        // may have the tunnel channel open and will handle this request.
        // If no tab can handle it, the SW's own 30s timeout catches it.
        clearTimeout(timer);
        pendingResponses.current.delete(requestId);
        return;
      }

      if (bodyBase64) {
        sendRef.current(peerId, JSON.stringify({ type: "tunnel:request-body", requestId, data: bodyBase64 }));
      }
      sendRef.current(peerId, JSON.stringify({ type: "tunnel:request-end", requestId }));
    };

    const unsubTunnel = subscribeRef.current((peerId, data) => {
      const msg = parseTunnelMessage(data);
      if (!msg) return;

      switch (msg.type) {
        case "tunnel:announce":
          setTunnels((prev) => {
            if (prev.some((t) => t.peerId === peerId)) return prev;
            return [...prev, { peerId, label: msg.label, port: msg.port }];
          });
          break;

        case "tunnel:close":
          setTunnels((prev) => prev.filter((t) => t.peerId !== peerId));
          break;

        case "tunnel:response": {
          const existing = pendingResponses.current.get(msg.requestId);
          if (existing) {
            existing.status = msg.status;
            existing.statusText = msg.statusText;
            existing.headers = msg.headers;
          } else {
            pendingResponses.current.set(msg.requestId, {
              status: msg.status,
              statusText: msg.statusText,
              headers: msg.headers,
              bodyChunks: [],
              timer: setTimeout(() => { pendingResponses.current.delete(msg.requestId); }, RELAY_REQUEST_TIMEOUT_MS),
            });
          }
          break;
        }

        case "tunnel:response-body": {
          const entry = pendingResponses.current.get(msg.requestId);
          if (entry) {
            entry.bodyChunks.push(msg.data);
          }
          break;
        }

        case "tunnel:response-end": {
          const entry = pendingResponses.current.get(msg.requestId);
          if (entry) {
            clearTimeout(entry.timer);
            pendingResponses.current.delete(msg.requestId);
            const response: SwFetchResponse = {
              kind: "sw-fetch-response",
              requestId: msg.requestId,
              status: entry.status,
              statusText: entry.statusText,
              headers: entry.headers,
              bodyBase64: entry.bodyChunks.join(""),
            };
            channel.postMessage(response);
          }
          break;
        }

        case "tunnel:error": {
          if (msg.requestId) {
            const errEntry = pendingResponses.current.get(msg.requestId);
            if (errEntry) clearTimeout(errEntry.timer);
            pendingResponses.current.delete(msg.requestId);
            const errResp: SwFetchError = {
              kind: "sw-fetch-error",
              requestId: msg.requestId,
              message: msg.message,
            };
            channel.postMessage(errResp);
          }
          break;
        }
      }
    });

    return () => {
      unsubTunnel();
      // Clear all pending timers to avoid leaks.
      for (const entry of pendingResponses.current.values()) {
        clearTimeout(entry.timer);
      }
      pendingResponses.current.clear();
      channel.close();
      bc.current = null;
    };
  }, []);

  // Prune tunnels whose peer has disconnected (e.g. CLI killed without sending tunnel:close).
  // Server-relay tunnels are managed via SSE events, not peer connection state.
  useEffect(() => {
    setTunnels((prev) => {
      const next = prev.filter((t) => t.serverRelay || connectedPeerIds.has(t.peerId));
      return next.length === prev.length ? prev : next;
    });
  }, [connectedPeerIds]);

  // Register and activate the Service Worker when WebRTC tunnels are first available.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hasWebRTCTunnels = tunnels.some(t => !t.serverRelay);
    if (!hasWebRTCTunnels) return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    navigator.serviceWorker
      .register("/tunnel-sw2.js", { scope: "/tunnel/", updateViaCache: "none" })
      .then((reg) => {
        if (reg.active) {
          if (!cancelled) setSwReady(true);
          return;
        }
        const worker = reg.installing || reg.waiting;
        if (worker) {
          worker.addEventListener("statechange", () => {
            if (worker.state === "activated" && !cancelled) {
              setSwReady(true);
            }
          });
        }
      })
      .catch((err) => {
        console.error("[tunnel] Service Worker registration failed:", err);
      });

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when tunnel count changes, not on every array reference
  }, [tunnels.length]);

  const addServerRelayTunnel = useCallback((data: { peerId: string; label?: string; port?: number; prefix?: string }) => {
    setTunnels((prev) => {
      const existing = prev.findIndex((t) => t.peerId === data.peerId);
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = { ...data, serverRelay: true };
        return updated;
      }
      return [...prev, { ...data, serverRelay: true }];
    });
  }, []);

  const removeServerRelayTunnel = useCallback((peerId: string) => {
    setTunnels((prev) => prev.filter((t) => !(t.peerId === peerId && t.serverRelay)));
  }, []);

  const removeTunnel = useCallback((peerId: string) => {
    setTunnels((prev) => prev.filter((t) => t.peerId !== peerId));
  }, []);

  const openTunnel = useCallback(async (peerId: string) => {
    if (typeof window === "undefined") return;
    const tunnel = tunnelsRef.current.find(t => t.peerId === peerId);
    if (tunnel?.serverRelay) {
      const response = await fetch(
        buildApiUrl(`/api/sessions/${sessionToken}/tunnels/${peerId}/viewer`),
        { method: "POST" }
      );
      if (!response.ok) {
        throw new Error(`failed to claim tunnel viewer: ${response.status}`);
      }
      const data = await response.json() as { prefix?: string };
      if (!data.prefix) {
        throw new Error("failed to claim tunnel viewer");
      }
      // Route through the tunnel viewer page with the prefix in the fragment.
      // This keeps the capability URL out of browser history and visible address bar.
      const viewerUrl = `/tunnel-view/${peerId}?serverRelay=1#${encodeURIComponent(data.prefix)}`;
      window.open(viewerUrl, "_blank", "noopener");
      return;
    }
    if (!swReady) {
      // Register and wait for activation directly — navigator.serviceWorker.ready
      // won't resolve because the SW scope (/tunnel/) doesn't cover the session page.
      const reg = await navigator.serviceWorker.register("/tunnel-sw2.js", { scope: "/tunnel/", updateViaCache: "none" });
      if (!reg.active) {
        await new Promise<void>((resolve) => {
          const worker = reg.installing || reg.waiting;
          if (!worker) { resolve(); return; }
          worker.addEventListener("statechange", () => {
            if (worker.state === "activated") resolve();
          });
        });
      }
    }
    window.open(`/tunnel-view/${peerId}/`, "_blank", "noopener");
  }, [sessionToken, swReady]);

  return { tunnels, swReady, openTunnel, addServerRelayTunnel, removeServerRelayTunnel, removeTunnel };
}
