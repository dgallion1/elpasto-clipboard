import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  ClipCryptoError,
  WrongUnlockSecretError,
  base64UrlDecode,
  base64UrlEncode,
  decryptBinaryPayload,
  decryptBinaryPayloadV2,
  decryptBinaryWithHandle,
  decryptHtmlPayload,
  decryptHtmlPayloadV2,
  decryptHtmlWithHandle,
  decryptTextPayload,
  decryptTextPayloadV2,
  decryptTextWithHandle,
  deriveMasterKey,
  encryptBinaryPayload,
  encryptBinaryPayloadV2,
  encryptBinaryWithHandle,
  encryptHtmlPayload,
  encryptHtmlPayloadV2,
  encryptHtmlWithHandle,
  encryptTextPayload,
  encryptTextPayloadV2,
  encryptTextWithHandle,
  generateUnlockSecret,
  isStrongUnlockSecret,
  normalizeUnlockSecret,
  toArrayBuffer,
} from "./clip-crypto";
import type { SecretHandle } from "./clip-crypto";

const originalCrypto = globalThis.crypto;

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: originalCrypto,
  });
});

describe("clip-crypto", () => {
  test("normalizes and validates unlock secrets", () => {
    const secret = generateUnlockSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(normalizeUnlockSecret("  hello  ")).toBe("hello");
    expect(isStrongUnlockSecret("short")).toBe(false);
    expect(isStrongUnlockSecret("  long-enough-secret  ")).toBe(true);
  });

  test("encodes and decodes base64url payloads", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = base64UrlEncode(bytes);

    expect(base64UrlDecode(encoded)).toEqual(bytes);
    expect(() => base64UrlDecode("bad!")).toThrow(ClipCryptoError);
    expect(toArrayBuffer(bytes)).toEqual(bytes.buffer.slice(0));
  });

  test("handles ArrayBuffer input for binary encrypt/decrypt", async () => {
    const secret = "very-strong-secret";
    const arrayBuffer = new Uint8Array([5, 6, 7, 8]).buffer;
    const encrypted = await encryptBinaryPayload(secret, arrayBuffer);
    const decrypted = await decryptBinaryPayload(secret, encrypted.ciphertext, encrypted.meta);
    expect(decrypted).toEqual(new Uint8Array([5, 6, 7, 8]));
  });

  test("encrypts and decrypts text, html, and binary payloads", async () => {
    const secret = "very-strong-secret";

    const text = await encryptTextPayload(secret, "hello");
    expect(await decryptTextPayload(secret, text.ciphertext, text.meta)).toBe("hello");

    const html = await encryptHtmlPayload(secret, "<b>hello</b>");
    expect(await decryptHtmlPayload(secret, html.ciphertext, html.meta)).toBe("<b>hello</b>");

    const binary = await encryptBinaryPayload(secret, new Uint8Array([1, 2, 3, 4]));
    expect(await decryptBinaryPayload(secret, binary.ciphertext, binary.meta)).toEqual(
      new Uint8Array([1, 2, 3, 4])
    );
  });

  test("rejects wrong secrets and payload mismatches", async () => {
    const secret = "very-strong-secret";
    const encrypted = await encryptTextPayload(secret, "hello");

    await expect(
      decryptTextPayload("different-strong-secret", encrypted.ciphertext, encrypted.meta)
    ).rejects.toBeInstanceOf(WrongUnlockSecretError);

    await expect(
      decryptHtmlPayload(secret, encrypted.ciphertext, encrypted.meta)
    ).rejects.toBeInstanceOf(ClipCryptoError);
  });

  test("wraps non-DOMException decrypt errors in ClipCryptoError", async () => {
    // Encrypt with the real crypto first
    const secret = "very-strong-secret";
    const encrypted = await encryptTextPayload(secret, "hello");

    // Now replace subtle.decrypt to throw a non-DOMException error
    const originalDecrypt = globalThis.crypto.subtle.decrypt.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, "decrypt").mockRejectedValue(
      new TypeError("some unexpected error")
    );

    await expect(
      decryptTextPayload(secret, encrypted.ciphertext, encrypted.meta)
    ).rejects.toBeInstanceOf(ClipCryptoError);

    await expect(
      decryptTextPayload(secret, encrypted.ciphertext, encrypted.meta)
    ).rejects.toThrow("some unexpected error");

    vi.mocked(globalThis.crypto.subtle.decrypt).mockRestore();
  });

  test("wraps non-Error decrypt throws in ClipCryptoError with fallback message", async () => {
    const secret = "very-strong-secret";
    const encrypted = await encryptTextPayload(secret, "hello");

    vi.spyOn(globalThis.crypto.subtle, "decrypt").mockRejectedValue("string-error");

    await expect(
      decryptTextPayload(secret, encrypted.ciphertext, encrypted.meta)
    ).rejects.toThrow("Failed to decrypt clip");

    vi.mocked(globalThis.crypto.subtle.decrypt).mockRestore();
  });

  test("fails cleanly when web crypto is unavailable", async () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });

    expect(() => generateUnlockSecret()).toThrow(ClipCryptoError);
    await expect(encryptTextPayload("strong-secret", "hello")).rejects.toBeInstanceOf(
      ClipCryptoError
    );
  });
});

describe("master key derivation", () => {
  test("deriveMasterKey returns a non-extractable CryptoKey", async () => {
    const masterKey = await deriveMasterKey("test-passphrase-long-enough");
    expect(masterKey.extractable).toBe(false);
    expect(masterKey.algorithm).toEqual({ name: "HKDF" });
    expect(masterKey.usages).toEqual(["deriveKey"]);
  });

  test("same passphrase produces same derived clip key", async () => {
    const mk1 = await deriveMasterKey("deterministic-test-secret");
    const mk2 = await deriveMasterKey("deterministic-test-secret");
    const salt = new Uint8Array(16);
    const iv = new Uint8Array(12);
    const key1 = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("elpasto-clip-v2") },
      mk1, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
    const key2 = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("elpasto-clip-v2") },
      mk2, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
    const plaintext = new TextEncoder().encode("hello");
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key1, plaintext);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, ct);
    expect(new TextDecoder().decode(pt)).toBe("hello");
  });

  test("different passphrases produce different master keys", async () => {
    const mk1 = await deriveMasterKey("passphrase-alpha-12chars");
    const mk2 = await deriveMasterKey("passphrase-bravo-12chars");
    const salt = new Uint8Array(16);
    const iv = new Uint8Array(12);
    const key1 = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("elpasto-clip-v2") },
      mk1, { name: "AES-GCM", length: 256 }, false, ["encrypt"]
    );
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, key1, new TextEncoder().encode("test")
    );
    const key2 = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("elpasto-clip-v2") },
      mk2, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
    await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, ct)).rejects.toThrow();
  });

  test("exportKey rejects non-extractable master key", async () => {
    const mk = await deriveMasterKey("test-passphrase-long-enough");
    await expect(crypto.subtle.exportKey("raw", mk)).rejects.toThrow();
  });
});

describe("v2 encrypt/decrypt", () => {
  let masterKey: CryptoKey;
  beforeAll(async () => {
    masterKey = await deriveMasterKey("test-secret-long-enough");
  });

  test("text round-trip", async () => {
    const { ciphertext, meta } = await encryptTextPayloadV2(masterKey, "hello v2");
    expect(meta.v).toBe(2);
    expect(meta.kdf).toBe("HKDF-SHA256");
    expect((meta as { iterations?: number }).iterations).toBeUndefined();
    expect(await decryptTextPayloadV2(masterKey, ciphertext, meta)).toBe("hello v2");
  });

  test("html round-trip", async () => {
    const { ciphertext, meta } = await encryptHtmlPayloadV2(masterKey, "<b>hello v2</b>");
    expect(meta.v).toBe(2);
    expect(meta.payload).toBe("html");
    expect(await decryptHtmlPayloadV2(masterKey, ciphertext, meta)).toBe("<b>hello v2</b>");
  });

  test("binary round-trip", async () => {
    const input = new Uint8Array([10, 20, 30, 40]);
    const { ciphertext, meta } = await encryptBinaryPayloadV2(masterKey, input);
    expect(meta.v).toBe(2);
    expect(meta.payload).toBe("binary");
    expect(await decryptBinaryPayloadV2(masterKey, ciphertext, meta)).toEqual(input);
  });

  test("wrong master key fails to decrypt", async () => {
    const { ciphertext, meta } = await encryptTextPayloadV2(masterKey, "secret text");
    const wrongKey = await deriveMasterKey("completely-different-passphrase");
    await expect(decryptTextPayloadV2(wrongKey, ciphertext, meta)).rejects.toBeInstanceOf(
      WrongUnlockSecretError
    );
  });

  test("normal-mode peer decrypts v2 clip via ephemeral master key", async () => {
    const passphrase = "shared-passphrase-long";
    const mk1 = await deriveMasterKey(passphrase);
    const { ciphertext, meta } = await encryptTextPayloadV2(mk1, "cross-mode message");
    // Normal-mode peer derives the same master key from the same passphrase
    const mk2 = await deriveMasterKey(passphrase);
    expect(await decryptTextPayloadV2(mk2, ciphertext, meta)).toBe("cross-mode message");
  });
});

describe("v2 decrypt edge cases", () => {
  let masterKey: CryptoKey;
  beforeAll(async () => {
    masterKey = await deriveMasterKey("v2-edge-case-secret");
  });

  test("rejects payload type mismatch in v2 decryption", async () => {
    // Encrypt as binary, try to decrypt as text
    const { ciphertext, meta } = await encryptBinaryPayloadV2(masterKey, new Uint8Array([1, 2]));
    await expect(
      decryptTextPayloadV2(masterKey, base64UrlEncode(ciphertext), meta)
    ).rejects.toThrow("Encrypted payload type binary is not supported here");
  });

  test("wraps non-DOMException v2 decrypt errors in ClipCryptoError", async () => {
    const { ciphertext, meta } = await encryptTextPayloadV2(masterKey, "hello");
    vi.spyOn(globalThis.crypto.subtle, "decrypt").mockRejectedValue(
      new TypeError("unexpected v2 error")
    );
    await expect(
      decryptTextPayloadV2(masterKey, ciphertext, meta)
    ).rejects.toThrow("unexpected v2 error");
    vi.mocked(globalThis.crypto.subtle.decrypt).mockRestore();
  });

  test("wraps non-Error v2 decrypt throws with fallback message", async () => {
    const { ciphertext, meta } = await encryptTextPayloadV2(masterKey, "hello");
    vi.spyOn(globalThis.crypto.subtle, "decrypt").mockRejectedValue("string-error-v2");
    await expect(
      decryptTextPayloadV2(masterKey, ciphertext, meta)
    ).rejects.toThrow("Failed to decrypt clip");
    vi.mocked(globalThis.crypto.subtle.decrypt).mockRestore();
  });
});

describe("unified dispatch", () => {
  test("normal handle encrypts v1, paranoid handle encrypts v2", async () => {
    const passphrase = "unified-test-passphrase";
    const normalHandle: SecretHandle = { mode: "normal", secret: passphrase };
    const paranoidHandle: SecretHandle = {
      mode: "paranoid",
      masterKey: await deriveMasterKey(passphrase),
    };

    const v1Result = await encryptTextWithHandle(normalHandle, "normal text");
    expect(v1Result.meta.v).toBe(1);

    const v2Result = await encryptTextWithHandle(paranoidHandle, "paranoid text");
    expect(v2Result.meta.v).toBe(2);
  });

  test("paranoid handle decrypts v2 text clip successfully", async () => {
    const passphrase = "paranoid-v2-decrypt-test";
    const mk = await deriveMasterKey(passphrase);
    const paranoidHandle: SecretHandle = { mode: "paranoid", masterKey: mk };
    const { ciphertext, meta } = await encryptTextPayloadV2(mk, "paranoid decrypt test");
    expect(await decryptTextWithHandle(paranoidHandle, ciphertext, meta)).toBe(
      "paranoid decrypt test"
    );
  });

  test("normal handle decrypts v2 clip via ephemeral derivation", async () => {
    const passphrase = "shared-long-passphrase";
    const mk = await deriveMasterKey(passphrase);
    // Paranoid side encrypts
    const { ciphertext, meta } = await encryptTextPayloadV2(mk, "hello from paranoid");
    // Normal-mode peer decrypts using secret string — should derive master key internally
    const normalHandle: SecretHandle = { mode: "normal", secret: passphrase };
    expect(await decryptTextWithHandle(normalHandle, ciphertext, meta)).toBe(
      "hello from paranoid"
    );
  });

  test("normal handle decrypts v1 text clip via decryptTextWithHandle", async () => {
    const passphrase = "normal-v1-text-pass";
    const normalHandle: SecretHandle = { mode: "normal", secret: passphrase };
    const { ciphertext, meta } = await encryptTextPayload(passphrase, "v1 text clip");
    expect(meta.v).toBe(1);
    expect(await decryptTextWithHandle(normalHandle, ciphertext, meta)).toBe("v1 text clip");
  });

  test("paranoid handle rejects v1 text clips even when a callback is provided", async () => {
    const passphrase = "old-passphrase-long";
    const { ciphertext, meta } = await encryptTextPayload(passphrase, "legacy clip");
    const paranoidHandle: SecretHandle = {
      mode: "paranoid",
      masterKey: await deriveMasterKey(passphrase),
    };
    await expect(decryptTextWithHandle(paranoidHandle, ciphertext, meta)).rejects.toBeInstanceOf(
      ClipCryptoError
    );
    await expect(
      decryptTextWithHandle(paranoidHandle, ciphertext, meta, async () => passphrase)
    ).rejects.toBeInstanceOf(ClipCryptoError);
  });

  test("encryptHtmlWithHandle: normal handle produces v1", async () => {
    const normalHandle: SecretHandle = { mode: "normal", secret: "html-normal-enc-pass" };
    const { meta } = await encryptHtmlWithHandle(normalHandle, "<p>v1 html</p>");
    expect(meta.v).toBe(1);
  });

  test("html unified dispatch round-trip", async () => {
    const passphrase = "html-unified-test-pass";
    const paranoidHandle: SecretHandle = {
      mode: "paranoid",
      masterKey: await deriveMasterKey(passphrase),
    };
    const { ciphertext, meta } = await encryptHtmlWithHandle(paranoidHandle, "<em>v2 html</em>");
    expect(meta.v).toBe(2);
    expect(await decryptHtmlWithHandle(paranoidHandle, ciphertext, meta)).toBe("<em>v2 html</em>");
  });

  test("decryptHtmlWithHandle: v1 clip + normal handle", async () => {
    const passphrase = "html-normal-v1-pass";
    const normalHandle: SecretHandle = { mode: "normal", secret: passphrase };
    const plaintext = '{"text":"hello","html":"<b>hello</b>"}';
    const { ciphertext, meta } = await encryptHtmlPayload(passphrase, plaintext);
    expect(meta.v).toBe(1);
    expect(await decryptHtmlWithHandle(normalHandle, ciphertext, meta)).toBe(plaintext);
  });

  test("decryptHtmlWithHandle: v2 clip + normal handle (ephemeral derivation)", async () => {
    const passphrase = "html-normal-v2-pass";
    const mk = await deriveMasterKey(passphrase);
    const normalHandle: SecretHandle = { mode: "normal", secret: passphrase };
    const plaintext = '{"text":"hello","html":"<b>hello</b>"}';
    const { ciphertext, meta } = await encryptHtmlPayloadV2(mk, plaintext);
    expect(meta.v).toBe(2);
    expect(await decryptHtmlWithHandle(normalHandle, ciphertext, meta)).toBe(plaintext);
  });

  test("decryptHtmlWithHandle: v1 clip + paranoid handle is unsupported", async () => {
    const passphrase = "html-paranoid-v1-pass";
    const paranoidHandle: SecretHandle = {
      mode: "paranoid",
      masterKey: await deriveMasterKey(passphrase),
    };
    const plaintext = '{"text":"hello","html":"<b>hello</b>"}';
    const { ciphertext, meta } = await encryptHtmlPayload(passphrase, plaintext);
    expect(meta.v).toBe(1);
    await expect(
      decryptHtmlWithHandle(paranoidHandle, ciphertext, meta, async () => passphrase)
    ).rejects.toBeInstanceOf(ClipCryptoError);
  });

  test("decryptHtmlWithHandle: v1 clip + paranoid handle + no callback (throws)", async () => {
    const passphrase = "html-paranoid-nocb-pass";
    const paranoidHandle: SecretHandle = {
      mode: "paranoid",
      masterKey: await deriveMasterKey(passphrase),
    };
    const plaintext = '{"text":"hello","html":"<b>hello</b>"}';
    const { ciphertext, meta } = await encryptHtmlPayload(passphrase, plaintext);
    await expect(decryptHtmlWithHandle(paranoidHandle, ciphertext, meta)).rejects.toBeInstanceOf(
      ClipCryptoError
    );
  });

  test("binary unified dispatch round-trip", async () => {
    const passphrase = "binary-unified-test-pass";
    const paranoidHandle: SecretHandle = {
      mode: "paranoid",
      masterKey: await deriveMasterKey(passphrase),
    };
    const input = new Uint8Array([5, 10, 15, 20]);
    const { ciphertext, meta } = await encryptBinaryWithHandle(paranoidHandle, input);
    expect(meta.v).toBe(2);
    expect(await decryptBinaryWithHandle(paranoidHandle, ciphertext, meta)).toEqual(input);
  });

  test("encryptBinaryWithHandle: normal handle produces v1", async () => {
    const passphrase = "binary-normal-enc-pass";
    const normalHandle: SecretHandle = { mode: "normal", secret: passphrase };
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const { meta } = await encryptBinaryWithHandle(normalHandle, input);
    expect(meta.v).toBe(1);
  });

  test("decryptBinaryWithHandle: v2 clip + paranoid handle (native HKDF path)", async () => {
    const passphrase = "binary-paranoid-v2-pass";
    const mk = await deriveMasterKey(passphrase);
    const paranoidHandle: SecretHandle = { mode: "paranoid", masterKey: mk };
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const { ciphertext, meta } = await encryptBinaryPayloadV2(mk, input);
    expect(meta.v).toBe(2);
    expect(await decryptBinaryWithHandle(paranoidHandle, ciphertext, meta)).toEqual(input);
  });

  test("decryptBinaryWithHandle: v2 clip + normal handle (ephemeral derivation)", async () => {
    const passphrase = "binary-normal-v2-pass";
    const mk = await deriveMasterKey(passphrase);
    const normalHandle: SecretHandle = { mode: "normal", secret: passphrase };
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const { ciphertext, meta } = await encryptBinaryPayloadV2(mk, input);
    expect(meta.v).toBe(2);
    expect(await decryptBinaryWithHandle(normalHandle, ciphertext, meta)).toEqual(input);
  });

  test("decryptBinaryWithHandle: v1 clip + normal handle (direct PBKDF2 path)", async () => {
    const passphrase = "binary-normal-v1-pass";
    const normalHandle: SecretHandle = { mode: "normal", secret: passphrase };
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const { ciphertext, meta } = await encryptBinaryPayload(passphrase, input);
    expect(meta.v).toBe(1);
    expect(await decryptBinaryWithHandle(normalHandle, ciphertext, meta)).toEqual(input);
  });

  test("decryptBinaryWithHandle: v1 clip + paranoid handle is unsupported", async () => {
    const passphrase = "binary-paranoid-v1-pass";
    const paranoidHandle: SecretHandle = {
      mode: "paranoid",
      masterKey: await deriveMasterKey(passphrase),
    };
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const { ciphertext, meta } = await encryptBinaryPayload(passphrase, input);
    expect(meta.v).toBe(1);
    await expect(
      decryptBinaryWithHandle(paranoidHandle, ciphertext, meta, async () => passphrase)
    ).rejects.toBeInstanceOf(ClipCryptoError);
  });

  test("decryptBinaryWithHandle: v1 clip + paranoid handle + no callback (throws)", async () => {
    const passphrase = "binary-paranoid-nocb-pass";
    const paranoidHandle: SecretHandle = {
      mode: "paranoid",
      masterKey: await deriveMasterKey(passphrase),
    };
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const { ciphertext, meta } = await encryptBinaryPayload(passphrase, input);
    await expect(
      decryptBinaryWithHandle(paranoidHandle, ciphertext, meta)
    ).rejects.toBeInstanceOf(ClipCryptoError);
  });
});
