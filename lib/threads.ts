import type { ClipZone } from "./clips";

export const MAX_ACTIVE_THREADS = 10;
export const MAX_THREAD_TOMBSTONES = 50;

export interface ThreadRecord {
  id: ClipZone;
  name: string;
  position: number;
  updatedAt: number;
  deletedAt?: number;
}

export function activeThreads(records: ThreadRecord[]): ThreadRecord[] {
  return records
    .filter((record) => record.deletedAt == null)
    .sort((a, b) => a.position - b.position || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
}

export function fallbackThreadName(index: number): string {
  return String(index + 1);
}

export function makeThreadRecord(
  id: ClipZone,
  name: string,
  position: number,
  updatedAt: number
): ThreadRecord {
  return {
    id,
    name: name.trim() || fallbackThreadName(position),
    position,
    updatedAt,
  };
}

export function createThreadId(): ClipZone {
  try {
    return crypto.randomUUID();
  } catch {
    return `thread-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export function normalizeThreadRecords(records: ThreadRecord[]): ThreadRecord[] {
  const byId = new Map<ClipZone, ThreadRecord>();
  for (const record of records) {
    if (!isValidThreadRecord(record)) {
      continue;
    }
    const normalized: ThreadRecord = {
      id: record.id.trim(),
      name: record.name.trim() || fallbackThreadName(record.position),
      position: Math.max(0, Math.floor(record.position)),
      updatedAt: record.updatedAt,
      ...(record.deletedAt != null ? { deletedAt: record.deletedAt } : {}),
    };
    const existing = byId.get(normalized.id);
    if (!existing || recordTimestamp(normalized) >= recordTimestamp(existing)) {
      byId.set(normalized.id, normalized);
    }
  }
  return pruneTombstones(renumberFallbackNames(normalizeActivePositions(Array.from(byId.values()))));
}

export function mergeThreadRecords(
  current: ThreadRecord[],
  incoming: ThreadRecord[],
  now = Date.now()
): ThreadRecord[] {
  const byId = new Map(normalizeThreadRecords(current).map((record) => [record.id, record]));
  for (const record of normalizeThreadRecords(incoming)) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      continue;
    }

    const incomingDeletedAt = record.deletedAt ?? 0;
    const localDeletedAt = existing.deletedAt ?? 0;
    if (localDeletedAt > incomingDeletedAt && localDeletedAt > record.updatedAt) {
      continue;
    }
    if (incomingDeletedAt > localDeletedAt && incomingDeletedAt >= existing.updatedAt) {
      byId.set(record.id, record);
      continue;
    }
    if (record.updatedAt > existing.updatedAt && record.updatedAt >= localDeletedAt) {
      byId.set(record.id, { ...record, deletedAt: record.deletedAt });
    }
  }
  return enforceThreadLimit(Array.from(byId.values()), now);
}

export function ensureThreadsForZones(
  records: ThreadRecord[],
  zones: ClipZone[],
  now = Date.now()
): ThreadRecord[] {
  const normalized = normalizeThreadRecords(records);
  const byId = new Map(normalized.map((record) => [record.id, record]));
  let changed = false;

  const legacyOrder = new Map<ClipZone, number>([
    ["A", 0],
    ["B", 1],
  ]);
  const orderedZones = Array.from(new Set(zones.filter((zone) => zone.trim().length > 0)))
    .sort((a, b) => (legacyOrder.get(a) ?? 1000) - (legacyOrder.get(b) ?? 1000) || a.localeCompare(b));

  for (const zone of orderedZones) {
    const existing = byId.get(zone);
    if (existing) {
      continue;
    }
    const position = activeThreads(Array.from(byId.values())).length;
    byId.set(zone, makeThreadRecord(zone, fallbackThreadName(position), position, now));
    changed = true;
  }

  const result = enforceThreadLimit(Array.from(byId.values()), now);
  if (!changed && result.length === normalized.length) {
    return normalized;
  }
  return result;
}

export function ensureAtLeastOneThread(records: ThreadRecord[], now = Date.now()): ThreadRecord[] {
  const normalized = normalizeThreadRecords(records);
  if (activeThreads(normalized).length > 0) {
    return normalized;
  }
  return [makeThreadRecord(createThreadId(), "1", 0, now), ...normalized];
}

export function normalizeActivePositions(records: ThreadRecord[]): ThreadRecord[] {
  const active = activeThreads(records);
  const activePositions = new Map(active.map((record, index) => [record.id, index]));
  return records.map((record) => {
    const position = activePositions.get(record.id);
    return position == null ? record : { ...record, position };
  });
}

export function enforceThreadLimit(records: ThreadRecord[], now = Date.now()): ThreadRecord[] {
  const normalized = normalizeActivePositions(records);
  const active = activeThreads(normalized);
  if (active.length <= MAX_ACTIVE_THREADS) {
    return normalized;
  }
  const keep = new Set(
    [...active]
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, MAX_ACTIVE_THREADS)
      .map((record) => record.id)
  );
  return normalizeActivePositions(
    normalized.map((record) => (
      record.deletedAt == null && !keep.has(record.id)
        ? { ...record, deletedAt: now, updatedAt: Math.max(record.updatedAt, now) }
        : record
    ))
  );
}

export function threadStorageKey(token: string): string {
  return `elpasto:threads:${token}`;
}

export function loadThreadRecords(token: string): ThreadRecord[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = localStorage.getItem(threadStorageKey(token));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? normalizeThreadRecords(parsed as ThreadRecord[]) : [];
  } catch {
    return [];
  }
}

export function persistThreadRecords(token: string, records: ThreadRecord[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    localStorage.setItem(threadStorageKey(token), JSON.stringify(normalizeThreadRecords(records)));
  } catch {
    // Ignore quota and privacy errors; peer/catalog inference can rebuild active metadata.
  }
}

function isValidThreadRecord(record: ThreadRecord): boolean {
  return (
    typeof record?.id === "string"
    && record.id.trim().length > 0
    && typeof record.name === "string"
    && Number.isFinite(record.position)
    && Number.isFinite(record.updatedAt)
    && (record.deletedAt == null || Number.isFinite(record.deletedAt))
  );
}

function pruneTombstones(records: ThreadRecord[]): ThreadRecord[] {
  const tombstones = records.filter((r) => r.deletedAt != null);
  if (tombstones.length <= MAX_THREAD_TOMBSTONES) {
    return records;
  }
  tombstones.sort((a, b) => (a.deletedAt ?? 0) - (b.deletedAt ?? 0));
  const toRemove = new Set(
    tombstones.slice(0, tombstones.length - MAX_THREAD_TOMBSTONES).map((r) => r.id)
  );
  return records.filter((r) => !toRemove.has(r.id));
}

function recordTimestamp(record: ThreadRecord): number {
  return Math.max(record.updatedAt, record.deletedAt ?? 0);
}

const FALLBACK_NAME_RE = /^\d+$/;

function renumberFallbackNames(records: ThreadRecord[]): ThreadRecord[] {
  let changed = false;
  const result = records.map((record) => {
    if (record.deletedAt != null || !FALLBACK_NAME_RE.test(record.name)) return record;
    const expected = fallbackThreadName(record.position);
    if (record.name === expected) return record;
    changed = true;
    return { ...record, name: expected };
  });
  return changed ? result : records;
}
