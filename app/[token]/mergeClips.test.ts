import { describe, expect, test } from "vitest";
import type { Clip } from "@/lib/clips";
import { mergeClips } from "./mergeClips";

function buildClip(overrides: Partial<Clip>): Clip {
  return {
    id: 1,
    session_id: 1,
    zone: "A",
    kind: "text",
    client_transfer_id: null,
    mime_type: null,
    text_content: null,
    html_content: null,
    storage_key: null,
    original_name: null,
    size_bytes: null,
    encrypted: false,
    encryption_version: null,
    encryption_meta: null,
    created_at: "2026-03-08T10:00:00Z",
    ...overrides,
  };
}

describe("mergeClips", () => {
  test("replaces local_only clip with canonical (non-local) clip sharing the same transfer id", () => {
    const localClip = buildClip({
      id: -1,
      client_transfer_id: "t1",
      local_only: true,
      local_origin: "sender",
      created_at: "2026-03-08T10:00:00Z",
    });
    const canonicalClip = buildClip({
      id: 101,
      client_transfer_id: "t1",
      local_only: false,
      created_at: "2026-03-08T10:00:00Z",
    });

    const result = mergeClips([localClip], [canonicalClip]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(101);
    expect(result[0].local_only).toBeFalsy();
  });

  test("prefers sender clip over receiver clip with the same transfer id", () => {
    const receiverClip = buildClip({
      id: -2,
      client_transfer_id: "t2",
      local_only: true,
      local_origin: "receiver",
      created_at: "2026-03-08T10:00:00Z",
    });
    const senderClip = buildClip({
      id: -1,
      client_transfer_id: "t2",
      local_only: true,
      local_origin: "sender",
      created_at: "2026-03-08T10:00:00Z",
    });

    const result = mergeClips([receiverClip], [senderClip]);
    expect(result).toHaveLength(1);
    expect(result[0].local_origin).toBe("sender");
  });

  test("does not replace non-local clip with local_only clip", () => {
    const canonicalClip = buildClip({
      id: 101,
      client_transfer_id: "t3",
      local_only: false,
      created_at: "2026-03-08T10:00:00Z",
    });
    const localClip = buildClip({
      id: -1,
      client_transfer_id: "t3",
      local_only: true,
      local_origin: "sender",
      created_at: "2026-03-08T10:00:00Z",
    });

    const result = mergeClips([canonicalClip], [localClip]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(101);
  });

  test("does not replace sender clip with receiver clip", () => {
    const senderClip = buildClip({
      id: -1,
      client_transfer_id: "t4",
      local_only: true,
      local_origin: "sender",
      created_at: "2026-03-08T10:00:00Z",
    });
    const receiverClip = buildClip({
      id: -2,
      client_transfer_id: "t4",
      local_only: true,
      local_origin: "receiver",
      created_at: "2026-03-08T10:00:00Z",
    });

    const result = mergeClips([senderClip], [receiverClip]);
    expect(result).toHaveLength(1);
    expect(result[0].local_origin).toBe("sender");
  });

  test("deduplicates clips by file signature (image/file with same zone, kind, name, created_at, size)", () => {
    const clip1 = buildClip({
      id: 1,
      kind: "image",
      zone: "A",
      original_name: "photo.png",
      size_bytes: 1024,
      created_at: "2026-03-08T10:00:00Z",
    });
    const clip2 = buildClip({
      id: 2,
      kind: "image",
      zone: "A",
      original_name: "photo.png",
      size_bytes: 1024,
      created_at: "2026-03-08T10:00:00Z",
    });

    const result = mergeClips([clip1], [clip2]);
    expect(result).toHaveLength(1);
  });

  test("keeps distinct clips with different ids and no transfer id", () => {
    const clip1 = buildClip({ id: 1, created_at: "2026-03-08T10:00:00Z" });
    const clip2 = buildClip({ id: 2, created_at: "2026-03-08T10:01:00Z" });

    const result = mergeClips([clip1], [clip2]);
    expect(result).toHaveLength(2);
  });

  test("sorts results newest first", () => {
    const older = buildClip({ id: 1, created_at: "2026-03-08T10:00:00Z" });
    const newer = buildClip({ id: 2, created_at: "2026-03-08T10:01:00Z" });

    const result = mergeClips([older], [newer]);
    expect(result[0].id).toBe(2);
    expect(result[1].id).toBe(1);
  });
});
