"use client";

import { useCallback } from "react";
import { ClipCryptoError } from "@/lib/clip-crypto";
import { parseSessionImportJson } from "@/hooks/useSessionHistory";
import { zipFolder } from "@/lib/zip-folder";
import type { PasteZoneActionState, PasteZoneProps } from "./types";

export interface UsePasteZoneActionsParams extends Pick<PasteZoneProps,
  "zone" | "unlockSecret" | "secretHandle" | "onClipAdded" | "onQueueLocalBinaryClip" |
  "onClearZone" | "onImportSessions"
>, PasteZoneActionState {}

export function usePasteZoneActions({
  zone,
  unlockSecret,
  secretHandle,
  onClipAdded,
  onQueueLocalBinaryClip,
  onClearZone,
  onImportSessions,
  fileInputRef,
  setError,
  setIsClearing,
  setIsDragOver,
  onSessionImportDetected,
}: UsePasteZoneActionsParams) {
  const clearError = useCallback(() => {
    setTimeout(() => setError(null), 3000);
  }, [setError]);

  const clearZone = useCallback(async () => {
    setIsClearing(true);
    try {
      await onClearZone();
    } catch {
      setError("Failed to clear clips");
      clearError();
    } finally {
      setIsClearing(false);
    }
  }, [clearError, onClearZone, setError, setIsClearing]);

  const addTextClip = useCallback(async (text: string, html?: string) => {
    try {
      const activeSecret = unlockSecret;
      const isHtml = Boolean(html);
      const transferId = crypto.randomUUID();

      const plaintext = isHtml ? JSON.stringify({ text, html }) : text;
      const file = new File(
        [new Blob([plaintext], { type: isHtml ? "application/json" : "text/plain" })],
        isHtml ? "clip.json" : "clip.txt",
        { type: isHtml ? "application/json" : "text/plain" }
      );

      const clip = await onQueueLocalBinaryClip({
        transferId,
        zone,
        file,
        kind: isHtml ? "html" : "text",
        ...(secretHandle ? { secretHandle } : activeSecret ? { secret: activeSecret } : {}),
      });

      onClipAdded(clip);
    } catch (error) {
      setError(resolveActionError(error, "Failed to add clip"));
      clearError();
    }
  }, [clearError, onClipAdded, onQueueLocalBinaryClip, secretHandle, setError, unlockSecret, zone]);

  const handleImportedSessionText = useCallback((text: string): boolean => {
    if (!onImportSessions) return false;
    const parsed = parseSessionImportJson(text);
    if (!parsed) return false;
    onSessionImportDetected(parsed);
    return true;
  }, [onImportSessions, onSessionImportDetected]);

  const addFileClip = useCallback(async (file: File) => {
    try {
      const activeSecret = unlockSecret;
      const transferId = crypto.randomUUID();
      const clip = await onQueueLocalBinaryClip({
        transferId,
        zone,
        file,
        kind: file.type.startsWith("image/") ? "image" : "file",
        ...(secretHandle ? { secretHandle } : activeSecret ? { secret: activeSecret } : {}),
      });

      onClipAdded(clip);
    } catch (error) {
      setError(resolveActionError(error, "Failed to upload"));
      clearError();
    }
  }, [clearError, onClipAdded, onQueueLocalBinaryClip, secretHandle, setError, unlockSecret, zone]);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }

    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          void addFileClip(file);
          return;
        }
      }
    }

    const html = event.clipboardData.getData("text/html");
    const text = event.clipboardData.getData("text/plain");

    if (html && text) {
      event.preventDefault();
      void addTextClip(text, html);
    } else if (text) {
      event.preventDefault();
      if (!handleImportedSessionText(text)) {
        void addTextClip(text);
      }
    }
  }, [addFileClip, addTextClip, handleImportedSessionText]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(false);

    const items = event.dataTransfer.items;
    if (items?.length) {
      const entries: FileSystemEntry[] = [];
      for (const item of items) {
        const entry = item.webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }

      if (entries.length > 0) {
        void (async () => {
          for (const entry of entries) {
            if (entry.isDirectory) {
              try {
                const zipped = await zipFolder(entry as FileSystemDirectoryEntry);
                await addFileClip(zipped);
              } catch {
                setError("Failed to zip folder");
                clearError();
              }
            } else {
              const file = await new Promise<File>((resolve, reject) =>
                (entry as FileSystemFileEntry).file(resolve, reject)
              );
              await addFileClip(file);
            }
          }
        })();
        return;
      }
    }

    const files = event.dataTransfer.files;
    if (files.length > 0) {
      for (const file of files) {
        void addFileClip(file);
      }
      return;
    }

    const text = event.dataTransfer.getData("text/plain");
    if (text) {
      if (!handleImportedSessionText(text)) {
        void addTextClip(text);
      }
    }
  }, [addFileClip, addTextClip, clearError, handleImportedSessionText, setError, setIsDragOver]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(true);
  }, [setIsDragOver]);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, [setIsDragOver]);

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      for (const file of files) {
        void addFileClip(file);
      }
    }
    event.target.value = "";
  }, [addFileClip]);

  const readClipboard = useCallback(async () => {
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith("image/"));
          if (imageType) {
            const blob = await item.getType(imageType);
            const file = new File([blob], "pasted-image.png", { type: imageType });
            await addFileClip(file);
            return;
          }
          if (item.types.includes("text/html") && item.types.includes("text/plain")) {
            const html = await (await item.getType("text/html")).text();
            const text = await (await item.getType("text/plain")).text();
            await addTextClip(text, html);
            return;
          }
          if (item.types.includes("text/plain")) {
            const text = await (await item.getType("text/plain")).text();
            if (!handleImportedSessionText(text)) {
              await addTextClip(text);
            }
            return;
          }
        }
      } else {
        const text = await navigator.clipboard.readText();
        if (text) {
          if (!handleImportedSessionText(text)) {
            await addTextClip(text);
          }
        }
      }
    } catch {
      setError("Clipboard access denied. Use the compose field to paste content.");
      clearError();
    }
  }, [addFileClip, addTextClip, clearError, handleImportedSessionText, setError]);

  return {
    clearZone,
    handlePaste,
    submitTextClip: (text: string) => {
      if (!handleImportedSessionText(text)) {
        void addTextClip(text);
      }
    },
    readClipboard,
    handleDrop,
    handleDragOver,
    handleDragLeave,
    handleFileSelect,
    openFilePicker: () => fileInputRef.current?.click(),
  };
}

function resolveActionError(error: unknown, fallback: string): string {
  if (error instanceof ClipCryptoError) {
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}
