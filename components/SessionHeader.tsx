"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PeerInfo } from "@/hooks/usePeerMesh";
import type { SessionEntry } from "@/hooks/useSessionHistory";
import { buildApiUrl } from "@/lib/api";
import { normalizeTokenInput } from "@/lib/token-validation";
import { getSessionUrl as buildSessionUrl } from "@/lib/session-url";
import type { SoundName, SoundVolume } from "@/hooks/useNotificationSound";
import { HelpModal } from "./HelpModal";
import { QRCodeModal } from "./QRCodeModal";
import { SoundDropdown } from "./SoundDropdown";
import { TunnelBadge } from "./TunnelBadge";
import type { TunnelInfo } from "@/hooks/useTunnelRelay";

interface SessionHistoryProps {
  entries: SessionEntry[];
  add: (token: string) => void;
  setLabel: (token: string, label: string) => void;
  togglePin: (token: string) => void;
  remove: (token: string) => void;
}

interface SessionHeaderProps {
  token: string;
  hasUnlockSecret: boolean;
  secretMode?: "normal" | "paranoid" | null;
  directPeerCount: number;
  localPeerId: string;
  peerNames: Record<string, string>;
  peers: PeerInfo[];
  totalClips: number;
  sessionHistory: SessionHistoryProps;
  onRenamePeer: (peerId: string, name: string) => void;
  onPingPeer: (peerId: string) => void;
  onManageSecret: () => void;
  onForgetSecret: () => void;
  onClearAll: () => Promise<void>;
  onExportSessions: () => void;
  tunnels: TunnelInfo[];
  swReady: boolean;
  onOpenTunnel: (peerId: string) => void;
  onRemoveTunnel: (peerId: string) => void;
  sound?: {
    enabled: boolean;
    soundName: SoundName;
    volume: SoundVolume;
    onSetEnabled: (enabled: boolean) => void;
    onSetSoundName: (name: SoundName) => void;
    onCycleVolume: () => void;
  };
}

function channelDot(state: PeerInfo["channelState"]): string {
  if (state === "open") return "bg-emerald-400";
  if (state === "connecting") return "bg-yellow-400";
  return "bg-neutral-500";
}

function channelLabel(state: PeerInfo["channelState"]): string {
  if (state === "none") return "negotiating";
  return state;
}

function peerDisplayName(peer: PeerInfo, peerNames: Record<string, string>, isLocal: boolean): string {
  const customName = peerNames[peer.peerId];
  if (customName) return customName;
  if (isLocal) return "you";
  return peer.peerId.slice(0, 8);
}

function peerDisplayId(peerId: string): string {
  return peerId.slice(0, 8);
}

type AliveStatus = boolean | "checking" | undefined;

export function SessionHeader({
  token,
  hasUnlockSecret,
  secretMode,
  directPeerCount,
  localPeerId,
  peerNames,
  peers,
  totalClips,
  sessionHistory,
  onRenamePeer,
  onPingPeer,
  onManageSecret,
  onForgetSecret,
  onClearAll,
  onExportSessions,
  tunnels,
  swReady,
  onOpenTunnel,
  onRemoveTunnel,
  sound,
}: SessionHeaderProps) {
  const router = useRouter();
  const { entries, add, setLabel, togglePin, remove } = sessionHistory;

  const [copied, setCopied] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const clearConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  // Peer dropdown state
  const [peerListOpen, setPeerListOpen] = useState(false);
  const peerListRef = useRef<HTMLDivElement>(null);
  const [editingPeerId, setEditingPeerId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  // Session dropdown state
  const [sessionListOpen, setSessionListOpen] = useState(false);
  const sessionListRef = useRef<HTMLDivElement>(null);
  const [editingSessionToken, setEditingSessionToken] = useState<string | null>(null);
  const [sessionLabelValue, setSessionLabelValue] = useState("");
  const sessionLabelInputRef = useRef<HTMLInputElement>(null);
  const [aliveStatus, setAliveStatus] = useState<Record<string, AliveStatus>>({});
  const [addingSession, setAddingSession] = useState(false);
  const [addTokenValue, setAddTokenValue] = useState("");
  const addTokenInputRef = useRef<HTMLInputElement>(null);

  // Shared outside-click handler
  useEffect(() => {
    if (!peerListOpen && !sessionListOpen) return;
    const handleClick = (e: MouseEvent) => {
      const inPeer = peerListRef.current?.contains(e.target as Node);
      const inSession = sessionListRef.current?.contains(e.target as Node);
      if (!inPeer && peerListOpen) {
        setPeerListOpen(false);
        setEditingPeerId(null);
      }
      if (!inSession && sessionListOpen) {
        setSessionListOpen(false);
        setEditingSessionToken(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [peerListOpen, sessionListOpen]);

  useEffect(() => {
    if (peers.length === 0) {
      setPeerListOpen(false);
      setEditingPeerId(null);
    }
  }, [peers.length]);

  useEffect(() => {
    if (editingPeerId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingPeerId]);

  useEffect(() => {
    if (editingSessionToken && sessionLabelInputRef.current) {
      sessionLabelInputRef.current.focus();
      sessionLabelInputRef.current.select();
    }
  }, [editingSessionToken]);

  useEffect(() => {
    if (addingSession && addTokenInputRef.current) {
      addTokenInputRef.current.focus();
    }
  }, [addingSession]);

  // Probe session alive status when menu opens
  useEffect(() => {
    if (!sessionListOpen) {
      setAliveStatus({});
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    // Current session is immediately alive
    setAliveStatus({ [token]: true });

    const otherEntries = entries.filter((e) => e.token !== token);
    if (otherEntries.length === 0) return;

    // Mark all others as checking
    setAliveStatus((prev) => {
      const next = { ...prev };
      for (const e of otherEntries) {
        next[e.token] = "checking";
      }
      return next;
    });

    for (const entry of otherEntries) {
      fetch(buildApiUrl(`/api/sessions/${entry.token}`), {
        method: "GET",
        cache: "no-store",
        signal,
      })
        .then((res) => {
          if (signal.aborted) return;
          setAliveStatus((prev) => ({ ...prev, [entry.token]: res.ok }));
        })
        .catch(() => {
          if (signal.aborted) return;
          setAliveStatus((prev) => ({ ...prev, [entry.token]: false }));
        });
    }

    return () => controller.abort();
  }, [sessionListOpen, entries, token]);

  const getSessionUrl = useCallback(() => buildSessionUrl(token), [token]);

  const clearAll = useCallback(async () => {
    if (!clearConfirm) {
      setClearConfirm(true);
      if (clearConfirmTimer.current) clearTimeout(clearConfirmTimer.current);
      clearConfirmTimer.current = setTimeout(() => setClearConfirm(false), 3000);
      return;
    }
    setClearConfirm(false);
    if (clearConfirmTimer.current) clearTimeout(clearConfirmTimer.current);
    setIsClearing(true);
    setClearError(null);
    try {
      await onClearAll();
    } catch {
      setClearError("Failed to clear");
      setTimeout(() => setClearError(null), 3000);
    } finally {
      setIsClearing(false);
    }
  }, [onClearAll, clearConfirm]);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(getSessionUrl());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const startEditing = (peerId: string) => {
    setEditingPeerId(peerId);
    setEditValue(peerNames[peerId] || "");
  };

  const commitEdit = () => {
    if (editingPeerId) {
      const trimmed = editValue.trim();
      if (trimmed) {
        onRenamePeer(editingPeerId, trimmed);
      }
      setEditingPeerId(null);
    }
  };

  const openSessionMenu = () => {
    setSessionListOpen((v) => !v);
    setPeerListOpen(false);
    setEditingPeerId(null);
  };

  const openPeerMenu = () => {
    setPeerListOpen((v) => !v);
    setSessionListOpen(false);
    setEditingSessionToken(null);
  };

  const commitSessionLabel = () => {
    if (editingSessionToken) {
      setLabel(editingSessionToken, sessionLabelValue);
      setEditingSessionToken(null);
    }
  };

  const startSessionLabelEdit = (entry: SessionEntry) => {
    setEditingSessionToken(entry.token);
    setSessionLabelValue(entry.label ?? "");
  };

  const commitAddSession = () => {
    const normalized = normalizeTokenInput(addTokenValue);
    if (normalized && /^[a-z]+(-[a-z]+)*$/.test(normalized)) {
      add(normalized);
    }
    setAddTokenValue("");
    setAddingSession(false);
  };

  const navigateToSession = (t: string) => {
    setSessionListOpen(false);
    router.push(`/${t}`);
  };

  function statusDot(status: AliveStatus): string {
    if (status === true) return "bg-emerald-400";
    if (status === false) return "bg-red-500";
    return "bg-neutral-500 animate-pulse";
  }

  // Build list: local peer first, then remote peers
  const allPeers: Array<PeerInfo & { isLocal: boolean }> = [
    { peerId: localPeerId, channelState: "open" as const, hasTunnel: false, name: peerNames[localPeerId], isLocal: true },
    ...peers.map((p) => ({ ...p, isLocal: false })),
  ];

  const hasOtherSessions = entries.some((e) => e.token !== token);

  return (
    <header className="flex flex-col gap-3 border-b border-neutral-800 bg-neutral-900 px-4 py-3 md:flex-row md:items-center md:justify-between">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/" className="text-lg font-semibold text-neutral-100 hover:text-white">elPasto</Link>

        {/* Session switcher */}
        <div className="relative" ref={sessionListRef}>
          <button
            onClick={openSessionMenu}
            aria-haspopup="menu"
            aria-expanded={sessionListOpen}
            aria-label="Session menu"
            className="text-sm text-neutral-400 font-mono hover:text-neutral-200 transition-colors cursor-pointer"
          >
            {token}
            <span className="ml-1 text-neutral-600">▾</span>
          </button>
          {sessionListOpen && (
            <div
              role="menu"
              className="absolute top-full left-0 mt-1 z-20 rounded-md border border-neutral-700 bg-neutral-800 p-1.5 shadow-lg min-w-[240px] max-w-[320px]"
            >
              {entries.map((entry) => {
                const isCurrent = entry.token === token;
                const status = isCurrent ? true : aliveStatus[entry.token];
                return (
                  <div
                    key={entry.token}
                    className={`group flex items-start gap-1.5 rounded px-1.5 py-1 ${isCurrent ? "bg-neutral-700/60" : "hover:bg-neutral-700/30"}`}
                  >
                    {/* Status dot */}
                    <span
                      className={`mt-1 h-2 w-2 shrink-0 rounded-full ${statusDot(status)}`}
                      title={status === true ? "alive" : status === false ? "unreachable" : "checking"}
                    />

                    {/* Label / token + nav */}
                    <button
                      className="min-w-0 flex-1 text-left"
                      disabled={isCurrent}
                      onClick={() => !isCurrent && navigateToSession(entry.token)}
                    >
                      {entry.label && (
                        <span className="block text-xs text-neutral-200 truncate">{entry.label}</span>
                      )}
                      <span className={`block font-mono text-[11px] ${entry.label ? "text-neutral-500" : "text-neutral-300"} truncate`}>
                        {entry.token}
                      </span>
                    </button>

                    {/* Controls */}
                    <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {/* Pin */}
                      <button
                        onClick={(e) => { e.stopPropagation(); togglePin(entry.token); }}
                        className={`px-1 py-0 rounded text-[10px] transition-colors cursor-pointer ${entry.pinned ? "text-amber-400 hover:text-amber-300" : "text-neutral-500 hover:text-neutral-300"}`}
                        title={entry.pinned ? "Unpin" : "Pin"}
                        aria-label={entry.pinned ? `Unpin ${entry.token}` : `Pin ${entry.token}`}
                      >
                        {entry.pinned ? "★" : "☆"}
                      </button>

                      {/* Edit label */}
                      {editingSessionToken === entry.token ? (
                        <input
                          ref={sessionLabelInputRef}
                          type="text"
                          value={sessionLabelValue}
                          onChange={(e) => setSessionLabelValue(e.target.value)}
                          onBlur={commitSessionLabel}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitSessionLabel();
                            if (e.key === "Escape") setEditingSessionToken(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="bg-neutral-900 border border-neutral-600 rounded px-1 py-0 text-[10px] text-neutral-200 w-24 outline-none focus:border-emerald-500"
                          maxLength={40}
                          placeholder="label…"
                        />
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); startSessionLabelEdit(entry); }}
                          className="px-1 py-0 rounded text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer"
                          title="Edit label"
                          aria-label={`Edit label for ${entry.token}`}
                        >
                          ✎
                        </button>
                      )}

                      {/* Remove — hidden for the session you're currently viewing */}
                      {!isCurrent && (
                        <button
                          onClick={(e) => { e.stopPropagation(); remove(entry.token); }}
                          className="px-1 py-0 rounded text-[10px] text-neutral-500 hover:text-red-400 transition-colors cursor-pointer"
                          title="Remove from list"
                          aria-label={`Remove ${entry.token}`}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {entries.length === 0 && (
                <p className="px-2 py-1 text-xs text-neutral-500">No sessions saved</p>
              )}
              {/* Footer actions */}
              <div className="border-t border-neutral-700 mt-1 pt-1">
                {addingSession ? (
                  <div className="flex items-center gap-1 px-1.5">
                    <input
                      ref={addTokenInputRef}
                      type="text"
                      value={addTokenValue}
                      onChange={(e) => setAddTokenValue(e.target.value)}
                      onBlur={commitAddSession}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitAddSession();
                        if (e.key === "Escape") { setAddingSession(false); setAddTokenValue(""); }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 bg-neutral-900 border border-neutral-600 rounded px-1.5 py-0.5 text-[11px] font-mono text-neutral-200 outline-none focus:border-emerald-500"
                      placeholder="paste token…"
                    />
                  </div>
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); setAddingSession(true); }}
                    className="w-full text-left px-1.5 py-0.5 text-[11px] text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer"
                    aria-label="Add session"
                  >
                    + add session
                  </button>
                )}
                {hasOtherSessions && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onExportSessions(); setSessionListOpen(false); }}
                    className="w-full text-left px-1.5 py-0.5 text-[11px] text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer"
                    aria-label="Export sessions"
                  >
                    ↓ export sessions
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {(secretMode === "paranoid" || hasUnlockSecret || secretMode === "normal") && (
          <span className="rounded-full border border-emerald-900 bg-emerald-950/60 px-2 py-0.5 text-xs text-emerald-300 flex items-center gap-1">
            {secretMode === "paranoid" ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-sky-400" aria-label="Paranoid encryption">
                <path fillRule="evenodd" d="M9.661 2.237a.531.531 0 0 1 .678 0 11.947 11.947 0 0 0 7.078 2.749.5.5 0 0 1 .479.425c.069.52.104 1.05.104 1.589 0 5.162-3.26 9.563-7.834 11.256a.48.48 0 0 1-.332 0C5.26 16.563 2 12.163 2 7c0-.538.035-1.069.104-1.589a.5.5 0 0 1 .48-.425 11.947 11.947 0 0 0 7.077-2.75Zm4.196 5.954a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5 text-amber-400" aria-label="Encrypted">
                <path fillRule="evenodd" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z" clipRule="evenodd" />
              </svg>
            )}
            Secret active
          </span>
        )}
        {peers.length > 0 && (
          <div className="relative" ref={peerListRef}>
            <button
              onClick={openPeerMenu}
              className="rounded-full border border-emerald-900 bg-emerald-950/60 px-2 py-0.5 text-xs text-emerald-300 hover:bg-emerald-900/40 transition-colors cursor-pointer"
            >
              {directPeerCount === 1
                ? "1 direct peer"
                : `${directPeerCount} direct peers`}
            </button>
            {peerListOpen && (
              <div className="absolute top-full left-0 mt-1 z-10 rounded-md border border-neutral-700 bg-neutral-800 p-2 text-xs shadow-lg min-w-[200px]">
                {allPeers.map((p) => (
                  <div key={p.peerId} className="flex items-center gap-2 py-0.5 group">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${channelDot(p.channelState)}`} />
                    {editingPeerId === p.peerId ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit();
                          if (e.key === "Escape") setEditingPeerId(null);
                        }}
                        className="bg-neutral-900 border border-neutral-600 rounded px-1 py-0 text-xs text-neutral-200 w-24 outline-none focus:border-emerald-500"
                        maxLength={20}
                      />
                    ) : (
                      <button
                        onClick={() => startEditing(p.peerId)}
                        className="min-w-0 text-left hover:text-emerald-300 transition-colors cursor-pointer"
                        title="Click to rename"
                      >
                        <span className="block font-mono text-neutral-300">
                          {peerDisplayName(p, peerNames, p.isLocal)}
                        </span>
                        <span className="block font-mono text-[10px] text-neutral-500">
                          id {peerDisplayId(p.peerId)}
                        </span>
                      </button>
                    )}
                    {!p.isLocal && p.channelState === "open" && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onPingPeer(p.peerId); }}
                        className="ml-auto px-1.5 py-0 rounded text-[10px] text-neutral-400 hover:text-emerald-300 hover:bg-emerald-950/40 transition-colors cursor-pointer"
                        title="Ping this device"
                      >
                        ping
                      </button>
                    )}
                    {!p.isLocal && (
                      <span className="text-neutral-500">{channelLabel(p.channelState)}</span>
                    )}
                    {p.isLocal && (
                      <span className="text-neutral-600 italic">this device</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <TunnelBadge
          tunnels={tunnels}
          swReady={swReady}
          peerNames={peerNames}
          onOpen={onOpenTunnel}
          onRemove={onRemoveTunnel}
          onShowHelp={() => setHelpOpen(true)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
        <button
          onClick={copyUrl}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            copied
              ? "bg-emerald-600 text-white"
              : "bg-blue-600 text-white hover:bg-blue-500"
          }`}
        >
          {copied ? "Copied!" : "Copy URL"}
        </button>
        <button
          onClick={() => setQrOpen(true)}
          className="rounded-md bg-neutral-800 px-2.5 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-neutral-100"
          aria-label="QR"
          title="Show QR code"
        >
          QR
        </button>
        <button
          onClick={copyToken}
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
            tokenCopied
              ? "bg-emerald-600 text-white"
              : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800"
          }`}
        >
          {tokenCopied ? "Copied!" : "Copy Token"}
        </button>
        <span className="hidden md:inline w-px h-5 bg-neutral-800" />
        <button
          onClick={onManageSecret}
          className="rounded-md px-3 py-1.5 text-sm text-neutral-400 transition-colors hover:text-neutral-200 hover:bg-neutral-800"
        >
          {(hasUnlockSecret || secretMode === "paranoid") ? "Manage Secret" : "Set Secret"}
        </button>
        {(hasUnlockSecret || secretMode === "paranoid") && (
          <button
            onClick={onForgetSecret}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-300 hover:bg-neutral-800"
          >
            Forget Secret
          </button>
        )}
        {totalClips > 0 && (
          <button
            onClick={clearAll}
            disabled={isClearing}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
              clearConfirm
                ? "bg-red-900/40 text-red-400 hover:bg-red-900/60"
                : "text-neutral-500 hover:bg-red-900/40 hover:text-red-400"
            }`}
          >
            {clearConfirm ? "Confirm Clear All?" : "Clear All"}
          </button>
        )}
        {sound && (
          <SoundDropdown
            enabled={sound.enabled}
            soundName={sound.soundName}
            volume={sound.volume}
            onSetEnabled={sound.onSetEnabled}
            onSetSoundName={sound.onSetSoundName}
            onCycleVolume={sound.onCycleVolume}
          />
        )}
        <button
          onClick={() => setHelpOpen(true)}
          className="rounded-md px-2 py-1.5 text-sm text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-300"
          aria-label="Help"
        >
          ?
        </button>
        {clearError && (
          <span className="text-xs text-red-400">{clearError}</span>
        )}
      </div>
      <QRCodeModal open={qrOpen} onClose={() => setQrOpen(false)} url={qrOpen ? getSessionUrl() : ""} />
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </header>
  );
}
