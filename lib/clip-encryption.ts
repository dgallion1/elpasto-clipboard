export const CLIP_ENCRYPTION_VERSION = 1;
export const CLIP_ENCRYPTION_KDF = "PBKDF2-SHA256" as const;

export interface ClipEncryptionMetaV1 {
  v: 1;
  kdf: typeof CLIP_ENCRYPTION_KDF;
  iterations: number;
  salt: string;
  iv: string;
  payload: "text" | "html" | "binary";
}

export const CLIP_ENCRYPTION_VERSION_V2 = 2;
export const CLIP_ENCRYPTION_KDF_V2 = "HKDF-SHA256" as const;

export interface ClipEncryptionMetaV2 {
  v: 2;
  kdf: typeof CLIP_ENCRYPTION_KDF_V2;
  salt: string;
  iv: string;
  payload: "text" | "html" | "binary";
}

export type ClipEncryptionMeta = ClipEncryptionMetaV1 | ClipEncryptionMetaV2;
