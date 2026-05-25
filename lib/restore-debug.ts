"use client";

const RESTORE_DEBUG_KEY = "elpasto:debug:restore";

function readDebugFlag(storage: Storage | undefined): string | null {
  try {
    return storage?.getItem(RESTORE_DEBUG_KEY) ?? null;
  } catch {
    return null;
  }
}

function isTruthyFlag(value: string | null): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function isRestoreDebugEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const queryEnabled = new URLSearchParams(window.location.search).has("debugRestore");
  return queryEnabled
    || isTruthyFlag(readDebugFlag(window.sessionStorage))
    || isTruthyFlag(readDebugFlag(window.localStorage));
}

export function logRestoreDebug(
  scope: string,
  event: string,
  details?: Record<string, unknown>
): void {
  if (!isRestoreDebugEnabled()) {
    return;
  }

  const prefix = `[elpasto:restore:${scope}] ${event}`;
  if (details && Object.keys(details).length > 0) {
    console.log(prefix, details);
    return;
  }
  console.log(prefix);
}
