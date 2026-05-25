import { describe, expect, test } from "vitest";
import {
  CLIP_ENCRYPTION_KDF,
  CLIP_ENCRYPTION_VERSION,
  CLIP_ENCRYPTION_VERSION_V2,
  CLIP_ENCRYPTION_KDF_V2,
} from "./clip-encryption";

describe("clip-encryption constants", () => {
  test("exposes the expected version and KDF", () => {
    expect(CLIP_ENCRYPTION_VERSION).toBe(1);
    expect(CLIP_ENCRYPTION_KDF).toBe("PBKDF2-SHA256");
  });

  test("exposes v2 constants", () => {
    expect(CLIP_ENCRYPTION_VERSION_V2).toBe(2);
    expect(CLIP_ENCRYPTION_KDF_V2).toBe("HKDF-SHA256");
  });
});
