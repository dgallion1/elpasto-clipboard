"use client";

import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { ClipCard } from "../ClipCard";
import { ComposeField } from "./ComposeField";
import type { PasteZoneProps, ImportSessionsResult } from "./types";
import type { ImportEntry } from "@/hooks/useSessionHistory";

interface PasteZoneContentProps extends PasteZoneProps {
  isFocused: boolean;
  isHidden: boolean;
  error: string | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  isClearing: boolean;
  isDragOver: boolean;
  clearZone: () => Promise<void>;
  handlePaste: (event: React.ClipboardEvent) => void;
  submitTextClip: (text: string) => void;
  readClipboard: () => Promise<void>;
  handleDrop: (event: React.DragEvent) => void;
  handleDragOver: (event: React.DragEvent) => void;
  handleDragLeave: () => void;
  handleFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  openFilePicker: () => void;
  pendingImport: ImportEntry[] | null;
  isImporting: boolean;
  importResult: ImportSessionsResult | null;
  onConfirmImport: () => void;
  onCancelImport: () => void;
}

export function PasteZoneContent({
  zone,
  threadName,
  clips,
  token,
  expiresAt,
  canCopyImage,
  getDirectClipCiphertext,
  getSendProgress,
  getTransferStats,
  readyPeerCount,
  unlockSecret,
  secretHandle,
  requestUnlockSecret,
  onClipDeleted,
  onUpdateClipContent,
  onFocusZone,
  isFocused,
  isHidden,
  subscribeToSendProgress,
  subscribeToDirectTransfers,
  error,
  fileInputRef,
  isClearing,
  isDragOver,
  clearZone,
  handlePaste,
  submitTextClip,
  readClipboard,
  handleDrop,
  handleDragOver,
  handleDragLeave,
  handleFileSelect,
  openFilePicker,
  pendingImport,
  isImporting,
  importResult,
  onConfirmImport,
  onCancelImport,
}: PasteZoneContentProps) {
  const zoneRef = useRef<HTMLDivElement>(null);

  // On mobile, the focused zone listens for document-level paste events
  // because mobile browsers don't reliably focus divs on tap, so the
  // onPaste handler on the div never fires.
  useEffect(() => {
    if (!isFocused) return;
    const handler = (e: ClipboardEvent) => {
      if (zoneRef.current?.contains(e.target as Node)) return;
      if ((e.target as Element)?.closest?.('[role="dialog"]')) return;
      handlePaste(e as unknown as React.ClipboardEvent);
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [isFocused, handlePaste]);

  const handleZoneToggle = () => {
    if (
      isFocused
      && typeof window !== "undefined"
      && window.matchMedia("(max-width: 767px)").matches
    ) {
      onFocusZone(zone);
      return;
    }

    onFocusZone(isFocused ? null : zone);
  };

  return (
    <div
      ref={zoneRef}
      className={`flex flex-col flex-1 min-w-0 min-h-0 rounded-lg transition-colors focus:ring-2 focus:ring-blue-500/40 focus:outline-none ${
        isHidden ? "hidden" : ""
      } ${
        isDragOver
          ? "ring-2 ring-blue-500/50 bg-blue-500/5"
          : "bg-neutral-900/30"
      }`}
      aria-label={`Thread ${threadName ?? zone} — Paste, drop, or upload content`}
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      tabIndex={0}
    >
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          onClick={handleZoneToggle}
          className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-neutral-600 hover:text-neutral-400 transition-colors md:pointer-events-none md:hover:text-neutral-600"
        >
          {isFocused && <span className="hidden">&larr;</span>}
          <span>Thread {threadName ?? zone}</span>
          {clips.length > 0 && <span className="text-neutral-700">{clips.length}</span>}
          {!isFocused && <span className="hidden">&#x25B8;</span>}
        </button>
        <div className="flex items-center gap-2">
          {clips.length > 0 && (
            <button
              onClick={() => void clearZone()}
              disabled={isClearing}
              className="px-2 py-1 text-xs bg-neutral-800 hover:bg-red-900/60 rounded text-neutral-400 hover:text-red-300 transition-colors disabled:opacity-50"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => void readClipboard()}
            className="px-2 py-1 text-xs bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-400 transition-colors md:hidden"
          >
            Paste
          </button>
          <button
            onClick={openFilePicker}
            className="px-2 py-1 text-xs bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-400 transition-colors"
          >
            Upload
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>

      <div className="p-3 pb-2 space-y-2">
        <ComposeField
          zone={zone}
          threadName={threadName}
          onSubmitText={submitTextClip}
          onPaste={handlePaste}
          onFocusZone={onFocusZone}
        />
        {pendingImport !== null && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-emerald-700 bg-emerald-950/40 px-3 py-2 text-sm">
            <span className="text-emerald-300">
              Found {pendingImport.length} {pendingImport.length === 1 ? "session" : "sessions"}. Import into history?
            </span>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={onConfirmImport}
                disabled={isImporting}
                className="px-2 py-0.5 rounded text-xs bg-emerald-700 hover:bg-emerald-600 text-white transition-colors disabled:opacity-50"
              >
                {isImporting ? "Importing..." : "Import"}
              </button>
              <button
                onClick={onCancelImport}
                disabled={isImporting}
                className="px-2 py-0.5 rounded text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-300 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {importResult !== null && (
          <div className="rounded-md border border-emerald-700 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
            {importResult.usedFallback
              ? `Imported ${importResult.importedCount} ${importResult.importedCount === 1 ? "session" : "sessions"} locally. They may remain unavailable until recreated on this server.`
              : `Imported ${importResult.importedCount} ${importResult.importedCount === 1 ? "session" : "sessions"} (${importResult.createdCount} created, ${importResult.existingCount} already existed).`}
          </div>
        )}
        {error && (
          <div className="text-sm text-red-400 bg-red-900/20 rounded p-2" role="alert">
            {error}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {clips.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-neutral-600 text-sm gap-1 py-8 select-none">
            <span className="text-neutral-500">Paste, drop, or type above</span>
            <span className="text-xs text-neutral-700">Enter to send · Ctrl+V / Cmd+V to paste</span>
          </div>
        )}
        {clips.map((clip) => (
          <ClipCard
            key={clip.id}
            clip={clip}
            token={token}
            expiresAt={expiresAt}
            canCopyImage={canCopyImage}
            getDirectClipCiphertext={getDirectClipCiphertext}
            getSendProgress={getSendProgress}
            getTransferStats={getTransferStats}
            readyPeerCount={readyPeerCount}
            unlockSecret={unlockSecret}
            secretHandle={secretHandle}
            requestUnlockSecret={requestUnlockSecret}
            onDelete={onClipDeleted}
            onUpdateContent={onUpdateClipContent}
            subscribeToSendProgress={subscribeToSendProgress}
            subscribeToDirectTransfers={subscribeToDirectTransfers}
          />
        ))}
      </div>
    </div>
  );
}
