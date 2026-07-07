"use client";

import { useCallback, useState } from "react";
import { QRCode } from "./QRCode";
import { QRCodeModal } from "./QRCodeModal";
import type { ConnectionState } from "@/lib/connection-state";

interface DeviceHandoffProps {
  state: ConnectionState;
  sessionUrl: string;
  token: string;
  hasClips: boolean;
}

const dismissKey = (token: string) => `elpasto:handoff-dismissed:${token}`;

export function DeviceHandoff({ state, sessionUrl, token, hasClips }: DeviceHandoffProps) {
  // Safe to read sessionStorage during init: DeviceHandoff only mounts
  // client-side, after SessionPageView's `loading` gate — never during SSR.
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return sessionStorage.getItem(dismissKey(token)) === "1";
    } catch {
      return false;
    }
  });
  const [qrOpen, setQrOpen] = useState(false);
  const [copied, setCopied] = useState<"url" | "token" | null>(null);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      sessionStorage.setItem(dismissKey(token), "1");
    } catch {
      // ignore — non-fatal
    }
  }, [token]);

  const copy = useCallback(
    async (kind: "url" | "token") => {
      try {
        await navigator.clipboard.writeText(kind === "url" ? sessionUrl : token);
        setCopied(kind);
        setTimeout(() => setCopied(null), 2000);
      } catch {
        // ignore
      }
    },
    [sessionUrl, token]
  );

  if (state === "connected-direct" || state === "connected-tunnel") {
    return null;
  }

  const connecting = state === "connecting";
  const statusText = connecting ? "Device connecting…" : "Waiting for your other device…";
  const dotClass = connecting ? "bg-amber-400 animate-pulse" : "bg-neutral-500 animate-pulse";

  // Slim banner once the thread has content — never covers clips.
  if (hasClips) {
    if (dismissed) return null;
    return (
      <>
        <div
          className="flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/70 px-3 py-1.5 text-sm text-neutral-400"
          role="status"
          aria-live="polite"
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
          <span className="min-w-0 flex-1 truncate">
            {connecting ? statusText : "No device linked yet"}
          </span>
          <button
            onClick={() => setQrOpen(true)}
            className="shrink-0 text-neutral-300 transition-colors hover:text-emerald-300"
          >
            Show QR
          </button>
          <button
            onClick={() => copy("url")}
            className="shrink-0 text-neutral-300 transition-colors hover:text-emerald-300"
          >
            {copied === "url" ? "Copied!" : "Copy URL"}
          </button>
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="shrink-0 text-neutral-500 transition-colors hover:text-neutral-300"
          >
            ✕
          </button>
        </div>
        <QRCodeModal open={qrOpen} onClose={() => setQrOpen(false)} url={qrOpen ? sessionUrl : ""} />
      </>
    );
  }

  // Full center panel when the thread is empty.
  return (
    <div
      className="flex flex-col items-center justify-center gap-5 py-10 text-center"
      role="status"
      aria-live="polite"
    >
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <QRCode value={sessionUrl} size={192} />
      </div>
      <div className="space-y-1">
        <p className="text-lg font-medium text-neutral-200">Scan to link your phone</p>
        <p className="flex items-center justify-center gap-2 text-sm text-neutral-500">
          <span className={`h-2 w-2 rounded-full ${dotClass}`} />
          {statusText}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => copy("url")}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
        >
          {copied === "url" ? "Copied!" : "Copy URL"}
        </button>
        <button
          onClick={() => copy("token")}
          className="rounded-md px-4 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
        >
          {copied === "token" ? "Copied!" : "Copy token"}
        </button>
      </div>
    </div>
  );
}
