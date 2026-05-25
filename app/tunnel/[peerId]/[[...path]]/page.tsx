"use client";

/**
 * Tunnel shell page — rendered at /tunnel/{peerId}/[...path]
 *
 * This page is the fallback when the Service Worker isn't yet controlling the
 * document. In normal operation the SW serves tunnel content transparently;
 * this shell is only visible briefly during the first load or on SW failure.
 *
 * Once the SW is ready it will handle all subsequent navigations and fetches
 * under /tunnel/ — this page just needs to ensure the SW is registered and
 * then reload so the SW can serve the real content.
 */

import { useEffect, useState } from "react";

export default function TunnelShellPage() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) {
      // Defer to next microtask to avoid synchronous setState in effect body
      Promise.resolve().then(() => {
        setStatus("error");
        setErrorMsg("Service Workers are not supported in this browser.");
      });
      return;
    }

    navigator.serviceWorker
      .register("/tunnel-sw2.js", { scope: "/tunnel/", updateViaCache: "none" })
      .then(() => navigator.serviceWorker.ready)
      .then(() => {
        setStatus("ready");
        // Reload so the SW can serve the tunnel content.
        window.location.reload();
      })
      .catch((err: Error) => {
        setStatus("error");
        setErrorMsg(err.message);
      });
  }, []);

  if (status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-100">
        <div className="max-w-md text-center">
          <p className="text-lg font-semibold text-red-400">Tunnel unavailable</p>
          <p className="mt-2 text-sm text-neutral-400">{errorMsg || "Could not initialize the tunnel relay."}</p>
          <p className="mt-4 text-xs text-neutral-500">
            Make sure the elPasto session tab is open and connected to a tunnel host.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-100">
      <div className="text-center">
        <p className="text-sm text-neutral-400">Connecting to tunnel…</p>
      </div>
    </div>
  );
}
