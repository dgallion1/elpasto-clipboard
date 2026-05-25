import { describe, expect, test } from "vitest";
import {
  MAX_ACTIVE_THREADS,
  makeThreadRecord,
  type ThreadRecord,
} from "@/lib/threads";
import {
  createThread,
  deleteThread,
  moveThread,
  renameThread,
} from "./thread-reducers";

function rec(
  id: string,
  position: number,
  name = id.toUpperCase(),
  overrides: Partial<ThreadRecord> = {},
): ThreadRecord {
  return { ...makeThreadRecord(id, name, position, 1000), ...overrides };
}

describe("createThread", () => {
  test("appends a thread at the next active ordinal", () => {
    const records = [rec("a", 0), rec("b", 1)];
    const result = createThread(records, 5000, () => "c");
    expect(result).not.toBeNull();
    expect(result!.thread.id).toBe("c");
    expect(result!.thread.position).toBe(2);
    expect(result!.thread.name).toBe("3"); // fallbackThreadName(2)
    expect(result!.thread.updatedAt).toBe(5000);
    expect(result!.records).toHaveLength(3);
    expect(result!.records[2]).toEqual(result!.thread);
  });

  test("ignores tombstoned threads when computing the next ordinal", () => {
    const records = [
      rec("a", 0),
      rec("b", 1, "B", { deletedAt: 100 }),
      rec("c", 2),
    ];
    const result = createThread(records, 5000, () => "new");
    expect(result).not.toBeNull();
    // 2 active threads → next position is 2, name is "3"
    expect(result!.thread.position).toBe(2);
    expect(result!.thread.name).toBe("3");
  });

  test("returns null at the active-thread cap", () => {
    const records = Array.from({ length: MAX_ACTIVE_THREADS }, (_, i) =>
      rec(`t${i}`, i),
    );
    expect(createThread(records, 5000, () => "extra")).toBeNull();
  });

  test("uses crypto.randomUUID by default", () => {
    const result = createThread([], 5000);
    expect(result).not.toBeNull();
    expect(result!.thread.id).toMatch(/^[a-z0-9-]+$/i);
  });
});

describe("renameThread", () => {
  test("applies the trimmed new name to the targeted thread only", () => {
    const records = [rec("a", 0, "Alpha"), rec("b", 1, "Beta")];
    const result = renameThread(records, "a", "  Apex  ", 7000);
    expect(result.name).toBe("Apex");
    expect(result.records.find((r) => r.id === "a")).toMatchObject({
      name: "Apex",
      updatedAt: 7000,
    });
    expect(result.records.find((r) => r.id === "b")).toMatchObject({
      name: "Beta",
      updatedAt: 1000, // untouched
    });
  });

  test("falls back to ordinal name when input is whitespace", () => {
    const records = [rec("a", 0, "Alpha"), rec("b", 1, "Beta")];
    const result = renameThread(records, "b", "   ", 7000);
    expect(result.name).toBe("2"); // fallbackThreadName(1)
  });

  test("falls back using active.length when id is not active", () => {
    const records = [
      rec("a", 0, "Alpha"),
      rec("ghost", 0, "Ghost", { deletedAt: 50 }),
    ];
    // Ordinal of "ghost" in active is -1, so falls back to active.length=1 → "2"
    const result = renameThread(records, "ghost", "", 7000);
    expect(result.name).toBe("2");
    // ghost record is still updated with the fallback name
    expect(result.records.find((r) => r.id === "ghost")).toMatchObject({
      name: "2",
      updatedAt: 7000,
    });
  });

  test("non-matching id leaves all records unchanged", () => {
    const records = [rec("a", 0, "Alpha")];
    const result = renameThread(records, "missing", "New", 7000);
    expect(result.records).toEqual(records);
  });
});

describe("deleteThread", () => {
  test("returns null when only one active thread remains", () => {
    const records = [rec("a", 0)];
    expect(deleteThread(records, "a", 9000)).toBeNull();
  });

  test("returns null when id is not in the active set", () => {
    const records = [rec("a", 0), rec("b", 1)];
    expect(deleteThread(records, "missing", 9000)).toBeNull();
  });

  test("tombstones the thread and bumps updatedAt", () => {
    const records = [rec("a", 0), rec("b", 1)];
    const result = deleteThread(records, "b", 9000);
    expect(result).not.toBeNull();
    const tombstoned = result!.records.find((r) => r.id === "b");
    expect(tombstoned?.deletedAt).toBe(9000);
    expect(tombstoned?.updatedAt).toBe(9000);
  });

  test("picks the thread to the right as the next active", () => {
    const records = [rec("a", 0), rec("b", 1), rec("c", 2)];
    const result = deleteThread(records, "b", 9000);
    expect(result?.nextActiveId).toBe("c");
  });

  test("picks the thread to the left when deleting the rightmost thread", () => {
    const records = [rec("a", 0), rec("b", 1), rec("c", 2)];
    const result = deleteThread(records, "c", 9000);
    expect(result?.nextActiveId).toBe("b");
  });

  test("preserves updatedAt when the existing value is more recent than now", () => {
    const records = [rec("a", 0), rec("b", 1, "B", { updatedAt: 99999 })];
    const result = deleteThread(records, "b", 9000);
    const tombstoned = result!.records.find((r) => r.id === "b");
    expect(tombstoned?.updatedAt).toBe(99999); // max(99999, 9000)
  });
});

describe("moveThread", () => {
  test("moves a thread to the right when direction=1", () => {
    const records = [rec("a", 0), rec("b", 1), rec("c", 2)];
    const result = moveThread(records, "a", 1, 9000);
    expect(result).not.toBeNull();
    const ids = result!.positions.map((p) => p.id);
    expect(ids).toEqual(["b", "a", "c"]);
    expect(result!.positions.find((p) => p.id === "a")?.position).toBe(1);
  });

  test("moves a thread to the left when direction=-1", () => {
    const records = [rec("a", 0), rec("b", 1), rec("c", 2)];
    const result = moveThread(records, "c", -1, 9000);
    expect(result).not.toBeNull();
    expect(result!.positions.map((p) => p.id)).toEqual(["a", "c", "b"]);
  });

  test("returns null when moving past the left edge", () => {
    const records = [rec("a", 0), rec("b", 1)];
    expect(moveThread(records, "a", -1, 9000)).toBeNull();
  });

  test("returns null when moving past the right edge", () => {
    const records = [rec("a", 0), rec("b", 1)];
    expect(moveThread(records, "b", 1, 9000)).toBeNull();
  });

  test("returns null when id is not in the active set", () => {
    const records = [rec("a", 0), rec("b", 1)];
    expect(moveThread(records, "missing", 1, 9000)).toBeNull();
  });

  test("only bumps updatedAt for threads that actually moved", () => {
    const records = [rec("a", 0), rec("b", 1), rec("c", 2)];
    const result = moveThread(records, "a", 1, 9000);
    const a = result!.positions.find((p) => p.id === "a")!;
    const b = result!.positions.find((p) => p.id === "b")!;
    const c = result!.positions.find((p) => p.id === "c")!;
    expect(a.updatedAt).toBe(9000); // moved 0 → 1
    expect(b.updatedAt).toBe(9000); // moved 1 → 0
    expect(c.updatedAt).toBe(1000); // position unchanged
  });
});
