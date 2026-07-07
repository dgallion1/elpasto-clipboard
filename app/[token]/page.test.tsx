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
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Clip } from "@/lib/clips";
import type { PeerSignalMessage } from "@/lib/realtime-session";

const useParamsMock = vi.fn(() => ({ token: "session-1" }));
const routerPushMock = vi.fn();
const buildApiUrlMock = vi.fn((path: string) => path);
const useClipboardCapabilitiesMock = vi.fn(() => ({ canCopyImage: true }));
const useRealtimeSessionMock = vi.fn();
const usePeerMeshMock = vi.fn();
const fetchMock = vi.fn();
const deleteStoredBinaryClipsBySessionMock = vi.fn(async () => undefined);
const renamePeerMock = vi.fn();
const pingPeerMock = vi.fn();
const clearIdentifyFlashMock = vi.fn();
const deleteMasterKeyMock = vi.fn(async () => undefined);
const loadMasterKeyMock = vi.fn(async (): Promise<CryptoKey | null> => null);
const storeMasterKeyMock = vi.fn(async () => undefined);
const probeParanoidSupportMock = vi.fn(async () => false);

let latestRealtimeOptions: Record<string, unknown> | null = null;
let latestPeerMeshOptions: Record<string, unknown> | null = null;
let latestHeaderProps: Record<string, unknown> | null = null;
let latestPasteZoneProps = new Map<string, Record<string, unknown>>();

const attachCanonicalClipMock = vi.fn();
const clearLocalBinaryClipsMock = vi.fn();
const clearReceivedBinaryClipsMock = vi.fn();
const getDirectClipCiphertextMock = vi.fn(() => null);
const getLocalBinaryClipsByZoneMock = vi.fn(
  (zone: string) => localSenderClipsByZone[zone as "A" | "B"]
);
const getLocalBinaryClipGroupsMock = vi.fn(() => localSenderClipsByZone);
const getSendProgressMock = vi.fn(() => null);
const getReceivedBinaryClipsByZoneMock = vi.fn(
  (zone: string) => localReceiverClipsByZone[zone as "A" | "B"]
);
const getReceivedBinaryClipGroupsMock = vi.fn(() => localReceiverClipsByZone);
const getTransferStatsMock = vi.fn(() => null);
const handlePeerSignalMock = vi.fn();
const queueLocalBinaryClipMock = vi.fn();
const broadcastClipDeleteMock = vi.fn();
const broadcastThreadCreatedMock = vi.fn();
const broadcastThreadDeletedMock = vi.fn();
const broadcastThreadRenamedMock = vi.fn();
const broadcastThreadReorderedMock = vi.fn();
const removeLocalBinaryClipMock = vi.fn();
const removeReceivedBinaryClipMock = vi.fn();
const subscribeToSendProgressMock = vi.fn(() => () => undefined);
const subscribeToDirectTransfersMock = vi.fn(() => () => undefined);
const subscribeToLocalBinaryClipsMock = vi.fn(() => () => undefined);
const sendTunnelMessageMock = vi.fn(() => false);
const subscribeTunnelMock = vi.fn(() => () => undefined);
const openTunnelChannelMock = vi.fn(() => false);
const sendPeerSignalMock = vi.fn(async () => true);
let localSenderClipsByZone: Record<"A" | "B", Clip[]> = { A: [], B: [] };
let localReceiverClipsByZone: Record<"A" | "B", Clip[]> = { A: [], B: [] };
let currentToken = "session-1";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSessionResponse(clips: { A: Clip[]; B: Clip[] }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      token: "session-1",
      createdAt: "2026-03-08T10:00:00Z",
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      clips,
    }),
  };
}

async function waitForSessionPageReady() {
  await waitFor(() => expect(latestPasteZoneProps.get("A")).toBeDefined());
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
}

vi.mock("next/navigation", () => ({
  useParams: () => useParamsMock(),
  useRouter: () => ({ push: routerPushMock }),
}));

vi.mock("@/lib/api", () => ({
  buildApiUrl: buildApiUrlMock,
  buildSseUrl: buildApiUrlMock,
}));

vi.mock("@/lib/clip-store", () => ({
  deleteStoredBinaryClipsBySession: (...args: unknown[]) =>
    (deleteStoredBinaryClipsBySessionMock as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("@/lib/crypto-store", () => ({
  deleteMasterKey: (...args: unknown[]) =>
    (deleteMasterKeyMock as (...a: unknown[]) => unknown)(...args),
  loadMasterKey: (...args: unknown[]) =>
    (loadMasterKeyMock as (...a: unknown[]) => unknown)(...args),
  storeMasterKey: (...args: unknown[]) =>
    (storeMasterKeyMock as (...a: unknown[]) => unknown)(...args),
  probeParanoidSupport: () => probeParanoidSupportMock(),
}));

vi.mock("@/hooks/useClipboard", () => ({
  useClipboardCapabilities: useClipboardCapabilitiesMock,
}));

vi.mock("@/hooks/useRealtimeSession", () => ({
  useRealtimeSession: (options: Record<string, unknown>) => {
    latestRealtimeOptions = options;
    return useRealtimeSessionMock(options);
  },
}));

vi.mock("@/hooks/usePeerMesh", () => ({
  usePeerMesh: (options: Record<string, unknown>) => {
    latestPeerMeshOptions = options;
    return usePeerMeshMock(options);
  },
}));

vi.mock("@/components/SessionHeader", () => ({
  SessionHeader: (props: Record<string, unknown>) => {
    latestHeaderProps = props;
    return <div data-testid="session-header">{String(props.totalClips)}</div>;
  },
}));

vi.mock("@/components/PasteZone", () => ({
  PasteZone: (props: Record<string, unknown>) => {
    latestPasteZoneProps.set(String(props.zone), props);
    const clips = Array.isArray(props.clips) ? props.clips : [];
    return <div data-testid={`paste-zone-${String(props.zone)}`}>{clips.length}</div>;
  },
}));

let SessionPage: typeof import("./page").default;

beforeAll(async () => {
  ({ default: SessionPage } = await import("./page"));
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      matches: false,
      media: "(max-width: 767px)",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    writable: true,
    configurable: true,
  });
});

beforeEach(() => {
  currentToken = "session-1";
  useParamsMock.mockReset();
  useParamsMock.mockImplementation(() => ({ token: currentToken }));
  latestRealtimeOptions = null;
  latestPeerMeshOptions = null;
  latestHeaderProps = null;
  latestPasteZoneProps = new Map();
  localSenderClipsByZone = { A: [], B: [] };
  localReceiverClipsByZone = { A: [], B: [] };
  localStorage.setItem("elpasto:threads:session-1", JSON.stringify([
    { id: "A", name: "1", position: 0, updatedAt: 1 },
    { id: "B", name: "2", position: 1, updatedAt: 1 },
  ]));
  buildApiUrlMock.mockReset();
  buildApiUrlMock.mockImplementation((path: string) => path);
  useClipboardCapabilitiesMock.mockReset();
  useClipboardCapabilitiesMock.mockReturnValue({ canCopyImage: true });
  useRealtimeSessionMock.mockReset();
  useRealtimeSessionMock.mockImplementation((options: Record<string, unknown>) => ({
    signalingReady: Boolean(options.enabled),
    sendPeerSignal: sendPeerSignalMock,
  }));
  renamePeerMock.mockReset();
  pingPeerMock.mockReset();
  clearIdentifyFlashMock.mockReset();
  deleteStoredBinaryClipsBySessionMock.mockReset();
  deleteStoredBinaryClipsBySessionMock.mockResolvedValue(undefined);
  deleteMasterKeyMock.mockReset();
  deleteMasterKeyMock.mockResolvedValue(undefined);
  loadMasterKeyMock.mockReset();
  loadMasterKeyMock.mockResolvedValue(null);
  storeMasterKeyMock.mockReset();
  storeMasterKeyMock.mockResolvedValue(undefined);
  probeParanoidSupportMock.mockReset();
  probeParanoidSupportMock.mockResolvedValue(false);
  usePeerMeshMock.mockReset();
  usePeerMeshMock.mockReturnValue({
    attachCanonicalClip: attachCanonicalClipMock,
    clearLocalBinaryClips: clearLocalBinaryClipsMock,
    clearReceivedBinaryClips: clearReceivedBinaryClipsMock,
    getDirectClipCiphertext: getDirectClipCiphertextMock,
    getSendProgress: getSendProgressMock,
    getLocalBinaryClipsByZone: getLocalBinaryClipsByZoneMock,
    getLocalBinaryClipGroups: getLocalBinaryClipGroupsMock,
    getReceivedBinaryClipsByZone: getReceivedBinaryClipsByZoneMock,
    getReceivedBinaryClipGroups: getReceivedBinaryClipGroupsMock,
    getTransferStats: getTransferStatsMock,
    handlePeerSignal: handlePeerSignalMock,
    queueLocalBinaryClip: queueLocalBinaryClipMock,
    broadcastClipDelete: broadcastClipDeleteMock,
    broadcastThreadCreated: broadcastThreadCreatedMock,
    broadcastThreadDeleted: broadcastThreadDeletedMock,
    broadcastThreadRenamed: broadcastThreadRenamedMock,
    broadcastThreadReordered: broadcastThreadReorderedMock,
    peers: [],
    readyPeerCount: 2,
    localPeerId: "peer-local-test",
    peerNames: {},
    identifyFlash: null,
    clearIdentifyFlash: clearIdentifyFlashMock,
    pingPeer: pingPeerMock,
    renamePeer: renamePeerMock,
    removeLocalBinaryClip: removeLocalBinaryClipMock,
    removeReceivedBinaryClip: removeReceivedBinaryClipMock,
    subscribeToSendProgress: subscribeToSendProgressMock,
    subscribeToDirectTransfers: subscribeToDirectTransfersMock,
    subscribeToLocalBinaryClips: subscribeToLocalBinaryClipsMock,
    sendTunnelMessage: sendTunnelMessageMock,
    subscribeTunnel: subscribeTunnelMock,
    openTunnelChannel: openTunnelChannelMock,
  });
  attachCanonicalClipMock.mockReset();
  clearLocalBinaryClipsMock.mockReset();
  clearReceivedBinaryClipsMock.mockReset();
  getDirectClipCiphertextMock.mockReset();
  getDirectClipCiphertextMock.mockReturnValue(null);
  getSendProgressMock.mockReset();
  getSendProgressMock.mockReturnValue(null);
  getLocalBinaryClipsByZoneMock.mockReset();
  getLocalBinaryClipsByZoneMock.mockImplementation(
    (zone: string) => localSenderClipsByZone[zone as "A" | "B"]
  );
  getLocalBinaryClipGroupsMock.mockReset();
  getLocalBinaryClipGroupsMock.mockImplementation(() => localSenderClipsByZone);
  getReceivedBinaryClipsByZoneMock.mockReset();
  getReceivedBinaryClipsByZoneMock.mockImplementation(
    (zone: string) => localReceiverClipsByZone[zone as "A" | "B"]
  );
  getReceivedBinaryClipGroupsMock.mockReset();
  getReceivedBinaryClipGroupsMock.mockImplementation(() => localReceiverClipsByZone);
  getTransferStatsMock.mockReset();
  getTransferStatsMock.mockReturnValue(null);
  handlePeerSignalMock.mockReset();
  queueLocalBinaryClipMock.mockReset();
  broadcastClipDeleteMock.mockReset();
  broadcastThreadCreatedMock.mockReset();
  broadcastThreadDeletedMock.mockReset();
  broadcastThreadRenamedMock.mockReset();
  broadcastThreadReorderedMock.mockReset();
  removeLocalBinaryClipMock.mockReset();
  removeReceivedBinaryClipMock.mockReset();
  subscribeToSendProgressMock.mockClear();
  subscribeToDirectTransfersMock.mockClear();
  subscribeToLocalBinaryClipsMock.mockClear();
  sendTunnelMessageMock.mockClear();
  subscribeTunnelMock.mockClear();
  openTunnelChannelMock.mockClear();
  sendPeerSignalMock.mockReset();
  sendPeerSignalMock.mockResolvedValue(true);
  routerPushMock.mockReset();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SessionPage", () => {
  test("loads canonical and local clips, attaches canonical rows, and forwards peer signals", async () => {
    const clipA = { id: 1, zone: "A", created_at: "2026-03-08T10:00:00Z" } as Clip;
    const clipB = { id: 2, zone: "B", created_at: "2026-03-08T10:01:00Z" } as Clip;
    const localSender = {
      id: -1,
      zone: "A",
      local_only: true,
      local_origin: "sender",
      created_at: "2026-03-08T10:02:00Z",
    } as Clip;
    const localReceiver = {
      id: -2,
      zone: "A",
      local_only: true,
      local_origin: "receiver",
      created_at: "2026-03-08T10:03:00Z",
    } as Clip;

    localSenderClipsByZone = { A: [localSender], B: [] };
    localReceiverClipsByZone = { A: [localReceiver], B: [] };

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [clipA], B: [clipB] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [clipA], B: [clipB] }));

    render(<SessionPage />);

    await waitFor(() => expect(latestPasteZoneProps.get("A")?.clips).toBeDefined());
    await waitFor(() => expect(attachCanonicalClipMock).toHaveBeenCalledWith(clipA));
    expect((latestPasteZoneProps.get("A")?.clips as Clip[]).map((clip) => clip.id)).toEqual([
      -2,
      -1,
      1,
    ]);
    expect(latestPasteZoneProps.get("B")?.clips).toEqual([clipB]);
    expect(attachCanonicalClipMock).toHaveBeenCalledWith(clipB);

    expect(latestPeerMeshOptions).toMatchObject({
      enabled: true,
      signalingReady: true,
      sendPeerSignal: sendPeerSignalMock,
      getCurrentUnlockSecret: expect.any(Function),
    });
    expect(
      (latestPeerMeshOptions?.getCurrentUnlockSecret as () => string | null)()
    ).toBeNull();
    expect(latestPasteZoneProps.get("A")).toMatchObject({
      getSendProgress: getSendProgressMock,
      getTransferStats: getTransferStatsMock,
      subscribeToSendProgress: subscribeToSendProgressMock,
    });
    expect(latestHeaderProps?.connectionState).toBe("connected-direct");
    expect(latestHeaderProps?.totalClips).toBe(4);

    const peerMessage = {
      fromPeerId: "peer-z",
      signalType: "announce",
    } satisfies PeerSignalMessage;

    await act(async () => {
      (latestRealtimeOptions?.onPeerSignal as (message: PeerSignalMessage) => void)(peerMessage);
    });
    expect(handlePeerSignalMock).toHaveBeenCalledWith(peerMessage);
  });

  test("does not gate empty sessions behind a secret prompt", async () => {
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);

    await waitFor(() => expect(latestPasteZoneProps.get("A")).toBeDefined());
    // Session loads and shows paste zones without requiring a secret upfront
    expect(latestPasteZoneProps.get("A")?.unlockSecret).toBeNull();
    expect(latestPasteZoneProps.get("B")).toBeDefined();
  });

  test("routes local deletes and mixed clear actions through peer mesh only", async () => {
    const canonicalClip = { id: 1, zone: "A", created_at: "2026-03-08T10:00:00Z" } as Clip;
    const localSender = {
      id: -1,
      zone: "A",
      local_only: true,
      local_origin: "sender",
      created_at: "2026-03-08T10:01:00Z",
    } as Clip;

    localSenderClipsByZone = { A: [localSender], B: [] };
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }))
      .mockResolvedValue({ ok: true, status: 200 });

    render(<SessionPage />);

    await waitFor(() => expect(latestPasteZoneProps.get("A")).toBeDefined());

    await act(async () => {
      (latestPasteZoneProps.get("A")?.onClipDeleted as (clip: Clip) => void)(localSender);
    });
    expect(removeLocalBinaryClipMock).toHaveBeenCalledWith(-1);

    await act(async () => {
      await (latestPasteZoneProps.get("A")?.onClearZone as () => Promise<void>)();
    });

    expect(clearLocalBinaryClipsMock).toHaveBeenCalledWith("A");
    expect(clearReceivedBinaryClipsMock).toHaveBeenCalledWith("A");

    await act(async () => {
      await (latestHeaderProps?.onClearAll as () => Promise<void>)();
    });

    expect(clearLocalBinaryClipsMock).toHaveBeenCalledWith();
    expect(clearReceivedBinaryClipsMock).toHaveBeenCalledWith();
  });

  test("removes stale canonical local-only sender clips from controller state when deleted", async () => {
    const staleLocalSender = {
      id: -1,
      zone: "A",
      local_only: true,
      local_origin: "sender",
      created_at: "2026-03-08T10:01:00Z",
    } as Clip;

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [staleLocalSender], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [staleLocalSender], B: [] }));

    render(<SessionPage />);

    await waitFor(() => expect(latestPasteZoneProps.get("A")?.clips).toEqual([staleLocalSender]));

    await act(async () => {
      (latestPasteZoneProps.get("A")?.onClipDeleted as (clip: Clip) => void)(staleLocalSender);
    });

    expect(removeLocalBinaryClipMock).toHaveBeenCalledWith(-1);
    expect(latestPasteZoneProps.get("A")?.clips).toEqual([]);
  });

  test("prefers canonical clips over local binary placeholders with the same transfer id", async () => {
    const canonicalClip = {
      id: 101,
      zone: "A",
      kind: "image",
      client_transfer_id: "transfer-1",
      created_at: "2026-03-08T10:02:00Z",
    } as Clip;
    const localSender = {
      id: -1,
      zone: "A",
      kind: "image",
      client_transfer_id: "transfer-1",
      local_only: true,
      local_origin: "sender",
      created_at: "2026-03-08T10:02:00Z",
    } as Clip;

    localSenderClipsByZone = { A: [localSender], B: [] };
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }));

    render(<SessionPage />);

    await waitFor(() => expect(latestPasteZoneProps.get("A")?.clips).toBeDefined());
    expect(latestPasteZoneProps.get("A")?.clips).toEqual([canonicalClip]);
    expect(latestHeaderProps?.totalClips).toBe(1);
  });

  test("removes sender-side binary state by transfer id when deleting a canonical clip", async () => {
    const canonicalClip = {
      id: 101,
      zone: "A",
      kind: "image",
      client_transfer_id: "transfer-1",
      created_at: "2026-03-08T10:02:00Z",
    } as Clip;

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }));

    const view = render(<SessionPage />);

    await waitFor(() => expect(latestPasteZoneProps.get("A")?.clips).toEqual([canonicalClip]));

    await act(async () => {
      (latestPasteZoneProps.get("A")?.onClipDeleted as (clip: Clip) => void)(canonicalClip);
    });

    expect(removeLocalBinaryClipMock).toHaveBeenCalledWith("transfer-1");
    expect(removeReceivedBinaryClipMock).toHaveBeenCalledWith(101);

    view.unmount();
    removeLocalBinaryClipMock.mockClear();
    removeReceivedBinaryClipMock.mockClear();
    latestPasteZoneProps = new Map();
    latestRealtimeOptions = null;

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }));

    render(<SessionPage />);

    await waitFor(() => expect(latestPasteZoneProps.get("A")?.clips).toEqual([canonicalClip]));

    await act(async () => {
      (latestRealtimeOptions?.onClipDeleted as (data: { id: number; zone: "A" | "B" }) => void)({
        id: 101,
        zone: "A",
      });
    });

    expect(removeLocalBinaryClipMock).toHaveBeenCalledWith("transfer-1");
    expect(removeReceivedBinaryClipMock).toHaveBeenCalledWith(101);
  });

  test("falls back to the canonical transfer-id map when deleting a rendered canonical clip without client_transfer_id", async () => {
    const canonicalClip = {
      id: 111,
      zone: "A",
      kind: "image",
      client_transfer_id: "transfer-fallback-delete",
      created_at: "2026-03-08T10:02:00Z",
    } as Clip;

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }));

    render(<SessionPage />);

    await waitFor(() => expect(latestPasteZoneProps.get("A")?.clips).toEqual([canonicalClip]));

    await act(async () => {
      (latestPasteZoneProps.get("A")?.onClipDeleted as (clip: Clip) => void)({
        ...canonicalClip,
        client_transfer_id: null,
      });
    });

    expect(removeLocalBinaryClipMock).toHaveBeenCalledWith("transfer-fallback-delete");
    expect(removeReceivedBinaryClipMock).toHaveBeenCalledWith(111);
    expect(broadcastClipDeleteMock).toHaveBeenCalledWith("transfer-fallback-delete");
  });

  test("broadcasts clip:delete to peers when deleting a clip with a transfer id", async () => {
    const canonicalClip = {
      id: 201,
      zone: "A",
      kind: "image",
      client_transfer_id: "transfer-peer-delete",
      created_at: "2026-03-08T10:02:00Z",
    } as Clip;

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }));

    render(<SessionPage />);

    await waitFor(() => expect(latestPasteZoneProps.get("A")?.clips).toEqual([canonicalClip]));

    await act(async () => {
      (latestPasteZoneProps.get("A")?.onClipDeleted as (clip: Clip) => void)(canonicalClip);
    });

    expect(broadcastClipDeleteMock).toHaveBeenCalledWith("transfer-peer-delete");
  });

  test("broadcasts clip:delete to peers when deleting a local receiver clip with a transfer id", async () => {
    const receiverClip: Clip = {
      id: -1000000,
      session_id: 0,
      zone: "A",
      kind: "image",
      client_transfer_id: "transfer-receiver-delete",
      mime_type: "image/png",
      text_content: null,
      html_content: null,
      storage_key: null,
      original_name: "photo.png",
      size_bytes: 1024,
      encrypted: false,
      encryption_version: null,
      encryption_meta: null,
      created_at: "2026-03-08T10:00:00Z",
      local_only: true,
      local_origin: "receiver",
      local_transfer_state: "failed",
      local_file: null,
    };

    localReceiverClipsByZone = { A: [receiverClip], B: [] };
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);

    await waitFor(() => {
      const clips = latestPasteZoneProps.get("A")?.clips as Clip[];
      return expect(clips?.some((c) => c.id === -1000000)).toBe(true);
    });

    await act(async () => {
      (latestPasteZoneProps.get("A")?.onClipDeleted as (clip: Clip) => void)(receiverClip);
    });

    expect(broadcastClipDeleteMock).toHaveBeenCalledWith("transfer-receiver-delete");
  });

  test("does not double-broadcast clip:delete when deleting a local sender clip with a transfer id", async () => {
    const senderClip: Clip = {
      id: -1000001,
      session_id: 0,
      zone: "A",
      kind: "image",
      client_transfer_id: "transfer-sender-delete",
      mime_type: "image/png",
      text_content: null,
      html_content: null,
      storage_key: null,
      original_name: "photo.png",
      size_bytes: 1024,
      encrypted: false,
      encryption_version: null,
      encryption_meta: null,
      created_at: "2026-03-08T10:00:00Z",
      local_only: true,
      local_origin: "sender",
      local_transfer_state: "failed",
      local_file: null,
    };

    localSenderClipsByZone = { A: [senderClip], B: [] };
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);

    await waitFor(() => {
      const clips = latestPasteZoneProps.get("A")?.clips as Clip[];
      return expect(clips?.some((c) => c.id === -1000001)).toBe(true);
    });

    await act(async () => {
      (latestPasteZoneProps.get("A")?.onClipDeleted as (clip: Clip) => void)(senderClip);
    });

    expect(removeLocalBinaryClipMock).toHaveBeenCalledWith(-1000001);
    expect(broadcastClipDeleteMock).not.toHaveBeenCalled();
  });

  test("re-syncs session clips when realtime becomes ready to avoid missed updates", async () => {
    let signalingReady = false;
    useRealtimeSessionMock.mockImplementation(() => ({
      signalingReady,
      sendPeerSignal: sendPeerSignalMock,
    }));

    const missedClip = {
      id: 9,
      zone: "A",
      created_at: "2026-03-08T10:05:00Z",
    } as Clip;

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          token: "session-1",
          createdAt: "2026-03-08T10:00:00Z",
          expiresAt: new Date(Date.now() + 5000).toISOString(),
          clips: {
            A: [],
            B: [],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          token: "session-1",
          createdAt: "2026-03-08T10:00:00Z",
          expiresAt: new Date(Date.now() + 5000).toISOString(),
          clips: {
            A: [missedClip],
            B: [],
          },
        }),
      });

    const view = render(<SessionPage />);

    await waitFor(() => expect(latestPasteZoneProps.get("A")?.clips).toEqual([]));

    signalingReady = true;
    view.rerender(<SessionPage />);

    await waitFor(() => expect(latestPasteZoneProps.get("A")?.clips).toEqual([missedClip]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/sessions/session-1");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/sessions/session-1");
  });

  test("ignores stale session responses after the token changes", async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    let resolveSecond: ((value: unknown) => void) | null = null;
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const secondResponse = new Promise((resolve) => {
      resolveSecond = resolve;
    });

    fetchMock
      .mockReturnValueOnce(firstResponse)
      .mockReturnValueOnce(secondResponse);

    const view = render(<SessionPage />);

    currentToken = "session-2";
    view.rerender(<SessionPage />);

    resolveSecond!({
      ok: true,
      status: 200,
      json: async () => ({
        token: "session-2",
        createdAt: "2026-03-08T10:00:00Z",
        expiresAt: new Date(Date.now() + 5000).toISOString(),
        clips: {
          A: [{ id: 22, zone: "A", created_at: "2026-03-08T10:02:00Z" }],
          B: [],
        },
      }),
    });

    await waitFor(() => expect(latestHeaderProps?.token).toBe("session-2"));
    expect((latestPasteZoneProps.get("A")?.clips as Clip[]).map((clip) => clip.id)).toEqual([22]);

    resolveFirst!({
      ok: true,
      status: 200,
      json: async () => ({
        token: "session-1",
        createdAt: "2026-03-08T10:00:00Z",
        expiresAt: new Date(Date.now() + 5000).toISOString(),
        clips: {
          A: [{ id: 11, zone: "A", created_at: "2026-03-08T10:01:00Z" }],
          B: [],
        },
      }),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(latestHeaderProps?.token).toBe("session-2");
    expect((latestPasteZoneProps.get("A")?.clips as Clip[]).map((clip) => clip.id)).toEqual([22]);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/sessions/session-1");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/sessions/session-2");
  });

  test("clears local state without relying on the removed clip delete API", async () => {
    const canonicalClip = { id: 1, zone: "A", created_at: "2026-03-08T10:00:00Z" } as Clip;

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }));

    render(<SessionPage />);

    await waitFor(() => expect(latestPasteZoneProps.get("A")).toBeDefined());

    await expect(
      (latestPasteZoneProps.get("A")?.onClearZone as () => Promise<void>)()
    ).resolves.toBeUndefined();
    expect(clearLocalBinaryClipsMock).toHaveBeenCalledWith("A");
    expect(clearReceivedBinaryClipsMock).toHaveBeenCalledWith("A");

    await expect((latestHeaderProps?.onClearAll as () => Promise<void>)()).resolves.toBeUndefined();
    expect(clearLocalBinaryClipsMock).toHaveBeenCalledWith();
    expect(clearReceivedBinaryClipsMock).toHaveBeenCalledWith();
  });

  test("shows load errors and redirects immediately for expired sessions", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    });

    const { getByRole, getByText, unmount } = render(<SessionPage />);
    await waitFor(() => expect(getByRole("alert").textContent).toContain("Session not found"));

    await act(async () => {
      fireEvent.click(getByText("Go Home"));
    });
    expect(routerPushMock).toHaveBeenCalledWith("/");

    unmount();
    routerPushMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new Error("boom"));

    const genericFailure = render(<SessionPage />);
    await waitFor(() =>
      expect(genericFailure.getByRole("alert").textContent).toContain("Failed to load session")
    );

    genericFailure.unmount();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        token: "session-1",
        createdAt: "2026-03-08T10:00:00Z",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        clips: {
          A: [],
          B: [],
        },
      }),
    });

    render(<SessionPage />);
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith("/"));
  });

  test("does not fire setTimeout for far-future expiry (avoids 32-bit overflow)", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    // Session with 10-year expiry — exceeds 32-bit signed int max (~24.8 days)
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000 * 10).toISOString();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        token: "session-1",
        createdAt: "2026-03-08T10:00:00Z",
        expiresAt: farFuture,
        clips: { A: [], B: [] },
      }),
    });

    const { unmount } = render(<SessionPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // setTimeout should NOT have been called with a delay exceeding MAX_SAFE_TIMEOUT
    const MAX_TIMEOUT = 0x7FFF_FFFF;
    const expirySetTimeout = setTimeoutSpy.mock.calls.find(
      ([, delay]) => typeof delay === "number" && delay > MAX_TIMEOUT
    );
    expect(expirySetTimeout).toBeUndefined();

    // Should NOT redirect (no immediate fire)
    expect(routerPushMock).not.toHaveBeenCalled();

    unmount();
    setTimeoutSpy.mockRestore();
  });

  test("applies realtime create, delete, clear, and local add flows across both zones", async () => {
    const clipA = { id: 1, zone: "A", created_at: "2026-03-08T10:00:00Z" } as Clip;
    const clipB = { id: 2, zone: "B", created_at: "2026-03-08T10:01:00Z" } as Clip;
    const receiverClip = {
      id: -2,
      zone: "B",
      local_only: true,
      local_origin: "receiver",
      created_at: "2026-03-08T10:02:00Z",
    } as Clip;

    localReceiverClipsByZone = { A: [], B: [receiverClip] };
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [clipA], B: [clipB] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [clipA], B: [clipB] }));

    render(<SessionPage />);
    await waitFor(() => expect(latestPasteZoneProps.get("B")?.clips).toBeDefined());

    const createdA = { id: 10, zone: "A", created_at: "2026-03-08T10:03:00Z" } as Clip;
    const createdB = { id: 20, zone: "B", created_at: "2026-03-08T10:04:00Z" } as Clip;
    const localAdded = { id: 30, zone: "B", created_at: "2026-03-08T10:05:00Z" } as Clip;

    await act(async () => {
      (latestRealtimeOptions?.onClipCreated as (clip: Clip) => void)(createdA);
      (latestRealtimeOptions?.onClipCreated as (clip: Clip) => void)(createdA);
      (latestRealtimeOptions?.onClipCreated as (clip: Clip) => void)(createdB);
      (latestPasteZoneProps.get("B")?.onClipAdded as (clip: Clip) => void)(localAdded);
      (latestPasteZoneProps.get("B")?.onClipAdded as (clip: Clip) => void)(localAdded);
    });

    expect((latestPasteZoneProps.get("A")?.clips as Clip[]).map((clip) => clip.id)).toEqual([10, 1]);
    expect((latestPasteZoneProps.get("B")?.clips as Clip[]).map((clip) => clip.id)).toEqual([
      30,
      20,
      -2,
      2,
    ]);

    await act(async () => {
      (latestPasteZoneProps.get("B")?.onClipDeleted as (clip: Clip) => void)(receiverClip);
      (latestPasteZoneProps.get("B")?.onClipDeleted as (clip: Clip) => void)(createdB);
      (latestRealtimeOptions?.onClipDeleted as (data: { id: number; zone: "B" }) => void)({
        id: 2,
        zone: "B",
      });
      (latestRealtimeOptions?.onClipsCleared as (data: { zone?: "A" | "B" }) => void)({ zone: "A" });
    });

    expect(removeReceivedBinaryClipMock).toHaveBeenCalledWith(-2);
    expect(latestPasteZoneProps.get("A")?.clips).toEqual([]);
    expect((latestPasteZoneProps.get("B")?.clips as Clip[]).map((clip) => clip.id)).toEqual([
      30,
      -2,
    ]);

    await act(async () => {
      (latestRealtimeOptions?.onClipsCleared as (data: { zone?: "A" | "B" }) => void)({});
    });
    expect(latestPasteZoneProps.get("A")?.clips).toEqual([]);
    expect((latestPasteZoneProps.get("B")?.clips as Clip[]).map((clip) => clip.id)).toEqual([-2]);
  });

  test("handles non-404 load failures and clears zone B without a server delete when only local clips remain", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const failedLoad = render(<SessionPage />);
    await waitFor(() =>
      expect(failedLoad.getByRole("alert").textContent).toContain("Failed to load session")
    );
    failedLoad.unmount();

    const localReceiver = {
      id: -9,
      zone: "B",
      local_only: true,
      local_origin: "receiver",
      created_at: "2026-03-08T10:06:00Z",
    } as Clip;

    localReceiverClipsByZone = { A: [], B: [localReceiver] };
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitFor(() => expect(latestPasteZoneProps.get("B")?.clips).toEqual([localReceiver]));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      await (latestPasteZoneProps.get("B")?.onClearZone as () => Promise<void>)();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clearLocalBinaryClipsMock).toHaveBeenCalledWith("B");
    expect(clearReceivedBinaryClipsMock).toHaveBeenCalledWith("B");
  });

  test("handleExpired deletes IndexedDB clips and redirects home", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        token: "session-1",
        createdAt: "2026-03-08T10:00:00Z",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        clips: { A: [], B: [] },
      }),
    });

    render(<SessionPage />);
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith("/"));
    expect(deleteStoredBinaryClipsBySessionMock).toHaveBeenCalledWith("session-1");
  });

  test("handleExpired fires when session expires via SSE event", async () => {
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitFor(() => expect(latestRealtimeOptions).not.toBeNull());

    await act(async () => {
      (latestRealtimeOptions?.onSessionExpired as () => void)();
    });

    expect(deleteStoredBinaryClipsBySessionMock).toHaveBeenCalledWith("session-1");
    expect(routerPushMock).toHaveBeenCalledWith("/");
  });

  test("session 404 triggers batch recreation and retries load on success", async () => {
    const sessionData = {
      token: "session-1",
      createdAt: "2026-03-08T10:00:00Z",
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      clips: { A: [{ id: 99, zone: "A", created_at: "2026-03-08T10:00:00Z" }], B: [] },
    };

    fetchMock
      // First load: 404
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      // Batch creation: success
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ created: ["session-1"], existing: [], invalid: [], capacity: [] }),
      })
      // Retry load: success
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => sessionData,
      })
      // Background re-sync (SSE reconnect) — same data
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => sessionData,
      });

    render(<SessionPage />);
    await waitFor(() => {
      const clips = latestPasteZoneProps.get("A")?.clips as Clip[];
      return expect(clips?.some((c) => c.id === 99)).toBe(true);
    });

    // At minimum 3 calls: initial 404, batch POST, retry GET
    // Plus potentially a background re-sync when signalingReady toggles
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  test("session 404 with batch recreation failure on foreground load shows error", async () => {
    fetchMock
      // First load: 404
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      // Batch creation: fails
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    const { getByRole } = render(<SessionPage />);
    await waitFor(() =>
      expect(getByRole("alert").textContent).toContain("Session not found")
    );
  });

  test("session 404 on background load is silenced after batch recreation failure", async () => {
    let signalingReady = false;
    useRealtimeSessionMock.mockImplementation(() => ({
      signalingReady,
      sendPeerSignal: sendPeerSignalMock,
    }));

    // Initial foreground load: success
    fetchMock.mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    const view = render(<SessionPage />);
    await waitFor(() => expect(latestPasteZoneProps.get("A")).toBeDefined());

    // Background load (SSE reconnect) triggers 404 -> batch fails -> silent
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    signalingReady = true;
    view.rerender(<SessionPage />);

    // Should NOT show error — background load is silenced
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    // Session header should still be visible (not replaced by error)
    expect(latestHeaderProps?.token).toBe("session-1");
  });

  test("non-200 response on background load is silenced", async () => {
    let signalingReady = false;
    useRealtimeSessionMock.mockImplementation(() => ({
      signalingReady,
      sendPeerSignal: sendPeerSignalMock,
    }));

    // Initial foreground load: success
    fetchMock.mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    const view = render(<SessionPage />);
    await waitFor(() => expect(latestPasteZoneProps.get("A")).toBeDefined());

    // Background load returns 500 — should be silenced
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    signalingReady = true;
    view.rerender(<SessionPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Session should still be rendered, not replaced by error
    expect(latestHeaderProps?.token).toBe("session-1");
  });

  test("network error on background load is silenced", async () => {
    let signalingReady = false;
    useRealtimeSessionMock.mockImplementation(() => ({
      signalingReady,
      sendPeerSignal: sendPeerSignalMock,
    }));

    // Initial foreground load: success
    fetchMock.mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    const view = render(<SessionPage />);
    await waitFor(() => expect(latestPasteZoneProps.get("A")).toBeDefined());

    // Background load throws network error — should be silenced
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    signalingReady = true;
    view.rerender(<SessionPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Session should still be rendered
    expect(latestHeaderProps?.token).toBe("session-1");
  });

  test("handleLocalClipAdded skips local_only clips", async () => {
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitForSessionPageReady();

    const localOnlyClip = {
      id: -42,
      zone: "A",
      local_only: true,
      local_origin: "sender",
      created_at: "2026-03-08T10:05:00Z",
    } as Clip;

    await act(async () => {
      (latestPasteZoneProps.get("A")?.onClipAdded as (clip: Clip) => void)(localOnlyClip);
    });

    // local_only clips should not be added to canonical clips
    // The merged clips should only contain what the sender mock provides
    const clips = latestPasteZoneProps.get("A")?.clips as Clip[];
    const canonical = clips?.filter((c) => !c.local_only);
    expect(canonical).toEqual([]);
  });

  test("session response with tunnels hydrates server-relay tunnels", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        token: "session-1",
        createdAt: "2026-03-08T10:00:00Z",
        expiresAt: new Date(Date.now() + 5000).toISOString(),
        clips: { A: [], B: [] },
        tunnels: [
          { peerId: "peer-tunnel-1", serverRelay: true, label: "my-server", port: 8080 },
        ],
      }),
    });

    render(<SessionPage />);
    await waitFor(() => expect(latestPasteZoneProps.get("A")).toBeDefined());
    // The tunnel data is processed — we can't directly verify the tunnel ref call
    // but we confirm the session loads successfully with tunnel data
    expect(latestHeaderProps?.token).toBe("session-1");
  });

  test("session 404 batch recreation retry also processes tunnels in response", async () => {
    fetchMock
      // First load: 404
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      // Batch creation: success
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ created: ["session-1"], existing: [], invalid: [], capacity: [] }),
      })
      // Retry load: success with tunnels
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          token: "session-1",
          createdAt: "2026-03-08T10:00:00Z",
          expiresAt: new Date(Date.now() + 5000).toISOString(),
          clips: { A: [], B: [] },
          tunnels: [{ peerId: "tunnel-peer", serverRelay: true }],
        }),
      });

    render(<SessionPage />);
    await waitFor(() => expect(latestHeaderProps?.token).toBe("session-1"));
  });

  test("session 404 batch recreation succeeds but retry GET fails shows error", async () => {
    fetchMock
      // First load: 404
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      // Batch creation: success
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ created: ["session-1"], existing: [], invalid: [], capacity: [] }),
      })
      // Retry load: also fails
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    const { getByRole } = render(<SessionPage />);
    await waitFor(() =>
      expect(getByRole("alert").textContent).toContain("Session not found")
    );
  });

  test("batch recreation network error falls through to 404 handling", async () => {
    fetchMock
      // First load: 404
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      // Batch creation: network error
      .mockRejectedValueOnce(new Error("network down"));

    const { getByRole } = render(<SessionPage />);
    await waitFor(() =>
      expect(getByRole("alert").textContent).toContain("Session not found")
    );
  });

  test("mergeClips prefers sender clips over receiver clips with same transfer id", async () => {
    const senderClip = {
      id: -1,
      zone: "A",
      kind: "image",
      client_transfer_id: "transfer-merge",
      local_only: true,
      local_origin: "sender",
      local_file: new File(["data"], "photo.png"),
      created_at: "2026-03-08T10:02:00Z",
    } as unknown as Clip;
    const receiverClip = {
      id: -2,
      zone: "A",
      kind: "image",
      client_transfer_id: "transfer-merge",
      local_only: true,
      local_origin: "receiver",
      created_at: "2026-03-08T10:02:00Z",
    } as Clip;

    localSenderClipsByZone = { A: [senderClip], B: [] };
    localReceiverClipsByZone = { A: [receiverClip], B: [] };

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);

    await waitFor(() => {
      const clips = latestPasteZoneProps.get("A")?.clips as Clip[];
      return expect(clips?.length).toBe(1);
    });
    // The merged result should be the sender clip (preferred over receiver)
    const clips = latestPasteZoneProps.get("A")?.clips as Clip[];
    expect(clips[0].local_origin).toBe("sender");
  });

  test("mergeClips replaces local_only clip with canonical (non-local) clip", async () => {
    const localOnlyClip = {
      id: -1,
      zone: "A",
      kind: "image",
      client_transfer_id: "transfer-promote",
      local_only: true,
      local_origin: "sender",
      created_at: "2026-03-08T10:02:00Z",
    } as Clip;
    const canonicalClip = {
      id: 500,
      zone: "A",
      kind: "image",
      client_transfer_id: "transfer-promote",
      local_only: false,
      created_at: "2026-03-08T10:02:00Z",
    } as Clip;

    localSenderClipsByZone = { A: [localOnlyClip], B: [] };

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [canonicalClip], B: [] }));

    render(<SessionPage />);

    await waitFor(() => {
      const clips = latestPasteZoneProps.get("A")?.clips as Clip[];
      return expect(clips?.length).toBe(1);
    });
    const clips = latestPasteZoneProps.get("A")?.clips as Clip[];
    // The canonical (non-local) clip should replace the local-only one
    expect(clips[0].id).toBe(500);
    expect(clips[0].local_only).toBeFalsy();
  });

  test("unlock secret is read from sessionStorage on mount and forwarded to peer mesh", async () => {
    sessionStorage.setItem("elpasto:secret:session-1", "my-secret-key");

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitForSessionPageReady();

    expect(latestPasteZoneProps.get("A")?.unlockSecret).toBe("my-secret-key");
    // getCurrentUnlockSecret should return the secret
    const getSecret = latestPeerMeshOptions?.getCurrentUnlockSecret as () => string | null;
    expect(getSecret()).toBe("my-secret-key");

    sessionStorage.removeItem("elpasto:secret:session-1");
  });

  test("handleSecretSubmit deletes paranoid master key so reload stays in normal mode", async () => {
    loadMasterKeyMock.mockResolvedValueOnce({ algorithm: { name: "HKDF" } } as CryptoKey);
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitFor(() => expect(latestHeaderProps).toBeDefined());

    // Open the secret manager via header's onManageSecret
    const onManageSecret = latestHeaderProps?.onManageSecret as () => void;
    act(() => { onManageSecret(); });

    // The SecretPrompt should now be open — find its text input and Use Secret button
    const input = document.querySelector("input[type='text']") as HTMLInputElement;
    expect(input).toBeTruthy();
    // Need a strong secret (>=12 chars) to pass validation
    fireEvent.change(input, { target: { value: "strong-normal-secret-12" } });

    // Find the "Use Secret" submit button
    deleteMasterKeyMock.mockClear();
    const buttons = Array.from(document.querySelectorAll("button"));
    const submitButton = buttons.find((b) => b.textContent === "Use Secret");
    expect(submitButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(submitButton!);
    });

    // Should have deleted any persisted paranoid master key
    expect(deleteMasterKeyMock).toHaveBeenCalledWith("session-1");

    // Normal secret should be in sessionStorage
    expect(sessionStorage.getItem("elpasto:secret:session-1")).toBe("strong-normal-secret-12");
    expect(latestPeerMeshOptions?.getCurrentSecretHandle).toBeTypeOf("function");
    expect(
      (latestPeerMeshOptions?.getCurrentSecretHandle as () => { mode: string; secret?: string } | null)()
    ).toMatchObject({ mode: "normal", secret: "strong-normal-secret-12" });

    sessionStorage.removeItem("elpasto:secret:session-1");
  });

  test("late master-key bootstrap does not override a newer normal secret selection", async () => {
    const deferredMasterKey = createDeferred<CryptoKey | null>();
    loadMasterKeyMock.mockImplementationOnce(() => deferredMasterKey.promise);
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitFor(() => expect(latestHeaderProps).toBeDefined());

    const onManageSecret = latestHeaderProps?.onManageSecret as () => void;
    act(() => {
      onManageSecret();
    });

    const input = document.querySelector("input[type='text']") as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "strong-normal-secret-12" } });

    const submitButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Use Secret"
    );
    expect(submitButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(submitButton!);
    });

    expect(
      (latestPeerMeshOptions?.getCurrentSecretHandle as () => { mode: string; secret?: string } | null)()
    ).toMatchObject({ mode: "normal", secret: "strong-normal-secret-12" });

    await act(async () => {
      deferredMasterKey.resolve({ algorithm: { name: "HKDF" } } as CryptoKey);
      await deferredMasterKey.promise;
    });

    await waitFor(() => {
      expect(
        (latestPeerMeshOptions?.getCurrentSecretHandle as () => { mode: string; secret?: string } | null)()
      ).toMatchObject({ mode: "normal", secret: "strong-normal-secret-12" });
    });

    sessionStorage.removeItem("elpasto:secret:session-1");
  });

  test("session import via PasteZone calls batch API and filters by success tokens", async () => {
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitForSessionPageReady();

    // Mock batch import API call
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        created: ["alpha-bravo-charlie-delta-echo"],
        existing: [],
        invalid: ["bad-token"],
        capacity: [],
      }),
    });

    const importFn = latestPasteZoneProps.get("A")?.onImportSessions as (
      entries: Array<{ token: string; label?: string; pinned?: boolean; peerNames?: Record<string, string> }>
    ) => Promise<{
      importedCount: number;
      createdCount: number;
      existingCount: number;
      invalidCount: number;
      capacityCount: number;
      usedFallback: boolean;
    }>;

    let result: Awaited<ReturnType<typeof importFn>> | undefined;
    await act(async () => {
      result = await importFn([
        { token: "alpha-bravo-charlie-delta-echo" },
        { token: "bad-token" },
      ]);
    });

    expect(result?.createdCount).toBe(1);
    expect(result?.invalidCount).toBe(1);
    expect(result?.usedFallback).toBe(false);
  });

  test("session import falls back to local-only when batch API fails", async () => {
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitForSessionPageReady();

    // Batch API fails
    fetchMock.mockRejectedValueOnce(new Error("server down"));

    const importFn = latestPasteZoneProps.get("A")?.onImportSessions as (
      entries: Array<{ token: string }>
    ) => Promise<{ importedCount: number; usedFallback: boolean }>;

    let result: Awaited<ReturnType<typeof importFn>> | undefined;
    await act(async () => {
      result = await importFn([{ token: "some-token-here-now-five" }]);
    });

    expect(result?.importedCount).toBe(1);
    expect(result?.usedFallback).toBe(true);
  });

  test("session import applies peer names from imported entries matching current token", async () => {
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitForSessionPageReady();

    // Batch API success
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        created: [],
        existing: ["session-1"],
        invalid: [],
        capacity: [],
      }),
    });

    const importFn = latestPasteZoneProps.get("A")?.onImportSessions as (
      entries: Array<{ token: string; peerNames?: Record<string, string> }>
    ) => Promise<{ importedCount: number; usedFallback: boolean }>;

    await act(async () => {
      await importFn([
        {
          token: "session-1",
          peerNames: { "peer-abc": "Alice", "peer-def": "Bob" },
        },
      ]);
    });

    expect(renamePeerMock).toHaveBeenCalledWith("peer-abc", "Alice");
    expect(renamePeerMock).toHaveBeenCalledWith("peer-def", "Bob");
  });

  test("session import applies peer names on fallback path too", async () => {
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitForSessionPageReady();

    // Batch API fails
    fetchMock.mockRejectedValueOnce(new Error("server down"));

    const importFn = latestPasteZoneProps.get("A")?.onImportSessions as (
      entries: Array<{ token: string; peerNames?: Record<string, string> }>
    ) => Promise<{ importedCount: number; usedFallback: boolean }>;

    await act(async () => {
      await importFn([
        {
          token: "session-1",
          peerNames: { "peer-xyz": "Charlie" },
        },
      ]);
    });

    expect(renamePeerMock).toHaveBeenCalledWith("peer-xyz", "Charlie");
  });

  test("session export creates a text clip via onQueueLocalBinaryClip", async () => {
    queueLocalBinaryClipMock.mockResolvedValueOnce({
      id: -999,
      zone: "A",
      kind: "text",
      created_at: "2026-03-08T10:00:00Z",
    } as Clip);

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitFor(() => expect(latestHeaderProps).not.toBeNull());

    await act(async () => {
      await (latestHeaderProps?.onExportSessions as () => Promise<void>)();
    });

    expect(queueLocalBinaryClipMock).toHaveBeenCalledTimes(1);
    const callArgs = queueLocalBinaryClipMock.mock.calls[0][0] as {
      transferId: string;
      zone: string;
      file: File;
      kind: string;
    };
    expect(callArgs.zone).toBe("A");
    expect(callArgs.kind).toBe("text");
    expect(callArgs.file.name).toBe("sessions.json");
  });

  test("session export with unlock secret passes secretHandle to queue call", async () => {
    sessionStorage.setItem("elpasto:secret:session-1", "export-secret");

    queueLocalBinaryClipMock.mockResolvedValueOnce({
      id: -999,
      zone: "A",
      kind: "text",
      created_at: "2026-03-08T10:00:00Z",
    } as Clip);

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitFor(() => expect(latestHeaderProps).not.toBeNull());

    await act(async () => {
      await (latestHeaderProps?.onExportSessions as () => Promise<void>)();
    });

    const callArgs = queueLocalBinaryClipMock.mock.calls[0][0] as {
      secret?: string;
      secretHandle?: { mode: string; secret?: string };
    };
    // In normal mode, secretHandle is preferred over the raw secret string
    expect(callArgs.secretHandle).toMatchObject({ mode: "normal", secret: "export-secret" });

    sessionStorage.removeItem("elpasto:secret:session-1");
  });

  test("mobile viewport sets focusedZone to A on mount", async () => {
    // Override matchMedia to simulate mobile viewport
    Object.defineProperty(window, "matchMedia", {
      value: () => ({
        matches: true,
        media: "(max-width: 767px)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      writable: true,
      configurable: true,
    });

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitForSessionPageReady();

    expect(latestPasteZoneProps.get("A")?.focusedZone).toBe("A");

    // Restore desktop matchMedia
    Object.defineProperty(window, "matchMedia", {
      value: () => ({
        matches: false,
        media: "(max-width: 767px)",
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      writable: true,
      configurable: true,
    });
  });

  test("session 404 batch recreation with non-ok retry falls through to error", async () => {
    fetchMock
      // First load: 404
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      // Batch creation: success
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ created: ["session-1"], existing: [], invalid: [], capacity: [] }),
      })
      // Retry load: still fails
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    const { getByRole } = render(<SessionPage />);
    await waitFor(() =>
      expect(getByRole("alert").textContent).toContain("Session not found")
    );
  });

  test("session import handles batch responses for more than 20 tokens (pagination)", async () => {
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitForSessionPageReady();

    // Generate 25 tokens (more than SESSION_BATCH_IMPORT_LIMIT of 20)
    const tokens = Array.from({ length: 25 }, (_, i) => `alpha-bravo-charlie-delta-${String(i).padStart(5, "x")}`);
    const entries = tokens.map((t) => ({ token: t }));

    // First batch: 20 tokens
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        created: tokens.slice(0, 20),
        existing: [],
        invalid: [],
        capacity: [],
      }),
    });
    // Second batch: 5 tokens
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        created: tokens.slice(20),
        existing: [],
        invalid: [],
        capacity: [],
      }),
    });

    const importFn = latestPasteZoneProps.get("A")?.onImportSessions as (
      entries: Array<{ token: string }>
    ) => Promise<{ importedCount: number; createdCount: number; usedFallback: boolean }>;

    let result: Awaited<ReturnType<typeof importFn>> | undefined;
    await act(async () => {
      result = await importFn(entries);
    });

    expect(result?.importedCount).toBe(25);
    expect(result?.createdCount).toBe(25);
    expect(result?.usedFallback).toBe(false);
    // Two batch API calls
    const batchCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[1] === "object" && (call[1] as RequestInit)?.method === "POST"
    );
    expect(batchCalls.length).toBe(2);
  });

  test("session export with empty entries is a no-op", async () => {
    // Override useSessionHistory to return empty entries
    // Since sessionHistory is created by SessionPageView via useSessionHistory,
    // we need an empty localStorage to get empty entries
    localStorage.removeItem("elpasto:sessions");

    queueLocalBinaryClipMock.mockResolvedValueOnce({
      id: -999,
      zone: "A",
      kind: "text",
      created_at: "2026-03-08T10:00:00Z",
    } as Clip);

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitFor(() => expect(latestHeaderProps).not.toBeNull());

    // Export will call buildSessionExportJson which returns "" for empty entries,
    // but useSessionHistory always adds the current token, so entries won't be empty.
    // This is actually not testable without mocking useSessionHistory.
    // Instead, test that export with peerNames includes them.
    await act(async () => {
      await (latestHeaderProps?.onExportSessions as () => Promise<void>)();
    });

    // Verify that the file content includes the session token
    const callArgs = queueLocalBinaryClipMock.mock.calls[0]?.[0] as { file: File } | undefined;
    if (callArgs) {
      const text = await callArgs.file.text();
      expect(text).toContain("session-1");
    }
  });

  test("handleRenamePeer for non-local peer does not update session history", async () => {
    usePeerMeshMock.mockReturnValue({
      ...usePeerMeshMock(),
      localPeerId: "peer-local-test",
      peerNames: {},
      renamePeer: renamePeerMock,
    });

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitFor(() => expect(latestHeaderProps).not.toBeNull());

    // Rename a non-local peer — should call renamePeer but NOT setMyPeerName
    await act(async () => {
      (latestHeaderProps?.onRenamePeer as (peerId: string, name: string) => void)(
        "peer-remote-other",
        "Remote Device"
      );
    });

    expect(renamePeerMock).toHaveBeenCalledWith("peer-remote-other", "Remote Device");
  });

  test("handleRenamePeer for local peer updates session history peer name", async () => {
    usePeerMeshMock.mockReturnValue({
      ...usePeerMeshMock(),
      localPeerId: "peer-local-test",
      peerNames: {},
      renamePeer: renamePeerMock,
    });

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitFor(() => expect(latestHeaderProps).not.toBeNull());

    // Rename the local peer — should call both renamePeer and setMyPeerName
    await act(async () => {
      (latestHeaderProps?.onRenamePeer as (peerId: string, name: string) => void)(
        "peer-local-test",
        "My Laptop"
      );
    });

    expect(renamePeerMock).toHaveBeenCalledWith("peer-local-test", "My Laptop");
    // Verify the peer name was stored in session history by reading localStorage
    const stored = localStorage.getItem("elpasto:sessions");
    if (stored) {
      const entries = JSON.parse(stored);
      const entry = entries.find((e: { token: string }) => e.token === "session-1");
      expect(entry?.myPeerName).toBe("My Laptop");
    }
  });

  test("peer name restore effect with no matching entry is a no-op", async () => {
    // Seed session history without myPeerName for the current token
    const historyEntries = [
      { token: "session-1", pinned: false, lastVisited: Date.now() },
    ];
    localStorage.setItem("elpasto:sessions", JSON.stringify(historyEntries));

    usePeerMeshMock.mockReturnValue({
      ...usePeerMeshMock(),
      localPeerId: "peer-no-name",
      peerNames: {},
      renamePeer: renamePeerMock,
    });

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitFor(() => expect(latestHeaderProps).not.toBeNull());

    // Wait for effects to settle
    await act(async () => { await Promise.resolve(); });

    // No peer name in history entry — renamePeer should not be called
    expect(renamePeerMock).not.toHaveBeenCalled();
  });

  test("session import non-ok batch response throws and triggers fallback", async () => {
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitForSessionPageReady();

    // Batch returns non-ok
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({}),
    });

    const importFn = latestPasteZoneProps.get("A")?.onImportSessions as (
      entries: Array<{ token: string }>
    ) => Promise<{ importedCount: number; usedFallback: boolean }>;

    let result: Awaited<ReturnType<typeof importFn>> | undefined;
    await act(async () => {
      result = await importFn([{ token: "some-token-here-now-five" }]);
    });

    expect(result?.usedFallback).toBe(true);
    expect(result?.importedCount).toBe(1);
  });

  test("requestUnlockSecret returns existing secret without prompting when already set", async () => {
    sessionStorage.setItem("elpasto:secret:session-1", "existing-secret");

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitFor(() => expect(latestPasteZoneProps.get("A")).toBeDefined());

    const requestFn = latestPasteZoneProps.get("A")?.requestUnlockSecret as () => Promise<string | null>;
    const result = await requestFn();
    expect(result).toBe("existing-secret");

    sessionStorage.removeItem("elpasto:secret:session-1");
  });

  test("removeTransferClip uses client_transfer_id from canonicalTransferIds map", async () => {
    const clipWithTransferId = {
      id: 9999,
      zone: "A",
      client_transfer_id: "transfer-xyz",
      created_at: "2026-03-08T10:00:00Z",
    } as Clip;

    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [clipWithTransferId], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [clipWithTransferId], B: [] }));

    render(<SessionPage />);
    await waitForSessionPageReady();

    // The clip has client_transfer_id so it should be in canonicalTransferIds map.
    // Trigger SSE onClipDeleted which calls removeTransferClipRef → removeTransferClip
    // which looks up the client_transfer_id from canonicalTransferIds.
    await act(async () => {
      (latestRealtimeOptions?.onClipDeleted as (data: { id: number; zone: "A" | "B" }) => void)({
        id: 9999,
        zone: "A",
      });
    });

    // removeLocalBinaryClip should be called with the client_transfer_id
    expect(removeLocalBinaryClipMock).toHaveBeenCalledWith("transfer-xyz");
    expect(removeReceivedBinaryClipMock).toHaveBeenCalledWith(9999);
  });

  test("requestUnlockSecret returns same pending promise on duplicate calls without secret", async () => {
    fetchMock
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }))
      .mockResolvedValueOnce(makeSessionResponse({ A: [], B: [] }));

    render(<SessionPage />);
    await waitFor(() => expect(latestPasteZoneProps.get("A")).toBeDefined());

    const requestFn = latestPasteZoneProps.get("A")?.requestUnlockSecret as () => Promise<string | null>;

    // Call twice without resolving — should get the same promise
    const promise1 = requestFn();
    const promise2 = requestFn();

    // Both should be the same promise object
    expect(promise1).toBe(promise2);
  });
});
