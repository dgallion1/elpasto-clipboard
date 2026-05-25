// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const { buildApiUrlMock } = vi.hoisted(() => ({
  buildApiUrlMock: vi.fn((path: string) => `https://api.test${path}`),
}));
vi.mock("@/lib/api", () => ({ buildApiUrl: buildApiUrlMock }));

import { useSessionLoader } from "./useSessionLoader";
import type { SessionData } from "./session-page-types";

const TOKEN = "test-token";

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    token: TOKEN,
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: "2026-01-02T00:00:00Z",
    clips: { A: [] },
    ...overrides,
  } as unknown as SessionData;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();
let onLoaded: ReturnType<typeof vi.fn<(data: SessionData) => void>>;
let onMissing: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  fetchMock.mockReset();
  buildApiUrlMock.mockClear();
  buildApiUrlMock.mockImplementation((path: string) => `https://api.test${path}`);
  onLoaded = vi.fn<(data: SessionData) => void>();
  onMissing = vi.fn<() => void>();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => cleanup());

describe("useSessionLoader happy path", () => {
  test("foreground load: sets loading then resolves with session data and clears error", async () => {
    const data = makeSession();
    fetchMock.mockResolvedValueOnce(jsonResponse(data));

    const { result } = renderHook(() =>
      useSessionLoader({
        token: TOKEN,
        onSessionLoaded: onLoaded,
        onSessionMissing: onMissing,
      }),
    );

    expect(result.current.loading).toBe(true);

    await act(async () => {
      await result.current.loadSession({ showLoading: true });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(onLoaded).toHaveBeenCalledWith(data);
    expect(onMissing).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.test/api/sessions/${TOKEN}`,
    );
  });

  test("background load: does not change loading on success", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeSession()));

    const { result } = renderHook(() =>
      useSessionLoader({
        token: TOKEN,
        onSessionLoaded: onLoaded,
        onSessionMissing: onMissing,
      }),
    );

    await act(async () => {
      await result.current.loadSession({ showLoading: false });
    });
    // Background success still clears `loading` in the finally block,
    // so foreground/background converge on a final loading=false.
    expect(result.current.loading).toBe(false);
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });
});

describe("useSessionLoader 404 recreate + retry", () => {
  test("calls onSessionLoaded when recreate succeeds and retry returns data", async () => {
    const recreated = makeSession({ token: TOKEN });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 200)) // recreate batch
      .mockResolvedValueOnce(jsonResponse(recreated)); // retry GET

    const { result } = renderHook(() =>
      useSessionLoader({
        token: TOKEN,
        onSessionLoaded: onLoaded,
        onSessionMissing: onMissing,
      }),
    );

    await act(async () => {
      await result.current.loadSession({ showLoading: true });
    });

    expect(onLoaded).toHaveBeenCalledWith(recreated);
    expect(onMissing).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();

    // batch body is the recreate payload
    const batchCall = fetchMock.mock.calls[1]!;
    expect(JSON.parse(batchCall[1]!.body as string)).toEqual({
      tokens: [TOKEN],
    });
  });

  test("foreground: sets error and calls onSessionMissing when recreate batch is not ok", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 500)); // recreate failed

    const { result } = renderHook(() =>
      useSessionLoader({
        token: TOKEN,
        onSessionLoaded: onLoaded,
        onSessionMissing: onMissing,
      }),
    );

    await act(async () => {
      await result.current.loadSession({ showLoading: true });
    });

    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe("Session not found or expired");
    expect(onLoaded).not.toHaveBeenCalled();
  });

  test("background: stays silent when recreate fails (does not clear state)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 500));

    const { result } = renderHook(() =>
      useSessionLoader({
        token: TOKEN,
        onSessionLoaded: onLoaded,
        onSessionMissing: onMissing,
      }),
    );

    await act(async () => {
      await result.current.loadSession({ showLoading: false });
    });
    expect(onMissing).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  test("recreate throws → falls through to missing path (foreground)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() =>
      useSessionLoader({
        token: TOKEN,
        onSessionLoaded: onLoaded,
        onSessionMissing: onMissing,
      }),
    );

    await act(async () => {
      await result.current.loadSession({ showLoading: true });
    });
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe("Session not found or expired");
  });

  test("retry GET non-ok falls through to missing (foreground)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 200))
      .mockResolvedValueOnce(jsonResponse({}, 503)); // retry not ok

    const { result } = renderHook(() =>
      useSessionLoader({
        token: TOKEN,
        onSessionLoaded: onLoaded,
        onSessionMissing: onMissing,
      }),
    );

    await act(async () => {
      await result.current.loadSession({ showLoading: true });
    });
    expect(onLoaded).not.toHaveBeenCalled();
    expect(onMissing).toHaveBeenCalled();
    expect(result.current.error).toBe("Session not found or expired");
  });
});

describe("useSessionLoader non-404 failures", () => {
  test("foreground: 500 response sets error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));

    const { result } = renderHook(() =>
      useSessionLoader({
        token: TOKEN,
        onSessionLoaded: onLoaded,
        onSessionMissing: onMissing,
      }),
    );

    await act(async () => {
      await result.current.loadSession({ showLoading: true });
    });
    expect(result.current.error).toBe("Failed to load session");
    expect(onLoaded).not.toHaveBeenCalled();
    expect(onMissing).not.toHaveBeenCalled();
  });

  test("background: 500 response is silent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));

    const { result } = renderHook(() =>
      useSessionLoader({
        token: TOKEN,
        onSessionLoaded: onLoaded,
        onSessionMissing: onMissing,
      }),
    );

    await act(async () => {
      await result.current.loadSession({ showLoading: false });
    });
    expect(result.current.error).toBeNull();
  });

  test("foreground: fetch rejection sets error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));

    const { result } = renderHook(() =>
      useSessionLoader({
        token: TOKEN,
        onSessionLoaded: onLoaded,
        onSessionMissing: onMissing,
      }),
    );

    await act(async () => {
      await result.current.loadSession({ showLoading: true });
    });
    expect(result.current.error).toBe("Failed to load session");
  });

  test("background: fetch rejection is silent", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));

    const { result } = renderHook(() =>
      useSessionLoader({
        token: TOKEN,
        onSessionLoaded: onLoaded,
        onSessionMissing: onMissing,
      }),
    );

    await act(async () => {
      await result.current.loadSession({ showLoading: false });
    });
    expect(result.current.error).toBeNull();
  });
});

describe("useSessionLoader stale request guard", () => {
  test("a later load supersedes an earlier in-flight load — no callbacks from the stale one", async () => {
    // First fetch resolves slowly; second fetch resolves immediately with
    // different data. Only the second call's callbacks should fire.
    let resolveFirst!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const fast = makeSession({ token: "fast" });
    fetchMock.mockResolvedValueOnce(jsonResponse(fast));

    const { result } = renderHook(() =>
      useSessionLoader({
        token: TOKEN,
        onSessionLoaded: onLoaded,
        onSessionMissing: onMissing,
      }),
    );

    // Kick off slow load
    let slowPromise!: Promise<void>;
    act(() => {
      slowPromise = result.current.loadSession({ showLoading: true });
    });

    // Kick off fast load — request id bumps, slow load becomes stale.
    await act(async () => {
      await result.current.loadSession({ showLoading: true });
    });

    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledWith(fast);

    // Now resolve the slow one — it must NOT call onLoaded again.
    await act(async () => {
      resolveFirst(jsonResponse(makeSession({ token: "slow" })));
      await slowPromise;
    });

    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  test("a stale 404 path does not call onSessionMissing or setError", async () => {
    // Slow 404 followed by a fast successful load.
    let resolveFirst!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(makeSession()));

    const { result } = renderHook(() =>
      useSessionLoader({
        token: TOKEN,
        onSessionLoaded: onLoaded,
        onSessionMissing: onMissing,
      }),
    );

    let slowPromise!: Promise<void>;
    act(() => {
      slowPromise = result.current.loadSession({ showLoading: true });
    });
    await act(async () => {
      await result.current.loadSession({ showLoading: true });
    });

    expect(result.current.error).toBeNull();
    expect(onLoaded).toHaveBeenCalledTimes(1);

    // Resolve the slow load as 404 — recreate would also fire but the request
    // id check should bail before we get there.
    await act(async () => {
      resolveFirst(jsonResponse({}, 404));
      await slowPromise;
    });

    expect(onMissing).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });
});

describe("useSessionLoader callback identity", () => {
  test("re-renders with new callbacks do not reset loadSession identity", async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeSession()));

    const { result, rerender } = renderHook(
      ({
        onLoaded: l,
        onMissing: m,
      }: {
        onLoaded: typeof onLoaded;
        onMissing: typeof onMissing;
      }) =>
        useSessionLoader({
          token: TOKEN,
          onSessionLoaded: l,
          onSessionMissing: m,
        }),
      { initialProps: { onLoaded, onMissing } },
    );

    const firstLoad = result.current.loadSession;

    const newOnLoaded = vi.fn();
    rerender({ onLoaded: newOnLoaded, onMissing });

    expect(result.current.loadSession).toBe(firstLoad);

    // Loading after rerender uses the new callback via ref.
    await act(async () => {
      await result.current.loadSession({ showLoading: false });
    });
    await waitFor(() => expect(newOnLoaded).toHaveBeenCalled());
    expect(onLoaded).not.toHaveBeenCalled();
  });
});
