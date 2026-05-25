import { describe, expect, test } from "vitest";
import type { Clip } from "@/lib/clips";
import {
  addClipToGroups,
  allGroupedClips,
  clearClipGroup,
  clipZonesFromGroups,
  clipsFromSession,
  removeClipFromGroups,
} from "./clip-groups";
import type { SessionData } from "./session-page-types";

function makeClip(overrides: Partial<Clip> & { id: number; zone: string }): Clip {
  return {
    session_id: 1,
    kind: "text",
    client_transfer_id: null,
    mime_type: "text/plain",
    text_content: null,
    html_content: null,
    storage_key: null,
    original_name: null,
    size_bytes: 0,
    encrypted: false,
    encryption_version: null,
    encryption_meta: null,
    created_at: "2026-03-08T10:00:00Z",
    local_only: false,
    local_origin: null,
    local_transfer_state: null,
    local_file: null,
    ...overrides,
  } as Clip;
}

describe("clipsFromSession", () => {
  test("groups clips by zone", () => {
    const data: SessionData = {
      token: "t",
      expiresAt: "2026-03-09T10:00:00Z",
      clips: {
        A: [makeClip({ id: 1, zone: "A" }), makeClip({ id: 2, zone: "A" })],
        B: [makeClip({ id: 3, zone: "B" })],
      },
    } as unknown as SessionData;

    const groups = clipsFromSession(data);
    expect(groups.A.map((c) => c.id)).toEqual([1, 2]);
    expect(groups.B.map((c) => c.id)).toEqual([3]);
  });

  test("re-groups by clip.zone, not by container key", () => {
    // Server sends clips inside zone-keyed buckets, but we regroup by the
    // clip's own zone field — this guards against drift between the two.
    const data: SessionData = {
      token: "t",
      expiresAt: "2026-03-09T10:00:00Z",
      clips: {
        A: [makeClip({ id: 1, zone: "B" })],
      },
    } as unknown as SessionData;

    const groups = clipsFromSession(data);
    expect(groups.A).toBeUndefined();
    expect(groups.B.map((c) => c.id)).toEqual([1]);
  });

  test("returns empty object when clips is missing", () => {
    const data = { token: "t", expiresAt: "2026-03-09T10:00:00Z" } as unknown as SessionData;
    expect(clipsFromSession(data)).toEqual({});
  });
});

describe("allGroupedClips", () => {
  test("flattens groups into a single array", () => {
    const clips = allGroupedClips({
      A: [makeClip({ id: 1, zone: "A" }), makeClip({ id: 2, zone: "A" })],
      B: [makeClip({ id: 3, zone: "B" })],
    });
    expect(clips.map((c) => c.id).sort()).toEqual([1, 2, 3]);
  });

  test("empty input returns empty array", () => {
    expect(allGroupedClips({})).toEqual([]);
  });
});

describe("addClipToGroups", () => {
  test("prepends to existing zone", () => {
    const groups = {
      A: [makeClip({ id: 1, zone: "A" })],
    };
    const next = addClipToGroups(groups, makeClip({ id: 2, zone: "A" }));
    expect(next.A.map((c) => c.id)).toEqual([2, 1]);
  });

  test("creates the zone when missing", () => {
    const next = addClipToGroups({}, makeClip({ id: 5, zone: "X" }));
    expect(next.X.map((c) => c.id)).toEqual([5]);
  });

  test("is a no-op when clip.id is already present", () => {
    const groups = { A: [makeClip({ id: 1, zone: "A" })] };
    const next = addClipToGroups(groups, makeClip({ id: 1, zone: "A" }));
    expect(next).toBe(groups);
  });
});

describe("removeClipFromGroups", () => {
  test("removes by id from the named zone", () => {
    const groups = {
      A: [makeClip({ id: 1, zone: "A" }), makeClip({ id: 2, zone: "A" })],
      B: [makeClip({ id: 3, zone: "B" })],
    };
    const next = removeClipFromGroups(groups, 1, "A");
    expect(next.A.map((c) => c.id)).toEqual([2]);
    expect(next.B.map((c) => c.id)).toEqual([3]);
  });

  test("scans every zone when no zone is provided", () => {
    const groups = {
      A: [makeClip({ id: 1, zone: "A" })],
      B: [makeClip({ id: 1, zone: "B" }), makeClip({ id: 9, zone: "B" })],
    };
    const next = removeClipFromGroups(groups, 1);
    expect(next.A).toEqual([]);
    expect(next.B.map((c) => c.id)).toEqual([9]);
  });

  test("named-zone removal of a missing zone returns a group with empty zone", () => {
    const next = removeClipFromGroups({}, 1, "Q");
    expect(next.Q).toEqual([]);
  });
});

describe("clearClipGroup", () => {
  test("clears the named zone", () => {
    const groups = {
      A: [makeClip({ id: 1, zone: "A" })],
      B: [makeClip({ id: 2, zone: "B" })],
    };
    const next = clearClipGroup(groups, "A");
    expect(next.A).toEqual([]);
    expect(next.B.map((c) => c.id)).toEqual([2]);
  });

  test("clears all when no zone is provided", () => {
    const next = clearClipGroup({
      A: [makeClip({ id: 1, zone: "A" })],
      B: [makeClip({ id: 2, zone: "B" })],
    });
    expect(next).toEqual({});
  });
});

describe("clipZonesFromGroups", () => {
  test("returns the union of zones across multiple groups", () => {
    const zones = clipZonesFromGroups(
      { A: [makeClip({ id: 1, zone: "A" })] },
      { B: [makeClip({ id: 2, zone: "B" })], A: [makeClip({ id: 3, zone: "A" })] },
    );
    expect(new Set(zones)).toEqual(new Set(["A", "B"]));
  });

  test("deduplicates zones", () => {
    const zones = clipZonesFromGroups({
      A: [makeClip({ id: 1, zone: "A" }), makeClip({ id: 2, zone: "A" })],
    });
    expect(zones).toEqual(["A"]);
  });

  test("returns empty when no clips exist", () => {
    expect(clipZonesFromGroups({}, {})).toEqual([]);
  });
});
