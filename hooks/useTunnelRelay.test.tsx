// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { UseTunnelRelayOptions } from "./useTunnelRelay";

// BroadcastChannel is not available in jsdom — stub it out.
class FakeBroadcastChannel {
  name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(name: string) { this.name = name; }
  postMessage(_msg: unknown) {}
  close() {}
}

let useTunnelRelay: typeof import("./useTunnelRelay").useTunnelRelay;

beforeEach(async () => {
  globalThis.BroadcastChannel = FakeBroadcastChannel as unknown as typeof BroadcastChannel;
  ({ useTunnelRelay } = await import("./useTunnelRelay"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeOptions(overrides?: Partial<UseTunnelRelayOptions>): UseTunnelRelayOptions {
  return {
    sessionToken: "amber-anchor-apple-arch-arrow",
    sendTunnelMessage: vi.fn(() => false),
    subscribeTunnel: vi.fn(() => () => {}),
    connectedPeerIds: new Set<string>(),
    ...overrides,
  };
}

describe("useTunnelRelay — server-relay tunnels", () => {
  test("addServerRelayTunnel adds a tunnel with serverRelay:true", async () => {
    const { result } = renderHook(() => useTunnelRelay(makeOptions()));

    expect(result.current.tunnels).toHaveLength(0);

    await act(async () => {
      result.current.addServerRelayTunnel({ peerId: "peer-sr-1", label: "my-app", port: 9000, prefix: "/relay/peer-sr-1/" });
    });

    expect(result.current.tunnels).toHaveLength(1);
    expect(result.current.tunnels[0]).toMatchObject({
      peerId: "peer-sr-1",
      label: "my-app",
      port: 9000,
      serverRelay: true,
    });
  });

  test("addServerRelayTunnel updates existing entry when called with the same peerId", async () => {
    const { result } = renderHook(() => useTunnelRelay(makeOptions()));

    await act(async () => {
      result.current.addServerRelayTunnel({ peerId: "peer-sr-2", label: "v1", port: 8080 });
    });

    expect(result.current.tunnels).toHaveLength(1);
    expect(result.current.tunnels[0].label).toBe("v1");

    // Simulate reconnect — same peerId, updated metadata.
    await act(async () => {
      result.current.addServerRelayTunnel({ peerId: "peer-sr-2", label: "v2", port: 8081 });
    });

    expect(result.current.tunnels).toHaveLength(1);
    expect(result.current.tunnels[0]).toMatchObject({
      peerId: "peer-sr-2",
      label: "v2",
      port: 8081,
      serverRelay: true,
    });
  });

  test("removeServerRelayTunnel removes a server-relay entry", async () => {
    const { result } = renderHook(() => useTunnelRelay(makeOptions()));

    await act(async () => {
      result.current.addServerRelayTunnel({ peerId: "peer-sr-3" });
    });

    expect(result.current.tunnels).toHaveLength(1);

    await act(async () => {
      result.current.removeServerRelayTunnel("peer-sr-3");
    });

    expect(result.current.tunnels).toHaveLength(0);
  });

  test("removeServerRelayTunnel does not remove non-server-relay tunnels with same peerId", async () => {
    // Inject a WebRTC tunnel directly by calling subscribeTunnel's listener.
    let tunnelListener: ((peerId: string, data: string | ArrayBuffer) => void) | null = null;
    const subscribeTunnel = vi.fn((listener: (peerId: string, data: string | ArrayBuffer) => void) => {
      tunnelListener = listener;
      return () => {};
    });

    const { result } = renderHook(() =>
      useTunnelRelay(makeOptions({
        subscribeTunnel,
        connectedPeerIds: new Set(["peer-webrtc"]),
      }))
    );

    // Inject a WebRTC tunnel:announce via the subscribe listener.
    await act(async () => {
      tunnelListener?.("peer-webrtc", JSON.stringify({ type: "tunnel:announce", label: "webrtc-app", port: 3000 }));
    });

    expect(result.current.tunnels).toHaveLength(1);
    expect(result.current.tunnels[0].serverRelay).toBeUndefined();

    // removeServerRelayTunnel for the same peerId should be a no-op (the tunnel is not serverRelay).
    await act(async () => {
      result.current.removeServerRelayTunnel("peer-webrtc");
    });

    expect(result.current.tunnels).toHaveLength(1);
    expect(result.current.tunnels[0].peerId).toBe("peer-webrtc");
  });

  test("server-relay tunnels survive connectedPeerIds changes (not pruned)", async () => {
    const connectedPeerIds = new Set<string>();
    const { result, rerender } = renderHook(
      (ids: ReadonlySet<string>) => useTunnelRelay(makeOptions({ connectedPeerIds: ids })),
      { initialProps: connectedPeerIds }
    );

    await act(async () => {
      result.current.addServerRelayTunnel({ peerId: "peer-relay-server" });
    });

    expect(result.current.tunnels).toHaveLength(1);

    // Simulate peer list changing — "peer-relay-server" is NOT in the connected set.
    await act(async () => {
      rerender(new Set(["some-other-peer"]));
    });

    // Server-relay tunnel should still be present.
    expect(result.current.tunnels).toHaveLength(1);
    expect(result.current.tunnels[0].peerId).toBe("peer-relay-server");
    expect(result.current.tunnels[0].serverRelay).toBe(true);
  });

  test("openTunnel claims a viewer prefix and opens the capability URL directly", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ prefix: "/api/tunnel/peer-sr-open/token-123/" }),
    }));
    const openMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("open", openMock);

    const { result } = renderHook(() => useTunnelRelay(makeOptions()));

    await act(async () => {
      result.current.addServerRelayTunnel({ peerId: "peer-sr-open", label: "viewer" });
    });

    await act(async () => {
      await result.current.openTunnel("peer-sr-open");
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/amber-anchor-apple-arch-arrow/tunnels/peer-sr-open/viewer",
      { method: "POST" }
    );
    expect(openMock).toHaveBeenCalledWith(
      "/tunnel-view/peer-sr-open?serverRelay=1#%2Fapi%2Ftunnel%2Fpeer-sr-open%2Ftoken-123%2F",
      "_blank",
      "noopener"
    );
  });

  test("non-server-relay tunnels ARE pruned when peer disconnects", async () => {
    let tunnelListener: ((peerId: string, data: string | ArrayBuffer) => void) | null = null;
    const subscribeTunnel = vi.fn((listener: (peerId: string, data: string | ArrayBuffer) => void) => {
      tunnelListener = listener;
      return () => {};
    });

    const initialPeerIds = new Set(["peer-webrtc-gone"]);
    const { result, rerender } = renderHook(
      (ids: ReadonlySet<string>) => useTunnelRelay(makeOptions({ subscribeTunnel, connectedPeerIds: ids })),
      { initialProps: initialPeerIds }
    );

    await act(async () => {
      tunnelListener?.("peer-webrtc-gone", JSON.stringify({ type: "tunnel:announce", label: "app", port: 3000 }));
    });

    expect(result.current.tunnels).toHaveLength(1);

    // Peer disappears from connected set.
    await act(async () => {
      rerender(new Set<string>());
    });

    expect(result.current.tunnels).toHaveLength(0);
  });

  // Note: Testing openTunnel with window.open is skipped here because it requires
  // Service Worker APIs (navigator.serviceWorker.register) that jsdom does not support.
  // The server-relay path of openTunnel (window.open(tunnel.prefix)) could theoretically
  // be tested, but the surrounding swReady guard and SW registration make it unwieldy
  // without a more complete SW mock. The openTunnel function is covered by the hook's
  // return signature test and by manual end-to-end testing.
});
