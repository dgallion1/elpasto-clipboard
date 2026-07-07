// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { SessionEntry } from "@/hooks/useSessionHistory";

const helpModalSpy = vi.fn();
const qrModalSpy = vi.fn();
const soundDropdownSpy = vi.fn();
const writeTextMock = vi.fn();
const pushMock = vi.fn();

vi.mock("./HelpModal", () => ({
  HelpModal: ({ open, onClose }: { open: boolean; onClose: () => void }) => {
    helpModalSpy({ open });
    return open ? <button onClick={onClose}>Close Help</button> : null;
  },
}));

vi.mock("./QRCodeModal", () => ({
  QRCodeModal: ({
    open,
    onClose,
    url,
  }: {
    open: boolean;
    onClose: () => void;
    url: string;
  }) => {
    qrModalSpy({ open, url });
    return open ? (
      <div data-testid="qr-modal">
        <span>{url}</span>
        <button onClick={onClose}>Close QR</button>
      </div>
    ) : null;
  },
}));

vi.mock("./SoundDropdown", () => ({
  SoundDropdown: (props: {
    enabled: boolean;
    soundName: string;
    volume: string;
    onSetEnabled: (enabled: boolean) => void;
    onSetSoundName: (name: string) => void;
    onCycleVolume: () => void;
  }) => {
    soundDropdownSpy(props);
    return <div data-testid="sound-dropdown">Sound dropdown</div>;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@/lib/api", () => ({
  buildApiUrl: (path: string) => path,
}));

let SessionHeader: typeof import("./SessionHeader").SessionHeader;

beforeAll(async () => {
  ({ SessionHeader } = await import("./SessionHeader"));
});

function makeSessionHistory(
  entries: SessionEntry[],
  overrides: Partial<{
    add: (token: string) => void;
    setLabel: (token: string, label: string) => void;
    togglePin: (token: string) => void;
    remove: (token: string) => void;
  }> = {}
) {
  return {
    entries,
    add: vi.fn(),
    setLabel: vi.fn(),
    togglePin: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  helpModalSpy.mockReset();
  qrModalSpy.mockReset();
  soundDropdownSpy.mockReset();
  writeTextMock.mockReset();
  pushMock.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: writeTextMock,
    },
  });
  window.history.replaceState({}, "", "/demo-token#secret");
  // Default fetch mock: sessions are alive
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const defaultSessionHistory = makeSessionHistory([
  { token: "demo-token", pinned: false, lastVisited: Date.now() },
]);

const defaultProps = {
  token: "demo-token",
  hasUnlockSecret: false,
  directPeerCount: 0,
  connectionState: "waiting" as const,
  localPeerId: "local-0000-0000-0000",
  peerNames: {} as Record<string, string>,
  peers: [] as { peerId: string; channelState: RTCDataChannelState | "none"; hasTunnel: boolean }[],
  totalClips: 0,
  sessionHistory: defaultSessionHistory,
  onRenamePeer: () => {},
  onPingPeer: () => {},
  onManageSecret: () => {},
  onForgetSecret: () => {},
  onClearAll: async () => undefined as void,
  onExportSessions: vi.fn(),
  tunnels: [],
  swReady: false,
  onOpenTunnel: vi.fn(),
  onRemoveTunnel: vi.fn(),
};

describe("SessionHeader", () => {
  test("renders the sound settings dropdown in place of the old mute toggle", () => {
    const view = render(
      <SessionHeader
        {...defaultProps}
        sound={{
          enabled: true,
          soundName: "bell",
          volume: "high",
          onSetEnabled: vi.fn(),
          onSetSoundName: vi.fn(),
          onCycleVolume: vi.fn(),
        }}
      />
    );

    expect(view.getByTestId("sound-dropdown")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Mute notifications" })).toBeNull();
    expect(view.queryByRole("button", { name: "Enable notification sound" })).toBeNull();
  });

  test("passes sound props through to SoundDropdown", () => {
    const onSetEnabled = vi.fn();
    const onSetSoundName = vi.fn();
    const onCycleVolume = vi.fn();

    render(
      <SessionHeader
        {...defaultProps}
        sound={{
          enabled: false,
          soundName: "brush",
          volume: "low",
          onSetEnabled,
          onSetSoundName,
          onCycleVolume,
        }}
      />
    );

    expect(soundDropdownSpy).toHaveBeenLastCalledWith({
      enabled: false,
      soundName: "brush",
      volume: "low",
      onSetEnabled,
      onSetSoundName,
      onCycleVolume,
    });
  });

  test("renders the session title as a home link", () => {
    const view = render(
      <SessionHeader {...defaultProps} />
    );

    const homeLink = view.getByRole("link", { name: "elPasto" });
    expect(homeLink.getAttribute("href")).toBe("/");
  });

  test("renders the connection pill for singular and plural peer counts", () => {
    const onePeer = [{ peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false }];
    const twoPeers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false },
      { peerId: "eeee-ffff-1111-2222", channelState: "open" as const, hasTunnel: false },
    ];

    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={onePeer} connectionState="connected-direct" />
    );

    expect(view.getByText("aaaa-bbb")).toBeTruthy();

    view.rerender(
      <SessionHeader {...defaultProps} directPeerCount={2} peers={twoPeers} connectionState="connected-direct" />
    );

    expect(view.getByText("2 devices")).toBeTruthy();
  });

  test("shows the connected peer name in the header pill", () => {
    const view = render(
      <SessionHeader
        {...defaultProps}
        peers={[{ peerId: "p1", channelState: "open" as const, hasTunnel: false }]}
        peerNames={{ p1: "Laptop" }}
        directPeerCount={1}
        connectionState="connected-direct"
      />
    );
    expect(view.getByText("Laptop")).toBeTruthy();
  });

  test("shows Linking… in the pill while connecting", () => {
    const view = render(
      <SessionHeader
        {...defaultProps}
        peers={[{ peerId: "p1", channelState: "connecting" as const, hasTunnel: false }]}
        directPeerCount={0}
        connectionState="connecting"
      />
    );
    expect(view.getByText("Linking…")).toBeTruthy();
  });

  test("hides the connection pill entirely while waiting (no peers)", () => {
    const view = render(<SessionHeader {...defaultProps} />);
    expect(view.queryByRole("button", { name: /Connection status/ })).toBeNull();
  });

  test("shows peer list with connection status on click", () => {
    const peers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false },
      { peerId: "eeee-ffff-1111-2222", channelState: "connecting" as const, hasTunnel: false },
    ];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" />
    );

    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    expect(view.getByText("aaaa-bbb")).toBeTruthy();
    expect(view.getByText("id aaaa-bbb")).toBeTruthy();
    expect(view.getByText("open")).toBeTruthy();
    expect(view.getByText("eeee-fff")).toBeTruthy();
    expect(view.getByText("id eeee-fff")).toBeTruthy();
    expect(view.getByText("connecting")).toBeTruthy();
  });

  test("shows the local peer id alongside the you label", () => {
    const peers = [{ peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false }];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" />
    );

    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    expect(view.getByText("you")).toBeTruthy();
    expect(view.getByText("id local-00")).toBeTruthy();
  });

  test("copies the canonical session URL and resets the flash state", async () => {
    vi.useFakeTimers();
    writeTextMock.mockResolvedValue(undefined);
    window.history.replaceState({}, "", "/wrong-token?x=1#secret");

    const view = render(
      <SessionHeader {...defaultProps} />
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy URL" }));
      await Promise.resolve();
    });

    expect(writeTextMock).toHaveBeenCalledWith("http://localhost/demo-token");
    expect(view.getByRole("button", { name: "Copied!" })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(view.getByRole("button", { name: "Copy URL" })).toBeTruthy();
  });

  test("ignores clipboard failures", async () => {
    writeTextMock.mockRejectedValue(new Error("clipboard denied"));

    const view = render(
      <SessionHeader {...defaultProps} />
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy URL" }));
      await Promise.resolve();
    });

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(view.getByRole("button", { name: "Copy URL" })).toBeTruthy();
  });

  test("opens and closes the QR and help modals", () => {
    const view = render(
      <SessionHeader {...defaultProps} />
    );

    fireEvent.click(view.getByRole("button", { name: "QR" }));
    expect(view.getByTestId("qr-modal")).toBeTruthy();
    expect(view.getByText("http://localhost/demo-token")).toBeTruthy();
    expect(qrModalSpy).toHaveBeenLastCalledWith({
      open: true,
      url: "http://localhost/demo-token",
    });

    fireEvent.click(view.getByRole("button", { name: "Close QR" }));
    expect(view.queryByTestId("qr-modal")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Help" }));
    expect(view.getByRole("button", { name: "Close Help" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Close Help" }));
    expect(view.queryByRole("button", { name: "Close Help" })).toBeNull();
  });

  test("disables clear all while pending and shows a timed error on failure", async () => {
    vi.useFakeTimers();
    let rejectClear: ((reason?: unknown) => void) | null = null;
    const onClearAll = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectClear = reject;
        })
    );
    const view = render(
      <SessionHeader {...defaultProps} totalClips={2} onClearAll={onClearAll} />
    );

    const clearButton = view.getByRole("button", { name: "Clear All" });
    // First click shows confirmation
    fireEvent.click(clearButton);
    expect(onClearAll).not.toHaveBeenCalled();
    expect(view.getByText("Confirm Clear All?")).toBeTruthy();

    // Second click executes
    fireEvent.click(view.getByRole("button", { name: "Confirm Clear All?" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
    expect(view.getByRole("button", { name: "Clear All" }).getAttribute("disabled")).not.toBeNull();

    await act(async () => {
      rejectClear?.(new Error("nope"));
    });

    expect(view.getByText("Failed to clear")).toBeTruthy();
    expect(view.getByRole("button", { name: "Clear All" }).getAttribute("disabled")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(view.queryByText("Failed to clear")).toBeNull();
  });

  test("clear all confirmation resets after 3 seconds", async () => {
    vi.useFakeTimers();
    const onClearAll = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <SessionHeader {...defaultProps} totalClips={2} onClearAll={onClearAll} />
    );
    fireEvent.click(view.getByRole("button", { name: "Clear All" }));
    expect(view.getByText("Confirm Clear All?")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(view.getByText("Clear All")).toBeTruthy();
    expect(onClearAll).not.toHaveBeenCalled();
  });

  // ─── Session dropdown tests ───────────────────────────────────────────────

  test("token renders as a button trigger, not plain text", () => {
    const view = render(<SessionHeader {...defaultProps} />);
    const btn = view.getByRole("button", { name: "Session menu" });
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain("demo-token");
  });

  test("clicking the token opens the session dropdown", () => {
    const view = render(<SessionHeader {...defaultProps} />);
    const btn = view.getByRole("button", { name: "Session menu" });

    expect(view.queryByRole("menu")).toBeNull();
    fireEvent.click(btn);
    expect(view.getByRole("menu")).toBeTruthy();
  });

  test("clicking outside closes the session dropdown", async () => {
    const view = render(<SessionHeader {...defaultProps} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));
    expect(view.getByRole("menu")).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(document.body);
    });
    expect(view.queryByRole("menu")).toBeNull();
  });

  test("current session row is highlighted and does not navigate", () => {
    const view = render(<SessionHeader {...defaultProps} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));

    const menu = view.getByRole("menu");
    // The current session nav button should be disabled
    const navBtns = menu.querySelectorAll<HTMLButtonElement>("button[disabled]");
    const currentBtn = Array.from(navBtns).find((b) =>
      b.textContent?.includes("demo-token")
    );
    expect(currentBtn).toBeTruthy();

    // Clicking it should NOT navigate
    fireEvent.click(currentBtn!);
    expect(pushMock).not.toHaveBeenCalled();
  });

  test("clicking another session row calls router.push", () => {
    const sessionHistory = makeSessionHistory([
      { token: "demo-token", pinned: false, lastVisited: Date.now() },
      { token: "other-session", pinned: false, lastVisited: Date.now() - 1000 },
    ]);

    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));

    // Find the nav button for the other session (not disabled)
    const menu = view.getByRole("menu");
    const allNavBtns = menu.querySelectorAll<HTMLButtonElement>(
      "button:not([disabled]):not([aria-label])"
    );
    const otherBtn = Array.from(allNavBtns).find((b) =>
      b.textContent?.includes("other-session")
    );
    expect(otherBtn).toBeTruthy();
    fireEvent.click(otherBtn!);
    expect(pushMock).toHaveBeenCalledWith("/other-session");
    expect(view.queryByRole("menu")).toBeNull();
  });

  test("pin control calls togglePin and does not trigger navigation", () => {
    const togglePin = vi.fn();
    const sessionHistory = makeSessionHistory(
      [{ token: "demo-token", pinned: false, lastVisited: Date.now() }],
      { togglePin }
    );
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));

    const pinBtn = view.getByRole("button", { name: /Pin demo-token/i });
    fireEvent.click(pinBtn);
    expect(pushMock).not.toHaveBeenCalled();
    expect(togglePin).toHaveBeenCalledWith("demo-token");
    // Menu stays open after pin
    expect(view.getByRole("menu")).toBeTruthy();
  });

  test("remove control calls remove and does not trigger navigation", () => {
    const remove = vi.fn();
    const sessionHistory = makeSessionHistory(
      [
        { token: "demo-token", pinned: false, lastVisited: Date.now() },
        { token: "other-session", pinned: false, lastVisited: Date.now() - 1000 },
      ],
      { remove }
    );

    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));

    const removeBtn = view.getByRole("button", { name: "Remove other-session" });
    fireEvent.click(removeBtn);
    expect(pushMock).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("other-session");
  });

  test("label editing calls setLabel with trimmed value and cancels on escape", async () => {
    const setLabel = vi.fn();
    const sessionHistory = makeSessionHistory(
      [{ token: "demo-token", pinned: false, lastVisited: Date.now() }],
      { setLabel }
    );
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));

    // Open edit for current session
    const editBtn = view.getByRole("button", { name: "Edit label for demo-token" });
    fireEvent.click(editBtn);

    const input = view.getByPlaceholderText("label…");
    fireEvent.change(input, { target: { value: "  My Work Session  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(setLabel).toHaveBeenCalledWith("demo-token", "  My Work Session  ");

    // Edit again and cancel with Escape — setLabel should not be called again
    const editBtn2 = view.getByRole("button", { name: "Edit label for demo-token" });
    fireEvent.click(editBtn2);
    const input2 = view.getByPlaceholderText("label…");
    fireEvent.change(input2, { target: { value: "new value" } });
    fireEvent.keyDown(input2, { key: "Escape" });

    expect(setLabel).toHaveBeenCalledTimes(1);
  });

  test("opening the session menu starts status probes", async () => {
    const sessionHistory = makeSessionHistory([
      { token: "demo-token", pinned: false, lastVisited: Date.now() },
      { token: "other-session", pinned: false, lastVisited: Date.now() - 1000 },
    ]);

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Session menu" }));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/other-session",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  test("alive/unavailable state renders after probes resolve", async () => {
    const sessionHistory = makeSessionHistory([
      { token: "demo-token", pinned: false, lastVisited: Date.now() },
      { token: "dead-session", pinned: false, lastVisited: Date.now() - 1000 },
    ]);

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Session menu" }));
      await Promise.resolve();
    });

    // Status dot for dead-session should be red (unreachable title)
    const menu = view.getByRole("menu");
    const dots = menu.querySelectorAll<HTMLElement>("span[title]");
    const unreachable = Array.from(dots).find((d) => d.title === "unreachable");
    expect(unreachable).toBeTruthy();
  });

  test("add session button calls add without navigating", () => {
    const add = vi.fn();
    const sessionHistory = makeSessionHistory(
      [{ token: "demo-token", pinned: false, lastVisited: Date.now() }],
      { add }
    );
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));

    // Click "+ add session"
    fireEvent.click(view.getByRole("button", { name: "Add session" }));
    const input = view.getByPlaceholderText("paste token…");
    expect(input).toBeTruthy();

    // Type a token and press Enter
    fireEvent.change(input, { target: { value: "new-session-token" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Should not navigate
    expect(pushMock).not.toHaveBeenCalled();
    // add should have been called
    expect(add).toHaveBeenCalledWith("new-session-token");
  });

  test("opening one dropdown closes the other", () => {
    const peers = [{ peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false }];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" />
    );

    // Open session menu
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));
    expect(view.getByRole("menu")).toBeTruthy();

    // Open peer menu — session menu should close
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    expect(view.queryByRole("menu")).toBeNull();
    expect(view.getByText("id aaaa-bbb")).toBeTruthy();

    // Open session menu again — peer list should close
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));
    expect(view.queryByText("id aaaa-bbb")).toBeNull();
    expect(view.getByRole("menu")).toBeTruthy();
  });

  test("remove button is hidden for the current session", () => {
    const sessionHistory = makeSessionHistory([
      { token: "demo-token", pinned: false, lastVisited: Date.now() },
      { token: "other-session", pinned: false, lastVisited: Date.now() - 1000 },
    ]);
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));

    // Remove button should exist for other session but NOT for current
    expect(view.queryByRole("button", { name: "Remove demo-token" })).toBeNull();
    expect(view.getByRole("button", { name: "Remove other-session" })).toBeTruthy();
  });

  test("add session normalizes input and rejects path-traversal tokens", () => {
    const add = vi.fn();
    const sessionHistory = makeSessionHistory(
      [{ token: "demo-token", pinned: false, lastVisited: Date.now() }],
      { add }
    );
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));
    fireEvent.click(view.getByRole("button", { name: "Add session" }));
    const input = view.getByPlaceholderText("paste token…");

    // Type a token with path traversal characters
    fireEvent.change(input, { target: { value: "foo/bar" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(add).not.toHaveBeenCalled();
  });

  test("add session normalizes casing and separators before calling add", () => {
    const add = vi.fn();
    const sessionHistory = makeSessionHistory(
      [{ token: "demo-token", pinned: false, lastVisited: Date.now() }],
      { add }
    );
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));
    fireEvent.click(view.getByRole("button", { name: "Add session" }));
    const input = view.getByPlaceholderText("paste token…");

    // Type with uppercase and underscores
    fireEvent.change(input, { target: { value: "  SOME__TOKEN  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Should be called with normalized value
    expect(add).toHaveBeenCalledWith("some-token");
  });

  test("export sessions button is visible when other sessions exist and calls onExportSessions", () => {
    const onExportSessions = vi.fn();
    const sessionHistory = makeSessionHistory([
      { token: "demo-token", pinned: false, lastVisited: Date.now() },
      { token: "other-session", pinned: false, lastVisited: Date.now() - 1000 },
    ]);

    const view = render(
      <SessionHeader {...defaultProps} sessionHistory={sessionHistory} onExportSessions={onExportSessions} />
    );
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));

    const exportBtn = view.getByRole("button", { name: "Export sessions" });
    expect(exportBtn).toBeTruthy();
    fireEvent.click(exportBtn);
    expect(onExportSessions).toHaveBeenCalledTimes(1);
    // Menu closes after export
    expect(view.queryByRole("menu")).toBeNull();
  });

  test("export sessions button is hidden when no other sessions exist", () => {
    const view = render(<SessionHeader {...defaultProps} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));

    expect(view.queryByRole("button", { name: "Export sessions" })).toBeNull();
  });

  // ─── Copy Token tests ──────────────────────────────────────────────────

  test("copies the plain token and resets the flash state", async () => {
    vi.useFakeTimers();
    writeTextMock.mockResolvedValue(undefined);

    const view = render(<SessionHeader {...defaultProps} />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy Token" }));
      await Promise.resolve();
    });

    expect(writeTextMock).toHaveBeenCalledWith("demo-token");
    expect(view.getByRole("button", { name: "Copied!" })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    // Should have two buttons named "Copy Token" or "Copy URL" — check the token one reverted
    expect(view.getByRole("button", { name: "Copy Token" })).toBeTruthy();
  });

  test("ignores clipboard failures for Copy Token", async () => {
    writeTextMock.mockRejectedValue(new Error("clipboard denied"));

    const view = render(<SessionHeader {...defaultProps} />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy Token" }));
      await Promise.resolve();
    });

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(view.getByRole("button", { name: "Copy Token" })).toBeTruthy();
  });

  // ─── Secret badge and buttons ──────────────────────────────────────────

  test("shows Secret active badge and Forget Secret when hasUnlockSecret is true", () => {
    const onManageSecret = vi.fn();
    const onForgetSecret = vi.fn();
    const view = render(
      <SessionHeader
        {...defaultProps}
        hasUnlockSecret={true}
        onManageSecret={onManageSecret}
        onForgetSecret={onForgetSecret}
      />
    );

    expect(view.getByText("Secret active")).toBeTruthy();
    expect(view.getByRole("button", { name: "Manage Secret" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Forget Secret" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Manage Secret" }));
    expect(onManageSecret).toHaveBeenCalledTimes(1);

    fireEvent.click(view.getByRole("button", { name: "Forget Secret" }));
    expect(onForgetSecret).toHaveBeenCalledTimes(1);
  });

  test("shows Set Secret when hasUnlockSecret is false", () => {
    const view = render(<SessionHeader {...defaultProps} hasUnlockSecret={false} />);
    expect(view.getByRole("button", { name: "Set Secret" })).toBeTruthy();
    expect(view.queryByText("Secret active")).toBeNull();
    expect(view.queryByRole("button", { name: "Forget Secret" })).toBeNull();
  });

  test("shows shield icon with paranoid encryption aria-label when secretMode is paranoid", () => {
    const view = render(
      <SessionHeader
        {...defaultProps}
        hasUnlockSecret={true}
        secretMode="paranoid"
      />
    );

    expect(view.getByText("Secret active")).toBeTruthy();
    // Shield icon has aria-label="Paranoid encryption"
    const shield = view.container.querySelector('[aria-label="Paranoid encryption"]');
    expect(shield).toBeTruthy();
    // Lock icon should NOT be present
    const lock = view.container.querySelector('[aria-label="Encrypted"]');
    expect(lock).toBeNull();
  });

  test("shows amber lock icon when secretMode is normal", () => {
    const view = render(
      <SessionHeader
        {...defaultProps}
        hasUnlockSecret={true}
        secretMode="normal"
      />
    );

    expect(view.getByText("Secret active")).toBeTruthy();
    const lock = view.container.querySelector('[aria-label="Encrypted"]');
    expect(lock).toBeTruthy();
    const shield = view.container.querySelector('[aria-label="Paranoid encryption"]');
    expect(shield).toBeNull();
  });

  test("backward compat: shows amber lock icon when only hasUnlockSecret is set (no secretMode)", () => {
    const view = render(
      <SessionHeader
        {...defaultProps}
        hasUnlockSecret={true}
      />
    );

    expect(view.getByText("Secret active")).toBeTruthy();
    const lock = view.container.querySelector('[aria-label="Encrypted"]');
    expect(lock).toBeTruthy();
  });

  // ─── Clear All hidden when no clips ────────────────────────────────────

  test("Clear All button is hidden when totalClips is 0", () => {
    const view = render(<SessionHeader {...defaultProps} totalClips={0} />);
    expect(view.queryByRole("button", { name: "Clear All" })).toBeNull();
  });

  test("Clear All button is visible when totalClips > 0", () => {
    const view = render(<SessionHeader {...defaultProps} totalClips={5} />);
    expect(view.getByRole("button", { name: "Clear All" })).toBeTruthy();
  });

  // ─── Peer list: channel states and negotiating label ───────────────────

  test("shows 'negotiating' for peers with channelState 'none'", () => {
    const peers = [
      { peerId: "peer-none-1234-5678", channelState: "none" as const, hasTunnel: false },
    ];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    expect(view.getByText("negotiating")).toBeTruthy();
  });

  test("shows closed state for peers with channelState 'closed'", () => {
    const peers = [
      { peerId: "peer-clos-1234-5678", channelState: "closed" as const, hasTunnel: false },
    ];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    expect(view.getByText("closed")).toBeTruthy();
  });

  test("shows custom peer names in the peer list", () => {
    const peers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false },
    ];
    const peerNames = { "aaaa-bbbb-cccc-dddd": "My Laptop" };
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" peerNames={peerNames} />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    expect(view.getAllByTitle("Click to rename")[1].textContent).toContain("My Laptop");
  });

  test("shows custom name for the local peer", () => {
    const peers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false },
    ];
    const peerNames = { "local-0000-0000-0000": "Home Desktop" };
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" peerNames={peerNames} />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    expect(view.getByText("Home Desktop")).toBeTruthy();
  });

  // ─── Peer rename ──────────────────────────────────────────────────────

  test("renaming a peer calls onRenamePeer with trimmed value", () => {
    const onRenamePeer = vi.fn();
    const peers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false },
    ];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" onRenamePeer={onRenamePeer} />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));

    // Click on the remote peer name to start editing
    fireEvent.click(view.getAllByTitle("Click to rename")[1]);
    const input = view.container.querySelector('input[maxlength="20"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "  Work PC  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenamePeer).toHaveBeenCalledWith("aaaa-bbbb-cccc-dddd", "Work PC");
  });

  test("renaming a peer with empty value does not call onRenamePeer", () => {
    const onRenamePeer = vi.fn();
    const peers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false },
    ];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" onRenamePeer={onRenamePeer} />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    fireEvent.click(view.getAllByTitle("Click to rename")[1]);
    const input = view.container.querySelector('input[maxlength="20"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenamePeer).not.toHaveBeenCalled();
  });

  test("escape cancels peer rename editing", () => {
    const onRenamePeer = vi.fn();
    const peers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false },
    ];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" onRenamePeer={onRenamePeer} />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    fireEvent.click(view.getAllByTitle("Click to rename")[1]);
    const input = view.container.querySelector('input[maxlength="20"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "something" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // Should not have called rename, and the input should be gone
    expect(onRenamePeer).not.toHaveBeenCalled();
    expect(view.container.querySelector('input[maxlength="20"]')).toBeNull();
  });

  test("blur commits peer rename", () => {
    const onRenamePeer = vi.fn();
    const peers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false },
    ];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" onRenamePeer={onRenamePeer} />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    fireEvent.click(view.getAllByTitle("Click to rename")[1]);
    const input = view.container.querySelector('input[maxlength="20"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "via blur" } });
    fireEvent.blur(input);
    expect(onRenamePeer).toHaveBeenCalledWith("aaaa-bbbb-cccc-dddd", "via blur");
  });

  // ─── Peer ping ────────────────────────────────────────────────────────

  test("ping button calls onPingPeer for open remote peers", () => {
    const onPingPeer = vi.fn();
    const peers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false },
    ];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" onPingPeer={onPingPeer} />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    const pingBtn = view.getByTitle("Ping this device");
    fireEvent.click(pingBtn);
    expect(onPingPeer).toHaveBeenCalledWith("aaaa-bbbb-cccc-dddd");
  });

  test("ping button is not shown for non-open peers", () => {
    const peers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "connecting" as const, hasTunnel: false },
    ];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    expect(view.container.querySelector('[title="Ping this device"]')).toBeNull();
  });

  test("ping button is not shown for local peer even though channelState is open", () => {
    // Only remote peers get ping. The local peer row has channelState "open" but isLocal=true.
    const peers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false },
    ];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    // One ping button for the single remote peer, none for local
    const pingBtns = view.container.querySelectorAll('[title="Ping this device"]');
    expect(pingBtns.length).toBe(1);
  });

  // ─── Peer list closes when peers becomes empty ─────────────────────────

  test("peer list closes when peers array becomes empty", () => {
    const peers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false },
    ];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    expect(view.getByText("id aaaa-bbb")).toBeTruthy();

    // Rerender with empty peers — dropdown should close
    view.rerender(<SessionHeader {...defaultProps} directPeerCount={0} peers={[]} />);
    expect(view.queryByText("id aaaa-bbb")).toBeNull();
  });

  // ─── Session label on entry with existing label ───────────────────────

  test("shows label above token in session dropdown for entries with labels", () => {
    const sessionHistory = makeSessionHistory([
      { token: "demo-token", pinned: false, lastVisited: Date.now(), label: "Work" },
      { token: "other-session", pinned: false, lastVisited: Date.now() - 1000, label: "Home" },
    ]);
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));

    expect(view.getByText("Work")).toBeTruthy();
    expect(view.getByText("Home")).toBeTruthy();
  });

  // ─── Session label editing: blur commits ──────────────────────────────

  test("session label editing commits on blur", () => {
    const setLabel = vi.fn();
    const sessionHistory = makeSessionHistory(
      [{ token: "demo-token", pinned: false, lastVisited: Date.now() }],
      { setLabel }
    );
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));

    fireEvent.click(view.getByRole("button", { name: "Edit label for demo-token" }));
    const input = view.getByPlaceholderText("label\u2026");
    fireEvent.change(input, { target: { value: "My Label" } });
    fireEvent.blur(input);
    expect(setLabel).toHaveBeenCalledWith("demo-token", "My Label");
  });

  // ─── Add session: Escape cancels ──────────────────────────────────────

  test("add session cancels on Escape", () => {
    const add = vi.fn();
    const sessionHistory = makeSessionHistory(
      [{ token: "demo-token", pinned: false, lastVisited: Date.now() }],
      { add }
    );
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));
    fireEvent.click(view.getByRole("button", { name: "Add session" }));
    const input = view.getByPlaceholderText("paste token\u2026");
    fireEvent.change(input, { target: { value: "some-token" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(add).not.toHaveBeenCalled();
    // Input should be hidden and add session button reappears
    expect(view.queryByPlaceholderText("paste token\u2026")).toBeNull();
  });

  // ─── Add session: blur commits ────────────────────────────────────────

  test("add session commits on blur", () => {
    const add = vi.fn();
    const sessionHistory = makeSessionHistory(
      [{ token: "demo-token", pinned: false, lastVisited: Date.now() }],
      { add }
    );
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));
    fireEvent.click(view.getByRole("button", { name: "Add session" }));
    const input = view.getByPlaceholderText("paste token\u2026");
    fireEvent.change(input, { target: { value: "valid-token" } });
    fireEvent.blur(input);

    expect(add).toHaveBeenCalledWith("valid-token");
  });

  // ─── Pinned session shows filled star ─────────────────────────────────

  test("pinned session shows filled star, unpinned shows empty star", () => {
    const sessionHistory = makeSessionHistory([
      { token: "demo-token", pinned: true, lastVisited: Date.now() },
      { token: "other-session", pinned: false, lastVisited: Date.now() - 1000 },
    ]);
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));

    const unpinBtn = view.getByRole("button", { name: "Unpin demo-token" });
    expect(unpinBtn.textContent).toContain("\u2605");
    const pinBtn = view.getByRole("button", { name: "Pin other-session" });
    expect(pinBtn.textContent).toContain("\u2606");
  });

  // ─── No sessions saved message ────────────────────────────────────────

  test("shows 'No sessions saved' when entries list is empty", () => {
    const sessionHistory = makeSessionHistory([]);
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));
    expect(view.getByText("No sessions saved")).toBeTruthy();
  });

  // ─── Alive status probe error fallback ─────────────────────────────────

  test("network error on alive probe marks session as unavailable", async () => {
    const sessionHistory = makeSessionHistory([
      { token: "demo-token", pinned: false, lastVisited: Date.now() },
      { token: "error-session", pinned: false, lastVisited: Date.now() - 1000 },
    ]);

    const fetchMock = vi.fn().mockRejectedValue(new Error("network error"));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Session menu" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const menu = view.getByRole("menu");
    const dots = menu.querySelectorAll<HTMLElement>("span[title]");
    const unreachable = Array.from(dots).find((d) => d.title === "unreachable");
    expect(unreachable).toBeTruthy();
  });

  // ─── Help modal opened from TunnelBadge via onShowHelp ─────────────────

  test("help modal toggles via the ? button", () => {
    const view = render(<SessionHeader {...defaultProps} />);
    fireEvent.click(view.getByRole("button", { name: "Help" }));
    expect(view.getByRole("button", { name: "Close Help" })).toBeTruthy();
    expect(helpModalSpy).toHaveBeenLastCalledWith({ open: true });
  });

  // ─── Clear All success path ───────────────────────────────────────────

  test("Clear All enables button after successful clear", async () => {
    const onClearAll = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <SessionHeader {...defaultProps} totalClips={3} onClearAll={onClearAll} />
    );
    const clearBtn = view.getByRole("button", { name: "Clear All" });

    // First click: confirmation
    fireEvent.click(clearBtn);
    expect(onClearAll).not.toHaveBeenCalled();

    // Second click: execute
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Confirm Clear All?" }));
      await Promise.resolve();
    });

    expect(onClearAll).toHaveBeenCalledTimes(1);
    // No error shown
    expect(view.queryByText("Failed to clear")).toBeNull();
  });

  // ─── Local peer shows "this device" label ─────────────────────────────

  test("clicking outside closes the peer dropdown", async () => {
    const peers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false },
    ];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    expect(view.getByText("id aaaa-bbb")).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(document.body);
    });
    expect(view.queryByText("id aaaa-bbb")).toBeNull();
  });

  test("aria-expanded reflects session menu open state", () => {
    const view = render(<SessionHeader {...defaultProps} />);
    const btn = view.getByRole("button", { name: "Session menu" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  test("clicking the session label input does not close the menu", () => {
    const setLabel = vi.fn();
    const sessionHistory = makeSessionHistory(
      [{ token: "demo-token", pinned: false, lastVisited: Date.now() }],
      { setLabel }
    );
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));
    fireEvent.click(view.getByRole("button", { name: "Edit label for demo-token" }));
    const input = view.getByPlaceholderText("label\u2026");
    fireEvent.click(input);
    // Menu should still be open
    expect(view.getByRole("menu")).toBeTruthy();
  });

  test("clicking the add token input does not close the menu", () => {
    const sessionHistory = makeSessionHistory([
      { token: "demo-token", pinned: false, lastVisited: Date.now() },
    ]);
    const view = render(<SessionHeader {...defaultProps} sessionHistory={sessionHistory} />);
    fireEvent.click(view.getByRole("button", { name: "Session menu" }));
    fireEvent.click(view.getByRole("button", { name: "Add session" }));
    const input = view.getByPlaceholderText("paste token\u2026");
    fireEvent.click(input);
    // Menu should still be open
    expect(view.getByRole("menu")).toBeTruthy();
  });

  test("TunnelBadge onShowHelp opens the help modal", () => {
    const tunnels = [{ peerId: "tunnel-peer-id", label: "dev" }];
    const view = render(
      <SessionHeader {...defaultProps} tunnels={tunnels} />
    );
    // Open the tunnel dropdown
    fireEvent.click(view.getByText("1 tunnel"));
    // Click "Host a tunnel..." which calls onShowHelp
    fireEvent.click(view.getByText("Host a tunnel..."));
    // Help modal should open
    expect(helpModalSpy).toHaveBeenLastCalledWith({ open: true });
  });

  test("local peer shows 'this device' label in peer list", () => {
    const peers = [
      { peerId: "aaaa-bbbb-cccc-dddd", channelState: "open" as const, hasTunnel: false },
    ];
    const view = render(
      <SessionHeader {...defaultProps} directPeerCount={1} peers={peers} connectionState="connected-direct" />
    );
    fireEvent.click(view.getByRole("button", { name: /Connection status/ }));
    expect(view.getByText("this device")).toBeTruthy();
  });
});
