import type { ClipZone } from "@/lib/clips";
import {
  activeThreads,
  ensureAtLeastOneThread,
  fallbackThreadName,
  makeThreadRecord,
  mergeThreadRecords,
  type ThreadRecord,
} from "@/lib/threads";
import type { ThreadPositionUpdate } from "./thread-reducers";
import { clearClipGroup, type ClipGroups } from "./clip-groups";

/**
 * Pure reducers for peer-mesh thread sync events.
 *
 * Each function takes the current `ThreadRecord[]` plus the inbound event from
 * a remote peer and returns the next records array. They always guarantee at
 * least one active thread remains.
 *
 * The hook layer wires these into `setThreadRecords((prev) => apply...(prev, event))`
 * so the only side effects live in the controller; this module stays test-pure.
 */

export function applyThreadsSync(
  prev: ThreadRecord[],
  incoming: ThreadRecord[],
): ThreadRecord[] {
  return ensureAtLeastOneThread(mergeThreadRecords(prev, incoming));
}

export function applyThreadCreated(
  prev: ThreadRecord[],
  thread: ThreadRecord,
): ThreadRecord[] {
  return ensureAtLeastOneThread(mergeThreadRecords(prev, [thread]));
}

export interface ThreadRenamedEvent {
  id: ClipZone;
  name: string;
  updatedAt: number;
}

export function applyThreadRenamed(
  prev: ThreadRecord[],
  event: ThreadRenamedEvent,
): ThreadRecord[] {
  const base =
    prev.find((thread) => thread.id === event.id) ??
    makeThreadRecord(
      event.id,
      event.name,
      activeThreads(prev).length,
      event.updatedAt,
    );
  return ensureAtLeastOneThread(
    mergeThreadRecords(prev, [
      { ...base, id: event.id, name: event.name, updatedAt: event.updatedAt },
    ]),
  );
}

export function applyThreadReordered(
  prev: ThreadRecord[],
  positions: ThreadPositionUpdate[],
): ThreadRecord[] {
  return ensureAtLeastOneThread(
    mergeThreadRecords(
      prev,
      positions.map((position) => {
        const base =
          prev.find((thread) => thread.id === position.id) ??
          makeThreadRecord(
            position.id,
            fallbackThreadName(position.position),
            position.position,
            position.updatedAt,
          );
        return {
          ...base,
          position: position.position,
          updatedAt: position.updatedAt,
        };
      }),
    ),
  );
}

export interface ThreadDeletedEvent {
  id: ClipZone;
  deletedAt: number;
}

export function applyThreadDeleted(
  prev: ThreadRecord[],
  event: ThreadDeletedEvent,
): ThreadRecord[] {
  const base =
    prev.find((thread) => thread.id === event.id) ??
    makeThreadRecord(
      event.id,
      fallbackThreadName(activeThreads(prev).length),
      activeThreads(prev).length,
      event.deletedAt,
    );
  return ensureAtLeastOneThread(
    mergeThreadRecords(prev, [
      {
        ...base,
        id: event.id,
        deletedAt: event.deletedAt,
        updatedAt: event.deletedAt,
      },
    ]),
  );
}

/**
 * After a remote delete, pick a replacement for `activeThreadId` only when the
 * current view is on the deleted thread. Returns the existing id otherwise.
 */
export function pickActiveAfterRemoteDelete(
  postDeleteRecords: ThreadRecord[],
  deletedId: ClipZone,
  currentActiveId: ClipZone | null,
): ClipZone | null {
  if (currentActiveId !== deletedId) {
    return currentActiveId;
  }
  return (
    activeThreads(postDeleteRecords).find((thread) => thread.id !== deletedId)
      ?.id ?? null
  );
}

export interface PeerThreadCallbacksDeps {
  getRecords: () => ThreadRecord[];
  setRecords: (updater: (prev: ThreadRecord[]) => ThreadRecord[]) => void;
  setCanonicalClipsByZone: (
    updater: (prev: ClipGroups) => ClipGroups,
  ) => void;
  setActiveThreadId: (
    updater: (current: ClipZone | null) => ClipZone | null,
  ) => void;
}

export interface PeerThreadCallbacks {
  onThreadsSync: (threads: ThreadRecord[]) => void;
  onThreadCreated: (thread: ThreadRecord) => void;
  onThreadRenamed: (event: ThreadRenamedEvent) => void;
  onThreadReordered: (positions: ThreadPositionUpdate[]) => void;
  onThreadDeleted: (event: ThreadDeletedEvent) => void;
}

/**
 * Builds the peer-mesh sync callbacks for thread events. Each callback
 * dispatches to one of the `apply*` reducers above and wires the side
 * effects (state setters) through the supplied dependencies. The factory
 * exists so the controller's `usePeerMesh({ ... })` call site reads as a
 * thin composition rather than five inline arrow callbacks.
 */
export function createPeerThreadCallbacks(
  deps: PeerThreadCallbacksDeps,
): PeerThreadCallbacks {
  return {
    onThreadsSync(threads) {
      deps.setRecords((prev) => applyThreadsSync(prev, threads));
    },
    onThreadCreated(thread) {
      deps.setRecords((prev) => applyThreadCreated(prev, thread));
    },
    onThreadRenamed(event) {
      deps.setRecords((prev) => applyThreadRenamed(prev, event));
    },
    onThreadReordered(positions) {
      deps.setRecords((prev) => applyThreadReordered(prev, positions));
    },
    onThreadDeleted(event) {
      deps.setCanonicalClipsByZone((prev) => clearClipGroup(prev, event.id));
      deps.setRecords((prev) => applyThreadDeleted(prev, event));
      deps.setActiveThreadId((current) =>
        pickActiveAfterRemoteDelete(deps.getRecords(), event.id, current),
      );
    },
  };
}
