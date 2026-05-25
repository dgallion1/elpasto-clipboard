"use client";

import { useCallback, useRef, useState } from "react";
import type { ClipZone } from "@/lib/clips";

interface ComposeFieldProps {
  zone: ClipZone;
  threadName?: string;
  onSubmitText: (text: string) => void;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onFocusZone: (zone: ClipZone | null) => void;
}

const MAX_HEIGHT = 144;

export function ComposeField({ zone, threadName, onSubmitText, onPaste, onFocusZone }: ComposeFieldProps) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resetHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    resetHeight();
  }, [resetHeight]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;

    const trimmed = draft.trim();
    if (!trimmed) {
      e.preventDefault();
      return;
    }

    e.preventDefault();
    onSubmitText(trimmed);
    setDraft("");
    // Reset height after clearing
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.style.height = "auto";
    });
  }, [draft, onSubmitText]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    onPaste(e);
  }, [onPaste]);

  const handleFocus = useCallback(() => {
    onFocusZone(zone);
  }, [onFocusZone, zone]);

  return (
    <textarea
      ref={textareaRef}
      rows={2}
      value={draft}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onFocus={handleFocus}
      placeholder="Type a message, or paste..."
      aria-label={`Compose clip for thread ${threadName ?? zone}`}
      spellCheck={true}
      className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-950/80 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/30 transition-colors"
      style={{ maxHeight: `${MAX_HEIGHT}px` }}
    />
  );
}
