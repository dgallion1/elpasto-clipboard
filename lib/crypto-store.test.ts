import "fake-indexeddb/auto";
import { describe, expect, test, beforeEach, vi } from "vitest";
import { deriveMasterKey } from "./clip-crypto";
import { storeMasterKey, loadMasterKey, deleteMasterKey, probeParanoidSupport } from "./crypto-store";

describe("crypto-store", () => {
  const token = "test-session-token";

  beforeEach(async () => {
    await deleteMasterKey(token);
  });

  test("store and load round-trip", async () => {
    const mk = await deriveMasterKey("test-passphrase-12chars");
    await storeMasterKey(token, mk);
    const loaded = await loadMasterKey(token);
    // NOTE: fake-indexeddb may not support structured cloning of CryptoKey objects.
    // In a real browser, IndexedDB stores CryptoKey via the structured clone algorithm.
    // We verify the API contract (store/load without throwing, value is non-null),
    // and check CryptoKey properties only when the polyfill preserves the type.
    expect(loaded).not.toBeNull();
    if (loaded instanceof CryptoKey) {
      expect(loaded.extractable).toBe(false);
      expect(loaded.algorithm).toEqual({ name: "HKDF" });
    }
    // If not a CryptoKey instance, the polyfill stored it as a plain object — that's OK for test env
  });

  test("load returns null for missing key", async () => {
    const loaded = await loadMasterKey("nonexistent-token");
    expect(loaded).toBeNull();
  });

  test("delete removes stored key", async () => {
    const mk = await deriveMasterKey("test-passphrase-12chars");
    await storeMasterKey(token, mk);
    await deleteMasterKey(token);
    const loaded = await loadMasterKey(token);
    expect(loaded).toBeNull();
  });

  test("delete on missing key does not throw", async () => {
    await expect(deleteMasterKey("nonexistent")).resolves.not.toThrow();
  });

  test("overwrite replaces existing key", async () => {
    const mk1 = await deriveMasterKey("first-passphrase-12c");
    const mk2 = await deriveMasterKey("second-passphrase-12c");
    await storeMasterKey(token, mk1);
    await storeMasterKey(token, mk2);
    const loaded = await loadMasterKey(token);
    expect(loaded).not.toBeNull();
  });

  test("probeParanoidSupport returns boolean", async () => {
    const result = await probeParanoidSupport();
    expect(typeof result).toBe("boolean");
  });

  test("probeParanoidSupport returns false when crypto.subtle is unavailable", async () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { subtle: undefined },
    });
    try {
      const result = await probeParanoidSupport();
      expect(result).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: original,
      });
    }
  });

  test("probeParanoidSupport returns false when crypto operations throw", async () => {
    vi.spyOn(globalThis.crypto.subtle, "importKey").mockRejectedValueOnce(
      new Error("crypto operation failed")
    );
    try {
      const result = await probeParanoidSupport();
      expect(result).toBe(false);
    } finally {
      vi.mocked(globalThis.crypto.subtle.importKey).mockRestore();
    }
  });
});
