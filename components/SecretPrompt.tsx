"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  generateUnlockSecret,
  isStrongUnlockSecret,
  normalizeUnlockSecret,
} from "@/lib/clip-crypto";

interface SecretPromptProps {
  canClear: boolean;
  initialSecret: string | null;
  mode: "setup" | "required" | "manage";
  onCancel: () => void;
  onClear: () => void;
  onSubmit: (secret: string) => void;
  onSubmitParanoid?: (secret: string) => void;
  paranoidAvailable?: boolean;
  open: boolean;
}

export function SecretPrompt({
  canClear,
  initialSecret,
  mode,
  onCancel,
  onClear,
  onSubmit,
  onSubmitParanoid,
  paranoidAvailable,
  open,
}: SecretPromptProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [paranoid, setParanoid] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (mode === "setup" && !initialSecret) {
      setDraft(generateUnlockSecret()); // eslint-disable-line react-hooks/set-state-in-effect -- reset form on open
    } else {
      setDraft(initialSecret ?? "");
    }
    setError(null);
    setCopied(false);
    setParanoid(false);
  }, [initialSecret, mode, open]);

  const dialogRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
        return;
      }

      if (e.key !== "Tab" || !dialogRef.current) return;

      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'input, button, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onCancel]
  );

  if (!open) return null;

  const title =
    mode === "setup"
      ? "Set Up Encryption"
      : mode === "required"
        ? "Enter Unlock Secret"
        : "Manage Secret";

  const description =
    mode === "setup"
      ? "All clips are encrypted before leaving your browser. Save this secret and share it out-of-band with anyone who needs access."
      : mode === "required"
        ? "A secret is required to add or view clips. Enter the secret that was shared with you, or set a new one for an empty session."
        : "Replace the current secret, copy it, or forget it on this device.";

  const submitDraft = () => {
    const nextSecret = normalizeUnlockSecret(draft);
    if (!nextSecret) {
      setError("Enter a secret or generate one.");
      return;
    }
    if (!isStrongUnlockSecret(nextSecret)) {
      setError("Use at least 12 characters or generate a secure secret.");
      return;
    }

    if (paranoid && onSubmitParanoid) {
      onSubmitParanoid(nextSecret);
    } else {
      onSubmit(nextSecret);
    }
  };

  const generateSecret = () => {
    setDraft(generateUnlockSecret());
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl"
      >
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-neutral-100">{title}</h2>
          <p className="text-sm text-neutral-400">{description}</p>
        </div>

        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submitDraft();
          }}
        >
          <label className="block space-y-2">
            <span className="text-sm text-neutral-300">Unlock secret</span>
            <div className="relative">
              <input
                autoFocus
                className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 pr-14 text-sm text-neutral-100 outline-none transition focus:border-blue-500"
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (error) setError(null);
                }}
                placeholder="Generate one or enter a strong passphrase"
                type="text"
                value={draft}
              />
              {draft && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                  <button
                    aria-label="Copy secret"
                    className="text-neutral-500 transition hover:text-neutral-200"
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(draft).then(
                        () => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        },
                        () => { /* clipboard unavailable — ignore silently */ }
                      );
                    }}
                  >
                    {copied ? (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-green-400">
                        <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                        <path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5a1.5 1.5 0 0 1-1.5 1.5h-1v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z" />
                        <path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.44A1.5 1.5 0 0 0 8.378 6H4.5Z" />
                      </svg>
                    )}
                  </button>
                  <button
                    aria-label="Clear"
                    className="text-neutral-500 transition hover:text-neutral-200"
                    type="button"
                    onClick={() => {
                      setDraft("");
                      if (error) setError(null);
                    }}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                      <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
                    </svg>
                  </button>
                </span>
              )}
            </div>
          </label>

          {error && (
            <p className="text-sm text-red-400" role="alert">
              {error}
            </p>
          )}

          {paranoidAvailable && onSubmitParanoid && mode !== "required" && (
            <label className="flex items-start gap-2 pt-1">
              <input
                type="checkbox"
                checked={paranoid}
                onChange={(e) => setParanoid(e.target.checked)}
                className="mt-0.5 accent-amber-500"
              />
              <span className="text-xs text-neutral-400">
                Forget passphrase after use
                <span className="text-neutral-600">{" — you\u2019ll need to re-enter it each time, but it\u2019s never stored on this device"}</span>
              </span>
            </label>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
              type="button"
              onClick={generateSecret}
            >
              Generate Secret
            </button>
            <button
              className="rounded-md bg-neutral-800 px-3 py-2 text-sm text-neutral-200 transition hover:bg-neutral-700"
              type="submit"
            >
              Use Secret
            </button>
            {canClear && (
              <button
                className="rounded-md bg-neutral-800 px-3 py-2 text-sm text-neutral-300 transition hover:bg-neutral-700"
                type="button"
                onClick={onClear}
              >
                Forget Secret
              </button>
            )}
            <button
              className="ml-auto rounded-md px-3 py-2 text-sm text-neutral-400 transition hover:text-neutral-200"
              type="button"
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
