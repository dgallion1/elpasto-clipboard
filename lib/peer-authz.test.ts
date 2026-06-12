import { describe, test, expect } from "vitest";
import { mayAcceptClipStart, mayReplaceClip, mayDeleteClip } from "@/lib/peer-authz";

describe("mayAcceptClipStart (H4a — no resurrection)", () => {
  test("accepts a clip that is not tombstoned", () => {
    expect(mayAcceptClipStart({ tombstoned: false })).toBe(true);
  });

  test("rejects a clip that was previously deleted (tombstoned)", () => {
    expect(mayAcceptClipStart({ tombstoned: true })).toBe(false);
  });
});

describe("mayReplaceClip (H4b — only the source peer may overwrite)", () => {
  test("allows the source peer to replace its own clip", () => {
    expect(mayReplaceClip({ sourcePeerId: "p1", senderPeerId: "p1", tombstoned: false })).toBe(true);
  });

  test("rejects a different peer overwriting (the swap attack)", () => {
    expect(mayReplaceClip({ sourcePeerId: "p1", senderPeerId: "p2", tombstoned: false })).toBe(false);
  });

  test("rejects replacing a clip with no known source", () => {
    expect(mayReplaceClip({ sourcePeerId: undefined, senderPeerId: "p2", tombstoned: false })).toBe(false);
  });

  test("rejects replacing a tombstoned clip even by its source", () => {
    expect(mayReplaceClip({ sourcePeerId: "p1", senderPeerId: "p1", tombstoned: true })).toBe(false);
  });
});

describe("mayDeleteClip (H2 — only the source peer may delete/tombstone)", () => {
  test("allows the source peer to delete its own clip", () => {
    expect(mayDeleteClip({ sourcePeerId: "p1", senderPeerId: "p1" })).toBe(true);
  });

  test("rejects a peer deleting a clip it did not provide (griefing/mass-delete)", () => {
    expect(mayDeleteClip({ sourcePeerId: "p1", senderPeerId: "p2" })).toBe(false);
  });

  test("rejects deleting a clip with no known source (e.g. our own authored clip)", () => {
    expect(mayDeleteClip({ sourcePeerId: undefined, senderPeerId: "p2" })).toBe(false);
  });
});
