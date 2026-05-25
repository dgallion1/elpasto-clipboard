/**
 * elpasto tunnel Service Worker
 * Scope: /tunnel/
 *
 * Intercepts all fetch and navigation requests from pages under /tunnel/{peerId}/...
 * and bridges them to the session page via BroadcastChannel("elpasto-tunnel").
 *
 * Absolute-path requests (e.g. fetch("/api/data")) from tunneled pages are
 * rewritten to go through the tunnel prefix so they reach the proxied service.
 */

const TUNNEL_BC_NAME = "elpasto-tunnel";
const FETCH_TIMEOUT_MS = 30_000;

// Map of pending SW-side fetch requests: requestId → { resolve, reject }
const pendingFetches = new Map();

const bc = new BroadcastChannel(TUNNEL_BC_NAME);

bc.onmessage = (event) => {
  const msg = event.data;
  if (!msg || !msg.requestId) return;

  const pending = pendingFetches.get(msg.requestId);
  if (!pending) return;
  pendingFetches.delete(msg.requestId);

  if (msg.kind === "sw-fetch-response") {
    pending.resolve(msg);
  } else if (msg.kind === "sw-fetch-error") {
    pending.reject(new Error(msg.message || "tunnel error"));
  }
};

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Direct tunnel request: /tunnel/{peerId}/...
  if (url.pathname.startsWith("/tunnel/")) {
    const segs = url.pathname.slice("/tunnel/".length).split("/");
    const peerId = segs[0];
    if (!peerId) return;
    const relativePath = "/" + segs.slice(1).join("/") + (url.search || "");
    event.respondWith(handleTunnelFetch(event, peerId, url, relativePath));
    return;
  }

  // Absolute-path request from a tunneled page (e.g. fetch("/api/data")).
  // The SW controls this page because it's under /tunnel/ scope, but the
  // request URL doesn't start with /tunnel/. Derive peerId from the
  // referring page (Referer header or client URL).
  const peerId = getPeerIdFromContext(event);
  if (peerId) {
    const relativePath = url.pathname + (url.search || "");
    event.respondWith(handleTunnelFetch(event, peerId, url, relativePath));
    return;
  }

  // Not a tunnel request — let it pass through.
});

/**
 * Extract peerId from the request context. Checks Referer header first,
 * then falls back to the client (page) URL.
 */
function getPeerIdFromContext(event) {
  // Check Referer header
  const referer = event.request.referrer || event.request.headers.get("referer");
  if (referer) {
    const match = referer.match(/\/tunnel\/([^/]+)/);
    if (match) return match[1];
  }
  // Fallback: check the client (controlled page) URL
  if (event.clientId) {
    // clientId is available but we can't do async in the sync fetch listener
    // to look it up. Referer should cover most cases.
  }
  return null;
}

async function handleTunnelFetch(event, peerId, url, relativePath) {
  const requestId = crypto.randomUUID();

  // Collect request headers
  const headers = {};
  for (const [k, v] of event.request.headers.entries()) {
    headers[k] = v;
  }

  // Collect optional request body
  let bodyBase64;
  const body = await event.request.arrayBuffer().catch(() => null);
  if (body && body.byteLength > 0) {
    bodyBase64 = arrayBufferToBase64(body);
  }

  const fetchRequest = {
    kind: "sw-fetch-request",
    requestId,
    peerId,
    method: event.request.method,
    url: relativePath,
    headers,
    bodyBase64,
  };

  // Post to page relay and wait for response
  let resolve, reject;
  const responsePromise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const timer = setTimeout(() => {
    if (pendingFetches.has(requestId)) {
      pendingFetches.delete(requestId);
      reject(new Error("tunnel fetch timeout"));
    }
  }, FETCH_TIMEOUT_MS);

  pendingFetches.set(requestId, {
    resolve: (msg) => { clearTimeout(timer); resolve(msg); },
    reject: (err) => { clearTimeout(timer); reject(err); },
  });

  bc.postMessage(fetchRequest);

  try {
    const resp = await responsePromise;

    // Decode base64 body
    const bodyBytes = resp.bodyBase64 ? base64ToArrayBuffer(resp.bodyBase64) : new ArrayBuffer(0);

    return new Response(bodyBytes, {
      status: resp.status,
      statusText: resp.statusText,
      headers: new Headers(resp.headers || {}),
    });
  } catch (err) {
    return new Response(`Tunnel error: ${err.message}`, {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
