"use client";

import { useState, useEffect, useCallback } from "react";
import { normalizeTokenInput, isValidToken } from "@/lib/token-validation";

const STORAGE_KEY = "elpasto:sessions";
const MAX_ENTRIES = 50;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionEntry {
  token: string;
  label?: string;
  pinned: boolean;
  lastVisited: number;
  myPeerName?: string;
}

export type ImportEntry = { token: string; label?: string; pinned?: boolean; myPeerName?: string; peerNames?: Record<string, string> };

function readEntries(): SessionEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is SessionEntry =>
        e !== null &&
        typeof e === "object" &&
        typeof e.token === "string" &&
        e.token.length > 0 &&
        typeof e.pinned === "boolean" &&
        typeof e.lastVisited === "number"
    );
  } catch {
    return [];
  }
}

function writeEntries(entries: SessionEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // storage unavailable — ignore
  }
}

export function pruneEntries(entries: SessionEntry[]): SessionEntry[] {
  const now = Date.now();
  return entries.filter((e) => e.pinned || now - e.lastVisited < STALE_MS);
}

export function sortEntries(entries: SessionEntry[]): SessionEntry[] {
  return [...entries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastVisited - a.lastVisited;
  });
}

function upsertCurrent(entries: SessionEntry[], token: string): SessionEntry[] {
  const now = Date.now();
  const idx = entries.findIndex((e) => e.token === token);
  if (idx >= 0) {
    const updated = [...entries];
    updated[idx] = { ...updated[idx], lastVisited: now };
    return updated;
  }
  return [...entries, { token, pinned: false, lastVisited: now }];
}

function capEntries(entries: SessionEntry[]): SessionEntry[] {
  return entries.slice(0, MAX_ENTRIES);
}

export function buildSessionExportJson(
  entries: SessionEntry[],
  opts?: { peerNames?: Record<string, string>; currentToken?: string },
): string {
  if (entries.length === 0) return "";
  const sessions = entries.map((e) => {
    const item: Record<string, unknown> = { token: e.token };
    if (e.label) item.label = e.label;
    if (e.pinned) item.pinned = true;
    if (e.myPeerName) item.myPeerName = e.myPeerName;
    if (opts?.currentToken === e.token && opts.peerNames && Object.keys(opts.peerNames).length > 0) {
      item.peerNames = opts.peerNames;
    }
    return item;
  });
  return JSON.stringify({ type: "elpasto:sessions", version: 1, sessions });
}

export function parseSessionImportJson(text: string): ImportEntry[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>).type !== "elpasto:sessions" ||
      (parsed as Record<string, unknown>).version !== 1 ||
      !Array.isArray((parsed as Record<string, unknown>).sessions)
    ) {
      return null;
    }
    const sessions = (parsed as { sessions: unknown[] }).sessions;
    const seen = new Map<string, ImportEntry>();
    for (const item of sessions) {
      if (typeof item !== "object" || item === null || typeof (item as Record<string, unknown>).token !== "string") {
        return null;
      }
      const raw = (item as Record<string, unknown>).token as string;
      const normalized = normalizeTokenInput(raw);
      if (!isValidToken(normalized)) return null;
      const entry: ImportEntry = { token: normalized };
      const itemObj = item as Record<string, unknown>;
      if (typeof itemObj.label === "string" && itemObj.label.trim()) {
        entry.label = itemObj.label.trim();
      }
      if (itemObj.pinned === true) {
        entry.pinned = true;
      }
      if (typeof itemObj.myPeerName === "string" && itemObj.myPeerName.trim()) {
        entry.myPeerName = itemObj.myPeerName.trim();
      }
      if (
        typeof itemObj.peerNames === "object" &&
        itemObj.peerNames !== null &&
        !Array.isArray(itemObj.peerNames)
      ) {
        const raw = itemObj.peerNames as Record<string, unknown>;
        if (Object.values(raw).every((v) => typeof v === "string")) {
          entry.peerNames = raw as Record<string, string>;
        }
      }
      seen.set(normalized, entry);
    }
    return Array.from(seen.values());
  } catch {
    return null;
  }
}

export function useSessionHistory(currentToken: string): {
  entries: SessionEntry[];
  add: (token: string) => void;
  setLabel: (token: string, label: string) => void;
  setMyPeerName: (token: string, name: string) => void;
  togglePin: (token: string) => void;
  remove: (token: string) => void;
  importEntries: (incoming: ImportEntry[]) => number;
} {
  const [entries, setEntries] = useState<SessionEntry[]>([]);

  // Load and upsert current token on mount / token change
  useEffect(() => {
    let loaded = readEntries();
    loaded = pruneEntries(loaded);
    loaded = upsertCurrent(loaded, currentToken);
    loaded = sortEntries(loaded);
    loaded = capEntries(loaded);
    writeEntries(loaded);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEntries(loaded);
  }, [currentToken]);

  // Sync across tabs
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      let fresh = readEntries();
      fresh = pruneEntries(fresh);
      fresh = upsertCurrent(fresh, currentToken);
      fresh = sortEntries(capEntries(fresh));
      setEntries(fresh);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [currentToken]);

  const mutate = useCallback((updater: (prev: SessionEntry[]) => SessionEntry[]) => {
    setEntries((prev) => {
      const next = sortEntries(capEntries(updater(prev)));
      writeEntries(next);
      return next;
    });
  }, []);

  const add = useCallback(
    (token: string) => {
      const normalized = normalizeTokenInput(token);
      if (!normalized) return;
      mutate((prev) => {
        if (prev.some((e) => e.token === normalized)) return prev;
        return [...prev, { token: normalized, pinned: false, lastVisited: Date.now() }];
      });
    },
    [mutate]
  );

  const setLabel = useCallback(
    (token: string, label: string) => {
      mutate((prev) =>
        prev.map((e) =>
          e.token === token
            ? { ...e, label: label.trim() || undefined }
            : e
        )
      );
    },
    [mutate]
  );

  const setMyPeerName = useCallback(
    (token: string, name: string) => {
      mutate((prev) =>
        prev.map((e) =>
          e.token === token ? { ...e, myPeerName: name.trim() || undefined } : e
        )
      );
    },
    [mutate]
  );

  const togglePin = useCallback(
    (token: string) => {
      mutate((prev) =>
        prev.map((e) => (e.token === token ? { ...e, pinned: !e.pinned } : e))
      );
    },
    [mutate]
  );

  const remove = useCallback(
    (token: string) => {
      mutate((prev) => prev.filter((e) => e.token !== token));
    },
    [mutate]
  );

  const importEntries = useCallback(
    (incoming: ImportEntry[]): number => {
      // Read current entries directly from storage for an accurate count,
      // since the React state updater may run asynchronously.
      const current = readEntries();
      const existingTokens = new Set(current.map((e) => e.token));
      const newCount = incoming.filter((item) => !existingTokens.has(item.token)).length;
      mutate((prev) => {
        const updated = [...prev];
        for (const item of incoming) {
          const idx = updated.findIndex((e) => e.token === item.token);
          if (idx >= 0) {
            updated[idx] = {
              ...updated[idx],
              ...(item.label !== undefined ? { label: item.label } : {}),
              ...(item.pinned !== undefined ? { pinned: item.pinned } : {}),
              ...(item.myPeerName !== undefined ? { myPeerName: item.myPeerName } : {}),
            };
          } else {
            updated.push({
              token: item.token,
              label: item.label,
              pinned: item.pinned ?? false,
              lastVisited: Date.now(),
              myPeerName: item.myPeerName,
            });
          }
        }
        return updated;
      });
      return newCount;
    },
    [mutate]
  );

  return { entries, add, setLabel, setMyPeerName, togglePin, remove, importEntries };
}
