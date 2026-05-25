"use client";

import { useEffect, useRef } from "react";

const versionEndpoint = "/__elpasto/version";
const checkIntervalMs = 60_000;

declare global {
  interface Window {
    __ELPASTO_BUILD_ID__?: string;
  }
}

interface FrontendVersionWatcherProps {
  reloadPage?: () => void;
}

export function FrontendVersionWatcher({
  reloadPage = () => window.location.reload(),
}: FrontendVersionWatcherProps) {
  const initialBuildId =
    typeof window === "undefined" ? null : window.__ELPASTO_BUILD_ID__ ?? null;
  const expectedBuildRef = useRef<string | null>(initialBuildId);
  const checkingRef = useRef(false);
  const reloadingRef = useRef(false);


  useEffect(() => {
    if (!initialBuildId) {
      return;
    }

    const checkVersion = async () => {
      if (checkingRef.current || reloadingRef.current) {
        return;
      }

      checkingRef.current = true;

      let latestBuild: string;
      try {
        const response = await fetch(versionEndpoint, { cache: "no-store" });
        if (!response.ok) {
          return;
        }

        latestBuild = (await response.text()).trim();
      } catch {
        return;
      } finally {
        checkingRef.current = false;
      }

      if (!latestBuild) {
        return;
      }

      if (!expectedBuildRef.current) {
        expectedBuildRef.current = latestBuild;
        return;
      }

      if (latestBuild !== expectedBuildRef.current) {
        reloadingRef.current = true;
        reloadPage();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void checkVersion();
      }
    };

    const intervalId = window.setInterval(() => {
      void checkVersion();
    }, checkIntervalMs);

    window.addEventListener("focus", handleVisibilityChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void checkVersion();

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleVisibilityChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [initialBuildId, reloadPage]);

  return null;
}
