"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface QRCodeModalProps {
  open: boolean;
  onClose: () => void;
  url: string;
}

export function QRCodeModal({ open, onClose, url }: QRCodeModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [urlCopied, setUrlCopied] = useState(false);
  const [QRCodeSVG, setQRCodeSVG] = useState<null | React.ComponentType<{
    value: string;
    size: number;
    level: "L" | "M" | "Q" | "H";
    includeMargin: boolean;
    bgColor: string;
    fgColor: string;
  }>>(null);

  useEffect(() => {
    let cancelled = false;

    void import("qrcode.react").then((module) => {
      if (!cancelled) {
        setQRCodeSVG(() => module.QRCodeSVG);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) setUrlCopied(false);
  }, [open]);

  const copyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 2000);
    } catch {
      // ignore
    }
  }, [url]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) {
        return;
      }

      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Session QR code"
        className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl"
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-neutral-100">Join by QR</h2>
            <p className="mt-0.5 text-sm text-neutral-500">
              Scan on another device to open this session.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="rounded-md p-1 text-neutral-500 transition hover:text-neutral-200"
            aria-label="Close"
          >
            &#x2715;
          </button>
        </div>

        <div className="space-y-3">
          <div className="flex justify-center rounded-lg bg-neutral-950 p-5">
            {QRCodeSVG ? (
              <QRCodeSVG value={url} size={224} level="M" includeMargin={true} bgColor="#0a0a0a" fgColor="#e5e5e5" />
            ) : (
              <div
                aria-label="Loading QR code"
                className="flex h-56 w-56 items-center justify-center text-xs text-neutral-600"
              >
                Loading QR...
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={copyUrl}
            className="w-full break-all rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-left font-mono text-xs text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-300 cursor-pointer"
            title="Click to copy URL"
          >
            {urlCopied ? <span className="text-emerald-400">Copied to clipboard!</span> : url}
          </button>
        </div>
      </div>
    </div>
  );
}
