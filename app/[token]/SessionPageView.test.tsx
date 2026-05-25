// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { ImportEntry, SessionEntry } from "@/hooks/useSessionHistory";
import type { ImportSessionsResult } from "@/components/paste-zone/types";

// Capture onImportSessions prop from PasteZone for testing
let capturedOnImportSessions:
  | ((entries: ImportEntry[]) => Promise<ImportSessionsResult>)
  | undefined;

// Capture onRenamePeer prop from SessionHeader for testing
let capturedOnRenamePeer: ((peerId: string, name: string) => void) | undefined;
let capturedSessionHeaderProps: Record<string, unknown> | undefined;

vi.mock("@/components/SessionHeader", () => ({
  SessionHeader: (props: Record<string, unknown>) => {
    const onRenamePeer = props.onRenamePeer as ((peerId: string, name: string) => void) | undefined;
    capturedOnRenamePeer = onRenamePeer;
    capturedSessionHeaderProps = props;
    return <div data-testid="session-header" />;
  },
}));

vi.mock("@/components/PasteZone", () => ({
  PasteZone: ({
    zone,
    focusedZone,
    onImportSessions,
  }: {
    zone: string;
    focusedZone: string | null;
    onImportSessions?: (entries: ImportEntry[]) => Promise<ImportSessionsResult>;
  }) => {
    capturedOnImportSessions = onImportSessions;
    return (
      <div
        data-testid={`paste-zone-${zone}`}
        data-focused-zone={focusedZone ?? "null"}
      />
    );
  },
}));

vi.mock("@/components/SecretPrompt", () => ({
  SecretPrompt: () => null,
}));

vi.mock("@/components/IdentifyFlashOverlay", () => ({
  IdentifyFlashOverlay: () => null,
}));

// Mock useSessionHistory so we can control individual methods and entries
const mockImportEntries = vi.fn().mockReturnValue(2);
const mockSetMyPeerName = vi.fn();
let mockHistoryEntries: SessionEntry[] = [];

vi.mock("@/hooks/useSessionHistory", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/hooks/useSessionHistory")>();
  return {
    ...original,
    useSessionHistory: () => ({
      entries: mockHistoryEntries,
      add: vi.fn(),
      setLabel: vi.fn(),
      setMyPeerName: mockSetMyPeerName,
      togglePin: vi.fn(),
      remove: vi.fn(),
      importEntries: mockImportEntries,
    }),
  };
});

let SessionPageView: typeof import("./SessionPageView").SessionPageView;

beforeAll(async () => {
  ({ SessionPageView } = await import("./SessionPageView"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  capturedOnImportSessions = undefined;
  capturedOnRenamePeer = undefined;
  capturedSessionHeaderProps = undefined;
  mockImportEntries.mockReset();
  mockImportEntries.mockReturnValue(2);
  mockSetMyPeerName.mockClear();
  mockHistoryEntries = [];
});

type Props = ComponentProps<typeof SessionPageView>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    loading: false,
    error: null,
    session: {
      token: "test-token",
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-02T00:00:00Z",
      clips: { A: [], B: [] },
    },
    token: "test-token",
    canCopyImage: false,
    unlockSecret: null,
    secretPromptMode: null,
    clearIdentifyFlash: vi.fn(),
    identifyFlash: null,
    localPeerId: "peer-1",
    peerNames: {},
    peers: [],
    pingPeer: vi.fn(),
    readyPeerCount: 0,
    renamePeer: vi.fn(),
    threads: [
      { id: "A", name: "1", position: 0, updatedAt: 1 },
      { id: "B", name: "2", position: 1, updatedAt: 1 },
    ],
    activeThreadId: "A",
    canCreateThread: true,
    onSelectThread: vi.fn(),
    onCreateThread: vi.fn(),
    onRenameThread: vi.fn(),
    onDeleteThread: vi.fn(),
    onMoveThread: vi.fn(),
    zones: [
      { zone: "A", threadName: "1", clips: [], onClearZone: vi.fn() },
      { zone: "B", threadName: "2", clips: [], onClearZone: vi.fn() },
    ],
    getDirectClipCiphertext: vi.fn(() => null),
    getSendProgress: vi.fn(() => null),
    getTransferStats: vi.fn(() => null),
    requestUnlockSecret: vi.fn(),
    onClipAdded: vi.fn(),
    onClipDeleted: vi.fn(),
    onQueueLocalBinaryClip: vi.fn(),
    onClearAll: vi.fn(),
    onGoHome: vi.fn(),
    onManageSecret: vi.fn(),
    onForgetSecret: vi.fn(),
    onSecretSubmit: vi.fn(),
    onSecretCancel: vi.fn(),
    subscribeToSendProgress: vi.fn(() => () => undefined),
    subscribeToDirectTransfers: vi.fn(() => () => undefined),
    tunnels: [],
    swReady: false,
    openTunnel: vi.fn(),
    removeTunnel: vi.fn(),
    sound: {
      enabled: false,
      soundName: "droplet",
      volume: "medium",
      onSetEnabled: vi.fn(),
      onSetSoundName: vi.fn(),
      onCycleVolume: vi.fn(),
    },
    ...overrides,
  };
}

type MockMQ = {
  matches: boolean;
  media: string;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatchChange: (newMatches: boolean) => void;
};

function mockMatchMedia(matches: boolean): MockMQ {
  const listeners: Array<(e: { matches: boolean }) => void> = [];
  const mq: MockMQ = {
    matches,
    media: "(max-width: 767px)",
    addEventListener: vi.fn(
      (event: string, cb: (e: { matches: boolean }) => void) => {
        if (event === "change") listeners.push(cb);
      }
    ),
    removeEventListener: vi.fn(),
    dispatchChange: (newMatches: boolean) => {
      listeners.forEach((cb) => cb({ matches: newMatches }));
    },
  };
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn(() => mq),
    writable: true,
    configurable: true,
  });
  return mq;
}

describe("SessionPageView tab bar", () => {
  test("threads expanded sound props into SessionHeader", () => {
    mockMatchMedia(false);
    const onSetEnabled = vi.fn();
    const onSetSoundName = vi.fn();
    const onCycleVolume = vi.fn();

    render(
      <SessionPageView
        {...makeProps({
          sound: {
            enabled: true,
            soundName: "bell",
            volume: "high",
            onSetEnabled,
            onSetSoundName,
            onCycleVolume,
          },
        })}
      />
    );

    expect(capturedSessionHeaderProps).toMatchObject({
      sound: {
        enabled: true,
        soundName: "bell",
        volume: "high",
        onSetEnabled,
        onSetSoundName,
        onCycleVolume,
      },
    });
  });

  test("tab bar renders dynamic thread buttons", () => {
    mockMatchMedia(false);
    const { getAllByRole } = render(<SessionPageView {...makeProps()} />);
    expect(getAllByRole("button", { name: "Select thread 1" }).length).toBeGreaterThan(0);
    expect(getAllByRole("button", { name: "Select thread 2" }).length).toBeGreaterThan(0);
  });

  test("active thread button is highlighted", async () => {
    mockMatchMedia(true);
    const { getAllByRole } = render(<SessionPageView {...makeProps()} />);
    const threadButtons = getAllByRole("button", { name: "Select thread 1" });
    expect(threadButtons.some((button) => button.className.includes("text-emerald-300") || button.className.includes("border-emerald-400"))).toBe(true);
  });

  test("inactive thread button is muted", async () => {
    mockMatchMedia(true);
    const { getAllByRole } = render(<SessionPageView {...makeProps()} />);
    const threadButtons = getAllByRole("button", { name: "Select thread 2" });
    expect(threadButtons.some((button) => button.className.includes("text-neutral-500") || button.className.includes("text-neutral-400"))).toBe(true);
  });

  test("clicking a thread tab selects it", () => {
    mockMatchMedia(true);
    const onSelectThread = vi.fn();
    const { getAllByRole } = render(<SessionPageView {...makeProps({ onSelectThread })} />);
    fireEvent.click(getAllByRole("button", { name: "Select thread 2" })[0]!);
    expect(onSelectThread).toHaveBeenCalledWith("B");
  });

  test("clicking the first thread tab selects it", () => {
    mockMatchMedia(true);
    const onSelectThread = vi.fn();
    const { getAllByRole } = render(<SessionPageView {...makeProps({ activeThreadId: "B", onSelectThread })} />);
    fireEvent.click(getAllByRole("button", { name: "Select thread 1" })[0]!);
    expect(onSelectThread).toHaveBeenCalledWith("A");
  });

  test("tab bar shows clip counts from zones prop", () => {
    mockMatchMedia(false);
    const clipA = { id: 1 } as any;
    const clipB = { id: 2 } as any;
    const props = makeProps({
      zones: [
        { zone: "A", threadName: "1", clips: [clipA, clipB], onClearZone: vi.fn() },
        { zone: "B", threadName: "2", clips: [clipA], onClearZone: vi.fn() },
      ],
    });
    const { getAllByRole } = render(<SessionPageView {...props} />);
    expect(getAllByRole("button", { name: "Select thread 1" })[0]!.textContent).toContain("2");
    expect(getAllByRole("button", { name: "Select thread 2" })[0]!.textContent).toContain("1");
  });

  test("focusedZone follows the active thread on mobile and desktop", () => {
    mockMatchMedia(true);
    const { getByTestId } = render(<SessionPageView {...makeProps()} />);
    expect(getByTestId("paste-zone-A").dataset.focusedZone).toBe("A");
  });

  test("focusedZone is active thread on desktop viewport", () => {
    mockMatchMedia(false);
    const { getByTestId } = render(<SessionPageView {...makeProps()} />);
    act(() => {});
    expect(getByTestId("paste-zone-A").dataset.focusedZone).toBe("A");
  });

  test("tab bar has md:hidden class to hide on desktop", () => {
    mockMatchMedia(false);
    const { container } = render(<SessionPageView {...makeProps()} />);
    const tabBar = container.querySelector(".md\\:hidden");
    expect(tabBar).not.toBeNull();
  });

  test("zones container has pb-14 bottom padding so content clears the tab bar", () => {
    mockMatchMedia(false);
    const { container } = render(<SessionPageView {...makeProps()} />);
    // The zones flex container should have pb-14 to avoid content being hidden behind the fixed tab bar
    const zonesContainer = container.querySelector(".pb-14");
    expect(zonesContainer).not.toBeNull();
  });

  test("focusedZone remains active thread when rotating from mobile to desktop", () => {
    const mq = mockMatchMedia(true);
    const { getByTestId } = render(<SessionPageView {...makeProps()} />);
    expect(getByTestId("paste-zone-A").dataset.focusedZone).toBe("A");
    act(() => mq.dispatchChange(false));
    expect(getByTestId("paste-zone-A").dataset.focusedZone).toBe("A");
  });
});

describe("SessionPageView loading and error states", () => {
  test("shows loading state", () => {
    mockMatchMedia(false);
    const props = makeProps({ loading: true });
    const { getByText } = render(<SessionPageView {...props} />);
    expect(getByText("Loading...")).toBeTruthy();
  });

  test("shows error message when error is set", () => {
    mockMatchMedia(false);
    const props = makeProps({ error: "Custom error message", session: null });
    const { getByText, getByRole } = render(<SessionPageView {...props} />);
    expect(getByRole("alert").textContent).toBe("Custom error message");
    expect(getByText("Go Home")).toBeTruthy();
  });

  test("shows 'Session not found' when session is null and no error", () => {
    mockMatchMedia(false);
    const props = makeProps({ error: null, session: null });
    const { getByRole } = render(<SessionPageView {...props} />);
    expect(getByRole("alert").textContent).toBe("Session not found");
  });

  test("Go Home button calls onGoHome", () => {
    mockMatchMedia(false);
    const onGoHome = vi.fn();
    const props = makeProps({ error: "test error", session: null, onGoHome });
    const { getByText } = render(<SessionPageView {...props} />);
    fireEvent.click(getByText("Go Home"));
    expect(onGoHome).toHaveBeenCalledTimes(1);
  });

  test("applies green background tint when unlockSecret is set", () => {
    mockMatchMedia(false);
    const props = makeProps({ unlockSecret: "my-secret" });
    const { container } = render(<SessionPageView {...props} />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain("bg-green-950/30");
  });

  test("no green background tint when unlockSecret is null", () => {
    mockMatchMedia(false);
    const props = makeProps({ unlockSecret: null });
    const { container } = render(<SessionPageView {...props} />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).not.toContain("bg-green-950/30");
  });

  test("tab bar renders thread clip count 0 when zones array is empty", () => {
    mockMatchMedia(false);
    const props = makeProps({ zones: [] });
    const { getAllByRole } = render(<SessionPageView {...props} />);
    expect(getAllByRole("button", { name: "Select thread 1" })[0]!.textContent).toContain("0");
  });
});

describe("SessionPageView handleImportSessions", () => {
  const entries: ImportEntry[] = [
    { token: "amber-anchor-apple-arch-arrow", label: "My Session", pinned: true },
    { token: "bronze-brook-bridge-brave-bloom" },
  ];

  test("successful batch: only created+existing entries are imported and result has correct counts", async () => {
    mockMatchMedia(false);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          created: ["amber-anchor-apple-arch-arrow"],
          existing: ["bronze-brook-bridge-brave-bloom"],
          invalid: [],
          capacity: [],
        }),
      })
    );

    render(<SessionPageView {...makeProps()} />);

    expect(capturedOnImportSessions).toBeDefined();
    let result!: ImportSessionsResult;
    await act(async () => {
      result = await capturedOnImportSessions!(entries);
    });

    // importEntries should have been called with both entries (created + existing)
    expect(mockImportEntries).toHaveBeenCalledOnce();
    const calledWith = mockImportEntries.mock.calls[0][0] as ImportEntry[];
    expect(calledWith).toHaveLength(2);
    expect(calledWith.map((e) => e.token)).toContain("amber-anchor-apple-arch-arrow");
    expect(calledWith.map((e) => e.token)).toContain("bronze-brook-bridge-brave-bloom");

    expect(result.importedCount).toBe(2);
    expect(result.createdCount).toBe(1);
    expect(result.existingCount).toBe(1);
    expect(result.invalidCount).toBe(0);
    expect(result.capacityCount).toBe(0);
    expect(result.usedFallback).toBe(false);
  });

  test("chunks large imports into 20-token batch requests and aggregates the result", async () => {
    mockMatchMedia(false);
    const largeEntries = Array.from({ length: 25 }, (_, index) => ({
      token: `token-${index.toString().padStart(2, "0")}`,
      ...(index === 0 ? { label: "First Session", pinned: true } : {}),
    })) satisfies ImportEntry[];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          created: largeEntries.slice(0, 12).map((entry) => entry.token),
          existing: largeEntries.slice(12, 20).map((entry) => entry.token),
          invalid: [],
          capacity: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          created: [],
          existing: largeEntries.slice(20, 23).map((entry) => entry.token),
          invalid: [largeEntries[23]!.token],
          capacity: [largeEntries[24]!.token],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<SessionPageView {...makeProps()} />);

    let result!: ImportSessionsResult;
    await act(async () => {
      result = await capturedOnImportSessions!(largeEntries);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      tokens: largeEntries.slice(0, 20).map((entry) => entry.token),
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      tokens: largeEntries.slice(20).map((entry) => entry.token),
    });

    expect(mockImportEntries).toHaveBeenCalledOnce();
    const imported = mockImportEntries.mock.calls[0][0] as ImportEntry[];
    expect(imported.map((entry) => entry.token)).toEqual(
      largeEntries.slice(0, 23).map((entry) => entry.token)
    );

    expect(result).toMatchObject({
      importedCount: 23,
      createdCount: 12,
      existingCount: 11,
      invalidCount: 1,
      capacityCount: 1,
      usedFallback: false,
    });
  });

  test("fallback on fetch failure: all entries are imported and usedFallback is true", async () => {
    mockMatchMedia(false);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error"))
    );

    render(<SessionPageView {...makeProps()} />);

    expect(capturedOnImportSessions).toBeDefined();
    let result!: ImportSessionsResult;
    await act(async () => {
      result = await capturedOnImportSessions!(entries);
    });

    // fallback: all entries passed through
    expect(mockImportEntries).toHaveBeenCalledOnce();
    const calledWith = mockImportEntries.mock.calls[0][0] as ImportEntry[];
    expect(calledWith).toHaveLength(2);

    expect(result.importedCount).toBe(2);
    expect(result.createdCount).toBe(0);
    expect(result.existingCount).toBe(0);
    expect(result.usedFallback).toBe(true);
  });

  test("fallback on non-OK response: all entries are imported and usedFallback is true", async () => {
    mockMatchMedia(false);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })
    );

    render(<SessionPageView {...makeProps()} />);

    expect(capturedOnImportSessions).toBeDefined();
    let result!: ImportSessionsResult;
    await act(async () => {
      result = await capturedOnImportSessions!(entries);
    });

    // fallback: all entries passed through
    expect(mockImportEntries).toHaveBeenCalledOnce();
    const calledWith = mockImportEntries.mock.calls[0][0] as ImportEntry[];
    expect(calledWith).toHaveLength(2);

    expect(result.importedCount).toBe(2);
    expect(result.createdCount).toBe(0);
    expect(result.existingCount).toBe(0);
    expect(result.usedFallback).toBe(true);
  });
});

describe("SessionPageView handleRenamePeer", () => {
  test("calls setMyPeerName when local peer renames", () => {
    mockMatchMedia(false);
    const props = makeProps();
    render(<SessionPageView {...props} />);
    act(() => capturedOnRenamePeer!(props.localPeerId, "Alice"));
    expect(mockSetMyPeerName).toHaveBeenCalledWith(props.token, "Alice");
  });

  test("does not call setMyPeerName when a remote peer renames", () => {
    mockMatchMedia(false);
    const props = makeProps();
    render(<SessionPageView {...props} />);
    act(() => capturedOnRenamePeer!("remote-peer-id", "Someone"));
    expect(mockSetMyPeerName).not.toHaveBeenCalled();
  });
});

describe("SessionPageView peer name restore", () => {
  test("restores peer name from session history when local peer has no name", async () => {
    mockMatchMedia(false);
    const props = makeProps({ peerNames: {} });
    mockHistoryEntries = [
      { token: props.token, pinned: false, lastVisited: Date.now(), myPeerName: "Alice" },
    ];
    render(<SessionPageView {...props} />);
    await waitFor(() => {
      expect(props.renamePeer).toHaveBeenCalledWith(props.localPeerId, "Alice");
    });
  });

  test("does not restore peer name when local peer already has one", async () => {
    mockMatchMedia(false);
    const props = makeProps({ peerNames: { "peer-1": "Existing" } });
    mockHistoryEntries = [
      { token: props.token, pinned: false, lastVisited: Date.now(), myPeerName: "Alice" },
    ];
    render(<SessionPageView {...props} />);
    // Allow effects to settle
    await act(async () => {});
    expect(props.renamePeer).not.toHaveBeenCalled();
  });

  test("does not call renamePeer when session history has no myPeerName", async () => {
    mockMatchMedia(false);
    const props = makeProps({ peerNames: {} });
    mockHistoryEntries = [
      { token: props.token, pinned: false, lastVisited: Date.now() },
    ];
    render(<SessionPageView {...props} />);
    await act(async () => {});
    expect(props.renamePeer).not.toHaveBeenCalled();
  });
});

describe("SessionPageView import applies peerNames", () => {
  test("calls renamePeer for each imported peerName matching current session", async () => {
    mockMatchMedia(false);
    const props = makeProps();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          created: [props.token],
          existing: [],
          invalid: [],
          capacity: [],
        }),
      })
    );

    render(<SessionPageView {...props} />);

    const importEntries: ImportEntry[] = [
      {
        token: props.token,
        peerNames: { "peer-2": "other", "peer-3": "left" },
      },
    ];

    await act(async () => {
      await capturedOnImportSessions!(importEntries);
    });

    expect(props.renamePeer).toHaveBeenCalledWith("peer-2", "other");
    expect(props.renamePeer).toHaveBeenCalledWith("peer-3", "left");
  });

  test("does not call renamePeer when imported session does not match current token", async () => {
    mockMatchMedia(false);
    const props = makeProps();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          created: ["other-session-token"],
          existing: [],
          invalid: [],
          capacity: [],
        }),
      })
    );

    render(<SessionPageView {...props} />);

    const importEntries: ImportEntry[] = [
      {
        token: "other-session-token",
        peerNames: { "peer-2": "other" },
      },
    ];

    await act(async () => {
      await capturedOnImportSessions!(importEntries);
    });

    expect(props.renamePeer).not.toHaveBeenCalled();
  });

  test("applies peerNames even on fallback import path", async () => {
    mockMatchMedia(false);
    const props = makeProps();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error"))
    );

    render(<SessionPageView {...props} />);

    const importEntries: ImportEntry[] = [
      {
        token: props.token,
        peerNames: { "peer-2": "remote" },
      },
    ];

    await act(async () => {
      await capturedOnImportSessions!(importEntries);
    });

    expect(props.renamePeer).toHaveBeenCalledWith("peer-2", "remote");
  });
});
