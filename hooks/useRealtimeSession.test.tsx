// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Clip } from "@/lib/clips";
import type { PeerSignalMessage } from "@/lib/realtime-session";

const buildApiUrlMock = vi.fn((path: string) => path);

class FakeEventSource {
  closed = false;
  readonly url: string;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    fakeEventSources.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }

  dispatch(type: string, data?: unknown) {
    const event = data === undefined
      ? new Event(type)
      : new MessageEvent(type, {
          data: typeof data === "string" ? data : JSON.stringify(data),
        });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

let fakeEventSources: FakeEventSource[] = [];
const fetchMock = vi.fn();

vi.mock("@/lib/api", () => ({
  buildApiUrl: buildApiUrlMock,
  buildSseUrl: buildApiUrlMock,
}));

let useRealtimeSession: typeof import("./useRealtimeSession").useRealtimeSession;

beforeAll(async () => {
  ({ useRealtimeSession } = await import("./useRealtimeSession"));
});

beforeEach(() => {
  fakeEventSources = [];
  buildApiUrlMock.mockReset();
  buildApiUrlMock.mockImplementation((path: string) => path);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({}),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useRealtimeSession", () => {
  test("uses SSE signaling for session events and peer signaling", async () => {
    const onClipCreated = vi.fn();
    const onClipDeleted = vi.fn();
    const onClipsCleared = vi.fn();
    const onPeerSignal = vi.fn();
    const onSessionExpired = vi.fn();

    const { result } = renderHook(() =>
      useRealtimeSession({
        token: "session-2",
        onClipCreated,
        onClipDeleted,
        onClipsCleared,
        onSessionExpired,
        onPeerSignal,
      })
    );

    expect(fakeEventSources).toHaveLength(1);
    const [eventSource] = fakeEventSources;
    expect(eventSource.url).toBe("/api/sessions/session-2/events");

    await act(async () => {
      eventSource.dispatch("open");
    });
    expect(result.current.signalingReady).toBe(true);

    const clip = { id: 7, zone: "B" } as Clip;
    const deleted = { id: 7, zone: "B" as const };
    const cleared = { zone: "B" as const };
    const peerMessage = {
      fromPeerId: "peer-z",
      signalType: "description",
      description: { type: "offer", sdp: "fake" },
    } satisfies PeerSignalMessage;

    await act(async () => {
      eventSource.dispatch("clip:created", clip);
      eventSource.dispatch("clip:deleted", deleted);
      eventSource.dispatch("clips:cleared", cleared);
      eventSource.dispatch("peer:signal", peerMessage);
      eventSource.dispatch("peer:signal", "{invalid");
      eventSource.dispatch("error");
    });

    expect(onClipCreated).toHaveBeenCalledWith(clip);
    expect(onClipDeleted).toHaveBeenCalledWith(deleted);
    expect(onClipsCleared).toHaveBeenCalledWith(cleared);
    expect(onPeerSignal).toHaveBeenCalledWith(peerMessage);
    expect(onPeerSignal).toHaveBeenCalledTimes(1);
    expect(result.current.signalingReady).toBe(false);

    let sent = false;
    await act(async () => {
      sent = await result.current.sendPeerSignal(peerMessage);
    });

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-2/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(peerMessage),
    });

    await act(async () => {
      eventSource.dispatch("session:expired");
    });

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(eventSource.closed).toBe(true);
    expect(result.current.signalingReady).toBe(false);
  });

  test("calls onTunnelAnnounce when tunnel:announce SSE event fires", async () => {
    const onTunnelAnnounce = vi.fn();

    renderHook(() =>
      useRealtimeSession({
        token: "session-ta",
        onClipCreated: vi.fn(),
        onClipDeleted: vi.fn(),
        onClipsCleared: vi.fn(),
        onSessionExpired: vi.fn(),
        onPeerSignal: vi.fn(),
        onTunnelAnnounce,
      })
    );

    const [eventSource] = fakeEventSources;

    await act(async () => {
      eventSource.dispatch("tunnel:announce", {
        peerId: "peer-tunnel-1",
        label: "my-app",
        port: 9000,
        serverRelay: true,
      });
    });

    expect(onTunnelAnnounce).toHaveBeenCalledOnce();
    expect(onTunnelAnnounce).toHaveBeenCalledWith({
      peerId: "peer-tunnel-1",
      label: "my-app",
      port: 9000,
      serverRelay: true,
    });
  });

  test("calls onTunnelClose when tunnel:close SSE event fires", async () => {
    const onTunnelClose = vi.fn();

    renderHook(() =>
      useRealtimeSession({
        token: "session-tc",
        onClipCreated: vi.fn(),
        onClipDeleted: vi.fn(),
        onClipsCleared: vi.fn(),
        onSessionExpired: vi.fn(),
        onPeerSignal: vi.fn(),
        onTunnelClose,
      })
    );

    const [eventSource] = fakeEventSources;

    await act(async () => {
      eventSource.dispatch("tunnel:close", {
        peerId: "peer-tunnel-1",
        serverRelay: true,
      });
    });

    expect(onTunnelClose).toHaveBeenCalledOnce();
    expect(onTunnelClose).toHaveBeenCalledWith({
      peerId: "peer-tunnel-1",
      serverRelay: true,
    });
  });

  test("tunnel SSE events do not throw when callbacks are undefined", async () => {
    // No onTunnelAnnounce / onTunnelClose passed — should be a no-op, not an error.
    renderHook(() =>
      useRealtimeSession({
        token: "session-tno",
        onClipCreated: vi.fn(),
        onClipDeleted: vi.fn(),
        onClipsCleared: vi.fn(),
        onSessionExpired: vi.fn(),
        onPeerSignal: vi.fn(),
        // onTunnelAnnounce and onTunnelClose intentionally omitted
      })
    );

    const [eventSource] = fakeEventSources;

    await expect(
      act(async () => {
        eventSource.dispatch("tunnel:announce", { peerId: "peer-x", serverRelay: true });
        eventSource.dispatch("tunnel:close", { peerId: "peer-x" });
      })
    ).resolves.toBeUndefined();
  });

  test("ignores MessageEvents with non-string data", async () => {
    const onClipCreated = vi.fn();

    renderHook(() =>
      useRealtimeSession({
        token: "session-nonstring",
        onClipCreated,
        onClipDeleted: vi.fn(),
        onClipsCleared: vi.fn(),
        onSessionExpired: vi.fn(),
        onPeerSignal: vi.fn(),
      })
    );

    const [eventSource] = fakeEventSources;

    await act(async () => {
      // Dispatch a MessageEvent whose data is a number (not a string)
      const event = new MessageEvent("clip:created", { data: 42 });
      for (const listener of (eventSource as any).listeners.get("clip:created") ?? []) {
        listener(event);
      }
    });

    expect(onClipCreated).not.toHaveBeenCalled();
  });

  test("ignores clip:deleted events with invalid JSON data", async () => {
    const onClipDeleted = vi.fn();
    renderHook(() =>
      useRealtimeSession({
        token: "session-cd",
        onClipCreated: vi.fn(),
        onClipDeleted,
        onClipsCleared: vi.fn(),
        onSessionExpired: vi.fn(),
        onPeerSignal: vi.fn(),
      })
    );
    const [eventSource] = fakeEventSources;
    await act(async () => {
      eventSource.dispatch("clip:deleted", "{bad json");
    });
    expect(onClipDeleted).not.toHaveBeenCalled();
  });

  test("ignores clips:cleared events with invalid JSON data", async () => {
    const onClipsCleared = vi.fn();
    renderHook(() =>
      useRealtimeSession({
        token: "session-cc",
        onClipCreated: vi.fn(),
        onClipDeleted: vi.fn(),
        onClipsCleared,
        onSessionExpired: vi.fn(),
        onPeerSignal: vi.fn(),
      })
    );
    const [eventSource] = fakeEventSources;
    await act(async () => {
      eventSource.dispatch("clips:cleared", "{bad json");
    });
    expect(onClipsCleared).not.toHaveBeenCalled();
  });

  test("ignores tunnel:announce events with invalid JSON data", async () => {
    const onTunnelAnnounce = vi.fn();
    renderHook(() =>
      useRealtimeSession({
        token: "session-tai",
        onClipCreated: vi.fn(),
        onClipDeleted: vi.fn(),
        onClipsCleared: vi.fn(),
        onSessionExpired: vi.fn(),
        onPeerSignal: vi.fn(),
        onTunnelAnnounce,
      })
    );
    const [eventSource] = fakeEventSources;
    await act(async () => {
      eventSource.dispatch("tunnel:announce", "{bad");
    });
    expect(onTunnelAnnounce).not.toHaveBeenCalled();
  });

  test("ignores tunnel:close events with invalid JSON data", async () => {
    const onTunnelClose = vi.fn();
    renderHook(() =>
      useRealtimeSession({
        token: "session-tci",
        onClipCreated: vi.fn(),
        onClipDeleted: vi.fn(),
        onClipsCleared: vi.fn(),
        onSessionExpired: vi.fn(),
        onPeerSignal: vi.fn(),
        onTunnelClose,
      })
    );
    const [eventSource] = fakeEventSources;
    await act(async () => {
      eventSource.dispatch("tunnel:close", "{bad");
    });
    expect(onTunnelClose).not.toHaveBeenCalled();
  });

  test("sends signal and returns false when fetch fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() =>
      useRealtimeSession({
        token: "session-sigfail",
        onClipCreated: vi.fn(),
        onClipDeleted: vi.fn(),
        onClipsCleared: vi.fn(),
        onSessionExpired: vi.fn(),
        onPeerSignal: vi.fn(),
      })
    );

    const [eventSource] = fakeEventSources;
    await act(async () => {
      eventSource.dispatch("open");
    });

    let sent = true;
    await act(async () => {
      sent = await result.current.sendPeerSignal({
        fromPeerId: "peer-x",
        signalType: "announce",
      });
    });
    expect(sent).toBe(false);
  });

  test("parseEventData returns null for a plain Event (not MessageEvent)", async () => {
    const onClipCreated = vi.fn();
    renderHook(() =>
      useRealtimeSession({
        token: "session-pe",
        onClipCreated,
        onClipDeleted: vi.fn(),
        onClipsCleared: vi.fn(),
        onSessionExpired: vi.fn(),
        onPeerSignal: vi.fn(),
      })
    );
    const [eventSource] = fakeEventSources;
    // Dispatch a raw Event, not a MessageEvent
    await act(async () => {
      eventSource.dispatch("clip:created");
    });
    expect(onClipCreated).not.toHaveBeenCalled();
  });

  test("disables realtime signaling cleanly when the hook is turned off", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useRealtimeSession({
          token: "session-3",
          enabled,
          onClipCreated: vi.fn(),
          onClipDeleted: vi.fn(),
          onClipsCleared: vi.fn(),
          onSessionExpired: vi.fn(),
          onPeerSignal: vi.fn(),
        }),
      {
        initialProps: { enabled: true },
      }
    );

    expect(fakeEventSources).toHaveLength(1);
    const [eventSource] = fakeEventSources;

    await act(async () => {
      eventSource.dispatch("open");
    });
    expect(result.current.signalingReady).toBe(true);

    rerender({ enabled: false });

    let sent = true;
    await act(async () => {
      sent = await result.current.sendPeerSignal({
        fromPeerId: "peer-a",
        signalType: "announce",
      });
    });

    expect(eventSource.closed).toBe(true);
    expect(result.current.signalingReady).toBe(false);
    expect(sent).toBe(false);
  });
});
