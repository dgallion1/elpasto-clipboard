import { useRef, useState } from "react";
import type { Clip } from "@/lib/clips";
import type { TransferStats } from "@/lib/direct-transfer";
import { isValidToken, normalizeTokenInput } from "@/lib/token-validation";
import { ImageLightbox } from "@/components/ImageLightbox";
import { usePdfPreviews } from "@/hooks/usePdfPreviews";
import { useZipImagePreviews } from "@/hooks/useZipImagePreviews";
import { ZipImageCarousel } from "./ZipImageCarousel";
import type { FileReadyState } from "./types";
import {
  formatBytes,
  formatFileNote,
  formatSpeed,
  sanitizePreviewHtml,
} from "./helpers";

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
const TRAILING_LINK_PUNCTUATION = new Set([".", ",", "!", "?", ";", ":"]);

function countOccurrences(text: string, needle: string) {
  let count = 0;
  for (const char of text) {
    if (char === needle) {
      count += 1;
    }
  }
  return count;
}

function trimLinkedUrl(url: string) {
  let end = url.length;

  for (;;) {
    if (end === 0) {
      break;
    }

    const char = url[end - 1];
    if (TRAILING_LINK_PUNCTUATION.has(char)) {
      end -= 1;
      continue;
    }

    const candidate = url.slice(0, end);
    const hasUnmatchedClosingDelimiter = (
      (char === ")" && countOccurrences(candidate, ")") > countOccurrences(candidate, "("))
      || (char === "]" && countOccurrences(candidate, "]") > countOccurrences(candidate, "["))
      || (char === "}" && countOccurrences(candidate, "}") > countOccurrences(candidate, "{"))
    );
    if (hasUnmatchedClosingDelimiter) {
      end -= 1;
      continue;
    }

    break;
  }

  return {
    href: url.slice(0, end),
    trailingText: url.slice(end),
  };
}

function LinkedText({ text }: { text: string }) {
  const trimmed = text.trim();
  const normalized = normalizeTokenInput(trimmed);
  if (isValidToken(normalized)) {
    return (
      <a
        href={`/${normalized}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 underline decoration-blue-400/40 hover:text-blue-300 hover:decoration-blue-300/60"
      >
        {trimmed}
      </a>
    );
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(URL_REGEX)) {
    const url = match[0];
    const start = match.index ?? 0;
    const { href, trailingText } = trimLinkedUrl(url);
    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start));
    }
    parts.push(
      <a
        key={start}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 underline decoration-blue-400/40 hover:text-blue-300 hover:decoration-blue-300/60"
      >
        {href}
      </a>
    );
    if (trailingText) {
      parts.push(trailingText);
    }
    lastIndex = start + url.length;
  }
  if (parts.length === 0) return <>{text}</>;
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return <>{parts}</>;
}

export function PlainPreview({
  clip,
  fileUrl,
  localImageUrl,
  directImageUrl,
  decryptedFileBlob,
  localFile,
  decryptedText,
  decryptedHtml,
  onDownload,
  awaitingDirectTransfer,
  peerAvailableForTransfer,
  transferStats,
  canEditContent = false,
  draftContent = "",
  isEditingContent = false,
  isSavingContent = false,
  onBeginEdit,
  onDraftContentChange,
  onSaveContent,
  onCancelContent,
}: {
  clip: Clip;
  fileUrl: string | null;
  localImageUrl: string | null;
  directImageUrl: string | null;
  decryptedFileBlob: Blob | null;
  localFile: File | null;
  decryptedText: string | null;
  decryptedHtml: string | null;
  onDownload: () => void | Promise<void>;
  awaitingDirectTransfer: boolean;
  peerAvailableForTransfer: boolean;
  transferStats: TransferStats | null;
  canEditContent?: boolean;
  draftContent?: string;
  isEditingContent?: boolean;
  isSavingContent?: boolean;
  onBeginEdit?: () => void;
  onDraftContentChange?: (value: string) => void;
  onSaveContent?: () => void | Promise<void>;
  onCancelContent?: () => void;
}) {
  const isZip = clip.kind === "file" && clip.mime_type === "application/zip";
  const isPdf = clip.kind === "file" && clip.mime_type === "application/pdf";
  const zipPreviews = useZipImagePreviews(
    isZip ? (decryptedFileBlob || localFile) : null,
    isZip,
  );
  const pdfPreviews = usePdfPreviews(
    isPdf ? (decryptedFileBlob || localFile) : null,
    isPdf,
  );

  if (clip.kind === "text") {
    const text = decryptedText || clip.text_content;
    if (isEditingContent) {
      return (
        <EditableContentTextarea
          draftContent={draftContent}
          isSavingContent={isSavingContent}
          onDraftContentChange={onDraftContentChange}
          onSaveContent={onSaveContent}
          onCancelContent={onCancelContent}
        />
      );
    }
    return (
      <EditablePreviewSurface
        canEditContent={canEditContent}
        onBeginEdit={onBeginEdit}
        className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-sm text-neutral-200"
      >
        {text
          ? canEditContent
            ? text
            : <LinkedText text={text} />
          : "Loading text..."}
      </EditablePreviewSurface>
    );
  }

  if (clip.kind === "html") {
    const html = decryptedHtml || clip.html_content;
    if (isEditingContent) {
      return (
        <EditableContentTextarea
          draftContent={draftContent}
          isSavingContent={isSavingContent}
          onDraftContentChange={onDraftContentChange}
          onSaveContent={onSaveContent}
          onCancelContent={onCancelContent}
        />
      );
    }
    if (!html) {
      return (
        <p className="text-sm text-neutral-400">Loading text...</p>
      );
    }
    return (
      <EditablePreviewSurface
        canEditContent={canEditContent}
        onBeginEdit={onBeginEdit}
        className="prose prose-invert prose-sm max-h-40 overflow-y-auto text-sm text-neutral-200"
      >
        <div
          dangerouslySetInnerHTML={{
            __html: sanitizePreviewHtml(html),
          }}
        />
      </EditablePreviewSurface>
    );
  }

  const imageUrl = localImageUrl || directImageUrl || fileUrl;
  if (clip.kind === "image" && imageUrl) {
    return (
      <ZoomableImage src={imageUrl} alt={clip.original_name || "Image"} />
    );
  }

  const fileDownloadReady =
    clip.kind === "file" && (decryptedFileBlob || localFile || fileUrl);
  if (fileDownloadReady) {
    if (pdfPreviews.pages && pdfPreviews.pages.length > 0) {
      return (
        <ZipImageCarousel
          images={pdfPreviews.pages}
          isLimited={pdfPreviews.isLimited}
          zipName={clip.original_name || "PDF"}
          zipNote={formatFileNote(clip)}
          userNote={clip.note}
          onDownload={onDownload}
        />
      );
    }
    if (zipPreviews.images && zipPreviews.images.length > 0) {
      return (
        <ZipImageCarousel
          images={zipPreviews.images}
          isLimited={zipPreviews.isLimited}
          zipName={clip.original_name || "Archive"}
          zipNote={formatFileNote(clip)}
          userNote={clip.note}
          onDownload={onDownload}
        />
      );
    }
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-neutral-700 bg-neutral-900/70 px-3 py-2">
        <FileSummary
          label={clip.original_name || "File"}
          note={formatFileNote(clip)}
          userNote={clip.note}
        />
        <button
          onClick={onDownload}
          className="shrink-0 rounded bg-blue-700 px-3 py-1.5 text-sm text-neutral-100 transition-colors hover:bg-blue-600"
        >
          Download
        </button>
      </div>
    );
  }

  if (awaitingDirectTransfer) {
    const directTransferFailed = clip.local_transfer_state === "failed";
    const label = clip.kind === "image" ? "Image" : "File";
    return (
      <div className="space-y-2 rounded-md border border-dashed border-neutral-700 bg-neutral-900/70 px-3 py-2">
        <FileSummary
          label={clip.original_name || label}
          note={formatFileNote(clip)}
          userNote={clip.note}
        />
        {transferStats && (
          <div className="space-y-1">
            <ProgressHeader
              label={`Receiving... ${formatBytes(transferStats.bytesReceived)} / ${formatBytes(transferStats.totalBytes)}`}
              detail={`${formatSpeed(transferStats.speedBps)} · ${Math.round(transferStats.progress * 100)}%`}
              progress={transferStats.progress}
            />
            <ProgressBar
              progress={transferStats.progress}
              accentClassName="bg-blue-500"
            />
          </div>
        )}
        <p
          className={`text-sm ${directTransferFailed ? "text-red-400" : "text-neutral-400"}`}
        >
          {directTransferFailed
            ? "Direct transfer stalled before completion. Ask the sender to retry."
            : transferStats
              ? "Transferring directly from sender..."
              : peerAvailableForTransfer
                ? "Peer connected. Requesting the file..."
                : "Waiting for a peer that has this file to connect..."}
        </p>
      </div>
    );
  }

  return (
    <FileSummary
      label={clip.original_name || "File"}
      note={formatFileNote(clip)}
    />
  );
}

export function EncryptedPreview({
  awaitingDirectTransfer,
  clip,
  decryptError,
  decryptedFileBlob,
  decryptedHtml,
  decryptedImageUrl,
  decryptedText,
  fileReadyState,
  isDecrypting,
  onDownload,
  onUnlock,
  transferStats,
  peerAvailableForTransfer,
  unlockSecret,
  hasSecret,
  canEditContent = false,
  draftContent = "",
  isEditingContent = false,
  isSavingContent = false,
  onBeginEdit,
  onDraftContentChange,
  onSaveContent,
  onCancelContent,
}: {
  awaitingDirectTransfer: boolean;
  clip: Clip;
  decryptError: string | null;
  decryptedFileBlob: Blob | null;
  decryptedHtml: string | null;
  decryptedImageUrl: string | null;
  decryptedText: string | null;
  fileReadyState: FileReadyState;
  isDecrypting: boolean;
  onDownload: () => void | Promise<void>;
  onUnlock: () => void | Promise<void>;
  peerAvailableForTransfer: boolean;
  transferStats: TransferStats | null;
  unlockSecret: string | null;
  hasSecret?: boolean;
  canEditContent?: boolean;
  draftContent?: string;
  isEditingContent?: boolean;
  isSavingContent?: boolean;
  onBeginEdit?: () => void;
  onDraftContentChange?: (value: string) => void;
  onSaveContent?: () => void | Promise<void>;
  onCancelContent?: () => void;
}) {
  const isZip = clip.kind === "file" && clip.mime_type === "application/zip";
  const isPdf = clip.kind === "file" && clip.mime_type === "application/pdf";
  const zipPreviews = useZipImagePreviews(
    isZip ? decryptedFileBlob : null,
    isZip,
  );
  const pdfPreviews = usePdfPreviews(
    isPdf ? decryptedFileBlob : null,
    isPdf,
  );

  const secretAvailable = hasSecret ?? Boolean(unlockSecret);
  const directTransferFailed =
    awaitingDirectTransfer && clip.local_transfer_state === "failed";

  if (clip.kind === "text" && decryptedText !== null) {
    if (isEditingContent) {
      return (
        <EditableContentTextarea
          draftContent={draftContent}
          isSavingContent={isSavingContent}
          onDraftContentChange={onDraftContentChange}
          onSaveContent={onSaveContent}
          onCancelContent={onCancelContent}
        />
      );
    }
    return (
      <EditablePreviewSurface
        canEditContent={canEditContent}
        onBeginEdit={onBeginEdit}
        className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-sm text-neutral-200"
      >
        {canEditContent ? decryptedText : <LinkedText text={decryptedText} />}
      </EditablePreviewSurface>
    );
  }

  if (clip.kind === "html" && decryptedHtml !== null) {
    if (isEditingContent) {
      return (
        <EditableContentTextarea
          draftContent={draftContent}
          isSavingContent={isSavingContent}
          onDraftContentChange={onDraftContentChange}
          onSaveContent={onSaveContent}
          onCancelContent={onCancelContent}
        />
      );
    }
    return (
      <EditablePreviewSurface
        canEditContent={canEditContent}
        onBeginEdit={onBeginEdit}
        className="prose prose-invert prose-sm max-h-40 overflow-y-auto text-sm text-neutral-200"
      >
        <div
          dangerouslySetInnerHTML={{ __html: sanitizePreviewHtml(decryptedHtml) }}
        />
      </EditablePreviewSurface>
    );
  }

  if (clip.kind === "image" && decryptedImageUrl) {
    return (
      <ZoomableImage src={decryptedImageUrl} alt={clip.original_name || "Encrypted image"} />
    );
  }

  if (clip.kind === "file" && fileReadyState === "ready") {
    if (pdfPreviews.pages && pdfPreviews.pages.length > 0) {
      return (
        <ZipImageCarousel
          images={pdfPreviews.pages}
          isLimited={pdfPreviews.isLimited}
          zipName={clip.original_name || "PDF"}
          zipNote={formatFileNote(clip)}
          userNote={clip.note}
          onDownload={onDownload}
        />
      );
    }
    if (zipPreviews.images && zipPreviews.images.length > 0) {
      return (
        <ZipImageCarousel
          images={zipPreviews.images}
          isLimited={zipPreviews.isLimited}
          zipName={clip.original_name || "Archive"}
          zipNote={formatFileNote(clip)}
          userNote={clip.note}
          onDownload={onDownload}
        />
      );
    }
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-neutral-700 bg-neutral-900/70 px-3 py-2">
        <FileSummary
          label={clip.original_name || "File"}
          note={formatFileNote(clip)}
          userNote={clip.note}
        />
        <button
          onClick={onDownload}
          className="shrink-0 rounded bg-blue-700 px-3 py-1.5 text-sm text-neutral-100 transition-colors hover:bg-blue-600"
        >
          Download
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed border-neutral-700 bg-neutral-900/70 p-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="rounded-full border border-amber-900 bg-amber-950/60 px-2 py-0.5 text-xs text-amber-200">
          Encrypted
        </span>
        <span className="text-neutral-300">
          {clip.kind === "file" || clip.kind === "image"
            ? clip.original_name || "Encrypted file"
            : clip.kind === "html"
              ? "Locked rich text clip"
              : "Locked text clip"}
        </span>
      </div>

      {(clip.kind === "file" || clip.kind === "image") && (
        <p className="text-xs text-neutral-500">{formatFileNote(clip)}</p>
      )}

      {awaitingDirectTransfer && transferStats && (
        <div className="space-y-1">
          <ProgressHeader
            label={`Receiving... ${formatBytes(transferStats.bytesReceived)} / ${formatBytes(transferStats.totalBytes)}`}
            detail={`${formatSpeed(transferStats.speedBps)} · ${Math.round(transferStats.progress * 100)}%`}
            progress={transferStats.progress}
          />
          <ProgressBar
            progress={transferStats.progress}
            accentClassName="bg-blue-500"
          />
        </div>
      )}

      <p
        className={`text-sm ${directTransferFailed ? "text-red-400" : "text-neutral-400"}`}
      >
        {awaitingDirectTransfer
          ? directTransferFailed
            ? "Direct transfer stalled before completion. Ask the sender to retry."
            : transferStats
              ? "Transferring directly from sender..."
              : peerAvailableForTransfer
                ? "Peer connected. Requesting the encrypted file..."
                : "Waiting for a peer that has this clip to connect..."
          : isDecrypting
            ? "Decrypting in this browser..."
            : secretAvailable
              ? clip.kind === "file"
                ? fileReadyState === "decrypting"
                  ? "Decrypting file..."
                  : "File received. Decrypting..."
                : "Decrypting with the current unlock secret."
              : "Provide the unlock secret to decrypt this clip locally."}
      </p>

      {decryptError && (
        <p className="text-sm text-red-400" role="alert">
          {decryptError}
        </p>
      )}

      {!secretAvailable && !awaitingDirectTransfer && (
        <button
          onClick={onUnlock}
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 transition-colors hover:bg-neutral-700"
        >
          Unlock
        </button>
      )}
    </div>
  );
}

function EditablePreviewSurface({
  canEditContent,
  className,
  children,
  onBeginEdit,
}: {
  canEditContent: boolean;
  className: string;
  children: React.ReactNode;
  onBeginEdit?: () => void;
}) {
  if (!canEditContent) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`${className} cursor-text rounded-md border border-transparent px-1 py-0.5 transition-colors hover:border-neutral-700 hover:bg-neutral-900/60 focus:border-neutral-600 focus:outline-none`}
      onClick={() => onBeginEdit?.()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onBeginEdit?.();
        }
      }}
    >
      {children}
    </div>
  );
}

function EditableContentTextarea({
  draftContent,
  isSavingContent,
  onDraftContentChange,
  onSaveContent,
  onCancelContent,
}: {
  draftContent: string;
  isSavingContent: boolean;
  onDraftContentChange?: (value: string) => void;
  onSaveContent?: () => void | Promise<void>;
  onCancelContent?: () => void;
}) {
  const ignoreNextBlurRef = useRef(false);

  return (
    <textarea
      className="min-h-28 w-full resize-y rounded-md border border-neutral-600 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-200 outline-none transition-colors focus:border-neutral-500"
      value={draftContent}
      autoFocus
      disabled={isSavingContent}
      onChange={(event) => onDraftContentChange?.(event.target.value)}
      onBlur={() => {
        if (ignoreNextBlurRef.current) {
          ignoreNextBlurRef.current = false;
          return;
        }
        void onSaveContent?.();
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          ignoreNextBlurRef.current = true;
          void onSaveContent?.();
          event.currentTarget.blur();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          ignoreNextBlurRef.current = true;
          onCancelContent?.();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function ProgressHeader({
  label,
  detail,
  progress,
}: {
  label: string;
  detail?: string;
  progress: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-neutral-400">
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0">{detail ?? `${Math.round(progress * 100)}%`}</span>
    </div>
  );
}

function ProgressBar({
  progress,
  accentClassName,
}: {
  progress: number;
  accentClassName: string;
}) {
  return (
    <div className="h-1.5 w-full rounded-full bg-neutral-700">
      <div
        className={`h-full rounded-full transition-[width] duration-150 ${accentClassName}`}
        style={{ width: `${Math.round(progress * 100)}%` }}
      />
    </div>
  );
}

function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- blob URLs from WebRTC/IndexedDB, not optimizable */}
      <img
        src={src}
        alt={alt}
        className="max-h-48 cursor-zoom-in rounded object-contain"
        onClick={() => setOpen(true)}
      />
      {open && (
        <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function FileSummary({
  label,
  note,
  userNote,
}: {
  label: string;
  note: string;
  userNote?: string | null;
}) {
  return (
    <div className="text-sm text-neutral-300">
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <div className="text-xs text-neutral-500">{note}</div>
        {userNote && (
          <div className="mt-1 text-xs text-neutral-400 italic">{userNote}</div>
        )}
      </div>
    </div>
  );
}
