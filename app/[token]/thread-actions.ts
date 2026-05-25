import type { ClipZone } from "@/lib/clips";
import {
  activeThreads,
  ensureAtLeastOneThread,
  type ThreadRecord,
} from "@/lib/threads";
import {
  createThread,
  deleteThread,
  moveThread,
  renameThread,
  type ThreadPositionUpdate,
} from "./thread-reducers";
import { clearClipGroup, type ClipGroups } from "./clip-groups";

export interface ThreadActionsDeps {
  getRecords: () => ThreadRecord[];
  setRecords: (updater: (prev: ThreadRecord[]) => ThreadRecord[]) => void;
  setActiveThreadId: (id: ClipZone | null) => void;
  setCanonicalClipsByZone: (updater: (prev: ClipGroups) => ClipGroups) => void;
  clearLocalBinaryClips: (zone?: ClipZone) => void;
  clearReceivedBinaryClips: (zone?: ClipZone) => void;
  broadcastThreadCreated: (thread: ThreadRecord) => void;
  broadcastThreadRenamed: (id: ClipZone, name: string, now: number) => void;
  broadcastThreadDeleted: (id: ClipZone, now: number) => void;
  broadcastThreadReordered: (positions: ThreadPositionUpdate[]) => void;
  /** Override the clock — defaults to `Date.now`. Used to make tests deterministic. */
  now?: () => number;
  /** Defers post-state side effects until React has committed the update. */
  schedulePostCommit?: (callback: () => void) => void;
}

export interface ThreadActions {
  onCreateThread: () => void;
  onRenameThread: (id: ClipZone, name: string) => void;
  onDeleteThread: (id: ClipZone) => void;
  onMoveThread: (id: ClipZone, direction: -1 | 1) => void;
}

/**
 * Builds the locally-initiated thread CRUD callbacks for the session page.
 *
 * Each action follows the same shape:
 *   1. Compute the pure-reducer result against the current records.
 *   2. Bail when the reducer rejects the change (e.g. at capacity, no-op move).
 *   3. Apply the resulting state via the supplied setters.
 *   4. Broadcast the change to peers.
 *
 * The factory keeps the side effects observable and decoupled so the
 * controller's hook layer becomes a thin composition wrapper.
 */
export function createThreadActions(deps: ThreadActionsDeps): ThreadActions {
  const nowFn = deps.now ?? Date.now;
  const schedulePostCommit =
    deps.schedulePostCommit ?? ((callback: () => void) => {
      setTimeout(callback, 0);
    });

  return {
    onCreateThread() {
      const now = nowFn();
      // Fast bail when the snapshot already shows we're at cap.
      const result = createThread(deps.getRecords(), now);
      if (!result) return;
      const threadId = result.thread.id;
      // The cap and ID generation must both happen against `prev` so a
      // concurrent peer-create queued in the same React batch can't push us
      // over MAX_ACTIVE_THREADS.
      deps.setRecords((prev) => {
        const inner = createThread(prev, now, () => threadId);
        if (!inner) return prev;
        return ensureAtLeastOneThread(inner.records);
      });
      schedulePostCommit(() => {
        const thread = activeThreads(deps.getRecords()).find(
          (current) => current.id === threadId,
        );
        if (!thread) return;
        deps.setActiveThreadId(thread.id);
        deps.broadcastThreadCreated(thread);
      });
    },

    onRenameThread(id, name) {
      const now = nowFn();
      const { name: nextName } = renameThread(deps.getRecords(), id, name, now);
      deps.setRecords((prev) => renameThread(prev, id, name, now).records);
      deps.broadcastThreadRenamed(id, nextName, now);
    },

    onDeleteThread(id) {
      const now = nowFn();
      // Snapshot used to decide whether the delete is permitted and to compute
      // the broadcast payload (nextActiveId). The actual state transition runs
      // inside setRecords(prev => ...) so any updates queued in the same
      // React batch (e.g. an SSE-driven thread add) are preserved.
      const result = deleteThread(deps.getRecords(), id, now);
      if (!result) return;
      deps.setRecords((prev) => {
        const inner = deleteThread(prev, id, now);
        return inner ? inner.records : prev;
      });
      deps.setCanonicalClipsByZone((prev) => clearClipGroup(prev, id));
      deps.clearLocalBinaryClips(id);
      deps.clearReceivedBinaryClips(id);
      deps.setActiveThreadId(result.nextActiveId);
      deps.broadcastThreadDeleted(id, now);
    },

    onMoveThread(id, direction) {
      const now = nowFn();
      // Fast bail when the snapshot already rules out the move.
      const snapshot = deps.getRecords();
      if (!moveThread(snapshot, id, direction, now)) return;
      const beforeIndex = activeThreads(snapshot).findIndex(
        (thread) => thread.id === id,
      );
      // Apply against `prev` so concurrent peer changes in the same React
      // batch are preserved. The broadcast is derived after commit from the
      // actual current records, not from this stale snapshot.
      deps.setRecords((prev) => {
        const inner = moveThread(prev, id, direction, now);
        if (!inner) return prev;
        return inner.records;
      });
      schedulePostCommit(() => {
        const current = activeThreads(deps.getRecords());
        const afterIndex = current.findIndex((thread) => thread.id === id);
        if (afterIndex < 0 || afterIndex === beforeIndex) return;
        deps.broadcastThreadReordered(
          current.map((thread, position) => ({
            id: thread.id,
            position,
            updatedAt: thread.updatedAt,
          })),
        );
      });
    },
  };
}
