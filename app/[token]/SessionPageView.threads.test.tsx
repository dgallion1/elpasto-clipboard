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
import type { ComponentProps } from "react";
import type { SessionEntry } from "@/hooks/useSessionHistory";

// --- Mocks ----------------------------------------------------------------
let capturedSessionHeaderProps: Record<string, unknown> | undefined;
let capturedOnFocusZone: ((zone: string | null) => void) | undefined;

vi.mock("@/components/SessionHeader", () => ({
  SessionHeader: (props: Record<string, unknown>) => {
    capturedSessionHeaderProps = props;
    return <div data-testid="session-header" />;
  },
}));

vi.mock("@/components/PasteZone", () => ({
  PasteZone: ({
    zone,
    onFocusZone,
  }: {
    zone: string;
    onFocusZone?: (zone: string | null) => void;
  }) => {
    if (zone === "A") capturedOnFocusZone = onFocusZone;
    return <div data-testid={`paste-zone-${zone}`} />;
  },
}));

vi.mock("@/components/SecretPrompt", () => ({ SecretPrompt: () => null }));
vi.mock("@/components/IdentifyFlashOverlay", () => ({
  IdentifyFlashOverlay: () => null,
}));

const mockImportEntries = vi.fn().mockReturnValue(0);
let mockHistoryEntries: SessionEntry[] = [];

vi.mock("@/hooks/useSessionHistory", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/hooks/useSessionHistory")>();
  return {
    ...original,
    useSessionHistory: () => ({
      entries: mockHistoryEntries,
      add: vi.fn(),
      setLabel: vi.fn(),
      setMyPeerName: vi.fn(),
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

beforeEach(() => {
  capturedSessionHeaderProps = undefined;
  capturedOnFocusZone = undefined;
  mockHistoryEntries = [];
  mockImportEntries.mockReset();
  mockImportEntries.mockReturnValue(0);
  // matchMedia is required by SessionPageView
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn(() => ({
      matches: false,
      media: "(max-width: 767px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
      { id: "A", name: "Alpha", position: 0, updatedAt: 1 },
      { id: "B", name: "Bravo", position: 1, updatedAt: 1 },
    ],
    activeThreadId: "A",
    canCreateThread: true,
    onSelectThread: vi.fn(),
    onCreateThread: vi.fn(),
    onRenameThread: vi.fn(),
    onDeleteThread: vi.fn(),
    onMoveThread: vi.fn(),
    zones: [
      { zone: "A", threadName: "Alpha", clips: [], onClearZone: vi.fn() },
      { zone: "B", threadName: "Bravo", clips: [], onClearZone: vi.fn() },
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
      soundName: "droplet" as const,
      volume: "medium" as const,
      onSetEnabled: vi.fn(),
      onSetSoundName: vi.fn(),
      onCycleVolume: vi.fn(),
    },
    ...overrides,
  };
}

describe("SessionPageView edit threads mode", () => {
  test("clicking Edit reveals per-thread move/rename/delete controls", () => {
    const view = render(<SessionPageView {...makeProps()} />);
    // Before Edit, move/rename/delete buttons should NOT exist
    expect(view.queryByLabelText("Move thread Alpha left")).toBeNull();
    expect(view.queryByLabelText("Rename thread Alpha")).toBeNull();
    expect(view.queryByLabelText("Delete thread Alpha")).toBeNull();

    fireEvent.click(view.getByLabelText("Edit threads"));

    expect(view.getByLabelText("Move thread Alpha left")).toBeTruthy();
    expect(view.getByLabelText("Move thread Alpha right")).toBeTruthy();
    expect(view.getByLabelText("Rename thread Alpha")).toBeTruthy();
    expect(view.getByLabelText("Delete thread Alpha")).toBeTruthy();
    // The Edit button toggles to a Done label
    expect(view.getByLabelText("Done editing threads")).toBeTruthy();
  });

  test("Move left button calls onMoveThread with -1", () => {
    const onMoveThread = vi.fn();
    const view = render(<SessionPageView {...makeProps({ onMoveThread })} />);
    fireEvent.click(view.getByLabelText("Edit threads"));
    // Bravo is at index 1, so its left button is enabled.
    fireEvent.click(view.getByLabelText("Move thread Bravo left"));
    expect(onMoveThread).toHaveBeenCalledWith("B", -1);
  });

  test("Move right button calls onMoveThread with 1", () => {
    const onMoveThread = vi.fn();
    const view = render(<SessionPageView {...makeProps({ onMoveThread })} />);
    fireEvent.click(view.getByLabelText("Edit threads"));
    fireEvent.click(view.getByLabelText("Move thread Alpha right"));
    expect(onMoveThread).toHaveBeenCalledWith("A", 1);
  });

  test("Move left on first thread is disabled; Move right on last thread is disabled", () => {
    const view = render(<SessionPageView {...makeProps()} />);
    fireEvent.click(view.getByLabelText("Edit threads"));
    expect(view.getByLabelText("Move thread Alpha left").hasAttribute("disabled")).toBe(true);
    expect(view.getByLabelText("Move thread Bravo right").hasAttribute("disabled")).toBe(true);
  });

  test("Delete is disabled when only one thread remains", () => {
    const view = render(
      <SessionPageView
        {...makeProps({
          threads: [{ id: "A", name: "Alpha", position: 0, updatedAt: 1 }],
          zones: [{ zone: "A", threadName: "Alpha", clips: [], onClearZone: vi.fn() }],
        })}
      />,
    );
    fireEvent.click(view.getByLabelText("Edit threads"));
    expect(view.getByLabelText("Delete thread Alpha").hasAttribute("disabled")).toBe(true);
  });

  test("clicking Done toggles edit mode off", () => {
    const view = render(<SessionPageView {...makeProps()} />);
    fireEvent.click(view.getByLabelText("Edit threads"));
    expect(view.getByLabelText("Move thread Alpha left")).toBeTruthy();
    fireEvent.click(view.getByLabelText("Done editing threads"));
    expect(view.queryByLabelText("Move thread Alpha left")).toBeNull();
  });
});

describe("SessionPageView rename thread via prompt", () => {
  test("submitting a new name in the prompt calls onRenameThread", () => {
    const onRenameThread = vi.fn();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Renamed");
    const view = render(<SessionPageView {...makeProps({ onRenameThread })} />);
    fireEvent.click(view.getByLabelText("Edit threads"));
    fireEvent.click(view.getByLabelText("Rename thread Alpha"));
    expect(promptSpy).toHaveBeenCalledWith("Rename thread", "Alpha");
    expect(onRenameThread).toHaveBeenCalledWith("A", "Renamed");
  });

  test("cancelling the rename prompt does not call onRenameThread", () => {
    const onRenameThread = vi.fn();
    vi.spyOn(window, "prompt").mockReturnValue(null);
    const view = render(<SessionPageView {...makeProps({ onRenameThread })} />);
    fireEvent.click(view.getByLabelText("Edit threads"));
    fireEvent.click(view.getByLabelText("Rename thread Alpha"));
    expect(onRenameThread).not.toHaveBeenCalled();
  });

  test("an empty prompt response still calls onRenameThread (caller normalises)", () => {
    const onRenameThread = vi.fn();
    vi.spyOn(window, "prompt").mockReturnValue("");
    const view = render(<SessionPageView {...makeProps({ onRenameThread })} />);
    fireEvent.click(view.getByLabelText("Edit threads"));
    fireEvent.click(view.getByLabelText("Rename thread Alpha"));
    expect(onRenameThread).toHaveBeenCalledWith("A", "");
  });
});

describe("SessionPageView delete thread", () => {
  test("skips the confirm prompt when the thread has no clips", () => {
    const onDeleteThread = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = render(<SessionPageView {...makeProps({ onDeleteThread })} />);
    fireEvent.click(view.getByLabelText("Edit threads"));
    fireEvent.click(view.getByLabelText("Delete thread Alpha"));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onDeleteThread).toHaveBeenCalledWith("A");
  });

  test("confirms before deleting a thread with clips", () => {
    const onDeleteThread = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = render(
      <SessionPageView
        {...makeProps({
          onDeleteThread,
          zones: [
            {
              zone: "A",
              threadName: "Alpha",
              // 2 clips
              clips: [{ id: 1 } as never, { id: 2 } as never],
              onClearZone: vi.fn(),
            },
            { zone: "B", threadName: "Bravo", clips: [], onClearZone: vi.fn() },
          ],
        })}
      />,
    );
    fireEvent.click(view.getByLabelText("Edit threads"));
    fireEvent.click(view.getByLabelText("Delete thread Alpha"));
    expect(confirmSpy).toHaveBeenCalledWith(
      "Delete thread Alpha and its 2 clips?",
    );
    expect(onDeleteThread).toHaveBeenCalledWith("A");
  });

  test("declining the confirm leaves the thread untouched", () => {
    const onDeleteThread = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = render(
      <SessionPageView
        {...makeProps({
          onDeleteThread,
          zones: [
            {
              zone: "A",
              threadName: "Alpha",
              clips: [{ id: 1 } as never],
              onClearZone: vi.fn(),
            },
            { zone: "B", threadName: "Bravo", clips: [], onClearZone: vi.fn() },
          ],
        })}
      />,
    );
    fireEvent.click(view.getByLabelText("Edit threads"));
    fireEvent.click(view.getByLabelText("Delete thread Alpha"));
    expect(onDeleteThread).not.toHaveBeenCalled();
  });
});

describe("SessionPageView mobile tab bar", () => {
  test("clicking a mobile tab calls onSelectThread", () => {
    // matchMedia mock from beforeEach reports desktop, but the mobile bar
    // is always rendered (md:hidden hides it on desktop via CSS only).
    const onSelectThread = vi.fn();
    const view = render(<SessionPageView {...makeProps({ onSelectThread })} />);
    // The mobile bar duplicates each thread's "Select thread <name>" button.
    const all = view.getAllByLabelText("Select thread Bravo");
    // Mobile bar uses the thread.name as the label (no clip-count suffix in the aria).
    // Click each, then verify at least one call landed.
    for (const btn of all) {
      fireEvent.click(btn);
    }
    expect(onSelectThread).toHaveBeenCalledWith("B");
  });
});

describe("SessionPageView export sessions", () => {
  test("returns early without queuing a clip when session history is empty", async () => {
    const onQueueLocalBinaryClip = vi.fn();
    const onClipAdded = vi.fn();
    mockHistoryEntries = []; // empty history → buildSessionExportJson returns ""
    render(
      <SessionPageView
        {...makeProps({ onQueueLocalBinaryClip, onClipAdded })}
      />,
    );

    expect(capturedSessionHeaderProps).toBeDefined();
    const onExportSessions = capturedSessionHeaderProps!.onExportSessions as
      | (() => Promise<void>)
      | undefined;
    expect(onExportSessions).toBeDefined();

    await act(async () => {
      await onExportSessions!();
    });

    expect(onQueueLocalBinaryClip).not.toHaveBeenCalled();
    expect(onClipAdded).not.toHaveBeenCalled();
  });

  test("queues a binary clip and reports it to onClipAdded when history has entries", async () => {
    const onQueueLocalBinaryClip = vi.fn().mockResolvedValue({ id: 9 });
    const onClipAdded = vi.fn();
    // crypto.randomUUID is invoked inside onExportSessions.
    Object.defineProperty(globalThis, "crypto", {
      value: { ...globalThis.crypto, randomUUID: () => "uuid-1" },
      configurable: true,
    });
    mockHistoryEntries = [
      { token: "test-token", pinned: false, lastVisited: Date.now() },
    ];

    render(
      <SessionPageView
        {...makeProps({ onQueueLocalBinaryClip, onClipAdded })}
      />,
    );

    const onExportSessions =
      capturedSessionHeaderProps!.onExportSessions as () => Promise<void>;
    await act(async () => {
      await onExportSessions();
    });

    expect(onQueueLocalBinaryClip).toHaveBeenCalledTimes(1);
    const arg = onQueueLocalBinaryClip.mock.calls[0]![0];
    expect(arg.transferId).toBe("uuid-1");
    expect(arg.zone).toBe("A");
    expect(arg.kind).toBe("text");
    expect(arg.file).toBeInstanceOf(File);
    expect(onClipAdded).toHaveBeenCalledWith({ id: 9 });
  });

  test("attaches secretHandle in the queue payload when available", async () => {
    const onQueueLocalBinaryClip = vi.fn().mockResolvedValue({ id: 9 });
    mockHistoryEntries = [
      { token: "test-token", pinned: false, lastVisited: Date.now() },
    ];

    render(
      <SessionPageView
        {...makeProps({
          onQueueLocalBinaryClip,
          onClipAdded: vi.fn(),
          secretHandle: { mode: "normal", secret: "passphrase" },
        })}
      />,
    );

    const onExportSessions =
      capturedSessionHeaderProps!.onExportSessions as () => Promise<void>;
    await act(async () => {
      await onExportSessions();
    });

    expect(onQueueLocalBinaryClip.mock.calls[0]![0]).toMatchObject({
      secretHandle: { mode: "normal", secret: "passphrase" },
    });
  });

  test("falls back to unlockSecret when secretHandle is not set", async () => {
    const onQueueLocalBinaryClip = vi.fn().mockResolvedValue({ id: 9 });
    mockHistoryEntries = [
      { token: "test-token", pinned: false, lastVisited: Date.now() },
    ];

    render(
      <SessionPageView
        {...makeProps({
          onQueueLocalBinaryClip,
          onClipAdded: vi.fn(),
          unlockSecret: "fallback-secret",
        })}
      />,
    );

    const onExportSessions =
      capturedSessionHeaderProps!.onExportSessions as () => Promise<void>;
    await act(async () => {
      await onExportSessions();
    });

    expect(onQueueLocalBinaryClip.mock.calls[0]![0]).toMatchObject({
      secret: "fallback-secret",
    });
  });
});

describe("SessionPageView PasteZone onFocusZone", () => {
  test("forwards a non-null zone to onSelectThread", () => {
    const onSelectThread = vi.fn();
    render(<SessionPageView {...makeProps({ onSelectThread })} />);
    expect(capturedOnFocusZone).toBeDefined();
    act(() => {
      capturedOnFocusZone!("B");
    });
    expect(onSelectThread).toHaveBeenCalledWith("B");
  });

  test("ignores a null zone (no thread selection)", () => {
    const onSelectThread = vi.fn();
    render(<SessionPageView {...makeProps({ onSelectThread })} />);
    act(() => {
      capturedOnFocusZone!(null);
    });
    expect(onSelectThread).not.toHaveBeenCalled();
  });
});
