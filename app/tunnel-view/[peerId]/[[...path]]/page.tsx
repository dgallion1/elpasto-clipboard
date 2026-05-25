"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

export default function TunnelViewerPage() {
  const params = useParams<{ peerId: string; path?: string[] }>();
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  const peerId = params.peerId;

  // Read everything from window.location directly inside the effect to avoid
  // Next.js useSearchParams() Suspense/hydration timing issues.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const url = new URL(window.location.href);
    const serverRelay = url.searchParams.get("serverRelay") === "1";

    if (serverRelay) {
      const hash = url.hash.slice(1); // strip leading '#'
      const prefix = hash ? decodeURIComponent(hash) : null;
      if (!prefix) {
        setStatus("error");
        setErrorMsg("Missing tunnel prefix. Re-open it from the session page.");
        return;
      }
      // Validate the prefix is an HTTP(S) URL to prevent javascript: or data: injection.
      let parsed: URL;
      try {
        parsed = new URL(prefix);
      } catch {
        setStatus("error");
        setErrorMsg("Invalid tunnel URL.");
        return;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        setStatus("error");
        setErrorMsg("Invalid tunnel URL scheme.");
        return;
      }
      // Clear the hash from the address bar to avoid accidental sharing.
      window.history.replaceState(null, "", url.pathname + url.search);
      setFrameSrc(prefix);
      setStatus("ready");
      return;
    }

    const pathSegments = Array.isArray(params.path) ? params.path : [];
    const pathStr = pathSegments.map(encodeURIComponent).join("/");
    const webrtcPath = pathStr ? `/tunnel/${peerId}/${pathStr}` : `/tunnel/${peerId}/`;

    if (!("serviceWorker" in navigator)) {
      setStatus("error");
      setErrorMsg("Service Workers are not supported in this browser.");
      return;
    }

    let cancelled = false;
    navigator.serviceWorker
      .register("/tunnel-sw2.js", { scope: "/tunnel/", updateViaCache: "none" })
      .then((reg) => {
        if (reg.active) {
          return;
        }
        return new Promise<void>((resolve) => {
          const worker = reg.installing || reg.waiting;
          if (!worker) {
            resolve();
            return;
          }
          worker.addEventListener("statechange", () => {
            if (worker.state === "activated") {
              resolve();
            }
          });
        });
      })
      .then(() => {
        if (cancelled) return;
        setFrameSrc(webrtcPath);
        setStatus("ready");
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setStatus("error");
        setErrorMsg(err.message || "Could not initialize the tunnel relay.");
      });

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount, reads from window.location
  }, []);

  if (status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-100">
        <div className="max-w-md text-center">
          <p className="text-lg font-semibold text-red-400">Tunnel unavailable</p>
          <p className="mt-2 text-sm text-neutral-400">{errorMsg}</p>
        </div>
      </div>
    );
  }

  if (!frameSrc || status !== "ready") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-100">
        <p className="text-sm text-neutral-400">Connecting to tunnel…</p>
      </div>
    );
  }

  return (
    <iframe
      src={frameSrc}
      referrerPolicy="no-referrer"
      className="h-screen w-full border-0 bg-white"
      title={`Tunnel ${peerId}`}
    />
  );
}
