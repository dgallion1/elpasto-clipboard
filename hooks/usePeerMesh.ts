"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encryptBinaryWithHandle } from "@/lib/clip-crypto";
import type { SecretHandle } from "@/lib/clip-crypto";
import type { Clip, ClipZone } from "@/lib/clips";
import { sortClipsNewestFirst } from "@/lib/clips";
import {
  addTombstone as persistTombstone,
  adoptOrphanedClips,
  deleteStoredBinaryClip,
  getStoredBinaryClip,
  getTombstones,
  listStoredBinaryClipMetadataBySession,
  listStoredBinaryClipsBySession,
  migrateStoredBinaryClips,
  putStoredBinaryClip,
  type BinaryClipCatalogEntry,
  type StoredBinaryClip,
} from "@/lib/clip-store";
import {
  DIRECT_TRANSFER_TIMEOUT_MS,
  DirectTransferStore,
  type DirectClipEnvelope,
  type TransferStats,
} from "@/lib/direct-transfer";
import { logRestoreDebug } from "@/lib/restore-debug";
import { SendProgressStore } from "@/lib/send-progress";
import type { PeerSignalMessage } from "@/lib/realtime-session";
import type { TurnCredentials } from "@/app/[token]/session-page-types";
import { activeThreads, makeThreadRecord, type ThreadRecord } from "@/lib/threads";
import {
  createPeerConnection,
  decodeDataChannelMessage,
  sendDirectTransfer,
  type DirectTransferControlMessage,
} from "@/lib/webrtc";
import { regenerateHtmlFromPlainText } from "@/lib/html-utils";
import { mayAcceptClipStart, mayDeleteClip, mayReplaceClip } from "@/lib/peer-authz";

function createRandomId(prefix: string): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

const resolvedTabIds = new Map<string, string>();
const pendingMigrations = new Map<string, Promise<number>>();
const EMPTY_LOCAL_CLIPS: Clip[] = [];

function getNavigationType(): string | null {
  try {
    const navigationEntry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (navigationEntry?.type) {
      return navigationEntry.type;
    }
    const legacyNavigation = (performance as Performance & {
      navigation?: {
        type?: number;
        TYPE_RELOAD?: number;
        TYPE_BACK_FORWARD?: number;
        TYPE_NAVIGATE?: number;
      };
    }).navigation;
    switch (legacyNavigation?.type) {
      case legacyNavigation.TYPE_RELOAD:
        return "reload";
      case legacyNavigation.TYPE_BACK_FORWARD:
        return "back_forward";
      case legacyNavigation.TYPE_NAVIGATE:
        return "navigate";
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function copyMyPeerName(sessionToken: string, fromTabId: string, toTabId: string): void {
  if (fromTabId === toTabId) {
    return;
  }
  try {
    const legacyKey = `elpasto:my-peer-name:${sessionToken}:${fromTabId}`;
    const nextKey = `elpasto:my-peer-name:${sessionToken}:${toTabId}`;
    const existingName = localStorage.getItem(legacyKey);
    if (existingName && !localStorage.getItem(nextKey)) {
      localStorage.setItem(nextKey, existingName);
    }
  } catch {
    // ignore quota and privacy errors
  }
}

// Tab-scoped storage key for persisting UI state like my peer name.
// This may be cloned by the browser when a tab is duplicated, so it must
// stay separate from the live WebRTC peer identity.
function getTabId(sessionToken: string): string {
  const key = `elpasto:tab-id:${sessionToken}`;
  try {
    const cached = resolvedTabIds.get(sessionToken);
    const stored = sessionStorage.getItem(key);
    if (cached && stored === cached) {
      return cached;
    }
    if (cached && stored !== cached) {
      resolvedTabIds.delete(sessionToken);
    }

    const existing = stored;
    if (existing) {
      if (getNavigationType() === "navigate") {
        const rotated = createRandomId("tab");
        sessionStorage.setItem(key, rotated);
        copyMyPeerName(sessionToken, existing, rotated);
        pendingMigrations.set(sessionToken, migrateStoredBinaryClips(sessionToken, existing, rotated));
        logRestoreDebug("tab", "rotated duplicated tab id", {
          sessionToken,
          previousTabId: existing,
          nextTabId: rotated,
        });
        resolvedTabIds.set(sessionToken, rotated);
        return rotated;
      }
      logRestoreDebug("tab", "reused existing tab id", {
        sessionToken,
        tabId: existing,
        navigationType: getNavigationType(),
      });
      resolvedTabIds.set(sessionToken, existing);
      return existing;
    }
    const id = createRandomId("tab");
    sessionStorage.setItem(key, id);
    logRestoreDebug("tab", "created fresh tab id", {
      sessionToken,
      tabId: id,
    });
    resolvedTabIds.set(sessionToken, id);
    return id;
  } catch {
    const fallback = createRandomId("tab");
    logRestoreDebug("tab", "using fallback tab id without sessionStorage", {
      sessionToken,
      tabId: fallback,
    });
    resolvedTabIds.set(sessionToken, fallback);
    return fallback;
  }
}

function loadMyPeerName(sessionToken: string): string | null {
  try {
    const tabId = getTabId(sessionToken);
    return localStorage.getItem(`elpasto:my-peer-name:${sessionToken}:${tabId}`);
  } catch {
    return null;
  }
}

function persistMyPeerName(sessionToken: string, name: string): void {
  try {
    const tabId = getTabId(sessionToken);
    localStorage.setItem(`elpasto:my-peer-name:${sessionToken}:${tabId}`, name);
  } catch {
    // ignore quota errors
  }
}


interface UsePeerMeshOptions {
  enabled: boolean;
  sessionToken: string;
  signalingReady: boolean;
  sendPeerSignal: (message: PeerSignalMessage) => Promise<boolean>;
  getCurrentUnlockSecret: () => string | null | Promise<string | null>;
  getCurrentSecretHandle?: () => SecretHandle | null;
  turnCredentials?: TurnCredentials;
  getThreadRecords?: () => ThreadRecord[];
  onThreadsSync?: (threads: ThreadRecord[]) => void;
  onThreadCreated?: (thread: ThreadRecord) => void;
  onThreadRenamed?: (data: { id: string; name: string; updatedAt: number }) => void;
  onThreadReordered?: (positions: { id: string; position: number; updatedAt: number }[]) => void;
  onThreadDeleted?: (data: { id: string; deletedAt: number }) => void;
}

interface PeerConnectionState {
  peerId: string;
  polite: boolean;
  pc: RTCPeerConnection;
  clipsChannel: RTCDataChannel | null;
  tunnelChannel: RTCDataChannel | null;
  makingOffer: boolean;
  ignoreOffer: boolean;
  connectTimeoutId?: ReturnType<typeof setTimeout>;
}

export interface PeerInfo {
  peerId: string;
  channelState: RTCDataChannelState | "none";
  hasTunnel: boolean;
  name?: string;
}

export interface IdentifyFlashEvent {
  id: number;
  fromPeerId: string;
}

interface LocalBinaryClipEntry {
  transferId: string;
  clip: Clip;
  file: File | null;
  ciphertext: Uint8Array | null;
  envelope: DirectClipEnvelope | null;
}

interface QueueLocalBinaryClipInput {
  transferId: string;
  zone: ClipZone;
  file: File;
  secret?: string;
  secretHandle?: SecretHandle;
  kind?: "text" | "html" | "image" | "file";
  note?: string;
}

export type UpdateLocalBinaryClipInput =
  | { transferId: string; kind: "text"; text: string }
  | { transferId: string; kind: "html"; text: string };

export function usePeerMesh({
  enabled,
  sessionToken,
  signalingReady,
  sendPeerSignal,
  getCurrentUnlockSecret,
  getCurrentSecretHandle,
  turnCredentials,
  getThreadRecords,
  onThreadsSync,
  onThreadCreated,
  onThreadRenamed,
  onThreadReordered,
  onThreadDeleted,
}: UsePeerMeshOptions) {
  const [localPeerId] = useState(() => createRandomId("peer"));
  const ownerTabId = useMemo(() => getTabId(sessionToken), [sessionToken]);
  const [readyPeerCount, setReadyPeerCount] = useState(0);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const peerNamesRef = useRef<Record<string, string>>({});
  const [peerNames, setPeerNames] = useState<Record<string, string>>({});
  const [identifyFlash, setIdentifyFlash] = useState<IdentifyFlashEvent | null>(null);
  const nextIdentifyFlashIdRef = useRef(0);
  const turnCredentialsRef = useRef(turnCredentials);

  useEffect(() => {
    turnCredentialsRef.current = turnCredentials;
  }, [turnCredentials]);

  // Restore my own name on mount (other peers' names arrive via peer:names-sync)
  // Also clean up legacy localStorage keys from earlier code
  useEffect(() => {
    try {
      localStorage.removeItem(`elpasto:peer-names:${sessionToken}`);
      localStorage.removeItem(`elpasto:peer-id:${sessionToken}`);
      localStorage.removeItem(`elpasto:my-peer-name:${sessionToken}`);
    } catch { /* ignore */ }
    const myName = loadMyPeerName(sessionToken);
    if (myName) {
      const initial: Record<string, string> = { [localPeerId]: myName };
      peerNamesRef.current = initial;
      setPeerNames(initial);
    }
  }, [localPeerId, sessionToken]);

  const storeRef = useRef<DirectTransferStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new DirectTransferStore({ sessionToken, ownerTabId });
  }
  const restoreReadyRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!restoreReadyRef.current) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    restoreReadyRef.current = { promise, resolve };
  }
  const sendProgressStoreRef = useRef<SendProgressStore | null>(null);
  if (!sendProgressStoreRef.current) {
    sendProgressStoreRef.current = new SendProgressStore();
  }

  const peersRef = useRef(new Map<string, PeerConnectionState>());
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localBinaryClipsRef = useRef(new Map<string, LocalBinaryClipEntry>());
  const localBinaryClipIdsRef = useRef(new Map<number, string>());
  const localBinaryListenersRef = useRef(new Set<() => void>());
  const tunnelMessageListenersRef = useRef(new Set<(peerId: string, data: string | ArrayBuffer) => void>());
  const transferOwnersRef = useRef(new Map<string, string>());
  // Security (H2/H4): the peer whose clip:start we accepted for each transfer.
  // Only that peer may later replace or delete/tombstone the clip.
  const transferSourceRef = useRef(new Map<string, string>());
  // Security (H4a): in-memory mirror of this session's tombstones so the direct
  // clip:start path can reject resurrection synchronously (an async IndexedDB read
  // here would delay startTransfer and drop the sender's first chunks).
  const tombstonedTransferIdsRef = useRef(new Set<string>());
  const transferRequestTimeoutsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const nextLocalBinaryClipIdRef = useRef(-1);
  const localBinarySnapshotRef = useRef<Record<string, Clip[]>>({});
  const getCurrentUnlockSecretRef = useRef(getCurrentUnlockSecret);
  const getCurrentSecretHandleRef = useRef(getCurrentSecretHandle);
  const getThreadRecordsRef = useRef(getThreadRecords);
  const onThreadsSyncRef = useRef(onThreadsSync);
  const onThreadCreatedRef = useRef(onThreadCreated);
  const onThreadRenamedRef = useRef(onThreadRenamed);
  const onThreadReorderedRef = useRef(onThreadReordered);
  const onThreadDeletedRef = useRef(onThreadDeleted);

  // Security (H2/H4a): persist a tombstone and mirror it in memory so the
  // synchronous clip:start resurrection check sees it immediately.
  const recordTombstone = useCallback((transferId: string) => {
    tombstonedTransferIdsRef.current.add(transferId);
    void persistTombstone(transferId, sessionToken);
  }, [sessionToken]);

  useEffect(() => {
    getCurrentUnlockSecretRef.current = getCurrentUnlockSecret;
  }, [getCurrentUnlockSecret]);

  useEffect(() => {
    getCurrentSecretHandleRef.current = getCurrentSecretHandle;
  }, [getCurrentSecretHandle]);

  useEffect(() => {
    getThreadRecordsRef.current = getThreadRecords;
    onThreadsSyncRef.current = onThreadsSync;
    onThreadCreatedRef.current = onThreadCreated;
    onThreadRenamedRef.current = onThreadRenamed;
    onThreadReorderedRef.current = onThreadReordered;
    onThreadDeletedRef.current = onThreadDeleted;
  });

  const rebuildLocalBinarySnapshots = useCallback(() => {
    const all = Array.from(localBinaryClipsRef.current.values()).map((e) => e.clip);
    const next: Record<string, Clip[]> = {};
    for (const clip of all) {
      (next[clip.zone] ??= []).push(clip);
    }
    for (const zone of Object.keys(next)) {
      next[zone].sort(sortClipsNewestFirst);
    }
    localBinarySnapshotRef.current = next;
  }, []);

  const emitLocalBinaryClips = useCallback(() => {
    rebuildLocalBinarySnapshots();
    for (const listener of localBinaryListenersRef.current) {
      listener();
    }
  }, [rebuildLocalBinarySnapshots]);

  const updateReadyPeerCount = useCallback(() => {
    let nextCount = 0;
    const nextPeers: PeerInfo[] = [];
    for (const state of peersRef.current.values()) {
      const channelState = state.clipsChannel?.readyState ?? "none";
      const hasTunnel = state.tunnelChannel?.readyState === "open";
      const name = peerNamesRef.current[state.peerId];
      nextPeers.push({ peerId: state.peerId, channelState, hasTunnel, name });
      if (channelState === "open") {
        nextCount += 1;
      }
    }
    setReadyPeerCount(nextCount);
    setPeers(nextPeers);
  }, []);

  const announce = useCallback(
    (toPeerId?: string) => {
      if (!enabled || !signalingReady) {
        return;
      }

      void sendPeerSignal({
        fromPeerId: localPeerId,
        toPeerId,
        signalType: "announce",
      });
    },
    [enabled, localPeerId, sendPeerSignal, signalingReady]
  );

  const scheduleReannounce = useCallback(() => {
    if (announceTimerRef.current) {
      clearTimeout(announceTimerRef.current);
    }
    announceTimerRef.current = setTimeout(() => {
      announce();
    }, 1_000);
  }, [announce]);

  const cleanupPeer = useCallback(
    (peerId: string, shouldReannounce = false) => {
      const state = peersRef.current.get(peerId);
      if (!state) {
        return;
      }

      peersRef.current.delete(peerId);
      sendProgressStoreRef.current?.clearPeer(peerId);
      if (state.connectTimeoutId) {
        clearTimeout(state.connectTimeoutId);
      }
      state.clipsChannel?.close();
      state.tunnelChannel?.close();
      state.pc.close();
      updateReadyPeerCount();

      if (shouldReannounce) {
        scheduleReannounce();
      }
    },
    [scheduleReannounce, updateReadyPeerCount]
  );

  const broadcastControlMessage = useCallback((message: DirectTransferControlMessage) => {
    const json = JSON.stringify(message);
    for (const state of peersRef.current.values()) {
      if (state.clipsChannel?.readyState === "open") {
        state.clipsChannel.send(json);
      }
    }
  }, []);

  const sendControlMessageToPeer = useCallback((peerId: string, message: DirectTransferControlMessage) => {
    const state = peersRef.current.get(peerId);
    if (state?.clipsChannel?.readyState !== "open") {
      return false;
    }
    state.clipsChannel.send(JSON.stringify(message));
    return true;
  }, []);

  const clearTransferRequestTimeout = useCallback((transferId: string) => {
    const timeoutId = transferRequestTimeoutsRef.current.get(transferId);
    if (!timeoutId) {
      return;
    }
    clearTimeout(timeoutId);
    transferRequestTimeoutsRef.current.delete(transferId);
  }, []);

  const releaseTransferOwner = useCallback((transferId: string, peerId?: string) => {
    const currentPeerId = transferOwnersRef.current.get(transferId);
    if (!currentPeerId) {
      return;
    }
    if (peerId && currentPeerId !== peerId) {
      return;
    }

    transferOwnersRef.current.delete(transferId);
    clearTransferRequestTimeout(transferId);
  }, [clearTransferRequestTimeout]);

  const reserveTransferOwner = useCallback((transferId: string, peerId: string) => {
    const currentPeerId = transferOwnersRef.current.get(transferId);
    if (currentPeerId && currentPeerId !== peerId) {
      return false;
    }

    transferOwnersRef.current.set(transferId, peerId);
    clearTransferRequestTimeout(transferId);
    const timeoutId = setTimeout(() => {
      if (transferOwnersRef.current.get(transferId) !== peerId) {
        return;
      }
      transferOwnersRef.current.delete(transferId);
      transferRequestTimeoutsRef.current.delete(transferId);
      storeRef.current?.markLocalTransferFailed(transferId);
    }, DIRECT_TRANSFER_TIMEOUT_MS);
    transferRequestTimeoutsRef.current.set(transferId, timeoutId);
    return true;
  }, [clearTransferRequestTimeout]);

  const acceptTransferOwner = useCallback((transferId: string, peerId: string) => {
    const currentPeerId = transferOwnersRef.current.get(transferId);
    if (currentPeerId && currentPeerId !== peerId) {
      return false;
    }

    transferOwnersRef.current.set(transferId, peerId);
    clearTransferRequestTimeout(transferId);
    return true;
  }, [clearTransferRequestTimeout]);

  const restoreSenderRecord = useCallback((record: StoredBinaryClip) => {
    if (!record.senderFileBytes) {
      logRestoreDebug("peer-mesh", "skipped sender restore without bytes", {
        transferId: record.transferId,
        ownerTabId,
        sessionToken,
      });
      return null;
    }

    const existing = localBinaryClipsRef.current.get(record.transferId);
    if (existing) {
      logRestoreDebug("peer-mesh", "sender restore reused existing local entry", {
        transferId: record.transferId,
        ownerTabId,
        sessionToken,
      });
      return existing;
    }

    const file = new File([record.senderFileBytes.slice(0)], record.originalName || "download", {
      type: record.mimeType || "application/octet-stream",
      lastModified: Date.parse(record.createdAt) || Date.now(),
    });
    const clipId = nextLocalBinaryClipIdRef.current;
    nextLocalBinaryClipIdRef.current -= 1;
    const clip: Clip = {
      id: clipId,
      session_id: 0,
      zone: record.zone,
      kind: record.kind,
      client_transfer_id: record.transferId,
      mime_type: record.mimeType,
      text_content: null,
      html_content: null,
      storage_key: null,
      original_name: record.originalName,
      size_bytes: record.sizeBytes,
      encrypted: Boolean(record.ciphertext && record.encryptionVersion && record.encryptionMeta),
      encryption_version: record.encryptionVersion ?? null,
      encryption_meta: record.encryptionMeta ?? null,
      created_at: record.createdAt,
      note: record.note || null,
      local_only: true,
      local_origin: "sender",
      local_transfer_state: "complete",
      local_file: file,
    };
    const entry: LocalBinaryClipEntry = {
      transferId: record.transferId,
      clip,
      file,
      ciphertext: record.ciphertext?.slice() ?? null,
      envelope: record.ciphertext && record.encryptionVersion && record.encryptionMeta
        ? {
          transferId: record.transferId,
          zone: record.zone,
          kind: record.kind,
          mimeType: record.mimeType,
          originalName: record.originalName,
          encrypted: true,
          encryptionVersion: record.encryptionVersion,
          encryptionMeta: record.encryptionMeta,
          sizeBytes: record.ciphertext.byteLength,
          createdAt: record.createdAt,
          note: record.note,
        }
        : null,
    };

    localBinaryClipsRef.current.set(record.transferId, entry);
    localBinaryClipIdsRef.current.set(clipId, record.transferId);
    logRestoreDebug("peer-mesh", "restored sender record from storage", {
      transferId: record.transferId,
      ownerTabId,
      sessionToken,
      hasCiphertext: Boolean(record.ciphertext?.byteLength),
      sizeBytes: record.sizeBytes,
      zone: record.zone,
    });
    return entry;
  }, [ownerTabId, sessionToken]);

  const persistSenderRecord = useCallback(async (
    entry: LocalBinaryClipEntry,
    senderFileBytes?: ArrayBuffer,
    ciphertext?: Uint8Array,
    envelope?: DirectClipEnvelope
  ) => {
    const resolvedBytes = senderFileBytes ?? (entry.file ? await entry.file.arrayBuffer() : undefined);
    await putStoredBinaryClip({
      transferId: entry.transferId,
      sessionToken,
      ownerTabId,
      zone: entry.clip.zone,
      kind: entry.clip.kind,
      mimeType: entry.clip.mime_type || entry.file?.type || "application/octet-stream",
      originalName: entry.clip.original_name || entry.file?.name || "download",
      sizeBytes: entry.clip.size_bytes || entry.file?.size || ciphertext?.byteLength || 0,
      encryptionVersion: envelope?.encryptionVersion ?? null,
      encryptionMeta: envelope?.encryptionMeta ?? null,
      createdAt: entry.clip.created_at,
      origin: "sender",
      note: entry.clip.note,
      senderFileBytes: resolvedBytes,
      ciphertext: ciphertext ?? entry.ciphertext ?? undefined,
    });
  }, [ownerTabId, sessionToken]);

  const buildTransferFromEntry = useCallback(async (
    entry: LocalBinaryClipEntry,
    secretOverride?: string,
    secretHandleOverride?: SecretHandle
  ) => {
    if (entry.ciphertext && entry.envelope) {
      return {
        envelope: entry.envelope,
        ciphertext: entry.ciphertext.slice(),
      };
    }

    if (!entry.file) {
      return null;
    }

    const fileBytes = await entry.file.arrayBuffer();

    // Resolve the handle — prefer SecretHandle, fall back to raw secret wrapped
    let handle: SecretHandle | null = null;
    if (secretHandleOverride) {
      handle = secretHandleOverride;
    } else if (getCurrentSecretHandleRef.current) {
      handle = getCurrentSecretHandleRef.current();
    } else {
      const raw = secretOverride ?? await getCurrentUnlockSecretRef.current();
      if (raw) handle = { mode: "normal", secret: raw };
    }

    if (!handle) {
      const rawBytes = new Uint8Array(fileBytes);
      const envelope: DirectClipEnvelope = {
        transferId: entry.transferId,
        zone: entry.clip.zone,
        kind: entry.clip.kind,
        mimeType: entry.clip.mime_type || "application/octet-stream",
        originalName: entry.clip.original_name || "download",
        encrypted: false,
        encryptionVersion: null,
        encryptionMeta: null,
        sizeBytes: rawBytes.byteLength,
        createdAt: entry.clip.created_at,
        note: entry.clip.note,
      };

      entry.envelope = envelope;
      await persistSenderRecord(entry, fileBytes);

      return { envelope, ciphertext: rawBytes };
    }

    const encrypted = await encryptBinaryWithHandle(handle, fileBytes);
    const envelope: DirectClipEnvelope = {
      transferId: entry.transferId,
      zone: entry.clip.zone,
      kind: entry.clip.kind,
      mimeType: entry.clip.mime_type || "application/octet-stream",
      originalName: entry.clip.original_name || "download",
      encrypted: true,
      encryptionVersion: encrypted.meta.v,
      encryptionMeta: encrypted.meta,
      sizeBytes: encrypted.ciphertext.byteLength,
      createdAt: entry.clip.created_at,
      note: entry.clip.note,
    };

    entry.ciphertext = encrypted.ciphertext.slice();
    entry.envelope = envelope;
    entry.clip.encrypted = true;
    entry.clip.encryption_version = encrypted.meta.v;
    entry.clip.encryption_meta = encrypted.meta;
    await persistSenderRecord(entry, fileBytes, encrypted.ciphertext, envelope);

    return {
      envelope,
      ciphertext: encrypted.ciphertext,
    };
  }, [persistSenderRecord]);

  const buildTransferFromStoredRecord = useCallback(async (
    record: StoredBinaryClip,
    secretOverride?: string,
    secretHandleOverride?: SecretHandle
  ) => {
    if (record.ciphertext) {
      const isEncrypted = record.encryptionVersion != null && record.encryptionMeta != null;
      return {
        envelope: {
          transferId: record.transferId,
          zone: record.zone,
          kind: record.kind,
          mimeType: record.mimeType,
          originalName: record.originalName,
          encrypted: isEncrypted,
          encryptionVersion: record.encryptionVersion,
          encryptionMeta: record.encryptionMeta,
          sizeBytes: record.ciphertext.byteLength,
          createdAt: record.createdAt,
          note: record.note,
        } satisfies DirectClipEnvelope,
        ciphertext: record.ciphertext.slice(),
      };
    }

    if (!record.senderFileBytes) {
      return null;
    }

    const restored = restoreSenderRecord(record);
    if (!restored) {
      return null;
    }

    emitLocalBinaryClips();
    return buildTransferFromEntry(restored, secretOverride, secretHandleOverride);
  }, [buildTransferFromEntry, emitLocalBinaryClips, restoreSenderRecord]);

  const sendTransferToPeer = useCallback(
    async (
      peerId: string,
      transferId: string,
      secretOverride?: string,
      secretHandleOverride?: SecretHandle,
      startMessageType: "clip:start" | "clip:update" = "clip:start"
    ) => {
      const state = peersRef.current.get(peerId);
      if (state?.clipsChannel?.readyState !== "open") {
        return false;
      }

      const localEntry = localBinaryClipsRef.current.get(transferId);
      const transfer = localEntry
        ? await buildTransferFromEntry(localEntry, secretOverride, secretHandleOverride)
        : await getStoredBinaryClip(transferId, ownerTabId).then((record) => (
          record ? buildTransferFromStoredRecord(record, secretOverride, secretHandleOverride) : null
        ));
      logRestoreDebug("peer-mesh", "resolved transfer source for peer send", {
        transferId,
        peerId,
        ownerTabId,
        fromLocalEntry: Boolean(localEntry),
        resolved: Boolean(transfer),
      });
      if (!transfer) {
        return false;
      }

      sendProgressStoreRef.current?.startPeerSend(
        transferId,
        peerId,
        transfer.ciphertext.byteLength
      );

      try {
        await sendDirectTransfer(
          state.clipsChannel,
          transfer.envelope,
          transfer.ciphertext,
          (sentBytes) => {
            sendProgressStoreRef.current?.updatePeerProgress(transferId, peerId, sentBytes);
          },
          startMessageType
        );
        sendProgressStoreRef.current?.finishPeerSend(transferId, peerId);
        return true;
      } catch (error) {
        sendProgressStoreRef.current?.failPeerSend(transferId, peerId);
        throw error;
      }
    },
    [buildTransferFromEntry, buildTransferFromStoredRecord, ownerTabId]
  );

  const sendCatalogOfferToPeer = useCallback(async (peerId: string) => {
    await restoreReadyRef.current?.promise;
    const [idbClips, tombstones] = await Promise.all([
      listStoredBinaryClipMetadataBySession(sessionToken, ownerTabId),
      getTombstones(sessionToken),
    ]);
    for (const id of tombstones) tombstonedTransferIdsRef.current.add(id);
    const deletedThreadIds = new Set(
      (getThreadRecordsRef.current?.() ?? [])
        .filter((thread) => thread.deletedAt != null)
        .map((thread) => thread.id)
    );

    // Merge in-memory sender clips with IDB results so the catalog remains
    // correct even if another tab adopted this tab's IDB records.
    const seen = new Set(idbClips.map((clip) => clip.transferId));
    const memoryOnly: BinaryClipCatalogEntry[] = [];
    for (const [, entry] of localBinaryClipsRef.current) {
      if (seen.has(entry.transferId)) continue;
      memoryOnly.push({
        transferId: entry.transferId,
        zone: entry.clip.zone,
        kind: entry.clip.kind,
        mimeType: entry.clip.mime_type || "application/octet-stream",
        originalName: entry.clip.original_name || "download",
        sizeBytes: entry.clip.size_bytes || 0,
        encryptionVersion: entry.clip.encryption_version ?? null,
        encryptionMeta: entry.clip.encryption_meta ?? null,
        createdAt: entry.clip.created_at,
        note: entry.clip.note,
      });
    }

    const allClips = [...idbClips, ...memoryOnly];
    const clips = allClips.filter((clip) => (
      !tombstones.has(clip.transferId) && !deletedThreadIds.has(clip.zone)
    ));
    logRestoreDebug("peer-mesh", "sending catalog offer", {
      peerId,
      ownerTabId,
      sessionToken,
      clipCount: clips.length,
      memoryOnlyCount: memoryOnly.length,
      filteredByTombstone: allClips.length - clips.length,
      transferIds: clips.map((clip) => clip.transferId),
    });
    sendControlMessageToPeer(peerId, {
      type: "catalog:offer",
      clips: clips.map((clip) => ({
        transferId: clip.transferId,
        zone: clip.zone,
        kind: clip.kind,
        mimeType: clip.mimeType,
        originalName: clip.originalName,
        sizeBytes: clip.sizeBytes,
        encryptionVersion: clip.encryptionVersion,
        encryptionMeta: clip.encryptionMeta,
        createdAt: clip.createdAt,
        note: clip.note,
      })),
    });
  }, [ownerTabId, sendControlMessageToPeer, sessionToken]);

  const handleCatalogOffer = useCallback(async (
    peerId: string,
    clips: BinaryClipCatalogEntry[]
  ) => {
    // Wait for the initial IndexedDB restore to finish so the
    // DirectTransferStore's completed map is populated before we
    // decide which clips need data from the peer.
    await restoreReadyRef.current?.promise;
    const tombstones = await getTombstones(sessionToken);
    for (const id of tombstones) tombstonedTransferIdsRef.current.add(id);
    const threadRecords = getThreadRecordsRef.current?.() ?? [];
    const deletedThreadIds = new Set(
      threadRecords
        .filter((thread) => thread.deletedAt != null)
        .map((thread) => thread.id)
    );
    const knownThreadIds = new Set(threadRecords.map((thread) => thread.id));
    const localMetadata = new Map(
      (await listStoredBinaryClipMetadataBySession(sessionToken, ownerTabId)).map((clip) => [clip.transferId, clip])
    );
    const requestIds: string[] = [];
    const tombstonedIds: string[] = [];
    logRestoreDebug("peer-mesh", "received catalog offer", {
      peerId,
      ownerTabId,
      sessionToken,
      incomingTransferIds: clips.map((clip) => clip.transferId),
      knownTransferIds: Array.from(localMetadata.keys()),
    });

    for (const clip of clips) {
      if (deletedThreadIds.has(clip.zone)) {
        logRestoreDebug("peer-mesh", "skipped catalog clip from deleted thread", {
          peerId,
          transferId: clip.transferId,
          zone: clip.zone,
          ownerTabId,
          sessionToken,
        });
        void deleteStoredBinaryClip(clip.transferId, ownerTabId);
        recordTombstone(clip.transferId);
        storeRef.current?.removeLocalClip(clip.transferId);
        tombstonedIds.push(clip.transferId);
        continue;
      }
      if (!knownThreadIds.has(clip.zone)) {
        const position = activeThreads(threadRecords).length;
        onThreadCreatedRef.current?.(makeThreadRecord(
          clip.zone,
          String(position + 1),
          position,
          Date.now()
        ));
        knownThreadIds.add(clip.zone);
      }

      if (tombstones.has(clip.transferId)) {
        logRestoreDebug("peer-mesh", "skipped tombstoned catalog clip", {
          peerId,
          transferId: clip.transferId,
          ownerTabId,
          sessionToken,
        });
        void deleteStoredBinaryClip(clip.transferId, ownerTabId);
        storeRef.current?.removeLocalClip(clip.transferId);
        tombstonedIds.push(clip.transferId);
        continue;
      }

      const existing = localMetadata.get(clip.transferId);
      const stored = existing ? await getStoredBinaryClip(clip.transferId, ownerTabId) : null;
      const hasLocalPayload = stored
        ? Boolean(stored.ciphertext?.byteLength || stored.senderFileBytes?.byteLength)
        : existing
          ? existing.hasCiphertext || existing.hasSenderFileBytes
          : false;
      const localTransferState = storeRef.current?.getLocalTransferState(clip.transferId);

      if (!existing) {
        await putStoredBinaryClip({
          transferId: clip.transferId,
          sessionToken,
          ownerTabId,
          zone: clip.zone,
          kind: clip.kind,
          mimeType: clip.mimeType,
          originalName: clip.originalName,
          sizeBytes: clip.sizeBytes,
          encryptionVersion: clip.encryptionVersion,
          encryptionMeta: clip.encryptionMeta,
          createdAt: clip.createdAt,
          origin: "receiver",
          note: clip.note,
        });
      } else if (!hasLocalPayload) {
        await putStoredBinaryClip({
          transferId: clip.transferId,
          sessionToken,
          ownerTabId,
          zone: clip.zone,
          kind: clip.kind,
          mimeType: clip.mimeType,
          originalName: clip.originalName,
          sizeBytes: clip.sizeBytes,
          encryptionVersion: clip.encryptionVersion,
          encryptionMeta: clip.encryptionMeta,
          createdAt: clip.createdAt,
          origin: stored?.origin ?? "receiver",
          note: clip.note,
          senderFileBytes: stored?.senderFileBytes,
          ciphertext: stored?.ciphertext,
        });
      }

      if (stored?.origin === "receiver" && stored.ciphertext?.byteLength) {
        storeRef.current?.hydrateStoredReceiverClips([stored]);
      }

      // Skip creating a receiver-style clip in DirectTransferStore when
      // the local tab is the sender — the sender clip (with local_file)
      // already exists in localBinaryClipsRef and should not be shadowed.
      if (stored?.origin !== "sender") {
        storeRef.current?.upsertRemoteMetadata(clip, hasLocalPayload);
      }
      logRestoreDebug("peer-mesh", "processed catalog clip", {
        peerId,
        transferId: clip.transferId,
        ownerTabId,
        hadMetadata: Boolean(existing),
        storedOrigin: stored?.origin ?? null,
        hasLocalPayload,
        localTransferState,
      });
      if (!hasLocalPayload && localTransferState !== "pending" && reserveTransferOwner(clip.transferId, peerId)) {
        requestIds.push(clip.transferId);
      }
    }

    // Propagate deletions back to the offering peer so they clean up
    for (const tid of tombstonedIds) {
      sendControlMessageToPeer(peerId, { type: "clip:delete", transferId: tid });
    }

    if (requestIds.length > 0) {
      logRestoreDebug("peer-mesh", "requesting missing catalog payloads", {
        peerId,
        ownerTabId,
        transferIds: requestIds,
      });
      const sent = sendControlMessageToPeer(peerId, {
        type: "catalog:request",
        transferIds: requestIds,
      });
      if (!sent) {
        for (const transferId of requestIds) {
          releaseTransferOwner(transferId, peerId);
        }
      }
    }
  }, [ownerTabId, releaseTransferOwner, reserveTransferOwner, sendControlMessageToPeer, sessionToken]);

  const clearThreadClipsFromRemoteDelete = useCallback((threadId: ClipZone) => {
    let senderClipsRemoved = false;
    const transferIds = Array.from(localBinaryClipsRef.current.values())
      .filter((entry) => entry.clip.zone === threadId)
      .map((entry) => entry.transferId);

    for (const transferId of transferIds) {
      releaseTransferOwner(transferId);
      const senderEntry = localBinaryClipsRef.current.get(transferId);
      if (senderEntry) {
        localBinaryClipsRef.current.delete(transferId);
        localBinaryClipIdsRef.current.delete(senderEntry.clip.id);
        senderClipsRemoved = true;
        void deleteStoredBinaryClip(transferId, ownerTabId);
      }
      recordTombstone(transferId);
    }

    storeRef.current?.clearLocalClips(threadId);
    if (senderClipsRemoved) {
      emitLocalBinaryClips();
    }
  }, [emitLocalBinaryClips, ownerTabId, releaseTransferOwner, sessionToken]);

  const setupTunnelChannel = useCallback(
    (state: PeerConnectionState, channel: RTCDataChannel) => {
      if (state.tunnelChannel === channel) {
        return;
      }
      if (state.tunnelChannel && state.tunnelChannel !== channel) {
        state.tunnelChannel.close();
      }
      state.tunnelChannel = channel;
      channel.binaryType = "arraybuffer";
      channel.addEventListener("open", () => {
        updateReadyPeerCount();
      });
      channel.addEventListener("close", () => {
        updateReadyPeerCount();
      });
      channel.addEventListener("message", (event) => {
        const data = event.data as string | ArrayBuffer;
        for (const listener of tunnelMessageListenersRef.current) {
          listener(state.peerId, data);
        }
      });
    },
    [updateReadyPeerCount]
  );

  const setupDataChannel = useCallback(
    (state: PeerConnectionState, channel: RTCDataChannel) => {
      if (channel.label === "tunnel") {
        setupTunnelChannel(state, channel);
        return;
      }

      // "clips" channel (default)
      if (state.clipsChannel === channel) {
        return;
      }

      if (state.clipsChannel && state.clipsChannel !== channel) {
        state.clipsChannel.close();
      }

      state.clipsChannel = channel;
      channel.binaryType = "arraybuffer";
      channel.addEventListener("open", () => {
        if (state.connectTimeoutId) {
          clearTimeout(state.connectTimeoutId);
          state.connectTimeoutId = undefined;
        }
        updateReadyPeerCount();
        void sendCatalogOfferToPeer(state.peerId);
        sendControlMessageToPeer(state.peerId, {
          type: "threads:sync",
          threads: getThreadRecordsRef.current?.() ?? [],
        });
        // Security (M1): each peer self-announces its own name below; we do not
        // broadcast a full roster (which would assert names about other peers).
        // Re-announce my own name so peers learn it after I reload
        const myName = loadMyPeerName(sessionToken);
        if (myName) {
          sendControlMessageToPeer(state.peerId, {
            type: "peer:name",
            peerId: localPeerId,
            name: myName,
          });
        }
      });
      channel.addEventListener("close", () => {
        sendProgressStoreRef.current?.clearPeer(state.peerId);
        updateReadyPeerCount();
        if (enabled) {
          scheduleReannounce();
        }
      });
      channel.addEventListener("message", (event) => {
        void (async () => {
          const message = await decodeDataChannelMessage(
            event.data as string | ArrayBuffer | Blob | ArrayBufferView
          );

          if (message.kind === "invalid") {
            // Security (H1): a peer sent a malformed/oversized/unknown control
            // message; it was rejected at the decode boundary. Drop it.
            return;
          }

          if (message.kind === "control") {
            switch (message.message.type) {
              case "clip:start": {
                const tid = message.message.envelope.transferId;
                // Security (H4a): never resurrect a clip deleted this session.
                if (!mayAcceptClipStart({ tombstoned: tombstonedTransferIdsRef.current.has(tid) })) {
                  return;
                }
                if (!acceptTransferOwner(tid, state.peerId)) {
                  return;
                }
                // Security (H2/H4): bind the clip to the peer that delivered it,
                // but only when the transfer is actually (re)started so a peer
                // cannot hijack source by re-announcing an existing clip.
                if (storeRef.current?.startTransfer(message.message.envelope)) {
                  transferSourceRef.current.set(tid, state.peerId);
                }
                return;
              }
              case "clip:update": {
                const tid = message.message.envelope.transferId;
                // Security (H4b): only the peer that delivered the clip may replace
                // it, and never onto a tombstoned id — blocks swapping a benign clip
                // for a malicious one (which would feed the html-render XSS).
                if (!mayReplaceClip({
                  sourcePeerId: transferSourceRef.current.get(tid),
                  senderPeerId: state.peerId,
                  tombstoned: tombstonedTransferIdsRef.current.has(tid),
                })) {
                  return;
                }
                if (!acceptTransferOwner(tid, state.peerId)) {
                  return;
                }
                storeRef.current?.startTransfer(message.message.envelope, { replaceExisting: true });
                return;
              }
              case "clip:end": {
                const transferId = message.message.transferId;
                await storeRef.current?.finishTransfer(
                  message.message.transferId,
                  message.message.totalChunks
                );
                if (storeRef.current?.getLocalTransferState(transferId) !== "pending") {
                  releaseTransferOwner(transferId, state.peerId);
                }
                return;
              }
              case "clip:delete": {
                const tid = message.message.transferId;
                // Security (H2): only the peer that delivered the clip may delete
                // and tombstone it for us — stops a peer wiping clips it merely
                // learned about (e.g. from another peer's catalog).
                if (!mayDeleteClip({ sourcePeerId: transferSourceRef.current.get(tid), senderPeerId: state.peerId })) {
                  return;
                }
                releaseTransferOwner(tid);
                transferSourceRef.current.delete(tid);
                storeRef.current?.removeLocalClip(tid);
                recordTombstone(tid);
                const senderEntry = localBinaryClipsRef.current.get(tid);
                if (senderEntry) {
                  localBinaryClipsRef.current.delete(tid);
                  localBinaryClipIdsRef.current.delete(senderEntry.clip.id);
                  emitLocalBinaryClips();
                  void deleteStoredBinaryClip(tid, ownerTabId);
                }
                return;
              }
              case "clips:clear": {
                let senderClipsRemoved = false;
                for (const transferId of message.message.transferIds) {
                  // Security (H2): only clear ids this peer actually delivered.
                  if (!mayDeleteClip({ sourcePeerId: transferSourceRef.current.get(transferId), senderPeerId: state.peerId })) {
                    continue;
                  }
                  releaseTransferOwner(transferId);
                  transferSourceRef.current.delete(transferId);
                  storeRef.current?.removeLocalClip(transferId);
                  recordTombstone(transferId);
                  const senderEntry = localBinaryClipsRef.current.get(transferId);
                  if (senderEntry) {
                    localBinaryClipsRef.current.delete(transferId);
                    localBinaryClipIdsRef.current.delete(senderEntry.clip.id);
                    senderClipsRemoved = true;
                    void deleteStoredBinaryClip(transferId, ownerTabId);
                  }
                }
                if (senderClipsRemoved) {
                  emitLocalBinaryClips();
                }
                return;
              }
              case "catalog:offer":
                await handleCatalogOffer(state.peerId, message.message.clips);
                return;
              case "catalog:request": {
                const unavailable: string[] = [];
                await Promise.allSettled(
                  message.message.transferIds.map(async (transferId) => {
                    const ok = await sendTransferToPeer(state.peerId, transferId);
                    if (!ok) {
                      unavailable.push(transferId);
                    }
                  })
                );
                if (unavailable.length > 0) {
                  sendControlMessageToPeer(state.peerId, {
                    type: "catalog:unavailable",
                    transferIds: unavailable,
                  });
                }
                return;
              }
              case "catalog:unavailable":
                for (const transferId of message.message.transferIds) {
                  releaseTransferOwner(transferId, state.peerId);
                  // Try the next connected peer before giving up
                  let retried = false;
                  for (const [altPeerId, altState] of peersRef.current.entries()) {
                    if (altPeerId === state.peerId) continue;
                    if (altState.clipsChannel?.readyState !== "open") continue;
                    if (reserveTransferOwner(transferId, altPeerId)) {
                      const sent = sendControlMessageToPeer(altPeerId, {
                        type: "catalog:request",
                        transferIds: [transferId],
                      });
                      if (sent) {
                        retried = true;
                      } else {
                        releaseTransferOwner(transferId, altPeerId);
                      }
                      break;
                    }
                  }
                  if (!retried) {
                    storeRef.current?.markLocalTransferFailed(transferId);
                  }
                }
                return;
              case "threads:sync":
                onThreadsSyncRef.current?.(message.message.threads);
                return;
              case "thread:created":
                onThreadCreatedRef.current?.(message.message.thread);
                return;
              case "thread:renamed":
                onThreadRenamedRef.current?.({
                  id: message.message.id,
                  name: message.message.name,
                  updatedAt: message.message.updatedAt,
                });
                return;
              case "thread:reordered":
                onThreadReorderedRef.current?.(message.message.positions);
                return;
              case "thread:deleted":
                clearThreadClipsFromRemoteDelete(message.message.id);
                onThreadDeletedRef.current?.({
                  id: message.message.id,
                  deletedAt: message.message.deletedAt,
                });
                return;
              case "peer:name": {
                const { peerId: targetId, name } = message.message;
                // Security (M1): a peer may only set its own name. Reject claims
                // about other peers' (or our) names — identity is bound to the
                // connection, not the message body.
                if (targetId !== state.peerId) {
                  return;
                }
                peerNamesRef.current = { ...peerNamesRef.current, [targetId]: name };
                setPeerNames({ ...peerNamesRef.current });
                updateReadyPeerCount();
                return;
              }
              case "peer:identify": {
                nextIdentifyFlashIdRef.current += 1;
                // Security (M1): attribute the ping to the connection peer, not
                // the (spoofable) id in the message body.
                setIdentifyFlash({
                  id: nextIdentifyFlashIdRef.current,
                  fromPeerId: state.peerId,
                });
                return;
              }
              case "peer:names-sync": {
                // Security (M1): a peer may only assert its own name; ignore any
                // names it claims about other peers.
                const name = message.message.names[state.peerId];
                if (typeof name === "string" && peerNamesRef.current[state.peerId] !== name) {
                  peerNamesRef.current = { ...peerNamesRef.current, [state.peerId]: name };
                  setPeerNames({ ...peerNamesRef.current });
                  updateReadyPeerCount();
                }
                return;
              }
            }
          }

          if (message.kind === "chunk") {
            storeRef.current?.appendChunk(
              message.transferId,
              message.index,
              message.payload
            );
          }
        })().catch((error) => {
          console.error("Failed to process peer message", error);
        });
      });
    },
    [
      enabled,
      handleCatalogOffer,
      acceptTransferOwner,
      clearThreadClipsFromRemoteDelete,
      recordTombstone,
      releaseTransferOwner,
      reserveTransferOwner,
      scheduleReannounce,
      sendCatalogOfferToPeer,
      sendControlMessageToPeer,
      sendTransferToPeer,
      setupTunnelChannel,
      updateReadyPeerCount,
    ]
  );

  const ensurePeer = useCallback(
    (peerId: string) => {
      const existing = peersRef.current.get(peerId);
      if (existing) {
        return existing;
      }

      const polite = localPeerId.localeCompare(peerId) > 0;
      const pc = createPeerConnection(turnCredentialsRef.current);
      const state: PeerConnectionState = {
        peerId,
        polite,
        pc,
        clipsChannel: null,
        tunnelChannel: null,
        makingOffer: false,
        ignoreOffer: false,
      };

      state.connectTimeoutId = setTimeout(() => {
        cleanupPeer(peerId, true);
      }, 10000);

      pc.addEventListener("icecandidate", (event) => {
        if (!event.candidate) {
          return;
        }

        void sendPeerSignal({
          fromPeerId: localPeerId,
          toPeerId: peerId,
          signalType: "ice-candidate",
          candidate: event.candidate.toJSON(),
        });
      });

      pc.addEventListener("negotiationneeded", async () => {
        try {
          state.makingOffer = true;
          await pc.setLocalDescription();
          if (!pc.localDescription) {
            return;
          }
          await sendPeerSignal({
            fromPeerId: localPeerId,
            toPeerId: peerId,
            signalType: "description",
            description: pc.localDescription.toJSON(),
          });
        } catch {
          cleanupPeer(peerId, true);
        } finally {
          state.makingOffer = false;
        }
      });

      pc.addEventListener("connectionstatechange", () => {
        const stateName = pc.connectionState;
        if (stateName === "failed" || stateName === "closed" || stateName === "disconnected") {
          cleanupPeer(peerId, true);
          return;
        }
        if (stateName === "connected" && state.connectTimeoutId) {
          clearTimeout(state.connectTimeoutId);
          state.connectTimeoutId = undefined;
        }
        updateReadyPeerCount();
      });

      pc.addEventListener("iceconnectionstatechange", () => {
        const stateName = pc.iceConnectionState;
        if (stateName === "failed" || stateName === "closed" || stateName === "disconnected") {
          cleanupPeer(peerId, true);
        }
      });

      pc.addEventListener("datachannel", (event) => {
        setupDataChannel(state, event.channel);
      });

      if (localPeerId.localeCompare(peerId) < 0 && !state.clipsChannel) {
        setupDataChannel(
          state,
          pc.createDataChannel("clips", { ordered: true })
        );
      }

      peersRef.current.set(peerId, state);
      updateReadyPeerCount();
      return state;
    },
    [cleanupPeer, localPeerId, sendPeerSignal, setupDataChannel, updateReadyPeerCount]
  );

  const handlePeerSignal = useCallback(
    async (message: PeerSignalMessage) => {
      if (!enabled || message.fromPeerId === localPeerId) {
        return;
      }
      if (message.toPeerId && message.toPeerId !== localPeerId) {
        return;
      }

      if (message.signalType === "leave") {
        cleanupPeer(message.fromPeerId, false);
        return;
      }

      if (message.signalType === "announce") {
        ensurePeer(message.fromPeerId);
        if (!message.toPeerId) {
          announce(message.fromPeerId);
        }
        return;
      }

      const state = ensurePeer(message.fromPeerId);
      const pc = state.pc;

      if (message.signalType === "description" && message.description) {
        const description = message.description;
        const offerCollision =
          description.type === "offer" &&
          (state.makingOffer || pc.signalingState !== "stable");

        state.ignoreOffer = !state.polite && offerCollision;
        if (state.ignoreOffer) {
          return;
        }

        try {
          if (offerCollision) {
            await Promise.all([
              pc.setLocalDescription({ type: "rollback" }),
              pc.setRemoteDescription(description),
            ]);
          } else {
            await pc.setRemoteDescription(description);
          }

          if (description.type === "offer") {
            await pc.setLocalDescription();
            if (pc.localDescription) {
              await sendPeerSignal({
                fromPeerId: localPeerId,
                toPeerId: message.fromPeerId,
                signalType: "description",
                description: pc.localDescription.toJSON(),
              });
            }
          }
        } catch {
          cleanupPeer(message.fromPeerId, true);
        }
        return;
      }

      if (message.signalType === "ice-candidate" && message.candidate && !state.ignoreOffer) {
        try {
          await pc.addIceCandidate(message.candidate);
        } catch {
          cleanupPeer(message.fromPeerId, true);
        }
      }
    },
    [announce, cleanupPeer, enabled, ensurePeer, localPeerId, sendPeerSignal]
  );

  const queueLocalBinaryClip = useCallback(
    async ({ transferId, zone, file, secret, secretHandle, kind: inputKind, note }: QueueLocalBinaryClipInput) => {
      const existing = localBinaryClipsRef.current.get(transferId);
      if (existing) {
        return existing.clip;
      }

      const kind = inputKind || (file.type.startsWith("image/") ? "image" : "file");
      const clipId = nextLocalBinaryClipIdRef.current;
      nextLocalBinaryClipIdRef.current -= 1;
      const clip: Clip = {
        id: clipId,
        session_id: 0,
        zone,
        kind,
        client_transfer_id: transferId,
        mime_type: file.type || "application/octet-stream",
        text_content: null,
        html_content: null,
        storage_key: null,
        original_name: file.name || "download",
        size_bytes: file.size,
        encrypted: false,
        encryption_version: null,
        encryption_meta: null,
        created_at: new Date().toISOString(),
        note: note || null,
        local_only: true,
        local_origin: "sender",
        local_transfer_state: "complete",
        local_file: file,
      };
      const entry: LocalBinaryClipEntry = {
        transferId,
        clip,
        file,
        ciphertext: null,
        envelope: null,
      };

      localBinaryClipsRef.current.set(transferId, entry);
      localBinaryClipIdsRef.current.set(clip.id, transferId);
      emitLocalBinaryClips();

      // Pre-encrypt when a secret is provided so ciphertext is available
      // in IDB before peers connect. Without this, encryption only happens
      // inside sendTransferToPeer which is skipped when no peers are connected.
      if (secretHandle) {
        await buildTransferFromEntry(entry, undefined, secretHandle);
        emitLocalBinaryClips();
      } else if (secret) {
        await buildTransferFromEntry(entry, secret);
        emitLocalBinaryClips();
      } else {
        await persistSenderRecord(entry);
      }

      const peerIds = Array.from(peersRef.current.keys());
      const sends = peerIds.map((peerId) => sendTransferToPeer(peerId, transferId, secret, secretHandle));
      if (sends.length > 0) {
        await Promise.allSettled(sends);
      }

      return clip;
    },
    [buildTransferFromEntry, emitLocalBinaryClips, persistSenderRecord, sendTransferToPeer]
  );

  const updateLocalBinaryClipContent = useCallback(async (
    input: UpdateLocalBinaryClipInput
  ) => {
    const entry = localBinaryClipsRef.current.get(input.transferId);
    if (!entry) {
      throw new Error("Local clip not found");
    }
    if (
      entry.clip.local_only !== true ||
      entry.clip.local_origin !== "sender" ||
      entry.clip.client_transfer_id !== input.transferId
    ) {
      throw new Error("Only sender-owned local clips can be edited");
    }
    if (entry.clip.kind !== input.kind || (input.kind !== "text" && input.kind !== "html")) {
      throw new Error("Only sender-owned text and HTML clips can be edited");
    }

    const wasEncrypted = entry.clip.encrypted;
    const secretHandle = getCurrentSecretHandleRef.current?.() ?? null;
    const rawSecret = secretHandle ? null : await getCurrentUnlockSecretRef.current();
    if (wasEncrypted && !secretHandle && !rawSecret) {
      throw new Error("Unlock secret required to edit encrypted clip");
    }

    const mimeType = input.kind === "html" ? "application/json" : "text/plain";
    const htmlContent = input.kind === "html"
      ? regenerateHtmlFromPlainText(input.text)
      : null;
    const payload = input.kind === "html"
      ? JSON.stringify({ text: input.text, html: htmlContent })
      : input.text;
    const file = new File(
      [new Blob([payload], { type: mimeType })],
      entry.clip.original_name || (input.kind === "html" ? "clip.json" : "clip.txt"),
      { type: mimeType }
    );

    entry.file = file;
    entry.clip = {
      ...entry.clip,
      mime_type: mimeType,
      size_bytes: file.size,
      text_content: input.text,
      html_content: htmlContent,
      local_file: file,
    };
    entry.ciphertext = null;
    entry.envelope = null;
    emitLocalBinaryClips();

    if (secretHandle) {
      await buildTransferFromEntry(entry, undefined, secretHandle);
    } else if (rawSecret) {
      await buildTransferFromEntry(entry, rawSecret);
    } else {
      await persistSenderRecord(entry);
    }

    emitLocalBinaryClips();

    const peerIds = Array.from(peersRef.current.keys());
    const sends = peerIds.map((peerId) =>
      sendTransferToPeer(peerId, input.transferId, undefined, undefined, "clip:update")
    );
    if (sends.length > 0) {
      await Promise.allSettled(sends);
    }
  }, [buildTransferFromEntry, emitLocalBinaryClips, persistSenderRecord, sendTransferToPeer]);

  const removeLocalBinaryClip = useCallback(
    (clipIdOrTransferId: number | string) => {
      const transferId = typeof clipIdOrTransferId === "string"
        ? clipIdOrTransferId
        : localBinaryClipIdsRef.current.get(clipIdOrTransferId);
      if (!transferId) {
        return;
      }

      const existing = localBinaryClipsRef.current.get(transferId);
      if (!existing) {
        return;
      }

      localBinaryClipsRef.current.delete(transferId);
      localBinaryClipIdsRef.current.delete(existing.clip.id);
      emitLocalBinaryClips();
      void deleteStoredBinaryClip(transferId, ownerTabId);
      recordTombstone(transferId);
      broadcastControlMessage({ type: "clip:delete", transferId });
    },
    [broadcastControlMessage, emitLocalBinaryClips, ownerTabId, recordTombstone]
  );

  const clearLocalBinaryClips = useCallback(
    (zone?: ClipZone) => {
      const transferIds = Array.from(localBinaryClipsRef.current.values())
        .filter((entry) => !zone || entry.clip.zone === zone)
        .map((entry) => entry.transferId);

      if (transferIds.length === 0) {
        return;
      }

      for (const transferId of transferIds) {
        const entry = localBinaryClipsRef.current.get(transferId);
        if (!entry) {
          continue;
        }
        localBinaryClipsRef.current.delete(transferId);
        localBinaryClipIdsRef.current.delete(entry.clip.id);
        void deleteStoredBinaryClip(transferId, ownerTabId);
        recordTombstone(transferId);
      }

      emitLocalBinaryClips();
      broadcastControlMessage({ type: "clips:clear", transferIds, zone });
    },
    [broadcastControlMessage, emitLocalBinaryClips, ownerTabId, recordTombstone]
  );

  const attachCanonicalClip = useCallback((clip: Clip) => {
    storeRef.current?.attachClip(clip);
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    logRestoreDebug("peer-mesh", "starting initial stored clip restore", {
      sessionToken,
      ownerTabId,
    });
    const migration = pendingMigrations.get(sessionToken);
    if (migration) {
      pendingMigrations.delete(sessionToken);
    }
    void (migration ?? Promise.resolve(0)).then(() =>
      Promise.all([
        listStoredBinaryClipsBySession(sessionToken, ownerTabId),
        getTombstones(sessionToken),
      ])
    ).then(async ([allRecords, tombstones]) => {
      for (const id of tombstones) tombstonedTransferIdsRef.current.add(id);
      // Filter out tombstoned clips — they were deleted in a prior session
      // and should not be restored or re-advertised.
      let records = allRecords.filter((r) => !tombstones.has(r.transferId));
      const tombstonedCount = allRecords.length - records.length;
      if (tombstonedCount > 0) {
        logRestoreDebug("peer-mesh", "filtered tombstoned clips from restore", {
          sessionToken,
          ownerTabId,
          tombstonedCount,
          tombstonedIds: allRecords
            .filter((r) => tombstones.has(r.transferId))
            .map((r) => r.transferId),
        });
        // Clean up the tombstoned records from IndexedDB
        for (const r of allRecords) {
          if (tombstones.has(r.transferId)) {
            void deleteStoredBinaryClip(r.transferId, ownerTabId);
          }
        }
      }
      // After a full browser restart, sessionStorage is gone so the tab ID
      // is freshly generated — no clips will match.  Adopt any orphaned clips
      // from the same session (left behind by the previous tab ID).
      if (records.length === 0 && !cancelled) {
        const adopted = await adoptOrphanedClips(sessionToken, ownerTabId, tombstones);
        if (adopted.length > 0) {
          logRestoreDebug("peer-mesh", "adopted orphaned clips after browser restart", {
            sessionToken,
            ownerTabId,
            adoptedCount: adopted.length,
            transferIds: adopted.map((r) => r.transferId),
          });
          records = adopted;
        }
      }
      if (cancelled) {
        restoreReadyRef.current?.resolve();
        return;
      }
      const senderRecords = records.filter((record) => record.origin === "sender");
      const receiverRecords = records.filter((record) => record.origin === "receiver");
      logRestoreDebug("peer-mesh", "loaded stored clips for initial restore", {
        sessionToken,
        ownerTabId,
        recordCount: records.length,
        senderTransfers: senderRecords.map((record) => record.transferId),
        receiverTransfers: receiverRecords.map((record) => record.transferId),
      });

      const threadRecords = getThreadRecordsRef.current?.() ?? [];
      const knownThreadIds = new Set(threadRecords.map((thread) => thread.id));
      const deletedThreadIds = new Set(
        threadRecords
          .filter((thread) => thread.deletedAt != null)
          .map((thread) => thread.id)
      );
      for (const record of records) {
        if (knownThreadIds.has(record.zone) || deletedThreadIds.has(record.zone)) {
          continue;
        }
        const position = activeThreads(threadRecords).length + knownThreadIds.size;
        onThreadCreatedRef.current?.(makeThreadRecord(
          record.zone,
          String(position + 1),
          position,
          Date.now()
        ));
        knownThreadIds.add(record.zone);
      }

      let senderChanged = false;
      for (const record of records) {
        if (record.origin !== "sender") {
          continue;
        }
        const restored = restoreSenderRecord(record);
        if (restored) {
          senderChanged = true;
        }
      }
      if (senderChanged) {
        emitLocalBinaryClips();
      }
      storeRef.current?.hydrateStoredReceiverClips(records);
      restoreReadyRef.current?.resolve();
    }).catch((error: unknown) => {
      logRestoreDebug("peer-mesh", "failed initial stored clip restore", {
        sessionToken,
        ownerTabId,
        error: error instanceof Error ? error.message : String(error),
      });
      restoreReadyRef.current?.resolve();
    });

    return () => {
      cancelled = true;
    };
  }, [emitLocalBinaryClips, enabled, ownerTabId, restoreSenderRecord, sessionToken]);

  useEffect(() => {
    const store = storeRef.current;
    if (!store) {
      return;
    }

    return store.subscribe(() => {
      for (const transferId of Array.from(transferOwnersRef.current.keys())) {
        if (store.getLocalTransferState(transferId) !== "pending") {
          releaseTransferOwner(transferId);
        }
      }
    });
  }, [releaseTransferOwner]);

  useEffect(() => {
    if (!enabled || !signalingReady) {
      return;
    }

    announce();

    return () => {
      if (!signalingReady) {
        return;
      }
      void sendPeerSignal({
        fromPeerId: localPeerId,
        signalType: "leave",
      });
    };
  }, [announce, enabled, localPeerId, sendPeerSignal, signalingReady]);

  useEffect(() => {
    if (enabled) {
      return;
    }

    if (announceTimerRef.current) {
      clearTimeout(announceTimerRef.current);
      announceTimerRef.current = null;
    }

    const peerIds = Array.from(peersRef.current.keys());
    for (const peerId of peerIds) {
      cleanupPeer(peerId, false);
    }
    sendProgressStoreRef.current?.clearAll();
    storeRef.current?.dispose();
    for (const timeoutId of transferRequestTimeoutsRef.current.values()) {
      clearTimeout(timeoutId);
    }
    transferOwnersRef.current.clear();
    transferRequestTimeoutsRef.current.clear();
    localBinaryClipsRef.current.clear();
    localBinaryClipIdsRef.current.clear();
    emitLocalBinaryClips();
  }, [cleanupPeer, emitLocalBinaryClips, enabled]);

  // Store callbacks in refs so the unmount-only effect below can call the
  // latest version without re-running (and triggering destructive cleanup)
  // every time the callback identity changes.
  const cleanupPeerRef = useRef(cleanupPeer);
  const emitLocalBinaryClipsRef = useRef(emitLocalBinaryClips);
  useEffect(() => { cleanupPeerRef.current = cleanupPeer; }, [cleanupPeer]);
  useEffect(() => { emitLocalBinaryClipsRef.current = emitLocalBinaryClips; }, [emitLocalBinaryClips]);

  useEffect(() => {
    return () => {
      if (announceTimerRef.current) {
        clearTimeout(announceTimerRef.current);
      }
      const peerIds = Array.from(peersRef.current.keys());
      for (const peerId of peerIds) {
        cleanupPeerRef.current(peerId, false);
      }
      sendProgressStoreRef.current?.clearAll();
      storeRef.current?.dispose();
      for (const timeoutId of transferRequestTimeoutsRef.current.values()) {
        clearTimeout(timeoutId);
      }
      transferOwnersRef.current.clear();
      transferRequestTimeoutsRef.current.clear();
      localBinaryClipsRef.current.clear();
      localBinaryClipIdsRef.current.clear();
      emitLocalBinaryClipsRef.current();
    };
  }, []);

  const pingPeer = useCallback((peerId: string) => {
    sendControlMessageToPeer(peerId, { type: "peer:identify", fromPeerId: localPeerId });
  }, [localPeerId, sendControlMessageToPeer]);

  const clearIdentifyFlash = useCallback((flashId?: number) => {
    setIdentifyFlash((current) => {
      if (typeof flashId === "number" && current?.id !== flashId) {
        return current;
      }
      return null;
    });
  }, []);

  const renamePeer = useCallback((peerId: string, name: string) => {
    peerNamesRef.current = { ...peerNamesRef.current, [peerId]: name };
    setPeerNames({ ...peerNamesRef.current });
    updateReadyPeerCount();
    // Security (M1): only a self-name is authoritative and broadcast. A label
    // applied to another peer stays local to this device and is not propagated.
    if (peerId === localPeerId) {
      persistMyPeerName(sessionToken, name);
      broadcastControlMessage({ type: "peer:name", peerId, name });
    }
  }, [broadcastControlMessage, localPeerId, sessionToken, updateReadyPeerCount]);

  return useMemo(() => ({
    attachCanonicalClip,
    clearIdentifyFlash,
    clearLocalBinaryClips,
    clearReceivedBinaryClips: (zone?: ClipZone) =>
      storeRef.current?.clearLocalClips(zone),
    getDirectClipCiphertext: (clipId: number) =>
      storeRef.current?.getClipCiphertext(clipId) ?? null,
    getSendProgress: (transferId: string) =>
      sendProgressStoreRef.current?.getTransferProgress(transferId) ?? null,
    getTransferStats: (transferId: string): TransferStats | null =>
      storeRef.current?.getTransferStats(transferId) ?? null,
    getLocalBinaryClipsByZone: (zone: ClipZone) =>
      localBinarySnapshotRef.current[zone] ?? EMPTY_LOCAL_CLIPS,
    getLocalBinaryClipGroups: () => localBinarySnapshotRef.current,
    getReceivedBinaryClipsByZone: (zone: ClipZone) =>
      storeRef.current?.getLocalClips(zone) ?? [],
    getReceivedBinaryClipGroups: () =>
      storeRef.current?.getLocalClipGroups() ?? {},
    handlePeerSignal,
    identifyFlash,
    localPeerId,
    peerNames,
    pingPeer,
    queueLocalBinaryClip,
    updateLocalBinaryClipContent,
    peers,
    readyPeerCount,
    renamePeer,
    broadcastClipDelete: (transferId: string) => {
      recordTombstone(transferId);
      broadcastControlMessage({ type: "clip:delete", transferId });
    },
    broadcastThreadCreated: (thread: ThreadRecord) =>
      broadcastControlMessage({ type: "thread:created", thread }),
    broadcastThreadRenamed: (id: string, name: string, updatedAt: number) =>
      broadcastControlMessage({ type: "thread:renamed", id, name, updatedAt }),
    broadcastThreadReordered: (positions: { id: string; position: number; updatedAt: number }[]) =>
      broadcastControlMessage({ type: "thread:reordered", positions }),
    broadcastThreadDeleted: (id: string, deletedAt: number) =>
      broadcastControlMessage({ type: "thread:deleted", id, deletedAt }),
    broadcastThreadsSync: (threads: ThreadRecord[]) =>
      broadcastControlMessage({ type: "threads:sync", threads }),
    removeLocalBinaryClip,
    removeReceivedBinaryClip: (clipId: number) =>
      storeRef.current?.removeLocalClip(clipId),
    subscribeToSendProgress: (listener: () => void) =>
      sendProgressStoreRef.current?.subscribe(listener) ?? (() => undefined),
    subscribeToDirectTransfers: (listener: () => void) =>
      storeRef.current?.subscribe(listener) ?? (() => undefined),
    subscribeToLocalBinaryClips: (listener: () => void) => {
      localBinaryListenersRef.current.add(listener);
      return () => {
        localBinaryListenersRef.current.delete(listener);
      };
    },
    sendTunnelMessage: (peerId: string, data: string | ArrayBuffer): boolean => {
      const state = peersRef.current.get(peerId);
      if (state?.tunnelChannel?.readyState !== "open") {
        return false;
      }
      if (typeof data === "string") {
        state.tunnelChannel.send(data);
      } else {
        state.tunnelChannel.send(data);
      }
      return true;
    },
    openTunnelChannel: (peerId: string): boolean => {
      const state = peersRef.current.get(peerId);
      if (!state) {
        return false;
      }
      if (state.tunnelChannel?.readyState === "open" || state.tunnelChannel?.readyState === "connecting") {
        return true;
      }
      setupDataChannel(state, state.pc.createDataChannel("tunnel", { ordered: true }));
      return true;
    },
    subscribeTunnel: (listener: (peerId: string, data: string | ArrayBuffer) => void) => {
      tunnelMessageListenersRef.current.add(listener);
      return () => {
        tunnelMessageListenersRef.current.delete(listener);
      };
    },
  }), [
    attachCanonicalClip,
    broadcastControlMessage,
    clearIdentifyFlash,
    clearLocalBinaryClips,
    handlePeerSignal,
    identifyFlash,
    localPeerId,
    peerNames,
    peers,
    pingPeer,
    queueLocalBinaryClip,
    updateLocalBinaryClipContent,
    readyPeerCount,
    removeLocalBinaryClip,
    renamePeer,
    setupDataChannel,
  ]);
}
