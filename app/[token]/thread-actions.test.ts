import { describe, expect, test, vi } from "vitest";
import {
  MAX_ACTIVE_THREADS,
  makeThreadRecord,
  type ThreadRecord,
} from "@/lib/threads";
import {
  createThreadActions,
  type ThreadActionsDeps,
} from "./thread-actions";
import type { ClipGroups } from "./clip-groups";

function rec(
  id: string,
  position: number,
  name = id.toUpperCase(),
  overrides: Partial<ThreadRecord> = {},
): ThreadRecord {
  return { ...makeThreadRecord(id, name, position, 1000), ...overrides };
}

interface MockDeps extends ThreadActionsDeps {
  records: ThreadRecord[];
  state: { records: ThreadRecord[] };
  setRecords: ThreadActionsDeps["setRecords"] &
    ReturnType<typeof vi.fn>;
  setActiveThreadId: ThreadActionsDeps["setActiveThreadId"] &
    ReturnType<typeof vi.fn>;
  setCanonicalClipsByZone: ThreadActionsDeps["setCanonicalClipsByZone"] &
    ReturnType<typeof vi.fn>;
  clearLocalBinaryClips: ThreadActionsDeps["clearLocalBinaryClips"] &
    ReturnType<typeof vi.fn>;
  clearReceivedBinaryClips: ThreadActionsDeps["clearReceivedBinaryClips"] &
    ReturnType<typeof vi.fn>;
  broadcastThreadCreated: ThreadActionsDeps["broadcastThreadCreated"] &
    ReturnType<typeof vi.fn>;
  broadcastThreadRenamed: ThreadActionsDeps["broadcastThreadRenamed"] &
    ReturnType<typeof vi.fn>;
  broadcastThreadDeleted: ThreadActionsDeps["broadcastThreadDeleted"] &
    ReturnType<typeof vi.fn>;
  broadcastThreadReordered: ThreadActionsDeps["broadcastThreadReordered"] &
    ReturnType<typeof vi.fn>;
}

function makeDeps(
  initialRecords: ThreadRecord[],
  opts: { now?: number } = {},
): MockDeps {
  const state = { records: initialRecords };
  const setRecords = vi.fn<ThreadActionsDeps["setRecords"]>((updater) => {
    state.records = updater(state.records);
  });
  const deps: MockDeps = {
    records: initialRecords,
    state,
    getRecords: () => state.records,
    setRecords,
    setActiveThreadId: vi.fn<ThreadActionsDeps["setActiveThreadId"]>(),
    setCanonicalClipsByZone:
      vi.fn<ThreadActionsDeps["setCanonicalClipsByZone"]>(),
    clearLocalBinaryClips:
      vi.fn<ThreadActionsDeps["clearLocalBinaryClips"]>(),
    clearReceivedBinaryClips:
      vi.fn<ThreadActionsDeps["clearReceivedBinaryClips"]>(),
    broadcastThreadCreated:
      vi.fn<ThreadActionsDeps["broadcastThreadCreated"]>(),
    broadcastThreadRenamed:
      vi.fn<ThreadActionsDeps["broadcastThreadRenamed"]>(),
    broadcastThreadDeleted:
      vi.fn<ThreadActionsDeps["broadcastThreadDeleted"]>(),
    broadcastThreadReordered:
      vi.fn<ThreadActionsDeps["broadcastThreadReordered"]>(),
    now: opts.now != null ? () => opts.now! : undefined,
  };
  // Expose the live state via the records property for assertions on what
  // setRecords mutated.
  Object.defineProperty(deps, "records", {
    get: () => state.records,
  });
  return deps;
}

async function flushPostCommit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createThreadActions.onCreateThread", () => {
  test("adds the new thread and broadcasts it", async () => {
    const deps = makeDeps([rec("a", 0)], { now: 5000 });
    const actions = createThreadActions(deps);

    actions.onCreateThread();
    await flushPostCommit();

    // setRecords was called once with a function that produced the new state
    expect(deps.setRecords).toHaveBeenCalledTimes(1);
    const next = deps.records;
    expect(next.map((r) => r.id)).toContain("a");
    expect(next).toHaveLength(2);

    // Active id was set to the new thread's id
    expect(deps.setActiveThreadId).toHaveBeenCalledTimes(1);
    const newThread = next.find((r) => r.id !== "a")!;
    expect(deps.setActiveThreadId).toHaveBeenCalledWith(newThread.id);

    // Broadcast called with the same thread record
    expect(deps.broadcastThreadCreated).toHaveBeenCalledWith(newThread);
  });

  test("does nothing when at the active-thread cap", () => {
    const records = Array.from({ length: MAX_ACTIVE_THREADS }, (_, i) =>
      rec(`t${i}`, i),
    );
    const deps = makeDeps(records);
    const actions = createThreadActions(deps);

    actions.onCreateThread();

    expect(deps.setRecords).not.toHaveBeenCalled();
    expect(deps.setActiveThreadId).not.toHaveBeenCalled();
    expect(deps.broadcastThreadCreated).not.toHaveBeenCalled();
  });

  test("does not exceed the cap when a peer-add lands in the same React batch", async () => {
    // Outer snapshot is one below cap, so the outer cap check passes. By the
    // time setRecords' updater runs, a concurrent peer-create has already
    // filled the last slot. The action must re-check the cap inside the
    // updater so it doesn't append over the limit.
    const snapshot = Array.from(
      { length: MAX_ACTIVE_THREADS - 1 },
      (_, i) => rec(`t${i}`, i),
    );
    const peerAdd = rec("peer", MAX_ACTIVE_THREADS - 1, "Peer");
    const deps = makeDeps(snapshot, { now: 9000 });

    deps.setRecords.mockImplementation((updater) => {
      deps.state.records = updater([...snapshot, peerAdd]);
    });

    const actions = createThreadActions(deps);
    actions.onCreateThread();
    await flushPostCommit();

    const active = deps.state.records.filter((r) => !r.deletedAt);
    expect(active.length).toBeLessThanOrEqual(MAX_ACTIVE_THREADS);
    expect(deps.setActiveThreadId).not.toHaveBeenCalled();
    expect(deps.broadcastThreadCreated).not.toHaveBeenCalled();
  });
});

describe("createThreadActions.onRenameThread", () => {
  test("renames a thread and broadcasts the resolved name", () => {
    const deps = makeDeps(
      [rec("a", 0, "Alpha"), rec("b", 1, "Beta")],
      { now: 7000 },
    );
    const actions = createThreadActions(deps);

    actions.onRenameThread("a", "  Apex  ");

    expect(deps.records.find((r) => r.id === "a")?.name).toBe("Apex");
    // Broadcast uses the resolved (trimmed) name
    expect(deps.broadcastThreadRenamed).toHaveBeenCalledWith("a", "Apex", 7000);
  });

  test("falls back to ordinal name when input is whitespace", () => {
    const deps = makeDeps(
      [rec("a", 0, "Alpha"), rec("b", 1, "Beta")],
      { now: 7000 },
    );
    const actions = createThreadActions(deps);

    actions.onRenameThread("b", "   ");

    // ordinal of "b" is 1 → fallbackThreadName(1) = "2"
    expect(deps.broadcastThreadRenamed).toHaveBeenCalledWith("b", "2", 7000);
  });
});

describe("createThreadActions.onDeleteThread", () => {
  test("tombstones the thread, clears its clips, and broadcasts the deletion", () => {
    const deps = makeDeps(
      [rec("a", 0), rec("b", 1), rec("c", 2)],
      { now: 9000 },
    );
    const actions = createThreadActions(deps);

    actions.onDeleteThread("b");

    expect(deps.records.find((r) => r.id === "b")?.deletedAt).toBe(9000);
    expect(deps.setCanonicalClipsByZone).toHaveBeenCalledTimes(1);
    // Verify the clip clearing functions were called for the deleted zone
    expect(deps.clearLocalBinaryClips).toHaveBeenCalledWith("b");
    expect(deps.clearReceivedBinaryClips).toHaveBeenCalledWith("b");
    // Active id moves to a neighbor
    expect(deps.setActiveThreadId).toHaveBeenCalledWith("c");
    expect(deps.broadcastThreadDeleted).toHaveBeenCalledWith("b", 9000);
  });

  test("setCanonicalClipsByZone updater empties the deleted zone's clip list", () => {
    const deps = makeDeps([rec("a", 0), rec("b", 1)], { now: 9000 });
    const actions = createThreadActions(deps);

    actions.onDeleteThread("b");

    const updater = (deps.setCanonicalClipsByZone.mock.calls[0]![0]) as (
      prev: ClipGroups,
    ) => ClipGroups;
    const prev: ClipGroups = {
      a: [{ id: 1, zone: "a" }] as never,
      b: [{ id: 2, zone: "b" }] as never,
    };
    const next = updater(prev);
    expect(next.b).toEqual([]);
    expect(next.a).toEqual([{ id: 1, zone: "a" }]);
  });

  test("does nothing when only one active thread remains", () => {
    const deps = makeDeps([rec("a", 0)]);
    const actions = createThreadActions(deps);

    actions.onDeleteThread("a");

    expect(deps.setRecords).not.toHaveBeenCalled();
    expect(deps.broadcastThreadDeleted).not.toHaveBeenCalled();
    expect(deps.clearLocalBinaryClips).not.toHaveBeenCalled();
  });

  test("does nothing when the id is not in the active set", () => {
    const deps = makeDeps([rec("a", 0), rec("b", 1)]);
    const actions = createThreadActions(deps);

    actions.onDeleteThread("missing");

    expect(deps.setRecords).not.toHaveBeenCalled();
    expect(deps.broadcastThreadDeleted).not.toHaveBeenCalled();
  });

  test("preserves a concurrently-added thread queued in the same React batch", () => {
    // Simulate React batching: getRecords() returns the snapshot at the time
    // the action fires, but by the time setRecords' updater runs, an SSE /
    // peer event has already appended a new thread. The fix must use `prev`
    // inside the updater so that added thread survives the delete.
    const initial = [rec("a", 0), rec("b", 1)];
    const queuedAdditional = rec("c", 2, "C", { updatedAt: 9500 });
    const deps = makeDeps(initial, { now: 9000 });

    // Override setRecords so the next call sees a state that already contains
    // the queued addition — mimicking a stale snapshot.
    deps.setRecords.mockImplementation((updater) => {
      const withConcurrent = [...initial, queuedAdditional];
      deps.state.records = updater(withConcurrent);
    });

    const actions = createThreadActions(deps);
    actions.onDeleteThread("b");

    // "b" is tombstoned and "c" survives — the concurrent add isn't dropped.
    expect(deps.state.records.find((r) => r.id === "b")?.deletedAt).toBe(9000);
    expect(deps.state.records.some((r) => r.id === "c")).toBe(true);
  });
});

describe("createThreadActions.onMoveThread", () => {
  test("reorders threads and broadcasts the new positions", async () => {
    const deps = makeDeps(
      [rec("a", 0), rec("b", 1), rec("c", 2)],
      { now: 9000 },
    );
    const actions = createThreadActions(deps);

    actions.onMoveThread("a", 1);
    await flushPostCommit();

    expect(deps.broadcastThreadReordered).toHaveBeenCalledTimes(1);
    const positions = deps.broadcastThreadReordered.mock.calls[0]![0];
    expect(positions.map((p: { id: string }) => p.id)).toEqual(["b", "a", "c"]);
    expect(
      positions.find((p: { id: string; position: number }) => p.id === "a")
        ?.position,
    ).toBe(1);
  });

  test("returns silently when the move would leave the bounds", () => {
    const deps = makeDeps([rec("a", 0), rec("b", 1)], { now: 9000 });
    const actions = createThreadActions(deps);

    actions.onMoveThread("a", -1);

    expect(deps.setRecords).not.toHaveBeenCalled();
    expect(deps.broadcastThreadReordered).not.toHaveBeenCalled();
  });

  test("preserves a concurrently-added thread queued in the same React batch", async () => {
    const initial = [rec("a", 0), rec("b", 1), rec("c", 2)];
    const queuedAdditional = rec("d", 3, "D", { updatedAt: 9500 });
    const deps = makeDeps(initial, { now: 9000 });

    deps.setRecords.mockImplementation((updater) => {
      const withConcurrent = [...initial, queuedAdditional];
      deps.state.records = updater(withConcurrent);
    });

    const actions = createThreadActions(deps);
    actions.onMoveThread("a", 1);
    await flushPostCommit();

    // The queued addition survives the move
    expect(deps.state.records.some((r) => r.id === "d")).toBe(true);
    // The move still took effect on a and b
    const byId = new Map(deps.state.records.map((r) => [r.id, r]));
    expect(byId.get("a")?.position).toBe(1);
    expect(byId.get("b")?.position).toBe(0);
  });

  test("broadcasts positions computed from the post-merge state, not the stale snapshot", async () => {
    // The outer snapshot has 3 threads; the actual state when the updater
    // runs has a fourth thread (peer add). Peers must see positions derived
    // from the merged state so their applyThreadReordered converges to the
    // same order as local state.
    const initial = [rec("a", 0), rec("b", 1), rec("c", 2)];
    const queuedAdditional = rec("d", 3, "D", { updatedAt: 9500 });
    const deps = makeDeps(initial, { now: 9000 });

    deps.setRecords.mockImplementation((updater) => {
      deps.state.records = updater([...initial, queuedAdditional]);
    });

    const actions = createThreadActions(deps);
    actions.onMoveThread("a", 1);
    await flushPostCommit();

    const positions = deps.broadcastThreadReordered.mock.calls[0]![0];
    expect(positions.map((p: { id: string }) => p.id)).toContain("d");
    expect(positions).toHaveLength(4);
  });
});

describe("createThreadActions defaults to Date.now when no clock is provided", () => {
  test("uses real Date.now for the timestamp", () => {
    const before = Date.now();
    const deps = makeDeps([rec("a", 0), rec("b", 1)]);
    const actions = createThreadActions(deps);

    actions.onRenameThread("a", "Updated");

    const after = Date.now();
    const ts = deps.broadcastThreadRenamed.mock.calls[0]![2];
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
