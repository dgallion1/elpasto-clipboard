import type { ClipZone } from "@/lib/clips";
import {
  MAX_ACTIVE_THREADS,
  activeThreads,
  createThreadId,
  fallbackThreadName,
  makeThreadRecord,
  normalizeActivePositions,
  type ThreadRecord,
} from "@/lib/threads";

/**
 * Result of attempting to create a new thread. `null` when the active-thread
 * cap has been reached and creation must be skipped silently.
 */
export interface CreateThreadResult {
  records: ThreadRecord[];
  thread: ThreadRecord;
}

export function createThread(
  records: ThreadRecord[],
  now: number,
  generateId: () => ClipZone = createThreadId,
): CreateThreadResult | null {
  const active = activeThreads(records);
  if (active.length >= MAX_ACTIVE_THREADS) {
    return null;
  }
  const thread = makeThreadRecord(
    generateId(),
    fallbackThreadName(active.length),
    active.length,
    now,
  );
  return { records: [...records, thread], thread };
}

export interface RenameThreadResult {
  records: ThreadRecord[];
  /** The name actually applied — may fall back when input is empty. */
  name: string;
}

export function renameThread(
  records: ThreadRecord[],
  id: ClipZone,
  name: string,
  now: number,
): RenameThreadResult {
  const trimmed = name.trim();
  const active = activeThreads(records);
  const ordinal = active.findIndex((thread) => thread.id === id);
  const nextName =
    trimmed || fallbackThreadName(ordinal >= 0 ? ordinal : active.length);
  const next = records.map((thread) =>
    thread.id === id
      ? { ...thread, name: nextName, updatedAt: now }
      : thread,
  );
  return { records: next, name: nextName };
}

export interface DeleteThreadResult {
  records: ThreadRecord[];
  /** Which thread to focus next, or `null` if no neighbor exists. */
  nextActiveId: ClipZone | null;
}

/**
 * Delete a thread by id. Returns `null` when the deletion is blocked (only one
 * active thread remaining, or the id isn't present in the active set).
 *
 * The caller should unconditionally apply `nextActiveId` to the active-thread
 * state — this matches the prior in-hook behavior where deleting any thread
 * pulls focus to a neighbor of the deleted thread.
 */
export function deleteThread(
  records: ThreadRecord[],
  id: ClipZone,
  now: number,
): DeleteThreadResult | null {
  const active = activeThreads(records);
  if (active.length <= 1) {
    return null;
  }
  const threadIndex = active.findIndex((thread) => thread.id === id);
  if (threadIndex < 0) {
    return null;
  }
  const nextRecords = normalizeActivePositions(
    records.map((thread) =>
      thread.id === id
        ? {
            ...thread,
            deletedAt: now,
            updatedAt: Math.max(thread.updatedAt, now),
          }
        : thread,
    ),
  );
  const nextActive =
    active[threadIndex + 1] ?? active[threadIndex - 1] ?? null;
  const nextActiveId = nextActive && nextActive.id !== id ? nextActive.id : null;
  return { records: nextRecords, nextActiveId };
}

export interface ThreadPositionUpdate {
  id: ClipZone;
  position: number;
  updatedAt: number;
}

export interface MoveThreadResult {
  records: ThreadRecord[];
  positions: ThreadPositionUpdate[];
}

/**
 * Move a thread by `direction` (-1 = left, 1 = right). Returns `null` when the
 * move is out of bounds (already at edge) or the id isn't active.
 */
export function moveThread(
  records: ThreadRecord[],
  id: ClipZone,
  direction: -1 | 1,
  now: number,
): MoveThreadResult | null {
  const active = activeThreads(records);
  const from = active.findIndex((thread) => thread.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= active.length) {
    return null;
  }
  const reordered = [...active];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved!);
  const positions: ThreadPositionUpdate[] = reordered.map((thread, position) => ({
    id: thread.id,
    position,
    updatedAt: thread.position === position ? thread.updatedAt : now,
  }));
  const nextRecords = normalizeActivePositions(
    records.map((thread) => {
      const next = positions.find((position) => position.id === thread.id);
      return next
        ? { ...thread, position: next.position, updatedAt: next.updatedAt }
        : thread;
    }),
  );
  return { records: nextRecords, positions };
}
