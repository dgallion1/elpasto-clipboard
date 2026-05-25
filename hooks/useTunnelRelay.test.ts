// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { SwFetchRequest, SwMessage } from "@/lib/tunnel-protocol";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const buildApiUrlMock = vi.fn((path: string) => path);

vi.mock("@/lib/api", () => ({
  buildApiUrl: (path: string) => buildApiUrlMock(path),
}));

// ── Fake BroadcastChannel ──────────────────────────────────────────────────────

type BCListener = (event: MessageEvent) => void;

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  readonly name: string;
  onmessage: BCListener | null = null;
  readonly posted: unknown[] = [];
  closed = false;

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(data: unknown) {
    this.posted.push(data);
  }
  close() {
    this.closed = true;
  }
}

// ── Fake ServiceWorker registration ────────────────────────────────────────────

function makeFakeServiceWorkerContainer() {
  let activeWorker: { state: string; addEventListener: ReturnType<typeof vi.fn> } | null = null;
  const registerMock = vi.fn(async () => ({
    active: activeWorker,
    installing: null,
    waiting: null,
  }));
  return { registerMock, setActive: (w: typeof activeWorker) => { activeWorker = w; } };
}

// ── Globals ────────────────────────────────────────────────────────────────────

const fetchMock = vi.fn();

let useTunnelRelay: typeof import("./useTunnelRelay").useTunnelRelay;

beforeAll(async () => {
  ({ useTunnelRelay } = await import("./useTunnelRelay"));
});

beforeEach(() => {
  FakeBroadcastChannel.instances = [];
  buildApiUrlMock.mockReset();
  buildApiUrlMock.mockImplementation((path: string) => path);
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  globalThis.BroadcastChannel = FakeBroadcastChannel as unknown as typeof BroadcastChannel;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

type TunnelListener = (peerId: string, data: string | ArrayBuffer) => void;

function makeOptions(overrides?: Partial<Parameters<typeof useTunnelRelay>[0]>) {
  const tunnelListeners = new Set<TunnelListener>();
  const sendTunnelMessage = vi.fn((_peerId: string, _data: string | ArrayBuffer) => true);
  const subscribeTunnel = vi.fn((listener: TunnelListener) => {
    tunnelListeners.add(listener);
    return () => { tunnelListeners.delete(listener); };
  });
  const connectedPeerIds = new Set<string>();

  return {
    options: {
      sessionToken: "test-session-token",
      sendTunnelMessage,
      subscribeTunnel,
      connectedPeerIds: connectedPeerIds as ReadonlySet<string>,
      ...overrides,
    },
    sendTunnelMessage,
    subscribeTunnel,
    tunnelListeners,
    connectedPeerIds,
    /** Dispatch a tunnel message from a peer to all subscribed listeners */
    dispatchTunnel(peerId: string, msg: Record<string, unknown>) {
      for (const l of tunnelListeners) {
        l(peerId, JSON.stringify(msg));
      }
    },
    /** Send a BroadcastChannel message to the hook's onmessage handler */
    dispatchBCMessage(data: SwMessage) {
      const bc = FakeBroadcastChannel.instances[0];
      if (bc?.onmessage) {
        bc.onmessage(new MessageEvent("message", { data }));
      }
    },
    /** Get posted messages from the BroadcastChannel */
    getPosted() {
      return FakeBroadcastChannel.instances[0]?.posted ?? [];
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("useTunnelRelay", () => {
  // ---------- Initial state ----------

  test("returns empty tunnels and swReady=false initially", () => {
    const { options } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));
    expect(result.current.tunnels).toEqual([]);
    expect(result.current.swReady).toBe(false);
  });

  test("subscribes to tunnel messages on mount", () => {
    const { options, subscribeTunnel } = makeOptions();
    renderHook(() => useTunnelRelay(options));
    expect(subscribeTunnel).toHaveBeenCalledTimes(1);
  });

  test("creates a BroadcastChannel on mount", () => {
    const { options } = makeOptions();
    renderHook(() => useTunnelRelay(options));
    expect(FakeBroadcastChannel.instances).toHaveLength(1);
    expect(FakeBroadcastChannel.instances[0].name).toBe("elpasto-tunnel");
  });

  // ---------- tunnel:announce / tunnel:close via WebRTC ----------

  test("tunnel:announce adds a WebRTC tunnel", () => {
    const { options, dispatchTunnel } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-a", { type: "tunnel:announce", label: "My App", port: 9000 });
    });

    expect(result.current.tunnels).toEqual([
      { peerId: "peer-a", label: "My App", port: 9000 },
    ]);
  });

  test("duplicate tunnel:announce from same peer is ignored", () => {
    const { options, dispatchTunnel } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-a", { type: "tunnel:announce", label: "App1" });
      dispatchTunnel("peer-a", { type: "tunnel:announce", label: "App2" });
    });

    expect(result.current.tunnels).toHaveLength(1);
    expect(result.current.tunnels[0].label).toBe("App1");
  });

  test("tunnel:announce from different peers adds multiple tunnels", () => {
    const { options, dispatchTunnel } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-a", { type: "tunnel:announce", label: "App A" });
      dispatchTunnel("peer-b", { type: "tunnel:announce", label: "App B" });
    });

    expect(result.current.tunnels).toHaveLength(2);
  });

  test("tunnel:close removes the tunnel", () => {
    const { options, dispatchTunnel } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-a", { type: "tunnel:announce", label: "App" });
    });
    expect(result.current.tunnels).toHaveLength(1);

    act(() => {
      dispatchTunnel("peer-a", { type: "tunnel:close" });
    });
    expect(result.current.tunnels).toEqual([]);
  });

  test("tunnel:close for unknown peer is a no-op", () => {
    const { options, dispatchTunnel } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-x", { type: "tunnel:close" });
    });
    expect(result.current.tunnels).toEqual([]);
  });

  // ---------- Server relay tunnel management ----------

  test("addServerRelayTunnel adds a server relay tunnel", () => {
    const { options } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      result.current.addServerRelayTunnel({
        peerId: "relay-1",
        label: "Relay App",
        port: 3000,
        prefix: "https://tunnel.example.com/abc/",
      });
    });

    expect(result.current.tunnels).toEqual([
      { peerId: "relay-1", label: "Relay App", port: 3000, prefix: "https://tunnel.example.com/abc/", serverRelay: true },
    ]);
  });

  test("addServerRelayTunnel updates existing tunnel for same peerId", () => {
    const { options } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      result.current.addServerRelayTunnel({ peerId: "relay-1", label: "V1" });
    });
    act(() => {
      result.current.addServerRelayTunnel({ peerId: "relay-1", label: "V2", prefix: "/new/" });
    });

    expect(result.current.tunnels).toHaveLength(1);
    expect(result.current.tunnels[0].label).toBe("V2");
    expect(result.current.tunnels[0].prefix).toBe("/new/");
  });

  test("removeServerRelayTunnel removes only server relay tunnels", () => {
    const { options, dispatchTunnel } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    // Add a WebRTC tunnel and a server relay tunnel with same peerId
    act(() => {
      dispatchTunnel("peer-x", { type: "tunnel:announce", label: "WebRTC" });
      result.current.addServerRelayTunnel({ peerId: "peer-x", label: "Relay" });
    });

    // The addServerRelayTunnel updates the existing entry (same peerId)
    // so we only get one entry. Let's use different peerIds instead.
    const { options: opts2, dispatchTunnel: dt2 } = makeOptions();
    const { result: r2 } = renderHook(() => useTunnelRelay(opts2));

    act(() => {
      dt2("peer-w", { type: "tunnel:announce", label: "WebRTC" });
      r2.current.addServerRelayTunnel({ peerId: "peer-r", label: "Relay" });
    });
    expect(r2.current.tunnels).toHaveLength(2);

    act(() => {
      r2.current.removeServerRelayTunnel("peer-r");
    });
    expect(r2.current.tunnels).toHaveLength(1);
    expect(r2.current.tunnels[0].peerId).toBe("peer-w");
  });

  test("removeTunnel removes any tunnel regardless of type", () => {
    const { options } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      result.current.addServerRelayTunnel({ peerId: "peer-a", label: "Relay" });
    });
    expect(result.current.tunnels).toHaveLength(1);

    act(() => {
      result.current.removeTunnel("peer-a");
    });
    expect(result.current.tunnels).toEqual([]);
  });

  // ---------- Merged tunnel list: WebRTC + server relay ----------

  test("tunnels list contains both WebRTC and server relay tunnels", () => {
    const { options, dispatchTunnel } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("webrtc-peer", { type: "tunnel:announce", label: "WebRTC App" });
      result.current.addServerRelayTunnel({ peerId: "relay-peer", label: "Relay App" });
    });

    expect(result.current.tunnels).toHaveLength(2);
    const webrtc = result.current.tunnels.find(t => t.peerId === "webrtc-peer");
    const relay = result.current.tunnels.find(t => t.peerId === "relay-peer");
    expect(webrtc?.serverRelay).toBeUndefined();
    expect(relay?.serverRelay).toBe(true);
  });

  // ---------- connectedPeerIds pruning ----------

  test("prunes WebRTC tunnels when peer disconnects", () => {
    const { options, dispatchTunnel, connectedPeerIds } = makeOptions();
    connectedPeerIds.add("peer-a");
    const { result, rerender } = renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-a", { type: "tunnel:announce", label: "App" });
    });
    expect(result.current.tunnels).toHaveLength(1);

    // Simulate peer disconnect — remove from connectedPeerIds and update the set reference
    const newConnected = new Set<string>();
    options.connectedPeerIds = newConnected;
    rerender();

    expect(result.current.tunnels).toEqual([]);
  });

  test("does not prune server relay tunnels when peer disconnects", () => {
    const { options } = makeOptions();
    const { result, rerender } = renderHook(() => useTunnelRelay(options));

    act(() => {
      result.current.addServerRelayTunnel({ peerId: "relay-1", label: "Relay" });
    });
    expect(result.current.tunnels).toHaveLength(1);

    // Change connectedPeerIds — server relay tunnels should survive
    options.connectedPeerIds = new Set<string>();
    rerender();

    expect(result.current.tunnels).toHaveLength(1);
    expect(result.current.tunnels[0].peerId).toBe("relay-1");
  });

  // ---------- BroadcastChannel: SW fetch request relay ----------

  test("relays SW fetch request to tunnel peer via sendTunnelMessage", () => {
    const { options, sendTunnelMessage, dispatchBCMessage, dispatchTunnel } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    // Add a tunnel so there's something to relay to
    act(() => {
      dispatchTunnel("peer-a", { type: "tunnel:announce", label: "App" });
    });

    const request: SwFetchRequest = {
      kind: "sw-fetch-request",
      requestId: "req-1",
      peerId: "peer-a",
      method: "GET",
      url: "/tunnel/peer-a/index.html",
      headers: { accept: "text/html" },
    };

    act(() => {
      dispatchBCMessage(request);
    });

    // Should send tunnel:request + tunnel:request-end (no body)
    expect(sendTunnelMessage).toHaveBeenCalledTimes(2);
    const firstCall = JSON.parse(sendTunnelMessage.mock.calls[0][1] as string);
    expect(firstCall).toEqual({
      type: "tunnel:request",
      requestId: "req-1",
      method: "GET",
      url: "/tunnel/peer-a/index.html",
      headers: { accept: "text/html" },
    });
    const secondCall = JSON.parse(sendTunnelMessage.mock.calls[1][1] as string);
    expect(secondCall).toEqual({ type: "tunnel:request-end", requestId: "req-1" });
  });

  test("relays SW fetch request with body (bodyBase64)", () => {
    const { options, sendTunnelMessage, dispatchBCMessage } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    const request: SwFetchRequest = {
      kind: "sw-fetch-request",
      requestId: "req-2",
      peerId: "peer-a",
      method: "POST",
      url: "/tunnel/peer-a/api/data",
      headers: {},
      bodyBase64: "aGVsbG8=",
    };

    act(() => {
      dispatchBCMessage(request);
    });

    // request + request-body + request-end = 3 calls
    expect(sendTunnelMessage).toHaveBeenCalledTimes(3);
    const bodyCall = JSON.parse(sendTunnelMessage.mock.calls[1][1] as string);
    expect(bodyCall).toEqual({ type: "tunnel:request-body", requestId: "req-2", data: "aGVsbG8=" });
  });

  test("ignores non-sw-fetch-request BroadcastChannel messages", () => {
    const { options, sendTunnelMessage, dispatchBCMessage } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchBCMessage({ kind: "sw-fetch-response", requestId: "x", status: 200, statusText: "OK", headers: {}, bodyBase64: "" });
    });

    expect(sendTunnelMessage).not.toHaveBeenCalled();
  });

  test("drops request when sendTunnelMessage returns false", () => {
    const { options, sendTunnelMessage, dispatchBCMessage, getPosted } = makeOptions();
    sendTunnelMessage.mockReturnValue(false);
    renderHook(() => useTunnelRelay(options));

    const request: SwFetchRequest = {
      kind: "sw-fetch-request",
      requestId: "req-fail",
      peerId: "peer-a",
      method: "GET",
      url: "/",
      headers: {},
    };

    act(() => {
      dispatchBCMessage(request);
    });

    // Should call send once (the tunnel:request), fail, and not send request-end
    expect(sendTunnelMessage).toHaveBeenCalledTimes(1);
    // No error posted to BC — silent drop
    expect(getPosted()).toEqual([]);
  });

  test("limits concurrent relay requests to MAX_CONCURRENT_RELAY_REQUESTS", () => {
    const { options, sendTunnelMessage, dispatchBCMessage } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    // Fill up 8 slots
    for (let i = 0; i < 8; i++) {
      act(() => {
        dispatchBCMessage({
          kind: "sw-fetch-request",
          requestId: `req-${i}`,
          peerId: "peer-a",
          method: "GET",
          url: "/",
          headers: {},
        } as SwFetchRequest);
      });
    }

    const callsBefore = sendTunnelMessage.mock.calls.length;

    // 9th request should be silently dropped
    act(() => {
      dispatchBCMessage({
        kind: "sw-fetch-request",
        requestId: "req-overflow",
        peerId: "peer-a",
        method: "GET",
        url: "/",
        headers: {},
      } as SwFetchRequest);
    });

    expect(sendTunnelMessage.mock.calls.length).toBe(callsBefore);
  });

  test("relay request times out and sends sw-fetch-error", () => {
    const { options, dispatchBCMessage, getPosted } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchBCMessage({
        kind: "sw-fetch-request",
        requestId: "req-timeout",
        peerId: "peer-a",
        method: "GET",
        url: "/slow",
        headers: {},
      } as SwFetchRequest);
    });

    // Advance past 35s timeout
    act(() => {
      vi.advanceTimersByTime(35_000);
    });

    const errors = getPosted().filter((m) => (m as Record<string, unknown>).kind === "sw-fetch-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      kind: "sw-fetch-error",
      requestId: "req-timeout",
      message: "tunnel relay timeout",
    });
  });

  // ---------- tunnel:response relay back to BroadcastChannel ----------

  test("relays complete tunnel response back to BroadcastChannel", () => {
    const { options, dispatchBCMessage, dispatchTunnel, getPosted } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    // Start a request
    act(() => {
      dispatchBCMessage({
        kind: "sw-fetch-request",
        requestId: "req-r1",
        peerId: "peer-a",
        method: "GET",
        url: "/page",
        headers: {},
      } as SwFetchRequest);
    });

    // Simulate response from peer
    act(() => {
      dispatchTunnel("peer-a", {
        type: "tunnel:response",
        requestId: "req-r1",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      });
      dispatchTunnel("peer-a", {
        type: "tunnel:response-body",
        requestId: "req-r1",
        data: "PGh0bWw+",
      });
      dispatchTunnel("peer-a", {
        type: "tunnel:response-body",
        requestId: "req-r1",
        data: "PC9odG1sPg==",
      });
      dispatchTunnel("peer-a", {
        type: "tunnel:response-end",
        requestId: "req-r1",
      });
    });

    const responses = getPosted().filter((m) => (m as Record<string, unknown>).kind === "sw-fetch-response");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({
      kind: "sw-fetch-response",
      requestId: "req-r1",
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html" },
      bodyBase64: "PGh0bWw+PC9odG1sPg==",
    });
  });

  test("tunnel:response for unknown requestId creates a new pending entry", () => {
    const { options, dispatchTunnel, getPosted } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    // Response arrives before (or without) any sw-fetch-request — still buffers
    act(() => {
      dispatchTunnel("peer-a", {
        type: "tunnel:response",
        requestId: "orphan-1",
        status: 404,
        statusText: "Not Found",
        headers: {},
      });
      dispatchTunnel("peer-a", {
        type: "tunnel:response-end",
        requestId: "orphan-1",
      });
    });

    const responses = getPosted().filter((m) => (m as Record<string, unknown>).kind === "sw-fetch-response");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ requestId: "orphan-1", status: 404 });
  });

  test("tunnel:response-body for unknown requestId is silently ignored", () => {
    const { options, dispatchTunnel, getPosted } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-a", {
        type: "tunnel:response-body",
        requestId: "ghost",
        data: "abc",
      });
    });

    // No crash, no BC message
    expect(getPosted()).toEqual([]);
  });

  test("tunnel:response-end for unknown requestId is silently ignored", () => {
    const { options, dispatchTunnel, getPosted } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-a", {
        type: "tunnel:response-end",
        requestId: "ghost",
      });
    });

    expect(getPosted()).toEqual([]);
  });

  // ---------- tunnel:error ----------

  test("tunnel:error with requestId forwards error to BroadcastChannel", () => {
    const { options, dispatchBCMessage, dispatchTunnel, getPosted } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    // Start a request
    act(() => {
      dispatchBCMessage({
        kind: "sw-fetch-request",
        requestId: "req-err",
        peerId: "peer-a",
        method: "GET",
        url: "/fail",
        headers: {},
      } as SwFetchRequest);
    });

    act(() => {
      dispatchTunnel("peer-a", {
        type: "tunnel:error",
        requestId: "req-err",
        message: "connection refused",
      });
    });

    const errors = getPosted().filter((m) => (m as Record<string, unknown>).kind === "sw-fetch-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      kind: "sw-fetch-error",
      requestId: "req-err",
      message: "connection refused",
    });
  });

  test("tunnel:error without requestId is silently ignored", () => {
    const { options, dispatchTunnel, getPosted } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-a", {
        type: "tunnel:error",
        message: "generic error",
      });
    });

    expect(getPosted()).toEqual([]);
  });

  test("tunnel:error for unknown requestId still forwards error to BroadcastChannel", () => {
    const { options, dispatchTunnel, getPosted } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-a", {
        type: "tunnel:error",
        requestId: "no-such-request",
        message: "boom",
      });
    });

    // The error is forwarded regardless of whether the requestId was pending
    const errors = getPosted().filter((m) => (m as Record<string, unknown>).kind === "sw-fetch-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      kind: "sw-fetch-error",
      requestId: "no-such-request",
      message: "boom",
    });
  });

  // ---------- openTunnel ----------

  test("openTunnel for server relay tunnel claims viewer and opens prefix URL", async () => {
    const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ prefix: "https://tunnel.example.com/abc123/" }),
    });

    const { options } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      result.current.addServerRelayTunnel({
        peerId: "relay-1",
        label: "Relay",
        prefix: "https://tunnel.example.com/abc123/",
      });
    });

    await act(async () => {
      await result.current.openTunnel("relay-1");
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/test-session-token/tunnels/relay-1/viewer",
      { method: "POST" },
    );
    expect(windowOpenSpy).toHaveBeenCalledWith(
      "/tunnel-view/relay-1?serverRelay=1#https%3A%2F%2Ftunnel.example.com%2Fabc123%2F",
      "_blank",
      "noopener",
    );
    windowOpenSpy.mockRestore();
  });

  test("openTunnel for server relay tunnel throws on non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });

    const { options } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      result.current.addServerRelayTunnel({ peerId: "relay-1", label: "Relay" });
    });

    await expect(
      act(async () => { await result.current.openTunnel("relay-1"); })
    ).rejects.toThrow("failed to claim tunnel viewer: 404");
  });

  test("openTunnel for server relay tunnel throws when no prefix returned", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const { options } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      result.current.addServerRelayTunnel({ peerId: "relay-1", label: "Relay" });
    });

    await expect(
      act(async () => { await result.current.openTunnel("relay-1"); })
    ).rejects.toThrow("failed to claim tunnel viewer");
  });

  test("openTunnel for WebRTC tunnel registers SW and opens tunnel-view URL", async () => {
    const fakeWorker = { state: "activated" as string, addEventListener: vi.fn() };
    const registerMock = vi.fn(async () => ({ active: fakeWorker, installing: null, waiting: null }));
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });
    const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const { options, dispatchTunnel } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-w", { type: "tunnel:announce", label: "WebRTC App" });
    });

    await act(async () => {
      await result.current.openTunnel("peer-w");
    });

    expect(registerMock).toHaveBeenCalledWith("/tunnel-sw2.js", { scope: "/tunnel/", updateViaCache: "none" });
    expect(windowOpenSpy).toHaveBeenCalledWith("/tunnel-view/peer-w/", "_blank", "noopener");
    windowOpenSpy.mockRestore();
  });

  test("openTunnel for WebRTC tunnel waits for SW activation when not active", async () => {
    let stateChangeHandler: (() => void) | null = null;
    const fakeWorker = {
      state: "installing" as string,
      addEventListener: vi.fn((_event: string, handler: () => void) => {
        stateChangeHandler = handler;
      }),
    };
    const registerMock = vi.fn(async () => ({ active: null, installing: fakeWorker, waiting: null }));
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });
    const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const { options, dispatchTunnel } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-w", { type: "tunnel:announce", label: "App" });
    });

    // Start openTunnel — it will wait for activation
    let openPromise: Promise<void>;
    await act(async () => {
      openPromise = result.current.openTunnel("peer-w");
      // Let the register promise resolve
      await vi.advanceTimersByTimeAsync(0);
    });

    // SW not activated yet — window.open not called
    expect(windowOpenSpy).not.toHaveBeenCalled();

    // Activate the worker
    await act(async () => {
      fakeWorker.state = "activated";
      stateChangeHandler?.();
      await openPromise!;
    });

    expect(windowOpenSpy).toHaveBeenCalledWith("/tunnel-view/peer-w/", "_blank", "noopener");
    windowOpenSpy.mockRestore();
  });

  // ---------- Cleanup on unmount ----------

  test("cleanup closes BroadcastChannel and unsubscribes on unmount", () => {
    const { options, tunnelListeners } = makeOptions();
    const { unmount } = renderHook(() => useTunnelRelay(options));

    const bcInstance = FakeBroadcastChannel.instances[0];
    expect(bcInstance.closed).toBe(false);
    expect(tunnelListeners.size).toBe(1);

    unmount();

    expect(bcInstance.closed).toBe(true);
    expect(tunnelListeners.size).toBe(0);
  });

  test("cleanup clears pending response timers on unmount", () => {
    const { options, dispatchBCMessage } = makeOptions();
    const { unmount } = renderHook(() => useTunnelRelay(options));

    // Create a pending request
    act(() => {
      dispatchBCMessage({
        kind: "sw-fetch-request",
        requestId: "req-pending",
        peerId: "peer-a",
        method: "GET",
        url: "/",
        headers: {},
      } as SwFetchRequest);
    });

    // Unmount should clear timers without errors
    unmount();

    // Advancing timers after unmount should not cause errors or BC messages
    act(() => {
      vi.advanceTimersByTime(35_000);
    });
    // BC is closed, so no messages can be posted
  });

  // ---------- Non-string tunnel messages ----------

  test("ignores non-string (ArrayBuffer) tunnel messages", () => {
    const { options, tunnelListeners } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      for (const l of tunnelListeners) {
        l("peer-a", new ArrayBuffer(10));
      }
    });

    expect(result.current.tunnels).toEqual([]);
  });

  test("ignores malformed JSON tunnel messages", () => {
    const { options, tunnelListeners } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      for (const l of tunnelListeners) {
        l("peer-a", "{invalid json");
      }
    });

    expect(result.current.tunnels).toEqual([]);
  });

  // ---------- Edge case: duplicate peerId across WebRTC announce and addServerRelayTunnel ----------

  test("addServerRelayTunnel overwrites existing WebRTC tunnel with same peerId", () => {
    const { options, dispatchTunnel } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("shared-peer", { type: "tunnel:announce", label: "WebRTC" });
    });
    expect(result.current.tunnels).toHaveLength(1);
    expect(result.current.tunnels[0].serverRelay).toBeUndefined();

    // addServerRelayTunnel finds existing entry by peerId and replaces it
    act(() => {
      result.current.addServerRelayTunnel({ peerId: "shared-peer", label: "Relay", prefix: "/r/" });
    });
    expect(result.current.tunnels).toHaveLength(1);
    expect(result.current.tunnels[0].serverRelay).toBe(true);
    expect(result.current.tunnels[0].label).toBe("Relay");
  });

  // ---------- SW registration for WebRTC tunnels ----------

  test("sets swReady when SW is already active on registration", async () => {
    const fakeWorker = { state: "activated" as string, addEventListener: vi.fn() };
    const registerMock = vi.fn(async () => ({
      active: fakeWorker,
      installing: null,
      waiting: null,
    }));
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });

    const { options, dispatchTunnel, connectedPeerIds } = makeOptions();
    connectedPeerIds.add("peer-sw");
    const { result } = renderHook(() => useTunnelRelay(options));

    // Add a WebRTC tunnel (not server relay) to trigger SW registration
    act(() => {
      dispatchTunnel("peer-sw", { type: "tunnel:announce", label: "App" });
    });

    // Let the registration promise resolve
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(registerMock).toHaveBeenCalledWith("/tunnel-sw2.js", { scope: "/tunnel/", updateViaCache: "none" });
    expect(result.current.swReady).toBe(true);
  });

  test("sets swReady after SW worker transitions to activated state", async () => {
    let stateChangeListener: (() => void) | null = null;
    const fakeWorker = {
      state: "installing" as string,
      addEventListener: vi.fn((_event: string, handler: () => void) => {
        stateChangeListener = handler;
      }),
    };
    const registerMock = vi.fn(async () => ({
      active: null,
      installing: fakeWorker,
      waiting: null,
    }));
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });

    const { options, dispatchTunnel, connectedPeerIds } = makeOptions();
    connectedPeerIds.add("peer-sw2");
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-sw2", { type: "tunnel:announce", label: "App" });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // SW not yet active
    expect(result.current.swReady).toBe(false);

    // Activate the worker
    act(() => {
      fakeWorker.state = "activated";
      stateChangeListener?.();
    });

    expect(result.current.swReady).toBe(true);
  });

  test("does not register SW when only server relay tunnels exist", async () => {
    const registerMock = vi.fn(async () => ({ active: null, installing: null, waiting: null }));
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });

    const { options } = makeOptions();
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      result.current.addServerRelayTunnel({ peerId: "relay-1", label: "Relay" });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(registerMock).not.toHaveBeenCalled();
    expect(result.current.swReady).toBe(false);
  });

  test("SW registration handles waiting worker that transitions to activated", async () => {
    let stateChangeListener: (() => void) | null = null;
    const fakeWorker = {
      state: "installed" as string,
      addEventListener: vi.fn((_event: string, handler: () => void) => {
        stateChangeListener = handler;
      }),
    };
    const registerMock = vi.fn(async () => ({
      active: null,
      installing: null,
      waiting: fakeWorker,
    }));
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });

    const { options, dispatchTunnel, connectedPeerIds } = makeOptions();
    connectedPeerIds.add("peer-sw3");
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-sw3", { type: "tunnel:announce", label: "App" });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.swReady).toBe(false);

    act(() => {
      fakeWorker.state = "activated";
      stateChangeListener?.();
    });

    expect(result.current.swReady).toBe(true);
  });

  // ---------- tunnel:response timeout for orphan responses ----------

  test("tunnel:response for unknown requestId times out and cleans up", () => {
    const { options, dispatchTunnel, getPosted } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    // Response arrives without a prior sw-fetch-request (orphan)
    act(() => {
      dispatchTunnel("peer-a", {
        type: "tunnel:response",
        requestId: "orphan-timeout",
        status: 200,
        statusText: "OK",
        headers: {},
      });
    });

    // Advance past the 35s timeout
    act(() => {
      vi.advanceTimersByTime(35_000);
    });

    // No error posted (it just cleans up the orphan entry silently)
    const errors = getPosted().filter((m) => (m as Record<string, unknown>).kind === "sw-fetch-error");
    expect(errors).toHaveLength(0);
  });

  test("SW registration failure is caught and logged", async () => {
    const registerMock = vi.fn(async () => { throw new Error("SW registration failed"); });
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      writable: true,
      configurable: true,
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { options, dispatchTunnel, connectedPeerIds } = makeOptions();
    connectedPeerIds.add("peer-fail");
    const { result } = renderHook(() => useTunnelRelay(options));

    act(() => {
      dispatchTunnel("peer-fail", { type: "tunnel:announce", label: "App" });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[tunnel] Service Worker registration failed:",
      expect.any(Error),
    );
    expect(result.current.swReady).toBe(false);
    consoleSpy.mockRestore();
  });

  // ---------- Concurrency: slot freed after response-end allows new requests ----------

  test("completing a response frees a relay slot for new requests", () => {
    const { options, sendTunnelMessage, dispatchBCMessage, dispatchTunnel } = makeOptions();
    renderHook(() => useTunnelRelay(options));

    // Fill 8 slots
    for (let i = 0; i < 8; i++) {
      act(() => {
        dispatchBCMessage({
          kind: "sw-fetch-request",
          requestId: `req-${i}`,
          peerId: "peer-a",
          method: "GET",
          url: "/",
          headers: {},
        } as SwFetchRequest);
      });
    }

    // Complete one request
    act(() => {
      dispatchTunnel("peer-a", { type: "tunnel:response", requestId: "req-0", status: 200, statusText: "OK", headers: {} });
      dispatchTunnel("peer-a", { type: "tunnel:response-end", requestId: "req-0" });
    });

    const callsBefore = sendTunnelMessage.mock.calls.length;

    // 9th request should now succeed
    act(() => {
      dispatchBCMessage({
        kind: "sw-fetch-request",
        requestId: "req-new",
        peerId: "peer-a",
        method: "GET",
        url: "/new",
        headers: {},
      } as SwFetchRequest);
    });

    expect(sendTunnelMessage.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
