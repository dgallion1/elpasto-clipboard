"use client";

import { useCallback, useState } from "react";
import { EncryptedPreview, PlainPreview } from "./clip-card/previews";
import type { ClipCardProps } from "./clip-card/types";
import { useClipCardController } from "./clip-card/useClipCardController";
import { updateClipNote } from "@/lib/clip-store";

export function ClipCard(props: ClipCardProps) {
  const {
    awaitingDirectTransfer,
    copyState,
    decryptError,
    decryptedFileBlob,
    decryptedHtml,
    decryptedImageUrl,
    decryptedText,
    deleteError,
    fileReadyState,
    fileUrl,
    handleCopy,
    handleDelete,
    handleDownload,
    handleUnlock,
    isDecrypting,
    isDownloading,
    localFile,
    localImageUrl,
    peerAvailableForTransfer,
    remaining,
    sendProgress,
    showDownloadButton,
    transferStats,
    unlockSecret,
  } = useClipCardController(props);
  const { canCopyImage, clip } = props;

  const isSenderFile = clip.local_only && clip.local_origin === "sender"
    && (clip.kind === "file" || clip.kind === "image");
  const isEditableClip = clip.local_only === true
    && clip.local_origin === "sender"
    && (clip.kind === "text" || clip.kind === "html")
    && Boolean(props.onUpdateContent)
    && (!clip.encrypted || Boolean(props.secretHandle || unlockSecret));
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [noteText, setNoteText] = useState(clip.note || "");
  const [savedNote, setSavedNote] = useState(clip.note || null);
  const [isEditingContent, setIsEditingContent] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [editingBaseline, setEditingBaseline] = useState("");
  const [isSavingContent, setIsSavingContent] = useState(false);
  const [contentSaveError, setContentSaveError] = useState<string | null>(null);

  const saveNote = useCallback(async (text: string) => {
    const trimmed = text.trim();
    const note = trimmed || null;
    setSavedNote(note);
    setNoteText(trimmed);
    setIsEditingNote(false);
    if (clip.client_transfer_id) {
      await updateClipNote(clip.client_transfer_id, props.token, note);
    }
  }, [clip.client_transfer_id, props.token]);

  const loadCommittedContent = useCallback(async () => {
    if (localFile && (clip.kind === "text" || clip.kind === "html")) {
      const raw = await localFile.text();
      if (clip.kind === "html") {
        try {
          const parsed = JSON.parse(raw) as { text?: string };
          return parsed.text ?? "";
        } catch {
          return raw;
        }
      }
      return raw;
    }

    return decryptedText ?? clip.text_content ?? "";
  }, [clip.kind, clip.text_content, decryptedText, localFile]);

  const beginContentEdit = useCallback(() => {
    if (!isEditableClip || isSavingContent) {
      return;
    }
    setContentSaveError(null);
    void loadCommittedContent().then((nextContent) => {
      setDraftContent(nextContent);
      setEditingBaseline(nextContent);
      setIsEditingContent(true);
    }).catch(() => {
      // Don't enter edit mode — we can't read the content, so opening an
      // empty textarea risks the user accidentally saving empty content.
    });
  }, [isEditableClip, isSavingContent, loadCommittedContent]);

  const cancelContentEdit = useCallback(() => {
    setDraftContent(editingBaseline);
    setContentSaveError(null);
    setIsEditingContent(false);
  }, [editingBaseline]);

  const saveContent = useCallback(async () => {
    if (
      !isEditableClip ||
      !props.onUpdateContent ||
      !clip.client_transfer_id ||
      isSavingContent
    ) {
      return;
    }
    if (draftContent === editingBaseline) {
      setContentSaveError(null);
      setIsEditingContent(false);
      return;
    }

    setIsSavingContent(true);
    setContentSaveError(null);
    try {
      await props.onUpdateContent({
        transferId: clip.client_transfer_id,
        kind: clip.kind as "text" | "html",
        text: draftContent,
      });
      setEditingBaseline(draftContent);
      setIsEditingContent(false);
    } catch (error) {
      setContentSaveError(error instanceof Error ? error.message : "Save failed");
    } finally {
      setIsSavingContent(false);
    }
  }, [
    clip.client_transfer_id,
    clip.kind,
    draftContent,
    editingBaseline,
    isEditableClip,
    isSavingContent,
    props.onUpdateContent,
  ]);

  const displayClip = savedNote !== clip.note ? { ...clip, note: savedNote } : clip;

  return (
    <div className="group rounded-lg border border-neutral-700 bg-neutral-800 p-3 transition-colors hover:border-neutral-600">
      <div className="mb-1 min-h-[2rem]">
        {clip.encrypted ? (
          <EncryptedPreview
            awaitingDirectTransfer={awaitingDirectTransfer}
            clip={displayClip}
            decryptError={decryptError}
            decryptedFileBlob={decryptedFileBlob}
            decryptedHtml={decryptedHtml}
            decryptedImageUrl={decryptedImageUrl}
            decryptedText={decryptedText}
            fileReadyState={fileReadyState}
            isDecrypting={isDecrypting}
            onDownload={handleDownload}
            onUnlock={handleUnlock}
            peerAvailableForTransfer={peerAvailableForTransfer}
            transferStats={transferStats}
            unlockSecret={unlockSecret}
            hasSecret={Boolean(unlockSecret || props.secretHandle)}
            canEditContent={isEditableClip}
            draftContent={draftContent}
            isEditingContent={isEditingContent}
            isSavingContent={isSavingContent}
            onBeginEdit={beginContentEdit}
            onDraftContentChange={setDraftContent}
            onSaveContent={saveContent}
            onCancelContent={cancelContentEdit}
          />
        ) : (
          <PlainPreview
            clip={displayClip}
            fileUrl={fileUrl}
            localImageUrl={localImageUrl}
            directImageUrl={decryptedImageUrl}
            decryptedFileBlob={decryptedFileBlob}
            localFile={localFile}
            decryptedText={decryptedText}
            decryptedHtml={decryptedHtml}
            onDownload={handleDownload}
            awaitingDirectTransfer={awaitingDirectTransfer}
            peerAvailableForTransfer={peerAvailableForTransfer}
            transferStats={transferStats}
            canEditContent={isEditableClip}
            draftContent={draftContent}
            isEditingContent={isEditingContent}
            isSavingContent={isSavingContent}
            onBeginEdit={beginContentEdit}
            onDraftContentChange={setDraftContent}
            onSaveContent={saveContent}
            onCancelContent={cancelContentEdit}
          />
        )}
      </div>

      {contentSaveError && (
        <div className="mb-2 text-xs text-red-400" role="alert">
          {contentSaveError}
        </div>
      )}

      {isSenderFile && isEditingNote && (
        <div className="mb-1">
          <input
            type="text"
            className="w-full rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 placeholder-neutral-600 outline-none focus:border-neutral-500"
            placeholder="Add a note for the recipient..."
            value={noteText}
            autoFocus
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveNote(noteText);
              if (e.key === "Escape") { setIsEditingNote(false); setNoteText(savedNote || ""); }
            }}
            onBlur={() => void saveNote(noteText)}
          />
        </div>
      )}

      {isSenderFile &&
        sendProgress != null && (
          <div className="mb-3 space-y-1">
            <div className="flex items-center justify-between gap-3 text-xs text-neutral-400">
              <span className="min-w-0 truncate">Sending...</span>
              <span className="shrink-0">{Math.round(sendProgress * 100)}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-neutral-700">
              <div
                className="h-full rounded-full bg-emerald-500 transition-[width] duration-150"
                style={{ width: `${Math.round(sendProgress * 100)}%` }}
              />
            </div>
          </div>
        )}

      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 font-mono text-neutral-500">
          {clip.encrypted && clip.encryption_version === 2 ? (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3 text-sky-400" aria-label="Paranoid encryption">
              <title>Encrypted with paranoid mode (HKDF-SHA256)</title>
              <path fillRule="evenodd" d="M9.661 2.237a.531.531 0 0 1 .678 0 11.947 11.947 0 0 0 7.078 2.749.5.5 0 0 1 .479.425c.069.52.104 1.05.104 1.589 0 5.162-3.26 9.563-7.834 11.256a.48.48 0 0 1-.332 0C5.26 16.563 2 12.163 2 7c0-.538.035-1.069.104-1.589a.5.5 0 0 1 .48-.425 11.947 11.947 0 0 0 7.077-2.75Zm4.196 5.954a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />
            </svg>
          ) : clip.encrypted ? (
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-3 w-3 text-amber-500/70"
              aria-label="Encrypted"
            >
              <title>Encrypted (AES-GCM)</title>
              <path
                fillRule="evenodd"
                d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z"
                clipRule="evenodd"
              />
            </svg>
          ) : null}
          {remaining}
        </span>
        <div className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
          {isSenderFile && !isEditingNote && !savedNote && (
            <button
              className="rounded bg-neutral-700 px-2 py-1 text-neutral-500 transition-colors hover:bg-neutral-600 hover:text-neutral-300"
              onClick={() => setIsEditingNote(true)}
            >
              + Note
            </button>
          )}
          {deleteError && (
            <span className="text-red-400" role="alert">
              Delete failed
            </span>
          )}
          {copyState && <span className="text-green-400">{copyState}</span>}
          {clip.kind !== "file" && (
            <button
              onClick={handleCopy}
              className="rounded bg-neutral-700 px-2 py-1 text-neutral-300 transition-colors hover:bg-neutral-600 disabled:cursor-not-allowed disabled:text-neutral-500"
              title={
                clip.kind === "image" && !canCopyImage
                  ? "Image copy not supported in this browser"
                  : "Copy"
              }
              disabled={
                (clip.kind === "image" && !canCopyImage) || awaitingDirectTransfer
              }
            >
              Copy
            </button>
          )}
          {showDownloadButton && (
            <button
              onClick={handleDownload}
              className="rounded bg-neutral-700 px-2 py-1 text-neutral-300 transition-colors hover:bg-neutral-600 disabled:cursor-not-allowed disabled:text-neutral-500"
              disabled={isDownloading || awaitingDirectTransfer}
            >
              {clip.encrypted
                ? isDownloading
                  ? "Decrypting..."
                  : "Decrypt & Download"
                : "Download"}
            </button>
          )}
          <button
            onClick={handleDelete}
            className="rounded bg-neutral-700 px-2 py-1 text-neutral-400 transition-colors hover:bg-red-900/50 hover:text-red-400"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
