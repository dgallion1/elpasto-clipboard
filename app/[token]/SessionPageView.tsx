import { useCallback, useEffect, useState } from "react";
import { SessionHeader } from "@/components/SessionHeader";
import { IdentifyFlashOverlay } from "@/components/IdentifyFlashOverlay";
import { PasteZone } from "@/components/PasteZone";
import { SecretPrompt } from "@/components/SecretPrompt";
import { DeviceHandoff } from "@/components/DeviceHandoff";
import { deriveConnectionState, type ConnectionState } from "@/lib/connection-state";
import { getSessionUrl } from "@/lib/session-url";
import type { IdentifyFlashEvent, PeerInfo } from "@/hooks/usePeerMesh";
import { useSessionHistory, buildSessionExportJson } from "@/hooks/useSessionHistory";
import type { ImportEntry } from "@/hooks/useSessionHistory";
import { buildApiUrl } from "@/lib/api";
import type { Clip, ClipZone } from "@/lib/clips";
import type { TransferStats } from "@/lib/direct-transfer";
import type { TunnelInfo } from "@/hooks/useTunnelRelay";
import type { SoundName, SoundVolume } from "@/hooks/useNotificationSound";
import type { SecretHandle } from "@/lib/clip-crypto";
import type { ThreadRecord } from "@/lib/threads";
import type { SessionData } from "./session-page-types";

const SESSION_BATCH_IMPORT_LIMIT = 20;

interface ZoneViewModel {
  zone: ClipZone;
  threadName?: string;
  clips: Clip[];
  onClearZone: () => Promise<void>;
}

interface SessionPageViewProps {
  loading: boolean;
  error: string | null;
  session: SessionData | null;
  token: string;
  canCopyImage: boolean;
  unlockSecret: string | null;
  secretPromptMode: "setup" | "required" | "manage" | null;
  clearIdentifyFlash: (flashId?: number) => void;
  identifyFlash: IdentifyFlashEvent | null;
  localPeerId: string;
  peerNames: Record<string, string>;
  peers: PeerInfo[];
  pingPeer: (peerId: string) => void;
  readyPeerCount: number;
  renamePeer: (peerId: string, name: string) => void;
  threads: ThreadRecord[];
  activeThreadId: ClipZone | null;
  canCreateThread: boolean;
  onSelectThread: (threadId: ClipZone) => void;
  onCreateThread: () => void;
  onRenameThread: (threadId: ClipZone, name: string) => void;
  onDeleteThread: (threadId: ClipZone) => void;
  onMoveThread: (threadId: ClipZone, direction: -1 | 1) => void;
  zones: ZoneViewModel[];
  getDirectClipCiphertext: (clipId: number) => Uint8Array | null;
  getSendProgress: (transferId: string) => number | null;
  getTransferStats: (transferId: string) => TransferStats | null;
  requestUnlockSecret: () => Promise<string | null>;
  onClipAdded: (clip: Clip) => void;
  onClipDeleted: (clip: Clip) => void;
  onUpdateClipContent?: (input: {
    transferId: string;
    kind: "text" | "html";
    text: string;
  }) => Promise<void>;
  onQueueLocalBinaryClip: (input: {
    transferId: string;
    zone: ClipZone;
    file: File;
    secret?: string;
    secretHandle?: SecretHandle;
    kind?: "text" | "html" | "image" | "file";
  }) => Promise<Clip>;
  onClearAll: () => Promise<void>;
  onGoHome: () => void;
  onManageSecret: () => void;
  onForgetSecret: () => void;
  onSecretSubmit: (secret: string) => void;
  onSecretCancel: () => void;
  subscribeToSendProgress: (listener: () => void) => () => void;
  subscribeToDirectTransfers: (listener: () => void) => () => void;
  tunnels: TunnelInfo[];
  swReady: boolean;
  openTunnel: (peerId: string) => void;
  removeTunnel: (peerId: string) => void;
  secretHandle?: SecretHandle | null;
  secretMode?: "normal" | "paranoid" | null;
  onSecretSubmitParanoid?: (secret: string) => void;
  paranoidAvailable?: boolean;
  sound?: {
    enabled: boolean;
    soundName: SoundName;
    volume: SoundVolume;
    onSetEnabled: (enabled: boolean) => void;
    onSetSoundName: (name: SoundName) => void;
    onCycleVolume: () => void;
  };
}

export function SessionPageView({
  loading,
  error,
  session,
  token,
  canCopyImage,
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
  threads,
  activeThreadId,
  canCreateThread,
  onSelectThread,
  onCreateThread,
  onRenameThread,
  onDeleteThread,
  onMoveThread,
  zones,
  getDirectClipCiphertext,
  getSendProgress,
  getTransferStats,
  requestUnlockSecret,
  onClipAdded,
  onClipDeleted,
  onUpdateClipContent,
  onQueueLocalBinaryClip,
  onClearAll,
  onGoHome,
  onManageSecret,
  onForgetSecret,
  onSecretSubmit,
  onSecretCancel,
  subscribeToSendProgress,
  subscribeToDirectTransfers,
  tunnels,
  swReady,
  openTunnel,
  removeTunnel,
  secretHandle,
  secretMode,
  onSecretSubmitParanoid,
  paranoidAvailable,
  sound,
}: SessionPageViewProps) {
  const sessionHistory = useSessionHistory(token);
  const [editingThreads, setEditingThreads] = useState(false);
  const activeZone = activeThreadId ?? zones[0]?.zone ?? null;
  const connectionState: ConnectionState = deriveConnectionState({ peers, readyPeerCount, tunnels });

  const onExportSessions = useCallback(async () => {
    const json = buildSessionExportJson(sessionHistory.entries, { peerNames, currentToken: token });
    if (!json) return;
    const file = new File([json], "sessions.json", { type: "text/plain" });
    const transferId = crypto.randomUUID();
    const clip = await onQueueLocalBinaryClip({
      transferId,
      zone: activeZone ?? zones[0]?.zone ?? "A",
      file,
      kind: "text",
      ...(secretHandle ? { secretHandle } : unlockSecret ? { secret: unlockSecret } : {}),
    });
    onClipAdded(clip);
  }, [sessionHistory.entries, token, peerNames, activeZone, zones, unlockSecret, secretHandle, onQueueLocalBinaryClip, onClipAdded]);

  const handleRenamePeer = useCallback(
    (peerId: string, name: string) => {
      renamePeer(peerId, name);
      if (peerId === localPeerId) {
        sessionHistory.setMyPeerName(token, name);
      }
    },
    [renamePeer, localPeerId, sessionHistory, token]
  );

  // Restore peer name from imported session history on first open.
  // sessionHistory reads from localStorage synchronously so entries are
  // populated before this effect runs. We gate on [localPeerId] because
  // that's the stable identity that makes the check meaningful; re-running
  // when peerNames changes is unnecessary since renamePeer itself will
  // update peerNames, and we only want this to fire once per mount.
  useEffect(() => {
    const entry = sessionHistory.entries.find((e) => e.token === token);
    if (entry?.myPeerName && !peerNames[localPeerId]) {
      renamePeer(localPeerId, entry.myPeerName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localPeerId]);

  const handleImportSessions = useCallback(async (entries: ImportEntry[]) => {
    const tokens = entries.map((e) => e.token);

    const applyPeerNames = (importedEntries: ImportEntry[]) => {
      const match = importedEntries.find((e) => e.token === token && e.peerNames);
      if (match?.peerNames) {
        for (const [peerId, name] of Object.entries(match.peerNames)) {
          renamePeer(peerId, name);
        }
      }
    };

    try {
      const created: string[] = [];
      const existing: string[] = [];
      const invalid: string[] = [];
      const capacity: string[] = [];

      for (let index = 0; index < tokens.length; index += SESSION_BATCH_IMPORT_LIMIT) {
        const batchTokens = tokens.slice(index, index + SESSION_BATCH_IMPORT_LIMIT);
        const response = await fetch(buildApiUrl("/api/sessions/batch"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokens: batchTokens }),
        });
        if (!response.ok) {
          throw new Error(`batch request failed: ${response.status}`);
        }
        const data = await response.json() as {
          created: string[];
          existing: string[];
          invalid: string[];
          capacity: string[];
        };
        created.push(...data.created);
        existing.push(...data.existing);
        invalid.push(...data.invalid);
        capacity.push(...data.capacity);
      }

      const successSet = new Set([...created, ...existing]);
      const filteredEntries = entries.filter((e) => successSet.has(e.token));
      sessionHistory.importEntries(filteredEntries);
      applyPeerNames(filteredEntries);
      return {
        importedCount: filteredEntries.length,
        createdCount: created.length,
        existingCount: existing.length,
        invalidCount: invalid.length,
        capacityCount: capacity.length,
        usedFallback: false,
      };
    } catch {
      sessionHistory.importEntries(entries);
      applyPeerNames(entries);
      return {
        importedCount: entries.length,
        createdCount: 0,
        existingCount: 0,
        invalidCount: 0,
        capacityCount: 0,
        usedFallback: true,
      };
    }
  }, [sessionHistory, token, renamePeer]);

  if (loading) {
    return (
      <main className="flex items-center justify-center min-h-screen">
        <span className="text-neutral-500">Loading...</span>
      </main>
    );
  }

  if (error || !session) {
    return (
      <main className="flex flex-col items-center justify-center min-h-screen gap-4">
        <p className="text-neutral-400" role="alert">{error || "Session not found"}</p>
        <button
          onClick={onGoHome}
          className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-md text-neutral-200 transition-colors"
        >
          Go Home
        </button>
      </main>
    );
  }

  const totalClips = zones.reduce((total, zone) => total + zone.clips.length, 0);
  const activeZoneModel = zones.find((zone) => zone.zone === activeZone) ?? zones[0] ?? null;
  const threadClipCounts = new Map(zones.map((zone) => [zone.zone, zone.clips.length]));

  const handleRenameThread = (thread: ThreadRecord) => {
    const next = window.prompt("Rename thread", thread.name);
    if (next == null) {
      return;
    }
    onRenameThread(thread.id, next);
  };

  const handleDeleteThread = (thread: ThreadRecord) => {
    const clipCount = threadClipCounts.get(thread.id) ?? 0;
    if (clipCount > 0 && !window.confirm(`Delete thread ${thread.name} and its ${clipCount} clips?`)) {
      return;
    }
    onDeleteThread(thread.id);
  };

  return (
    <div className={`flex flex-col h-screen transition-colors duration-500 ${(unlockSecret || secretHandle) ? "bg-green-950/30" : ""}`}>
      <span className="absolute h-px w-px overflow-hidden [clip:rect(0,0,0,0)]" role="status" aria-live="polite">
        {connectionState === "connected-direct"
          ? "Device connected"
          : connectionState === "connected-tunnel"
            ? "Device connected via relay"
            : connectionState === "connecting"
              ? "Device connecting"
              : ""}
      </span>
      <SessionHeader
        token={session.token}
        hasUnlockSecret={Boolean(unlockSecret)}
        secretMode={secretMode}
        directPeerCount={readyPeerCount}
        localPeerId={localPeerId}
        peerNames={peerNames}
        peers={peers}
        totalClips={totalClips}
        sessionHistory={sessionHistory}
        onRenamePeer={handleRenamePeer}
        onPingPeer={pingPeer}
        onManageSecret={onManageSecret}
        onForgetSecret={onForgetSecret}
        onClearAll={onClearAll}
        onExportSessions={onExportSessions}
        tunnels={tunnels}
        swReady={swReady}
        onOpenTunnel={openTunnel}
        onRemoveTunnel={removeTunnel}
        sound={sound}
      />
      <IdentifyFlashOverlay
        flash={identifyFlash}
        peerNames={peerNames}
        onDone={clearIdentifyFlash}
      />
      <div className="flex flex-col gap-2 border-b border-neutral-800 bg-neutral-950/80 px-2 py-2">
        <div className="flex items-center gap-2 overflow-x-auto">
          {threads.map((thread, index) => {
            const isActive = thread.id === activeZoneModel?.zone;
            return (
              <div key={thread.id} className={`flex shrink-0 items-center rounded-md border ${isActive ? "border-emerald-500/60 bg-emerald-950/40" : "border-neutral-800 bg-neutral-900/70"}`}>
                <button
                  onClick={() => onSelectThread(thread.id)}
                  aria-label={`Select thread ${thread.name || String(index + 1)}`}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors ${isActive ? "text-emerald-300" : "text-neutral-400 hover:text-neutral-200"}`}
                >
                  {thread.name || String(index + 1)}
                  <span className="ml-2 text-xs text-neutral-500">{threadClipCounts.get(thread.id) ?? 0}</span>
                </button>
                {editingThreads && (
                  <div className="flex items-center gap-0.5 pr-1">
                    <button
                      onClick={() => onMoveThread(thread.id, -1)}
                      disabled={index === 0}
                      className="px-1 py-1 text-xs text-neutral-500 hover:text-neutral-200 disabled:opacity-30"
                      aria-label={`Move thread ${thread.name} left`}
                    >
                      &larr;
                    </button>
                    <button
                      onClick={() => onMoveThread(thread.id, 1)}
                      disabled={index === threads.length - 1}
                      className="px-1 py-1 text-xs text-neutral-500 hover:text-neutral-200 disabled:opacity-30"
                      aria-label={`Move thread ${thread.name} right`}
                    >
                      &rarr;
                    </button>
                    <button
                      onClick={() => handleRenameThread(thread)}
                      className="px-1.5 py-1 text-xs text-neutral-500 hover:text-neutral-200"
                      aria-label={`Rename thread ${thread.name}`}
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => handleDeleteThread(thread)}
                      disabled={threads.length <= 1}
                      className="px-1.5 py-1 text-xs text-neutral-500 hover:text-red-300 disabled:opacity-30"
                      aria-label={`Delete thread ${thread.name}`}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <button
            onClick={() => setEditingThreads((prev) => !prev)}
            className={`shrink-0 rounded-md border px-2.5 py-1.5 text-sm transition-colors ${editingThreads ? "border-emerald-500/60 bg-emerald-950/40 text-emerald-300" : "border-neutral-800 bg-neutral-900 text-neutral-500 hover:text-neutral-300"}`}
            aria-label={editingThreads ? "Done editing threads" : "Edit threads"}
          >
            {editingThreads ? "Done" : "Edit"}
          </button>
          {editingThreads && (
            <button
              onClick={onCreateThread}
              disabled={!canCreateThread}
              className="shrink-0 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
              aria-label="Create thread"
            >
              +
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-1 min-h-0 p-2 flex-col gap-2 pb-14 md:pb-2">
        <DeviceHandoff
          state={connectionState}
          sessionUrl={getSessionUrl(token)}
          token={token}
          hasClips={(activeZoneModel?.clips.length ?? 0) > 0}
        />
        {zones.map(({ zone, threadName, clips, onClearZone }) => (
          <PasteZone
            key={zone}
            zone={zone}
            threadName={threadName}
            clips={clips}
            token={token}
            expiresAt={session.expiresAt}
            canCopyImage={canCopyImage}
            unlockSecret={unlockSecret}
            secretHandle={secretHandle}
            requestUnlockSecret={requestUnlockSecret}
            getDirectClipCiphertext={getDirectClipCiphertext}
            getSendProgress={getSendProgress}
            getTransferStats={getTransferStats}
            readyPeerCount={readyPeerCount}
            onClipAdded={onClipAdded}
            onClipDeleted={onClipDeleted}
            onUpdateClipContent={onUpdateClipContent}
            onQueueLocalBinaryClip={onQueueLocalBinaryClip}
            onClearZone={onClearZone}
            focusedZone={activeZone}
            onFocusZone={(nextZone) => {
              if (nextZone) {
                onSelectThread(nextZone);
              }
            }}
            subscribeToSendProgress={subscribeToSendProgress}
            subscribeToDirectTransfers={subscribeToDirectTransfers}
            onImportSessions={handleImportSessions}
          />
        ))}
      </div>
      <div className="fixed bottom-0 left-0 right-0 flex gap-1 overflow-x-auto md:hidden bg-neutral-900 border-t border-neutral-800 z-10 px-2 pb-[env(safe-area-inset-bottom)]">
        {threads.map((thread) => (
          <button
            key={thread.id}
            onClick={() => onSelectThread(thread.id)}
            aria-label={`Select thread ${thread.name}`}
            className={`shrink-0 h-12 px-4 flex items-center justify-center gap-1.5 text-sm font-medium transition-colors border-b-2 ${
              activeZone === thread.id
                ? "border-emerald-400 text-emerald-400"
                : "border-transparent text-neutral-500"
            }`}
          >
            {thread.name}
            <span className="text-xs">{threadClipCounts.get(thread.id) ?? 0}</span>
          </button>
        ))}
        <button
          onClick={onCreateThread}
          disabled={!canCreateThread}
          className="shrink-0 h-12 px-4 text-lg text-neutral-400 disabled:opacity-40"
        >
          +
        </button>
      </div>
      <SecretPrompt
        canClear={Boolean(unlockSecret) || Boolean(secretHandle)}
        initialSecret={secretHandle?.mode === "normal" ? secretHandle.secret : unlockSecret}
        mode={secretPromptMode ?? "required"}
        onCancel={onSecretCancel}
        onClear={onForgetSecret}
        onSubmit={onSecretSubmit}
        onSubmitParanoid={onSecretSubmitParanoid}
        paranoidAvailable={paranoidAvailable}
        open={secretPromptMode !== null}
      />
    </div>
  );
}
