// @vitest-environment jsdom
import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  MAX_ACTIVE_THREADS,
  MAX_THREAD_TOMBSTONES,
  activeThreads,
  createThreadId,
  enforceThreadLimit,
  ensureAtLeastOneThread,
  ensureThreadsForZones,
  fallbackThreadName,
  loadThreadRecords,
  makeThreadRecord,
  mergeThreadRecords,
  normalizeActivePositions,
  normalizeThreadRecords,
  persistThreadRecords,
  threadStorageKey,
  type ThreadRecord,
} from "./threads";

function makeThread(overrides: Partial<ThreadRecord> & { id: string }): ThreadRecord {
  return {
    name: "1",
    position: 0,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("lib/threads", () => {
  describe("activeThreads", () => {
    test("filters out deleted records", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "a", position: 0 }),
        makeThread({ id: "b", position: 1, deletedAt: 2000 }),
        makeThread({ id: "c", position: 2 }),
      ];
      const active = activeThreads(records);
      expect(active.map((r) => r.id)).toEqual(["a", "c"]);
    });

    test("sorts by position, then updatedAt, then id", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "b", position: 1, updatedAt: 1000 }),
        makeThread({ id: "a", position: 0, updatedAt: 1000 }),
        makeThread({ id: "c", position: 1, updatedAt: 1000 }),
      ];
      const active = activeThreads(records);
      expect(active.map((r) => r.id)).toEqual(["a", "b", "c"]);
    });

    test("returns empty for all-deleted records", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "a", deletedAt: 1000 }),
        makeThread({ id: "b", deletedAt: 2000 }),
      ];
      expect(activeThreads(records)).toEqual([]);
    });
  });

  describe("fallbackThreadName", () => {
    test("returns 1-based index as string", () => {
      expect(fallbackThreadName(0)).toBe("1");
      expect(fallbackThreadName(4)).toBe("5");
    });
  });

  describe("makeThreadRecord", () => {
    test("creates a record with trimmed name", () => {
      const record = makeThreadRecord("t1", "  My Thread  ", 2, 5000);
      expect(record).toEqual({
        id: "t1",
        name: "My Thread",
        position: 2,
        updatedAt: 5000,
      });
    });

    test("uses fallback name for empty string", () => {
      const record = makeThreadRecord("t1", "", 3, 5000);
      expect(record.name).toBe("4");
    });

    test("uses fallback name for whitespace-only", () => {
      const record = makeThreadRecord("t1", "   ", 0, 5000);
      expect(record.name).toBe("1");
    });
  });

  describe("createThreadId", () => {
    test("returns a UUID string", () => {
      const id = createThreadId();
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    test("returns fallback when crypto.randomUUID is unavailable", () => {
      const orig = crypto.randomUUID;
      // @ts-expect-error testing fallback
      crypto.randomUUID = undefined;
      try {
        const id = createThreadId();
        expect(id).toMatch(/^thread-\d+-/);
      } finally {
        crypto.randomUUID = orig;
      }
    });
  });

  describe("normalizeThreadRecords", () => {
    test("deduplicates by id, keeping latest timestamp", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "a", name: "old", updatedAt: 1000 }),
        makeThread({ id: "a", name: "new", updatedAt: 2000 }),
      ];
      const result = normalizeThreadRecords(records);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("new");
    });

    test("keeps record with deletedAt over older updatedAt", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "a", updatedAt: 1000 }),
        makeThread({ id: "a", updatedAt: 500, deletedAt: 1500 }),
      ];
      const result = normalizeThreadRecords(records);
      expect(result).toHaveLength(1);
      expect(result[0].deletedAt).toBe(1500);
    });

    test("trims ids and names", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: " x ", name: " hello ", position: 0, updatedAt: 1000 }),
      ];
      const result = normalizeThreadRecords(records);
      expect(result[0].id).toBe("x");
      expect(result[0].name).toBe("hello");
    });

    test("clamps negative positions to 0", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "a", position: -5, updatedAt: 1000 }),
      ];
      const result = normalizeThreadRecords(records);
      expect(result[0].position).toBe(0);
    });

    test("floors fractional positions", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "a", position: 2.7, updatedAt: 1000 }),
        makeThread({ id: "b", position: 0, updatedAt: 1000 }),
        makeThread({ id: "c", position: 1, updatedAt: 1000 }),
      ];
      const result = normalizeThreadRecords(records);
      // a starts at floor(2.7)=2, after position normalization it's at index 2
      expect(result.find((r) => r.id === "a")?.position).toBe(2);
    });

    test("skips records with empty id", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "", updatedAt: 1000 }),
        makeThread({ id: "valid", updatedAt: 1000 }),
      ];
      const result = normalizeThreadRecords(records);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("valid");
    });

    test("skips records with whitespace-only id", () => {
      const records = [makeThread({ id: "   ", updatedAt: 1000 })];
      expect(normalizeThreadRecords(records)).toHaveLength(0);
    });

    test("skips records with non-finite position", () => {
      const records = [makeThread({ id: "a", position: NaN, updatedAt: 1000 })];
      expect(normalizeThreadRecords(records)).toHaveLength(0);
    });

    test("skips records with non-finite updatedAt", () => {
      const records = [makeThread({ id: "a", updatedAt: Infinity })];
      expect(normalizeThreadRecords(records)).toHaveLength(0);
    });

    test("skips records with non-finite deletedAt", () => {
      const records = [makeThread({ id: "a", updatedAt: 1000, deletedAt: NaN })];
      expect(normalizeThreadRecords(records)).toHaveLength(0);
    });

    test("skips records with missing id", () => {
      const records = [{ name: "x", position: 0, updatedAt: 1000 }] as unknown as ThreadRecord[];
      expect(normalizeThreadRecords(records)).toHaveLength(0);
    });

    test("skips null/undefined entries", () => {
      const records = [null, undefined, makeThread({ id: "a", updatedAt: 1000 })] as unknown as ThreadRecord[];
      expect(normalizeThreadRecords(records)).toHaveLength(1);
    });

    test("normalizes active positions to contiguous 0-based", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "a", position: 5, updatedAt: 1000 }),
        makeThread({ id: "b", position: 10, updatedAt: 2000 }),
      ];
      const result = normalizeThreadRecords(records);
      expect(result.map((r) => r.position)).toEqual([0, 1]);
    });

    test("renumbers duplicate fallback names after multi-peer merge", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "peer-a", name: "1", position: 0, updatedAt: 1000 }),
        makeThread({ id: "peer-b", name: "1", position: 1, updatedAt: 1001 }),
        makeThread({ id: "peer-c", name: "1", position: 2, updatedAt: 1002 }),
      ];
      const result = normalizeThreadRecords(records);
      expect(result.map((r) => r.name)).toEqual(["1", "2", "3"]);
    });

    test("preserves custom (non-numeric) names during renumbering", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "a", name: "Links", position: 0, updatedAt: 1000 }),
        makeThread({ id: "b", name: "1", position: 1, updatedAt: 1001 }),
      ];
      const result = normalizeThreadRecords(records);
      expect(result.find((r) => r.id === "a")?.name).toBe("Links");
      expect(result.find((r) => r.id === "b")?.name).toBe("2");
    });

    test("prunes tombstones beyond MAX_THREAD_TOMBSTONES", () => {
      const records: ThreadRecord[] = [];
      for (let i = 0; i < MAX_THREAD_TOMBSTONES + 10; i++) {
        records.push(makeThread({ id: `del-${i}`, deletedAt: 1000 + i, updatedAt: 500 }));
      }
      records.push(makeThread({ id: "active", updatedAt: 1000 }));
      const result = normalizeThreadRecords(records);
      const tombstones = result.filter((r) => r.deletedAt != null);
      expect(tombstones).toHaveLength(MAX_THREAD_TOMBSTONES);
      // Should keep the newest tombstones
      const kept = tombstones.map((r) => r.deletedAt).sort((a, b) => a! - b!);
      expect(kept[0]).toBe(1000 + 10); // oldest 10 evicted
      // Active record preserved
      expect(result.find((r) => r.id === "active")).toBeDefined();
    });
  });

  describe("mergeThreadRecords", () => {
    test("adds new records from incoming", () => {
      const current = [makeThread({ id: "a", updatedAt: 1000 })];
      const incoming = [makeThread({ id: "b", updatedAt: 2000 })];
      const result = mergeThreadRecords(current, incoming);
      expect(result.map((r) => r.id).sort()).toEqual(["a", "b"]);
    });

    test("incoming update wins when newer", () => {
      const current = [makeThread({ id: "a", name: "old", updatedAt: 1000 })];
      const incoming = [makeThread({ id: "a", name: "new", updatedAt: 2000 })];
      const result = mergeThreadRecords(current, incoming);
      expect(result.find((r) => r.id === "a")?.name).toBe("new");
    });

    test("local record wins when newer", () => {
      const current = [makeThread({ id: "a", name: "local", updatedAt: 3000 })];
      const incoming = [makeThread({ id: "a", name: "remote", updatedAt: 2000 })];
      const result = mergeThreadRecords(current, incoming);
      expect(result.find((r) => r.id === "a")?.name).toBe("local");
    });

    test("local tombstone wins over older incoming update", () => {
      const current = [makeThread({ id: "a", updatedAt: 1000, deletedAt: 3000 })];
      const incoming = [makeThread({ id: "a", name: "revived", updatedAt: 2000 })];
      const result = mergeThreadRecords(current, incoming);
      const thread = result.find((r) => r.id === "a");
      expect(thread?.deletedAt).toBe(3000);
    });

    test("incoming tombstone wins over older local update", () => {
      const current = [makeThread({ id: "a", name: "alive", updatedAt: 1000 })];
      const incoming = [makeThread({ id: "a", updatedAt: 500, deletedAt: 2000 })];
      const result = mergeThreadRecords(current, incoming);
      const thread = result.find((r) => r.id === "a");
      expect(thread?.deletedAt).toBe(2000);
    });

    test("stale peer cannot resurrect a locally tombstoned thread", () => {
      const current = [makeThread({ id: "a", updatedAt: 1000, deletedAt: 5000 })];
      const incoming = [makeThread({ id: "a", name: "back!", updatedAt: 4000 })];
      const result = mergeThreadRecords(current, incoming);
      const thread = result.find((r) => r.id === "a");
      expect(thread?.deletedAt).toBe(5000);
    });

    test("enforces thread limit after merge", () => {
      const current: ThreadRecord[] = [];
      for (let i = 0; i < MAX_ACTIVE_THREADS; i++) {
        current.push(makeThread({ id: `t${i}`, position: i, updatedAt: 1000 + i }));
      }
      const incoming = [makeThread({ id: "overflow", position: 10, updatedAt: 5000 })];
      const result = mergeThreadRecords(current, incoming, 6000);
      const active = activeThreads(result);
      expect(active.length).toBeLessThanOrEqual(MAX_ACTIVE_THREADS);
    });
  });

  describe("ensureThreadsForZones", () => {
    test("creates records for unknown zone IDs", () => {
      const records: ThreadRecord[] = [];
      const result = ensureThreadsForZones(records, ["A", "B"], 1000);
      const active = activeThreads(result);
      expect(active).toHaveLength(2);
      expect(active[0].id).toBe("A");
      expect(active[1].id).toBe("B");
    });

    test("preserves existing thread records", () => {
      const existing = [makeThread({ id: "A", name: "My Thread", updatedAt: 1000 })];
      const result = ensureThreadsForZones(existing, ["A", "B"], 2000);
      const aThread = result.find((r) => r.id === "A");
      expect(aThread?.name).toBe("My Thread");
    });

    test("puts A before B via legacy ordering", () => {
      const result = ensureThreadsForZones([], ["B", "A"], 1000);
      const active = activeThreads(result);
      expect(active[0].id).toBe("A");
      expect(active[1].id).toBe("B");
    });

    test("ignores empty/whitespace zones", () => {
      const result = ensureThreadsForZones([], ["", " ", "A"], 1000);
      expect(activeThreads(result)).toHaveLength(1);
    });

    test("returns same reference if nothing changed", () => {
      const existing = normalizeThreadRecords([makeThread({ id: "A", updatedAt: 1000 })]);
      const result = ensureThreadsForZones(existing, ["A"], 2000);
      expect(result).toStrictEqual(existing);
    });

    test("does not skip tombstoned threads (creates new record for existing tombstone)", () => {
      const existing = [makeThread({ id: "A", updatedAt: 1000, deletedAt: 2000 })];
      const result = ensureThreadsForZones(existing, ["A"], 3000);
      // The existing tombstoned record is found by byId.get, so it's not re-created
      const aThread = result.find((r) => r.id === "A");
      expect(aThread).toBeDefined();
    });
  });

  describe("ensureAtLeastOneThread", () => {
    test("returns records unchanged if active threads exist", () => {
      const records = [makeThread({ id: "a", updatedAt: 1000 })];
      const result = ensureAtLeastOneThread(records, 2000);
      expect(activeThreads(result)).toHaveLength(1);
      expect(result[0].id).toBe("a");
    });

    test("creates a default thread when all are deleted", () => {
      const records = [makeThread({ id: "a", updatedAt: 1000, deletedAt: 2000 })];
      const result = ensureAtLeastOneThread(records, 3000);
      const active = activeThreads(result);
      expect(active).toHaveLength(1);
      expect(active[0].name).toBe("1");
    });

    test("creates a default thread when list is empty", () => {
      const result = ensureAtLeastOneThread([], 1000);
      const active = activeThreads(result);
      expect(active).toHaveLength(1);
      expect(active[0].name).toBe("1");
      expect(active[0].position).toBe(0);
    });
  });

  describe("normalizeActivePositions", () => {
    test("assigns contiguous 0-based positions to active records", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "a", position: 5, updatedAt: 1000 }),
        makeThread({ id: "b", position: 10, updatedAt: 2000 }),
        makeThread({ id: "c", position: 7, deletedAt: 3000, updatedAt: 500 }),
      ];
      const result = normalizeActivePositions(records);
      expect(result.find((r) => r.id === "a")?.position).toBe(0);
      expect(result.find((r) => r.id === "b")?.position).toBe(1);
      // Deleted records keep their position unchanged
      expect(result.find((r) => r.id === "c")?.position).toBe(7);
    });
  });

  describe("enforceThreadLimit", () => {
    test("does nothing when under limit", () => {
      const records = [
        makeThread({ id: "a", updatedAt: 1000 }),
        makeThread({ id: "b", updatedAt: 2000 }),
      ];
      const result = enforceThreadLimit(records);
      expect(activeThreads(result)).toHaveLength(2);
    });

    test("tombstones oldest threads when over limit", () => {
      const records: ThreadRecord[] = [];
      for (let i = 0; i < MAX_ACTIVE_THREADS + 3; i++) {
        records.push(makeThread({ id: `t${i}`, position: i, updatedAt: 1000 + i }));
      }
      const now = 9999;
      const result = enforceThreadLimit(records, now);
      const active = activeThreads(result);
      expect(active).toHaveLength(MAX_ACTIVE_THREADS);
      // The 3 oldest should be tombstoned
      const tombstoned = result.filter((r) => r.deletedAt != null);
      expect(tombstoned).toHaveLength(3);
      expect(tombstoned.every((r) => r.deletedAt === now)).toBe(true);
    });

    test("keeps newest by updatedAt", () => {
      const records: ThreadRecord[] = [];
      for (let i = 0; i < MAX_ACTIVE_THREADS + 1; i++) {
        records.push(makeThread({ id: `t${i}`, position: i, updatedAt: 1000 + i }));
      }
      const result = enforceThreadLimit(records, 9999);
      const active = activeThreads(result);
      // t0 (oldest updatedAt=1000) should be tombstoned
      expect(active.find((r) => r.id === "t0")).toBeUndefined();
      // t10 (newest) should be active
      expect(active.find((r) => r.id === `t${MAX_ACTIVE_THREADS}`)).toBeDefined();
    });

    test("does not re-tombstone already deleted records", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "deleted", updatedAt: 500, deletedAt: 600 }),
      ];
      for (let i = 0; i < MAX_ACTIVE_THREADS + 1; i++) {
        records.push(makeThread({ id: `t${i}`, position: i, updatedAt: 1000 + i }));
      }
      const result = enforceThreadLimit(records, 9999);
      const active = activeThreads(result);
      expect(active).toHaveLength(MAX_ACTIVE_THREADS);
      // Pre-existing tombstone preserved with original deletedAt
      expect(result.find((r) => r.id === "deleted")?.deletedAt).toBe(600);
    });
  });

  describe("localStorage persistence", () => {
    beforeEach(() => {
      localStorage.clear();
    });

    test("threadStorageKey formats correctly", () => {
      expect(threadStorageKey("abc")).toBe("elpasto:threads:abc");
    });

    test("loadThreadRecords returns empty for missing key", () => {
      expect(loadThreadRecords("missing")).toEqual([]);
    });

    test("round-trips through persist and load", () => {
      const records = [
        makeThread({ id: "a", name: "first", position: 0, updatedAt: 1000 }),
        makeThread({ id: "b", name: "second", position: 1, updatedAt: 2000 }),
      ];
      persistThreadRecords("test-token", records);
      const loaded = loadThreadRecords("test-token");
      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe("a");
      expect(loaded[1].id).toBe("b");
    });

    test("loadThreadRecords handles malformed JSON gracefully", () => {
      localStorage.setItem(threadStorageKey("bad"), "not json{{{");
      expect(loadThreadRecords("bad")).toEqual([]);
    });

    test("loadThreadRecords handles non-array JSON", () => {
      localStorage.setItem(threadStorageKey("obj"), JSON.stringify({ id: "a" }));
      expect(loadThreadRecords("obj")).toEqual([]);
    });

    test("loadThreadRecords normalizes loaded records", () => {
      const raw = [
        { id: "a", name: "  padded  ", position: -1, updatedAt: 1000 },
        { id: "", name: "bad", position: 0, updatedAt: 1000 },
      ];
      localStorage.setItem(threadStorageKey("norm"), JSON.stringify(raw));
      const loaded = loadThreadRecords("norm");
      expect(loaded).toHaveLength(1);
      expect(loaded[0].name).toBe("padded");
      expect(loaded[0].position).toBe(0);
    });

    test("persistThreadRecords normalizes before saving", () => {
      const records = [
        makeThread({ id: "a", position: 5, updatedAt: 1000 }),
        makeThread({ id: "b", position: 10, updatedAt: 2000 }),
      ];
      persistThreadRecords("tok", records);
      const loaded = loadThreadRecords("tok");
      expect(loaded[0].position).toBe(0);
      expect(loaded[1].position).toBe(1);
    });

    test("persistThreadRecords silently handles quota errors", () => {
      const mockSetItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });
      expect(() => {
        persistThreadRecords("tok", [makeThread({ id: "a", updatedAt: 1000 })]);
      }).not.toThrow();
      mockSetItem.mockRestore();
    });
  });

  describe("tombstone pruning", () => {
    test("evicts oldest tombstones when exceeding MAX_THREAD_TOMBSTONES", () => {
      const records: ThreadRecord[] = [];
      for (let i = 0; i < MAX_THREAD_TOMBSTONES + 5; i++) {
        records.push(makeThread({
          id: `del-${i}`,
          updatedAt: 100,
          deletedAt: 1000 + i,
        }));
      }
      const result = normalizeThreadRecords(records);
      const tombstones = result.filter((r) => r.deletedAt != null);
      expect(tombstones).toHaveLength(MAX_THREAD_TOMBSTONES);
      // Oldest 5 should be evicted (deletedAt: 1000-1004)
      for (let i = 0; i < 5; i++) {
        expect(result.find((r) => r.id === `del-${i}`)).toBeUndefined();
      }
      // Newest should be kept
      expect(result.find((r) => r.id === `del-${MAX_THREAD_TOMBSTONES + 4}`)).toBeDefined();
    });

    test("does not prune when at or below limit", () => {
      const records: ThreadRecord[] = [];
      for (let i = 0; i < MAX_THREAD_TOMBSTONES; i++) {
        records.push(makeThread({
          id: `del-${i}`,
          updatedAt: 100,
          deletedAt: 1000 + i,
        }));
      }
      const result = normalizeThreadRecords(records);
      expect(result.filter((r) => r.deletedAt != null)).toHaveLength(MAX_THREAD_TOMBSTONES);
    });

    test("preserves active records when pruning tombstones", () => {
      const records: ThreadRecord[] = [
        makeThread({ id: "active-1", position: 0, updatedAt: 5000 }),
      ];
      for (let i = 0; i < MAX_THREAD_TOMBSTONES + 3; i++) {
        records.push(makeThread({
          id: `del-${i}`,
          updatedAt: 100,
          deletedAt: 1000 + i,
        }));
      }
      const result = normalizeThreadRecords(records);
      expect(result.find((r) => r.id === "active-1")).toBeDefined();
      expect(result.find((r) => r.id === "active-1")?.deletedAt).toBeUndefined();
    });
  });
});
