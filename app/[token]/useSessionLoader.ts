"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildApiUrl } from "@/lib/api";
import type { SessionData } from "./session-page-types";

export interface SessionLoaderOptions {
  token: string;
  /**
   * Invoked when a session payload is successfully loaded — either via the
   * initial GET or after a 404 → recreate → retry. The controller is
   * responsible for normalising clips and threads from the returned data.
   */
  onSessionLoaded: (data: SessionData) => void;
  /**
   * Invoked when a foreground load couldn't recover (404 + recreate failed,
   * or recreate itself threw). The controller typically clears canonical
   * session state. Never fires for background loads — those preserve
   * existing state so sender blob URLs aren't destroyed.
   */
  onSessionMissing: () => void;
}

export interface SessionLoader {
  loadSession: (opts: { showLoading: boolean }) => Promise<void>;
  loading: boolean;
  error: string | null;
}

/**
 * Owns the network state machine for loading and refreshing a session.
 *
 *  - foreground (`showLoading: true`): updates `loading`/`error` so the page
 *    can render a spinner / error state.
 *  - background (`showLoading: false`): silent; errors don't surface so the
 *    session view stays mounted and sender blob URLs survive.
 *
 * A monotonic request id guards every await boundary so a slow in-flight
 * load can't clobber state set by a newer load that already finished.
 */
export function useSessionLoader({
  token,
  onSessionLoaded,
  onSessionMissing,
}: SessionLoaderOptions): SessionLoader {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  // Route callbacks through refs so loadSession's identity stays stable
  // (it depends only on `token`).
  const onLoadedRef = useRef(onSessionLoaded);
  const onMissingRef = useRef(onSessionMissing);
  useEffect(() => {
    onLoadedRef.current = onSessionLoaded;
  }, [onSessionLoaded]);
  useEffect(() => {
    onMissingRef.current = onSessionMissing;
  }, [onSessionMissing]);

  const loadSession = useCallback(
    async ({ showLoading }: { showLoading: boolean }) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      if (showLoading) {
        setLoading(true);
        setError(null);
      }

      try {
        const res = await fetch(buildApiUrl(`/api/sessions/${token}`));
        if (requestId !== requestIdRef.current) {
          return;
        }

        if (res.status === 404) {
          // Session missing on server (e.g. snapshot lost during restart).
          // Recreate it so the token stays valid and IndexedDB clips survive.
          try {
            const recreate = await fetch(buildApiUrl("/api/sessions/batch"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tokens: [token] }),
            });
            if (recreate.ok) {
              const retry = await fetch(
                buildApiUrl(`/api/sessions/${token}`),
              );
              if (requestId !== requestIdRef.current) return;
              if (retry.ok) {
                const data = (await retry.json()) as SessionData;
                onLoadedRef.current(data);
                setError(null);
                return;
              }
            }
          } catch {
            // fall through
          }
          // Background loads must not destroy session state — true expiry is
          // handled by the SSE session-expired event.
          if (!showLoading) return;
          if (requestId !== requestIdRef.current) return;
          onMissingRef.current();
          setError("Session not found or expired");
          return;
        }

        if (!res.ok) {
          if (!showLoading) return;
          throw new Error("Failed to load session");
        }

        const data = (await res.json()) as SessionData;
        if (requestId !== requestIdRef.current) {
          return;
        }
        onLoadedRef.current(data);
        setError(null);
      } catch {
        if (requestId !== requestIdRef.current) {
          return;
        }
        // Only surface errors on initial foreground load. Background
        // (SSE reconnection) errors must not poison the render.
        if (showLoading) {
          setError("Failed to load session");
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [token],
  );

  return { loadSession, loading, error };
}
