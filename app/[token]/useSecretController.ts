"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SecretHandle } from "@/lib/clip-crypto";
import { deriveMasterKey } from "@/lib/clip-crypto";
import {
  deleteMasterKey,
  loadMasterKey,
  probeParanoidSupport,
  storeMasterKey,
} from "@/lib/crypto-store";

export type SecretPromptMode = "setup" | "required" | "manage" | null;

export interface SecretController {
  unlockSecret: string | null;
  secretHandle: SecretHandle | null;
  secretMode: "normal" | "paranoid" | null;
  secretPromptMode: SecretPromptMode;
  paranoidAvailable: boolean;
  requestUnlockSecret: () => Promise<string | null>;
  handleSecretSubmit: (secret: string) => Promise<void>;
  handleSecretCancel: () => void;
  handleSecretClear: () => Promise<void>;
  handleSecretSubmitParanoid: (passphrase: string) => Promise<void>;
  openSecretManager: () => void;
  getCurrentSecretHandle: () => SecretHandle | null;
}

/**
 * Owns all per-session secret state — the raw unlock passphrase, the
 * encryption-mode handle (normal AES-GCM vs paranoid HKDF), the current prompt
 * UI mode, and the pending "secret requested" promise used by ClipCard.
 *
 * Persistence:
 *  - `sessionStorage[elpasto:secret:<token>]` holds the raw passphrase in
 *    normal mode. Paranoid mode never writes the passphrase to storage.
 *  - `crypto-store` (IndexedDB) holds the derived master key for paranoid mode.
 */
export function useSecretController(token: string): SecretController {
  const [unlockSecret, setUnlockSecret] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return sessionStorage.getItem(`elpasto:secret:${token}`) ?? null;
  });
  const [secretHandle, setSecretHandle] = useState<SecretHandle | null>(null);
  const [secretPromptMode, setSecretPromptMode] = useState<SecretPromptMode>(null);
  const [paranoidAvailable, setParanoidAvailable] = useState(false);

  const secretHandleRef = useRef<SecretHandle | null>(null);
  const unlockSecretRef = useRef<string | null>(unlockSecret);
  const pendingSecretResolveRef = useRef<((value: string | null) => void) | null>(null);
  const pendingSecretPromiseRef = useRef<Promise<string | null> | null>(null);
  const secretSelectionVersionRef = useRef(0);

  useEffect(() => {
    unlockSecretRef.current = unlockSecret;
  }, [unlockSecret]);

  useEffect(() => {
    secretHandleRef.current = secretHandle;
  }, [secretHandle]);

  // When unlockSecret changes in normal mode, sync to secretHandle.
  // Paranoid handles are preserved — they are owned by the IndexedDB load
  // effect and the explicit paranoid submit path.
  useEffect(() => {
    if (unlockSecret) {
      setSecretHandle({ mode: "normal", secret: unlockSecret });
    } else if (!secretHandle || secretHandle.mode === "normal") {
      setSecretHandle(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlockSecret]);

  // Load paranoid master key from IndexedDB on mount.
  useEffect(() => {
    let cancelled = false;
    const loadVersion = secretSelectionVersionRef.current;
    void (async () => {
      try {
        const mk = await loadMasterKey(token);
        if (cancelled) return;
        if (
          mk
          && loadVersion === secretSelectionVersionRef.current
          && !unlockSecretRef.current
          && secretHandleRef.current == null
        ) {
          setSecretHandle({ mode: "paranoid", masterKey: mk });
        }
      } catch {
        // IndexedDB unavailable — ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    void probeParanoidSupport().then((supported) => {
      if (!cancelled) setParanoidAvailable(supported);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const invalidatePendingSecretBootstrap = useCallback(() => {
    secretSelectionVersionRef.current += 1;
  }, []);

  const setSecret = useCallback(
    (nextSecret: string | null) => {
      setUnlockSecret(nextSecret);
      if (nextSecret) {
        sessionStorage.setItem(`elpasto:secret:${token}`, nextSecret);
      } else {
        sessionStorage.removeItem(`elpasto:secret:${token}`);
      }
    },
    [token],
  );

  const resolvePendingSecret = useCallback((value: string | null) => {
    pendingSecretResolveRef.current?.(value);
    pendingSecretResolveRef.current = null;
    pendingSecretPromiseRef.current = null;
  }, []);

  const requestUnlockSecret = useCallback((): Promise<string | null> => {
    if (unlockSecretRef.current) return Promise.resolve(unlockSecretRef.current);
    if (pendingSecretPromiseRef.current) return pendingSecretPromiseRef.current;

    setSecretPromptMode("required");
    const pendingPromise = new Promise<string | null>((resolve) => {
      pendingSecretResolveRef.current = resolve;
    });
    pendingSecretPromiseRef.current = pendingPromise;
    return pendingPromise;
  }, []);

  const handleSecretSubmit = useCallback(
    async (secret: string) => {
      invalidatePendingSecretBootstrap();
      await deleteMasterKey(token).catch(() => {});
      setSecretHandle({ mode: "normal", secret });
      setSecret(secret);
      setSecretPromptMode(null);
      resolvePendingSecret(secret);
    },
    [invalidatePendingSecretBootstrap, resolvePendingSecret, setSecret, token],
  );

  const handleSecretCancel = useCallback(() => {
    setSecretPromptMode(null);
    resolvePendingSecret(null);
  }, [resolvePendingSecret]);

  const handleSecretClear = useCallback(async () => {
    invalidatePendingSecretBootstrap();
    setSecret(null);
    setSecretHandle(null);
    await deleteMasterKey(token).catch(() => {});
    setSecretPromptMode(null);
    resolvePendingSecret(null);
  }, [invalidatePendingSecretBootstrap, resolvePendingSecret, setSecret, token]);

  const handleSecretSubmitParanoid = useCallback(
    async (passphrase: string) => {
      invalidatePendingSecretBootstrap();
      const masterKey = await deriveMasterKey(passphrase);
      await storeMasterKey(token, masterKey);
      setSecretHandle({ mode: "paranoid", masterKey });
      // Discard the raw passphrase from all persistent storage.
      setUnlockSecret(null);
      sessionStorage.removeItem(`elpasto:secret:${token}`);
      setSecretPromptMode(null);
      // Resolve any pending secret prompt with the raw passphrase (one-time use).
      resolvePendingSecret(passphrase);
    },
    [invalidatePendingSecretBootstrap, resolvePendingSecret, token],
  );

  const openSecretManager = useCallback(() => {
    setSecretPromptMode("manage");
  }, []);

  const getCurrentSecretHandle = useCallback(
    () => secretHandleRef.current,
    [],
  );

  return {
    unlockSecret,
    secretHandle,
    secretMode: secretHandle?.mode ?? null,
    secretPromptMode,
    paranoidAvailable,
    requestUnlockSecret,
    handleSecretSubmit,
    handleSecretCancel,
    handleSecretClear,
    handleSecretSubmitParanoid,
    openSecretManager,
    getCurrentSecretHandle,
  };
}
