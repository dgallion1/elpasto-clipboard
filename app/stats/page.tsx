"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

interface StatsSnapshot {
  uptime_seconds: number;
  page_views: number;
  api_requests: number;
  unique_visitors: number;
  sessions_created: number;
  session_views: number;
  clips_created: number;

  active_sessions: number;
  sse_connections: number;
  active_tunnels: number;
  sessions_with_viewers: number;
}

type FetchResult =
  | { kind: "ok"; snapshot: StatsSnapshot; fetchedAt: Date }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

type DisplayState = FetchResult | { kind: "loading" } | { kind: "needs-key" };

const REFRESH_INTERVAL_MS = 5_000;

const subscribeNoop = () => () => {};
const readKeyFromLocation = (): string => {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("key") ?? "";
};
const readKeySSR = (): string => "";

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export default function StatsPage() {
  const key = useSyncExternalStore(subscribeNoop, readKeyFromLocation, readKeySSR);
  const [fetched, setFetched] = useState<FetchResult | null>(null);

  useEffect(() => {
    if (key === "") return;

    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/stats?key=${encodeURIComponent(key)}`, {
          cache: "no-store",
        });
        if (cancelled) return;
        if (response.status === 404) {
          setFetched({ kind: "unauthorized" });
          return;
        }
        if (!response.ok) {
          setFetched({ kind: "error", message: `HTTP ${response.status}` });
          return;
        }
        const snapshot = (await response.json()) as StatsSnapshot;
        if (cancelled) return;
        setFetched({ kind: "ok", snapshot, fetchedAt: new Date() });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "fetch failed";
        setFetched({ kind: "error", message });
      }
    };

    load();
    const interval = window.setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [key]);

  const state: DisplayState = useMemo(() => {
    if (key === "") return { kind: "needs-key" };
    if (fetched === null) return { kind: "loading" };
    return fetched;
  }, [key, fetched]);

  const tiles = useMemo(() => {
    if (state.kind !== "ok") return [];
    const s = state.snapshot;
    return [
      { label: "Uptime", value: formatUptime(s.uptime_seconds), accent: "neutral" as const },
      { label: "Page views", value: s.page_views.toLocaleString(), accent: "neutral" as const },
      { label: "API requests", value: s.api_requests.toLocaleString(), accent: "neutral" as const },
      { label: "Unique visitors (today)", value: s.unique_visitors.toLocaleString(), accent: "blue" as const },
      { label: "Sessions created", value: s.sessions_created.toLocaleString(), accent: "blue" as const },
      { label: "Session views", value: s.session_views.toLocaleString(), accent: "neutral" as const },
      { label: "Clips shared (offers)", value: s.clips_created.toLocaleString(), accent: "emerald" as const },

      { label: "Active sessions", value: s.active_sessions.toLocaleString(), accent: "emerald" as const },
      { label: "SSE connections", value: s.sse_connections.toLocaleString(), accent: "emerald" as const },
      { label: "Sessions with viewers", value: s.sessions_with_viewers.toLocaleString(), accent: "emerald" as const },
      { label: "Active tunnels", value: s.active_tunnels.toLocaleString(), accent: "sky" as const },
    ];
  }, [state]);

  return (
    <main className="min-h-screen px-6 py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-10 flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">elPasto stats</h1>
          <p className="text-sm text-neutral-500">
            Server-side counters from <code className="font-mono text-neutral-400">/api/stats</code>. Refreshes every 5s.
          </p>
        </header>

        {state.kind === "loading" && (
          <p className="text-sm text-neutral-500">Loading…</p>
        )}

        {state.kind === "needs-key" && (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-6 text-sm text-neutral-300">
            <p className="mb-2 font-medium text-neutral-100">Missing access key</p>
            <p className="text-neutral-400">
              Append <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-neutral-200">?key=&lt;STATS_DASHBOARD_KEY&gt;</code> to the URL.
            </p>
          </div>
        )}

        {state.kind === "unauthorized" && (
          <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-6 text-sm text-red-200">
            <p className="font-medium">Not found</p>
            <p className="mt-1 text-red-300/80">
              The stats endpoint either is not configured (server-side <code className="font-mono">STATS_DASHBOARD_KEY</code> unset) or the key in the URL is wrong.
            </p>
          </div>
        )}

        {state.kind === "error" && (
          <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-6 text-sm text-amber-200">
            <p className="font-medium">Could not load stats</p>
            <p className="mt-1 font-mono text-xs text-amber-300/80">{state.message}</p>
          </div>
        )}

        {state.kind === "ok" && (
          <>
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {tiles.map((tile) => (
                <div
                  key={tile.label}
                  className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3"
                >
                  <div
                    className={
                      tile.accent === "emerald"
                        ? "text-[11px] font-medium uppercase tracking-wide text-emerald-400/80"
                        : tile.accent === "blue"
                          ? "text-[11px] font-medium uppercase tracking-wide text-blue-400/80"
                          : tile.accent === "sky"
                            ? "text-[11px] font-medium uppercase tracking-wide text-sky-400/80"
                            : "text-[11px] font-medium uppercase tracking-wide text-neutral-500"
                    }
                  >
                    {tile.label}
                  </div>
                  <div className="mt-1 font-mono text-xl font-semibold text-neutral-100">
                    {tile.value}
                  </div>
                </div>
              ))}
            </section>
            <p className="mt-6 text-xs text-neutral-600">
              Last refreshed {state.fetchedAt.toLocaleTimeString()}.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
