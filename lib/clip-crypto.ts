"use client";

import {
  CLIP_ENCRYPTION_KDF,
  CLIP_ENCRYPTION_KDF_V2,
  CLIP_ENCRYPTION_VERSION,
  CLIP_ENCRYPTION_VERSION_V2,
  type ClipEncryptionMeta,
  type ClipEncryptionMetaV1,
  type ClipEncryptionMetaV2,
} from "./clip-encryption";

const PBKDF2_ITERATIONS = 210_000;
const GENERATED_SECRET_BYTES = 16;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AES_KEY_LENGTH = 256;
const BASE64_CHUNK_SIZE = 0x8000;
const MIN_SECRET_LENGTH = 12;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class ClipCryptoError extends Error {}

export class WrongUnlockSecretError extends ClipCryptoError {}

export function generateUnlockSecret(): string {
  return base64UrlEncode(randomBytes(GENERATED_SECRET_BYTES));
}

export function normalizeUnlockSecret(secret: string): string {
  return secret.trim();
}

export function isStrongUnlockSecret(secret: string): boolean {
  return normalizeUnlockSecret(secret).length >= MIN_SECRET_LENGTH;
}

export async function encryptTextPayload(
  secret: string,
  plaintext: string
): Promise<{ ciphertext: string; meta: ClipEncryptionMetaV1 }> {
  const { ciphertext, meta } = await encryptBytes(
    normalizeUnlockSecret(secret),
    textEncoder.encode(plaintext),
    "text"
  );

  return {
    ciphertext: base64UrlEncode(ciphertext),
    meta,
  };
}

export async function decryptTextPayload(
  secret: string,
  ciphertext: string,
  meta: ClipEncryptionMetaV1
): Promise<string> {
  const plaintext = await decryptBytes(
    normalizeUnlockSecret(secret),
    base64UrlDecode(ciphertext),
    meta,
    "text"
  );

  return textDecoder.decode(plaintext);
}

export async function encryptHtmlPayload(
  secret: string,
  plaintext: string
): Promise<{ ciphertext: string; meta: ClipEncryptionMetaV1 }> {
  const { ciphertext, meta } = await encryptBytes(
    normalizeUnlockSecret(secret),
    textEncoder.encode(plaintext),
    "html"
  );

  return {
    ciphertext: base64UrlEncode(ciphertext),
    meta,
  };
}

export async function decryptHtmlPayload(
  secret: string,
  ciphertext: string,
  meta: ClipEncryptionMetaV1
): Promise<string> {
  const plaintext = await decryptBytes(
    normalizeUnlockSecret(secret),
    base64UrlDecode(ciphertext),
    meta,
    "html"
  );

  return textDecoder.decode(plaintext);
}

export async function encryptBinaryPayload(
  secret: string,
  plaintext: ArrayBuffer | Uint8Array
): Promise<{ ciphertext: Uint8Array; meta: ClipEncryptionMetaV1 }> {
  return encryptBytes(normalizeUnlockSecret(secret), normalizeBytes(plaintext), "binary");
}

export async function decryptBinaryPayload(
  secret: string,
  ciphertext: ArrayBuffer | Uint8Array,
  meta: ClipEncryptionMetaV1
): Promise<Uint8Array> {
  return decryptBytes(
    normalizeUnlockSecret(secret),
    normalizeBytes(ciphertext),
    meta,
    "binary"
  );
}

export function base64UrlEncode(bytes: Uint8Array): string {
  const binaryChunks: string[] = [];

  for (let index = 0; index < bytes.length; index += BASE64_CHUNK_SIZE) {
    binaryChunks.push(
      String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK_SIZE))
    );
  }

  return btoa(binaryChunks.join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!value || /[^A-Za-z0-9_-]/.test(value)) {
    throw new ClipCryptoError("Invalid encrypted payload encoding");
  }

  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const base64 = padded.padEnd(Math.ceil(padded.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function encryptBytes(
  secret: string,
  plaintext: Uint8Array,
  payload: ClipEncryptionMetaV1["payload"]
): Promise<{ ciphertext: Uint8Array; meta: ClipEncryptionMetaV1 }> {
  const cryptoApi = getWebCrypto();
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveAesKey(secret, salt, PBKDF2_ITERATIONS);
  const ciphertext = await cryptoApi.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plaintext)
  );

  return {
    ciphertext: new Uint8Array(ciphertext),
    meta: {
      v: CLIP_ENCRYPTION_VERSION,
      kdf: CLIP_ENCRYPTION_KDF,
      iterations: PBKDF2_ITERATIONS,
      salt: base64UrlEncode(salt),
      iv: base64UrlEncode(iv),
      payload,
    },
  };
}

async function decryptBytes(
  secret: string,
  ciphertext: Uint8Array,
  meta: ClipEncryptionMetaV1,
  payload: ClipEncryptionMetaV1["payload"]
): Promise<Uint8Array> {
  if (meta.payload !== payload) {
    throw new ClipCryptoError(`Encrypted payload type ${meta.payload} is not supported here`);
  }

  const cryptoApi = getWebCrypto();
  const key = await deriveAesKey(secret, base64UrlDecode(meta.salt), meta.iterations);

  try {
    const plaintext = await cryptoApi.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64UrlDecode(meta.iv)) },
      key,
      toArrayBuffer(ciphertext)
    );

    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof DOMException && error.name === "OperationError") {
      throw new WrongUnlockSecretError("Wrong unlock secret");
    }

    throw new ClipCryptoError(
      error instanceof Error ? error.message : "Failed to decrypt clip"
    );
  }
}

async function deriveAesKey(
  secret: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const cryptoApi = getWebCrypto();
  const keyMaterial = await cryptoApi.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return cryptoApi.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      iterations,
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: AES_KEY_LENGTH,
    },
    false,
    ["encrypt", "decrypt"]
  );
}

export type SecretHandle =
  | { mode: "normal"; secret: string }
  | { mode: "paranoid"; masterKey: CryptoKey };

const MASTER_SALT_INFO = "elpasto-paranoid-v2-salt";
const CLIP_V2_INFO = "elpasto-clip-v2";

let cachedMasterSalt: ArrayBuffer | null = null;

async function getMasterSalt(): Promise<ArrayBuffer> {
  if (cachedMasterSalt) return cachedMasterSalt;
  cachedMasterSalt = await getWebCrypto().subtle.digest(
    "SHA-256",
    textEncoder.encode(MASTER_SALT_INFO)
  );
  return cachedMasterSalt;
}

export async function deriveMasterKey(passphrase: string): Promise<CryptoKey> {
  const cryptoApi = getWebCrypto();
  const masterSalt = await getMasterSalt();
  const keyMaterial = await cryptoApi.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const masterKeyBits = await cryptoApi.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: masterSalt,
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    AES_KEY_LENGTH
  );
  return cryptoApi.subtle.importKey(
    "raw",
    masterKeyBits,
    "HKDF",
    false,
    ["deriveKey"]
  );
}

function getWebCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new ClipCryptoError("Web Crypto is not available in this browser");
  }

  return globalThis.crypto;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getWebCrypto().getRandomValues(bytes);
  return bytes;
}

function normalizeBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

// ---------------------------------------------------------------------------
// v2 HKDF-based encrypt/decrypt
// ---------------------------------------------------------------------------

const CLIP_V2_INFO_BYTES = textEncoder.encode(CLIP_V2_INFO);

async function deriveClipKeyV2(masterKey: CryptoKey, salt: Uint8Array): Promise<CryptoKey> {
  return getWebCrypto().subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(salt), info: CLIP_V2_INFO_BYTES },
    masterKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptBytesV2(
  masterKey: CryptoKey,
  plaintext: Uint8Array,
  payload: ClipEncryptionMetaV2["payload"]
): Promise<{ ciphertext: Uint8Array; meta: ClipEncryptionMetaV2 }> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveClipKeyV2(masterKey, salt);
  const ciphertext = await getWebCrypto().subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plaintext)
  );
  return {
    ciphertext: new Uint8Array(ciphertext),
    meta: {
      v: CLIP_ENCRYPTION_VERSION_V2,
      kdf: CLIP_ENCRYPTION_KDF_V2,
      salt: base64UrlEncode(salt),
      iv: base64UrlEncode(iv),
      payload,
    },
  };
}

async function decryptBytesV2(
  masterKey: CryptoKey,
  ciphertext: Uint8Array,
  meta: ClipEncryptionMetaV2,
  payload: ClipEncryptionMetaV2["payload"]
): Promise<Uint8Array> {
  if (meta.payload !== payload) {
    throw new ClipCryptoError(`Encrypted payload type ${meta.payload} is not supported here`);
  }
  const key = await deriveClipKeyV2(masterKey, base64UrlDecode(meta.salt));
  try {
    const plaintext = await getWebCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64UrlDecode(meta.iv)) },
      key,
      toArrayBuffer(ciphertext)
    );
    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof DOMException && error.name === "OperationError") {
      throw new WrongUnlockSecretError("Wrong unlock secret");
    }
    throw new ClipCryptoError(
      error instanceof Error ? error.message : "Failed to decrypt clip"
    );
  }
}

export async function encryptTextPayloadV2(
  masterKey: CryptoKey,
  plaintext: string
): Promise<{ ciphertext: string; meta: ClipEncryptionMetaV2 }> {
  const { ciphertext, meta } = await encryptBytesV2(masterKey, textEncoder.encode(plaintext), "text");
  return { ciphertext: base64UrlEncode(ciphertext), meta };
}

export async function decryptTextPayloadV2(
  masterKey: CryptoKey,
  ciphertext: string,
  meta: ClipEncryptionMetaV2
): Promise<string> {
  const plaintext = await decryptBytesV2(masterKey, base64UrlDecode(ciphertext), meta, "text");
  return textDecoder.decode(plaintext);
}

export async function encryptHtmlPayloadV2(
  masterKey: CryptoKey,
  plaintext: string
): Promise<{ ciphertext: string; meta: ClipEncryptionMetaV2 }> {
  const { ciphertext, meta } = await encryptBytesV2(masterKey, textEncoder.encode(plaintext), "html");
  return { ciphertext: base64UrlEncode(ciphertext), meta };
}

export async function decryptHtmlPayloadV2(
  masterKey: CryptoKey,
  ciphertext: string,
  meta: ClipEncryptionMetaV2
): Promise<string> {
  const plaintext = await decryptBytesV2(masterKey, base64UrlDecode(ciphertext), meta, "html");
  return textDecoder.decode(plaintext);
}

export async function encryptBinaryPayloadV2(
  masterKey: CryptoKey,
  plaintext: ArrayBuffer | Uint8Array
): Promise<{ ciphertext: Uint8Array; meta: ClipEncryptionMetaV2 }> {
  return encryptBytesV2(masterKey, normalizeBytes(plaintext), "binary");
}

export async function decryptBinaryPayloadV2(
  masterKey: CryptoKey,
  ciphertext: ArrayBuffer | Uint8Array,
  meta: ClipEncryptionMetaV2
): Promise<Uint8Array> {
  return decryptBytesV2(masterKey, normalizeBytes(ciphertext), meta, "binary");
}

// ---------------------------------------------------------------------------
// Unified dispatch — routes to v1 or v2 based on SecretHandle mode / meta.v
// ---------------------------------------------------------------------------

export async function encryptTextWithHandle(
  handle: SecretHandle,
  plaintext: string
): Promise<{ ciphertext: string; meta: ClipEncryptionMeta }> {
  if (handle.mode === "paranoid") return encryptTextPayloadV2(handle.masterKey, plaintext);
  return encryptTextPayload(handle.secret, plaintext);
}

export async function decryptTextWithHandle(
  handle: SecretHandle,
  ciphertext: string,
  meta: ClipEncryptionMeta,
  requestRawSecret?: () => Promise<string | null>
): Promise<string> {
  if (meta.v === 2) {
    const mk =
      handle.mode === "paranoid" ? handle.masterKey : await deriveMasterKey(handle.secret);
    return decryptTextPayloadV2(mk, ciphertext, meta);
  }
  if (handle.mode === "normal") return decryptTextPayload(handle.secret, ciphertext, meta);
  void requestRawSecret;
  throw new ClipCryptoError("Paranoid mode only supports v2 clips");
}

export async function encryptHtmlWithHandle(
  handle: SecretHandle,
  plaintext: string
): Promise<{ ciphertext: string; meta: ClipEncryptionMeta }> {
  if (handle.mode === "paranoid") return encryptHtmlPayloadV2(handle.masterKey, plaintext);
  return encryptHtmlPayload(handle.secret, plaintext);
}

export async function decryptHtmlWithHandle(
  handle: SecretHandle,
  ciphertext: string,
  meta: ClipEncryptionMeta,
  requestRawSecret?: () => Promise<string | null>
): Promise<string> {
  if (meta.v === 2) {
    const mk =
      handle.mode === "paranoid" ? handle.masterKey : await deriveMasterKey(handle.secret);
    return decryptHtmlPayloadV2(mk, ciphertext, meta);
  }
  if (handle.mode === "normal") return decryptHtmlPayload(handle.secret, ciphertext, meta);
  void requestRawSecret;
  throw new ClipCryptoError("Paranoid mode only supports v2 clips");
}

export async function encryptBinaryWithHandle(
  handle: SecretHandle,
  plaintext: ArrayBuffer | Uint8Array
): Promise<{ ciphertext: Uint8Array; meta: ClipEncryptionMeta }> {
  if (handle.mode === "paranoid") return encryptBinaryPayloadV2(handle.masterKey, plaintext);
  return encryptBinaryPayload(handle.secret, plaintext);
}

export async function decryptBinaryWithHandle(
  handle: SecretHandle,
  ciphertext: ArrayBuffer | Uint8Array,
  meta: ClipEncryptionMeta,
  requestRawSecret?: () => Promise<string | null>
): Promise<Uint8Array> {
  if (meta.v === 2) {
    const mk =
      handle.mode === "paranoid" ? handle.masterKey : await deriveMasterKey(handle.secret);
    return decryptBinaryPayloadV2(mk, normalizeBytes(ciphertext), meta);
  }
  if (handle.mode === "normal")
    return decryptBinaryPayload(handle.secret, ciphertext, meta);
  void requestRawSecret;
  throw new ClipCryptoError("Paranoid mode only supports v2 clips");
}
