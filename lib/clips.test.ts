import { describe, expect, test } from "vitest";
import type { Clip } from "./clips";
import { sortClipsNewestFirst } from "./clips";

function makeClip(overrides: Partial<Clip>): Clip {
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
    created_at: "2026-03-11T12:00:00.000Z",
    ...overrides,
  };
}

describe("lib/clips", () => {
  test("sorts newest clips first", () => {
    const older = makeClip({ id: 1, created_at: "2026-03-11T11:00:00.000Z" });
    const newer = makeClip({ id: 2, created_at: "2026-03-11T13:00:00.000Z" });

    expect(sortClipsNewestFirst(older, newer)).toBeGreaterThan(0);
    expect(sortClipsNewestFirst(newer, older)).toBeLessThan(0);
  });
});
