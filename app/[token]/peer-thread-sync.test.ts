import { describe, expect, test, vi } from "vitest";
import {
  activeThreads,
  makeThreadRecord,
  type ThreadRecord,
} from "@/lib/threads";
import {
  applyThreadCreated,
  applyThreadDeleted,
  applyThreadRenamed,
  applyThreadReordered,
  applyThreadsSync,
  createPeerThreadCallbacks,
  pickActiveAfterRemoteDelete,
  type PeerThreadCallbacksDeps,
} from "./peer-thread-sync";
import type { ClipGroups } from "./clip-groups";

function rec(
  id: string,
  position: number,
  name = id.toUpperCase(),
  overrides: Partial<ThreadRecord> = {},
): ThreadRecord {
  return { ...makeThreadRecord(id, name, position, 1000), ...overrides };
}

describe("applyThreadsSync", () => {
  test("merges incoming records into the existing set", () => {
    const prev = [rec("a", 0)];
    const next = applyThreadsSync(prev, [rec("b", 1, "B", { updatedAt: 5000 })]);
    expect(next.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  test("keeps the newer copy when the same id is in both", () => {
    const prev = [rec("a", 0, "Old", { updatedAt: 1000 })];
    const next = applyThreadsSync(prev, [
      rec("a", 0, "New", { updatedAt: 5000 }),
    ]);
    expect(next.find((r) => r.id === "a")?.name).toBe("New");
  });

  test("ensures at least one active thread when prev is empty and incoming is empty", () => {
    const next = applyThreadsSync([], []);
    expect(activeThreads(next).length).toBeGreaterThanOrEqual(1);
  });
});

describe("applyThreadCreated", () => {
  test("adds a single new thread", () => {
    const prev = [rec("a", 0)];
    const incoming = rec("b", 1, "B", { updatedAt: 5000 });
    const next = applyThreadCreated(prev, incoming);
    expect(next.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  test("re-applying an existing record is idempotent on identity", () => {
    const prev = [rec("a", 0, "A", { updatedAt: 1000 })];
    const next = applyThreadCreated(
      prev,
      rec("a", 0, "A", { updatedAt: 1000 }),
    );
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe("a");
  });
});

describe("applyThreadRenamed", () => {
  test("updates an existing thread's name and updatedAt", () => {
    const prev = [rec("a", 0, "Alpha"), rec("b", 1, "Beta")];
    const next = applyThreadRenamed(prev, {
      id: "a",
      name: "Apex",
      updatedAt: 7000,
    });
    const renamed = next.find((r) => r.id === "a")!;
    expect(renamed.name).toBe("Apex");
    expect(renamed.updatedAt).toBe(7000);
    // Other thread untouched
    expect(next.find((r) => r.id === "b")?.name).toBe("Beta");
  });

  test("inserts a record when the renamed id is unknown locally", () => {
    // The remote may rename a thread we've never seen — we synthesise one
    // so future events stay coherent.
    const prev = [rec("a", 0, "Alpha")];
    const next = applyThreadRenamed(prev, {
      id: "ghost",
      name: "From The Void",
      updatedAt: 8000,
    });
    expect(next.map((r) => r.id).sort()).toEqual(["a", "ghost"]);
    const ghost = next.find((r) => r.id === "ghost")!;
    expect(ghost.name).toBe("From The Void");
    expect(ghost.updatedAt).toBe(8000);
  });
});

describe("applyThreadReordered", () => {
  test("applies a new position to every thread in the payload", () => {
    const prev = [rec("a", 0), rec("b", 1), rec("c", 2)];
    const next = applyThreadReordered(prev, [
      { id: "a", position: 2, updatedAt: 9000 },
      { id: "b", position: 0, updatedAt: 9000 },
      { id: "c", position: 1, updatedAt: 9000 },
    ]);
    const byId = new Map(next.map((r) => [r.id, r]));
    expect(byId.get("a")?.position).toBe(2);
    expect(byId.get("b")?.position).toBe(0);
    expect(byId.get("c")?.position).toBe(1);
  });

  test("synthesises any thread referenced in positions but not present locally", () => {
    const prev = [rec("a", 0)];
    const next = applyThreadReordered(prev, [
      { id: "a", position: 0, updatedAt: 9000 },
      { id: "remote", position: 1, updatedAt: 9000 },
    ]);
    expect(next.map((r) => r.id).sort()).toEqual(["a", "remote"]);
    const remote = next.find((r) => r.id === "remote")!;
    expect(remote.position).toBe(1);
  });
});

describe("applyThreadDeleted", () => {
  test("tombstones an existing thread by id", () => {
    const prev = [rec("a", 0), rec("b", 1)];
    const next = applyThreadDeleted(prev, { id: "a", deletedAt: 9000 });
    const tombstoned = next.find((r) => r.id === "a")!;
    expect(tombstoned.deletedAt).toBe(9000);
    expect(tombstoned.updatedAt).toBe(9000);
  });

  test("creates a tombstone entry when the deleted id is unknown locally", () => {
    // Defensive: a remote delete for a thread we've never had should still
    // produce a record so the merge logic stays stable on rejoin.
    const prev = [rec("a", 0)];
    const next = applyThreadDeleted(prev, { id: "ghost", deletedAt: 9000 });
    const ghost = next.find((r) => r.id === "ghost");
    expect(ghost?.deletedAt).toBe(9000);
  });

  test("ensures at least one active thread when deleting the only thread", () => {
    const prev = [rec("a", 0)];
    const next = applyThreadDeleted(prev, { id: "a", deletedAt: 9000 });
    expect(activeThreads(next).length).toBeGreaterThanOrEqual(1);
  });
});

describe("pickActiveAfterRemoteDelete", () => {
  test("returns the current id when the deleted thread wasn't active", () => {
    const records = [rec("a", 0), rec("b", 1)];
    expect(pickActiveAfterRemoteDelete(records, "b", "a")).toBe("a");
  });

  test("picks a surviving active thread when the deleted thread was active", () => {
    const records = [rec("a", 0), rec("b", 1), rec("c", 2)];
    const next = pickActiveAfterRemoteDelete(records, "b", "b");
    // It picks the first remaining active thread other than the deleted id.
    expect(next).toBe("a");
  });

  test("returns null when no surviving active thread remains", () => {
    // Only the deleted thread is active in `records` (others all tombstoned).
    const records = [
      rec("a", 0),
      rec("b", 1, "B", { deletedAt: 100 }),
    ];
    expect(pickActiveAfterRemoteDelete(records, "a", "a")).toBeNull();
  });

  test("returns null when currentActiveId is null even if the deleted id was active", () => {
    const records = [rec("a", 0)];
    expect(pickActiveAfterRemoteDelete(records, "a", null)).toBeNull();
  });
});

describe("createPeerThreadCallbacks", () => {
  function makeDeps(initialRecords: ThreadRecord[]) {
    const state = { records: initialRecords, clips: {} as ClipGroups };
    const setRecords = vi.fn<PeerThreadCallbacksDeps["setRecords"]>(
      (updater) => {
        state.records = updater(state.records);
      },
    );
    const setCanonicalClipsByZone = vi.fn<
      PeerThreadCallbacksDeps["setCanonicalClipsByZone"]
    >((updater) => {
      state.clips = updater(state.clips);
    });
    const setActiveThreadId =
      vi.fn<PeerThreadCallbacksDeps["setActiveThreadId"]>();
    return {
      state,
      setRecords,
      setCanonicalClipsByZone,
      setActiveThreadId,
      getRecords: () => state.records,
    };
  }

  test("onThreadsSync dispatches applyThreadsSync to setRecords", () => {
    const deps = makeDeps([rec("a", 0)]);
    const callbacks = createPeerThreadCallbacks(deps);

    callbacks.onThreadsSync([rec("b", 1, "B", { updatedAt: 5000 })]);

    expect(deps.state.records.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(deps.setActiveThreadId).not.toHaveBeenCalled();
  });

  test("onThreadCreated adds a single thread", () => {
    const deps = makeDeps([rec("a", 0)]);
    const callbacks = createPeerThreadCallbacks(deps);

    callbacks.onThreadCreated(rec("z", 1, "Z", { updatedAt: 6000 }));

    expect(deps.state.records.find((r) => r.id === "z")?.name).toBe("Z");
  });

  test("onThreadRenamed updates the existing thread", () => {
    const deps = makeDeps([rec("a", 0, "Alpha")]);
    const callbacks = createPeerThreadCallbacks(deps);

    callbacks.onThreadRenamed({ id: "a", name: "Apex", updatedAt: 7000 });

    expect(deps.state.records.find((r) => r.id === "a")?.name).toBe("Apex");
  });

  test("onThreadReordered applies new positions", () => {
    const deps = makeDeps([rec("a", 0), rec("b", 1), rec("c", 2)]);
    const callbacks = createPeerThreadCallbacks(deps);

    callbacks.onThreadReordered([
      { id: "a", position: 2, updatedAt: 8000 },
      { id: "b", position: 0, updatedAt: 8000 },
      { id: "c", position: 1, updatedAt: 8000 },
    ]);

    const byId = new Map(deps.state.records.map((r) => [r.id, r]));
    expect(byId.get("a")?.position).toBe(2);
    expect(byId.get("b")?.position).toBe(0);
  });

  test("onThreadDeleted clears clips, tombstones the thread, and re-picks activeThreadId", () => {
    const deps = makeDeps([rec("a", 0), rec("b", 1), rec("c", 2)]);
    const callbacks = createPeerThreadCallbacks(deps);

    // Seed the canonical clip groups so we can observe clearClipGroup's result
    deps.state.clips = {
      b: [{ id: 1 } as never, { id: 2 } as never],
      c: [{ id: 3 } as never],
    };

    callbacks.onThreadDeleted({ id: "b", deletedAt: 9000 });

    expect(deps.state.records.find((r) => r.id === "b")?.deletedAt).toBe(9000);
    expect(deps.state.clips.b).toEqual([]);
    expect(deps.state.clips.c).toEqual([{ id: 3 }]);

    // setActiveThreadId is called with an updater function — invoke it to
    // verify the picker behavior.
    expect(deps.setActiveThreadId).toHaveBeenCalledTimes(1);
    const picker = deps.setActiveThreadId.mock.calls[0]![0]!;
    expect(picker("b")).toBe("a"); // deleted thread was active → pick neighbor
    expect(picker("c")).toBe("c"); // currentActiveId !== deletedId → unchanged
  });
});
