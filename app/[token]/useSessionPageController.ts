"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useParams, useRouter } from "next/navigation";
import { useClipboardCapabilities } from "@/hooks/useClipboard";
import { useFaviconBadge } from "@/hooks/useFaviconBadge";
import { usePeerMesh } from "@/hooks/usePeerMesh";
import { useRealtimeSession } from "@/hooks/useRealtimeSession";
import { deleteStoredBinaryClipsBySession } from "@/lib/clip-store";
import type { Clip, ClipZone } from "@/lib/clips";
import { parseUtcTimestamp } from "@/lib/time";
import {
  MAX_ACTIVE_THREADS,
  activeThreads,
  ensureAtLeastOneThread,
  ensureThreadsForZones,
  loadThreadRecords,
  persistThreadRecords,
  type ThreadRecord,
} from "@/lib/threads";
import type { PeerSignalMessage } from "@/lib/realtime-session";
import { useTunnelRelay } from "@/hooks/useTunnelRelay";
import { useNotificationSound } from "@/hooks/useNotificationSound";
import { mergeClips } from "./mergeClips";
import { EMPTY_CLIPS, type SessionData } from "./session-page-types";
import {
  addClipToGroups,
  allGroupedClips,
  clearClipGroup,
  clipZonesFromGroups,
  clipsFromSession,
  removeClipFromGroups,
  type ClipGroups,
} from "./clip-groups";
import {
  applyThreadCreated,
  applyThreadDeleted,
  applyThreadRenamed,
  applyThreadReordered,
  applyThreadsSync,
  pickActiveAfterRemoteDelete,
} from "./peer-thread-sync";
import {
  createThread,
  deleteThread,
  moveThread,
  renameThread,
} from "./thread-reducers";
import { useSecretController } from "./useSecretController";
import { useSessionLoader } from "./useSessionLoader";

const EMPTY_CLIP_GROUPS: ClipGroups = {};

type ServerRelayTunnel = {
  peerId: string;
  label?: string;
  port?: number;
  prefix?: string;
};

type ServerRelayTunnelEvent =
  | { type: "add"; data: ServerRelayTunnel }
  | { type: "remove"; peerId: string };

export function useSessionPageController() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params.token;
  const caps = useClipboardCapabilities();
  const notifyNewClip = useFaviconBadge();
  const notificationSound = useNotificationSound();

  const [session, setSession] = useState<SessionData | null>(null);
  const [canonicalClipsByZone, setCanonicalClipsByZone] = useState<ClipGroups>({});
  const [serverRelayTunnelEvents, setServerRelayTunnelEvents] = useState<
    ServerRelayTunnelEvent[]
  >([]);
  const [threadRecords, setThreadRecords] = useState<ThreadRecord[]>(() =>
    loadThreadRecords(token)
  );
  const [activeThreadId, setActiveThreadId] = useState<ClipZone | null>(null);

  const secrets = useSecretController(token);
  const {
    unlockSecret,
    secretHandle,
    secretMode,
    secretPromptMode,
    paranoidAvailable,
    requestUnlockSecret,
    handleSecretSubmit,
    handleSecretCancel,
    handleSecretClear,
    handleSecretSubmitParanoid,
    openSecretManager,
    getCurrentSecretHandle,
  } = secrets;
  const unlockSecretRef = useRef<string | null>(unlockSecret);

  const peerSignalHandlerRef = useRef<((message: PeerSignalMessage) => void) | null>(null);
  const removeTransferClipRef = useRef<(clipId: number) => void>(() => {});
  const hadRealtimeConnectionRef = useRef(false);
  const threadRecordsRef = useRef<ThreadRecord[]>(threadRecords);

  useEffect(() => {
    threadRecordsRef.current = threadRecords;
  }, [threadRecords]);

  const getThreadRecords = useCallback(
    () => threadRecordsRef.current,
    [],
  );

  useEffect(() => {
    const loaded = loadThreadRecords(token);
    setThreadRecords(loaded);
    setActiveThreadId(activeThreads(loaded)[0]?.id ?? null);
  }, [token]);

  useEffect(() => {
    persistThreadRecords(token, threadRecords);
  }, [threadRecords, token]);

  const activeThreadRecords = useMemo(() => activeThreads(threadRecords), [threadRecords]);

  useEffect(() => {
    if (activeThreadRecords.length === 0) {
      if (!session) {
        return;
      }
      const fallback = ensureAtLeastOneThread(threadRecords);
      setThreadRecords(fallback);
      setActiveThreadId(activeThreads(fallback)[0]?.id ?? null);
      return;
    }
    if (!activeThreadId || !activeThreadRecords.some((thread) => thread.id === activeThreadId)) {
      setActiveThreadId(activeThreadRecords[0]?.id ?? null);
    }
  }, [activeThreadId, activeThreadRecords, session, threadRecords]);

  useEffect(() => {
    unlockSecretRef.current = unlockSecret;
  }, [unlockSecret]);

  const handleSessionLoaded = useCallback((data: SessionData) => {
    const clips = clipsFromSession(data);
    setSession(data);
    setCanonicalClipsByZone(clips);
    setThreadRecords((prev) => ensureAtLeastOneThread(
      ensureThreadsForZones(prev, clipZonesFromGroups(clips))
    ));
    const tunnels = data.tunnels;
    if (Array.isArray(tunnels)) {
      setServerRelayTunnelEvents((prev) => [
        ...prev,
        ...tunnels.map((t) => ({ type: "add" as const, data: t })),
      ]);
    }
  }, []);

  const handleSessionMissing = useCallback(() => {
    setSession(null);
    setCanonicalClipsByZone({});
  }, []);

  const { loadSession, loading, error } = useSessionLoader({
    token,
    onSessionLoaded: handleSessionLoaded,
    onSessionMissing: handleSessionMissing,
  });

  useEffect(() => {
    hadRealtimeConnectionRef.current = false;
    void loadSession({ showLoading: true });
  }, [loadSession]);

  const handleExpired = useCallback(() => {
    void deleteStoredBinaryClipsBySession(token);
    router.push("/");
  }, [router, token]);

  useEffect(() => {
    if (!session) {
      return;
    }
    const diff = parseUtcTimestamp(session.expiresAt) - Date.now();
    if (diff <= 0) {
      handleExpired();
      return;
    }
    // setTimeout uses a 32-bit signed int internally (~24.8 days max).
    // For longer expiries (e.g. 10-year sessions), skip the timer entirely
    // — the session will be checked on next load anyway.
    const MAX_TIMEOUT = 0x7FFF_FFFF;
    if (diff > MAX_TIMEOUT) {
      return;
    }
    const timer = setTimeout(handleExpired, diff);
    return () => clearTimeout(timer);
  }, [session, handleExpired]);

  const handleClipCreated = useCallback((clip: Clip) => {
    setThreadRecords((prev) => ensureAtLeastOneThread(ensureThreadsForZones(prev, [clip.zone])));
    setCanonicalClipsByZone((prev) => {
      if ((prev[clip.zone] ?? EMPTY_CLIPS).some((current) => current.id === clip.id)) {
        return prev;
      }
      notifyNewClip();
      notificationSound.play();
      return addClipToGroups(prev, clip);
    });
  }, [notifyNewClip, notificationSound]);

  const handleClipsCleared = useCallback((data: { zone?: ClipZone }) => {
    setCanonicalClipsByZone((prev) => clearClipGroup(prev, data.zone));
  }, []);

  const handleClipDeleted = useCallback((data: { id: number; zone: ClipZone }) => {
    removeTransferClipRef.current(data.id);
    setCanonicalClipsByZone((prev) => removeClipFromGroups(prev, data.id, data.zone));
  }, []);

  const realtime = useRealtimeSession({
    token,
    enabled: Boolean(session),
    onClipCreated: handleClipCreated,
    onClipDeleted: handleClipDeleted,
    onClipsCleared: handleClipsCleared,
    onSessionExpired: handleExpired,
    onPeerSignal: (message) => {
      peerSignalHandlerRef.current?.(message);
    },
    onTunnelAnnounce: (data) => {
      setServerRelayTunnelEvents((prev) => [...prev, { type: "add", data }]);
    },
    onTunnelClose: (data) => {
      setServerRelayTunnelEvents((prev) => [
        ...prev,
        { type: "remove", peerId: data.peerId },
      ]);
    },
  });

  const canonicalTransferIds = useMemo(
    () =>
      new Map(
        allGroupedClips(canonicalClipsByZone)
          .filter((clip) => Boolean(clip.client_transfer_id))
          .map((clip) => [clip.id, clip.client_transfer_id as string])
      ),
    [canonicalClipsByZone]
  );

  useEffect(() => {
    if (!realtime.signalingReady) {
      hadRealtimeConnectionRef.current = false;
      return;
    }
    if (hadRealtimeConnectionRef.current) {
      return;
    }

    hadRealtimeConnectionRef.current = true;
    void loadSession({ showLoading: false });
  }, [loadSession, realtime.signalingReady]);

  const handleThreadsSync = useCallback((threads: ThreadRecord[]) => {
    setThreadRecords((prev) => applyThreadsSync(prev, threads));
  }, []);

  const handleThreadCreated = useCallback((thread: ThreadRecord) => {
    setThreadRecords((prev) => applyThreadCreated(prev, thread));
  }, []);

  const handleThreadRenamed = useCallback(
    (event: Parameters<typeof applyThreadRenamed>[1]) => {
      setThreadRecords((prev) => applyThreadRenamed(prev, event));
    },
    [],
  );

  const handleThreadReordered = useCallback(
    (positions: Parameters<typeof applyThreadReordered>[1]) => {
      setThreadRecords((prev) => applyThreadReordered(prev, positions));
    },
    [],
  );

  const handleThreadDeletedFromPeer = useCallback(
    (event: Parameters<typeof applyThreadDeleted>[1]) => {
      setCanonicalClipsByZone((prev) => clearClipGroup(prev, event.id));
      setThreadRecords((prev) => applyThreadDeleted(prev, event));
      setTimeout(() => {
        setActiveThreadId((current) =>
          pickActiveAfterRemoteDelete(getThreadRecords(), event.id, current),
        );
      }, 0);
    },
    [getThreadRecords],
  );

  const peerThreadCallbacks = useMemo(
    () => ({
      onThreadsSync: handleThreadsSync,
      onThreadCreated: handleThreadCreated,
      onThreadRenamed: handleThreadRenamed,
      onThreadReordered: handleThreadReordered,
      onThreadDeleted: handleThreadDeletedFromPeer,
    }),
    [
      handleThreadCreated,
      handleThreadDeletedFromPeer,
      handleThreadRenamed,
      handleThreadReordered,
      handleThreadsSync,
    ],
  );

  const peerMesh = usePeerMesh({
    enabled: Boolean(session),
    sessionToken: token,
    signalingReady: realtime.signalingReady,
    sendPeerSignal: realtime.sendPeerSignal,
    getCurrentUnlockSecret: () => unlockSecretRef.current,
    getCurrentSecretHandle,
    turnCredentials: session?.turnCredentials,
    getThreadRecords,
    ...peerThreadCallbacks,
  });
  const {
    attachCanonicalClip,
    broadcastClipDelete,
    broadcastThreadCreated,
    broadcastThreadDeleted,
    broadcastThreadRenamed,
    broadcastThreadReordered,
    clearIdentifyFlash,
    clearLocalBinaryClips,
    clearReceivedBinaryClips,
    getDirectClipCiphertext,
    getSendProgress,
    getLocalBinaryClipGroups,
    getReceivedBinaryClipGroups,
    getTransferStats,
    handlePeerSignal,
    identifyFlash,
    localPeerId,
    peerNames,
    peers,
    pingPeer,
    queueLocalBinaryClip,
    readyPeerCount,
    renamePeer,
    removeLocalBinaryClip,
    removeReceivedBinaryClip,
    subscribeToSendProgress,
    subscribeToDirectTransfers,
    subscribeToLocalBinaryClips,
    updateLocalBinaryClipContent,
  } = peerMesh;

  const removeTransferClip = useCallback((clipId: number, clientTransferId?: string | null) => {
    removeLocalBinaryClip(clientTransferId ?? clipId);
    removeReceivedBinaryClip(clipId);
  }, [removeLocalBinaryClip, removeReceivedBinaryClip]);

  const connectedPeerIds = useMemo(() => {
    const set = new Set<string>();
    for (const p of peerMesh.peers) {
      if (p.channelState === "open" || p.hasTunnel) set.add(p.peerId);
    }
    return set;
  }, [peerMesh.peers]);

  const { tunnels, swReady, openTunnel, removeTunnel, addServerRelayTunnel, removeServerRelayTunnel } = useTunnelRelay({
    sessionToken: token,
    sendTunnelMessage: peerMesh.sendTunnelMessage,
    subscribeTunnel: peerMesh.subscribeTunnel,
    connectedPeerIds,
  });

  const handleOpenTunnel = useCallback((peerId: string) => {
    void openTunnel(peerId).catch((error) => {
      console.error("[tunnel] failed to open tunnel:", error);
    });
  }, [openTunnel]);

  useEffect(() => {
    if (serverRelayTunnelEvents.length === 0) {
      return;
    }
    for (const event of serverRelayTunnelEvents) {
      if (event.type === "add") {
        addServerRelayTunnel(event.data);
      } else {
        removeServerRelayTunnel(event.peerId);
      }
    }
    setServerRelayTunnelEvents([]);
  }, [
    addServerRelayTunnel,
    removeServerRelayTunnel,
    serverRelayTunnelEvents,
  ]);

  useEffect(() => {
    removeTransferClipRef.current = (clipId: number) => {
      removeTransferClip(clipId, canonicalTransferIds.get(clipId));
    };
  }, [canonicalTransferIds, removeTransferClip]);

  useEffect(() => {
    peerSignalHandlerRef.current = handlePeerSignal;
    return () => {
      peerSignalHandlerRef.current = null;
    };
  }, [handlePeerSignal]);

  const localSenderClipsByZone = useSyncExternalStore(
    subscribeToLocalBinaryClips,
    getLocalBinaryClipGroups,
    () => EMPTY_CLIP_GROUPS
  );
  const localReceiverClipsByZone = useSyncExternalStore(
    subscribeToDirectTransfers,
    getReceivedBinaryClipGroups,
    () => EMPTY_CLIP_GROUPS
  );

  // Badge favicon when a new clip arrives from a remote peer via WebRTC
  const prevReceiverCountRef = useRef(0);
  useEffect(() => {
    const count = allGroupedClips(localReceiverClipsByZone).length;
    if (count > prevReceiverCountRef.current) {
      notifyNewClip();
      notificationSound.play();
    }
    prevReceiverCountRef.current = count;
  }, [localReceiverClipsByZone, notifyNewClip, notificationSound]);

  useEffect(() => {
    if (!session) {
      return;
    }
    for (const clip of allGroupedClips(canonicalClipsByZone)) {
      attachCanonicalClip(clip);
    }
  }, [attachCanonicalClip, canonicalClipsByZone, localReceiverClipsByZone, session]);

  const clipsByThread = useMemo(() => {
    const result: ClipGroups = {};
    for (const thread of activeThreadRecords) {
      result[thread.id] = mergeClips(
        canonicalClipsByZone[thread.id] ?? EMPTY_CLIPS,
        localSenderClipsByZone[thread.id] ?? EMPTY_CLIPS,
        localReceiverClipsByZone[thread.id] ?? EMPTY_CLIPS
      );
    }
    return result;
  }, [activeThreadRecords, canonicalClipsByZone, localReceiverClipsByZone, localSenderClipsByZone]);

  useEffect(() => {
    const zones = clipZonesFromGroups(
      canonicalClipsByZone,
      localSenderClipsByZone,
      localReceiverClipsByZone
    );
    if (zones.length === 0) {
      return;
    }
    setThreadRecords((prev) => ensureAtLeastOneThread(ensureThreadsForZones(prev, zones)));
  }, [canonicalClipsByZone, localReceiverClipsByZone, localSenderClipsByZone]);

  const handleLocalClipAdded = useCallback((clip: Clip) => {
    setThreadRecords((prev) => ensureAtLeastOneThread(ensureThreadsForZones(prev, [clip.zone])));
    if (clip.local_only) {
      return;
    }

    setCanonicalClipsByZone((prev) => addClipToGroups(prev, clip));
  }, []);

  const handleClipRemoved = useCallback((clip: Clip) => {
    const transferId =
      clip.client_transfer_id ?? canonicalTransferIds.get(clip.id) ?? null;
    const shouldBroadcastClipDelete = Boolean(
      transferId && (!clip.local_only || clip.local_origin !== "sender")
    );

    if (shouldBroadcastClipDelete && transferId) {
      broadcastClipDelete(transferId);
    }

    if (clip.local_only) {
      setCanonicalClipsByZone((prev) => removeClipFromGroups(prev, clip.id, clip.zone));

      if (clip.local_origin === "sender") {
        removeLocalBinaryClip(clip.id);
      } else {
        removeReceivedBinaryClip(clip.id);
      }
      return;
    }

    if (transferId) {
      removeTransferClip(clip.id, transferId);
    }
    setCanonicalClipsByZone((prev) => removeClipFromGroups(prev, clip.id, clip.zone));
  }, [broadcastClipDelete, canonicalTransferIds, removeLocalBinaryClip, removeReceivedBinaryClip, removeTransferClip]);

  const handleClearZone = useCallback(async (zone: ClipZone) => {
    setCanonicalClipsByZone((prev) => clearClipGroup(prev, zone));
    clearLocalBinaryClips(zone);
    clearReceivedBinaryClips(zone);
  }, [
    clearLocalBinaryClips,
    clearReceivedBinaryClips,
  ]);

  const handleClearAll = useCallback(async () => {
    setCanonicalClipsByZone({});
    clearLocalBinaryClips();
    clearReceivedBinaryClips();
  }, [
    clearLocalBinaryClips,
    clearReceivedBinaryClips,
  ]);

  const handleCreateThread = useCallback(() => {
    const now = Date.now();
    const result = createThread(threadRecords, now);
    if (!result) return;
    const threadId = result.thread.id;
    setThreadRecords((prev) => {
      const inner = createThread(prev, now, () => threadId);
      return inner ? ensureAtLeastOneThread(inner.records) : prev;
    });
    setTimeout(() => {
      const thread = activeThreads(getThreadRecords()).find(
        (current) => current.id === threadId,
      );
      if (!thread) return;
      setActiveThreadId(thread.id);
      broadcastThreadCreated(thread);
    }, 0);
  }, [broadcastThreadCreated, getThreadRecords, threadRecords]);

  const handleRenameThread = useCallback(
    (id: ClipZone, name: string) => {
      const now = Date.now();
      const { name: nextName } = renameThread(threadRecords, id, name, now);
      setThreadRecords((prev) => renameThread(prev, id, name, now).records);
      broadcastThreadRenamed(id, nextName, now);
    },
    [broadcastThreadRenamed, threadRecords],
  );

  const handleDeleteThread = useCallback(
    (id: ClipZone) => {
      const now = Date.now();
      const result = deleteThread(threadRecords, id, now);
      if (!result) return;
      setThreadRecords((prev) => {
        const inner = deleteThread(prev, id, now);
        return inner ? inner.records : prev;
      });
      setCanonicalClipsByZone((prev) => clearClipGroup(prev, id));
      clearLocalBinaryClips(id);
      clearReceivedBinaryClips(id);
      setActiveThreadId(result.nextActiveId);
      broadcastThreadDeleted(id, now);
    },
    [
      broadcastThreadDeleted,
      clearLocalBinaryClips,
      clearReceivedBinaryClips,
      threadRecords,
    ],
  );

  const handleMoveThread = useCallback(
    (id: ClipZone, direction: -1 | 1) => {
      const now = Date.now();
      if (!moveThread(threadRecords, id, direction, now)) return;
      const beforeIndex = activeThreads(threadRecords).findIndex(
        (thread) => thread.id === id,
      );
      setThreadRecords((prev) => {
        const inner = moveThread(prev, id, direction, now);
        return inner ? inner.records : prev;
      });
      setTimeout(() => {
        const current = activeThreads(getThreadRecords());
        const afterIndex = current.findIndex((thread) => thread.id === id);
        if (afterIndex < 0 || afterIndex === beforeIndex) return;
        broadcastThreadReordered(
          current.map((thread, position) => ({
            id: thread.id,
            position,
            updatedAt: thread.updatedAt,
          })),
        );
      }, 0);
    },
    [broadcastThreadReordered, getThreadRecords, threadRecords],
  );

  return {
    loading,
    error,
    session,
    token,
    canCopyImage: caps.canCopyImage,
    unlockSecret,
    secretPromptMode,
    clearIdentifyFlash,
    identifyFlash,
    localPeerId,
    peerNames,
    peers,
    pingPeer,
    readyPeerCount,
    renamePeer,
    threads: activeThreadRecords,
    activeThreadId,
    canCreateThread: activeThreadRecords.length < MAX_ACTIVE_THREADS,
    onSelectThread: setActiveThreadId,
    onCreateThread: handleCreateThread,
    onRenameThread: handleRenameThread,
    onDeleteThread: handleDeleteThread,
    onMoveThread: handleMoveThread,
    zones: activeThreadRecords.map((thread) => ({
      zone: thread.id,
      threadName: thread.name,
      clips: clipsByThread[thread.id] ?? EMPTY_CLIPS,
      onClearZone: () => handleClearZone(thread.id),
    })),
    getDirectClipCiphertext,
    getSendProgress,
    getTransferStats,
    requestUnlockSecret,
    onClipAdded: handleLocalClipAdded,
    onClipDeleted: handleClipRemoved,
    onUpdateClipContent: updateLocalBinaryClipContent,
    onQueueLocalBinaryClip: queueLocalBinaryClip,
    onClearAll: handleClearAll,
    onGoHome: () => router.push("/"),
    onManageSecret: openSecretManager,
    onForgetSecret: handleSecretClear,
    onSecretSubmit: handleSecretSubmit,
    onSecretCancel: handleSecretCancel,
    onSecretSubmitParanoid: handleSecretSubmitParanoid,
    subscribeToSendProgress,
    subscribeToDirectTransfers,
    tunnels,
    swReady,
    openTunnel: handleOpenTunnel,
    removeTunnel,
    secretHandle,
    secretMode,
    getCurrentSecretHandle,
    paranoidAvailable,
    sound: {
      enabled: notificationSound.enabled,
      soundName: notificationSound.soundName,
      volume: notificationSound.volume,
      onSetEnabled: notificationSound.setEnabled,
      onSetSoundName: notificationSound.setSoundName,
      onCycleVolume: notificationSound.cycleVolume,
    },
  };
}
