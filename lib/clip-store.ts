import type { ClipEncryptionMeta } from "./clip-encryption";
import type { ClipKind, ClipZone } from "./clips";
import { logRestoreDebug } from "./restore-debug";

const DATABASE_NAME = "elpasto-binary-clips";
const DATABASE_VERSION = 3;
const STORE_NAME = "binary-clips";
const SESSION_TOKEN_INDEX = "sessionToken";
const LEGACY_OWNER_TAB_ID = "__legacy__";
const TOMBSTONE_STORE_NAME = "tombstones";
const TOMBSTONE_MAX_COUNT = 500;

export interface TombstoneRecord {
  transferId: string;
  sessionToken: string;
  deletedAt: number;
}

export interface StoredBinaryClip {
  transferId: string;
  sessionToken: string;
  ownerTabId: string;
  zone: ClipZone;
  kind: ClipKind;
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  encryptionVersion: number | null;
  encryptionMeta: ClipEncryptionMeta | null;
  createdAt: string;
  origin: "sender" | "receiver";
  note?: string | null;
  senderFileBytes?: ArrayBuffer;
  ciphertext?: Uint8Array;
}

export interface BinaryClipCatalogEntry {
  transferId: string;
  zone: ClipZone;
  kind: ClipKind;
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  encryptionVersion: number | null;
  encryptionMeta: ClipEncryptionMeta | null;
  createdAt: string;
  note?: string | null;
}

interface StoredBinaryClipMetadata {
  transferId: string;
  sessionToken: string;
  ownerTabId: string;
  zone: ClipZone;
  kind: ClipKind;
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  encryptionVersion: number | null;
  encryptionMeta: ClipEncryptionMeta | null;
  createdAt: string;
  origin: "sender" | "receiver";
  note?: string | null;
  hasSenderFileBytes: boolean;
  hasCiphertext: boolean;
}

interface PersistedStoredBinaryClip extends Omit<StoredBinaryClip, "ciphertext"> {
  storageKey: string;
  ciphertext?: ArrayBuffer;
}

interface LegacyPersistedStoredBinaryClip extends Omit<PersistedStoredBinaryClip, "ownerTabId" | "storageKey"> {}

const memoryStore = new Map<string, PersistedStoredBinaryClip>();
const tombstoneMemoryStore = new Map<string, TombstoneRecord>();
let openDatabasePromise: Promise<IDBDatabase> | null = null;

/** @internal — only for use in tests */
export function _resetForTesting(): void {
  openDatabasePromise = null;
  memoryStore.clear();
  tombstoneMemoryStore.clear();
}

export async function putStoredBinaryClip(clip: StoredBinaryClip): Promise<void> {
  const serialized = serializeForStorage(clip);
  if (!hasIndexedDb()) {
    memoryStore.set(serialized.storageKey, serialized);
    return;
  }

  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).put(serialized);
  await waitForTransaction(tx);
}

export async function getStoredBinaryClip(
  transferId: string,
  ownerTabId: string
): Promise<StoredBinaryClip | null> {
  if (!hasIndexedDb()) {
    const memoryRecord = deserializeFromStorage(
      memoryStore.get(makeStorageKey(ownerTabId, transferId))
      ?? memoryStore.get(makeStorageKey(LEGACY_OWNER_TAB_ID, transferId))
    );
    logRestoreDebug("clip-store", "read stored clip from memory", {
      transferId,
      ownerTabId,
      found: Boolean(memoryRecord),
      recordOwnerTabId: memoryRecord?.ownerTabId ?? null,
    });
    return memoryRecord;
  }

  const db = await openDatabase();
  const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
  const record = await withRequest<PersistedStoredBinaryClip | undefined>(
    store.get(makeStorageKey(ownerTabId, transferId))
  );
  if (record) {
    logRestoreDebug("clip-store", "read stored clip by scoped key", {
      transferId,
      ownerTabId,
      recordOwnerTabId: record.ownerTabId,
    });
    return deserializeFromStorage(record);
  }
  const legacyRecord = await withRequest<PersistedStoredBinaryClip | undefined>(
    store.get(makeStorageKey(LEGACY_OWNER_TAB_ID, transferId))
  );
  logRestoreDebug("clip-store", "read stored clip by legacy fallback", {
    transferId,
    ownerTabId,
    found: Boolean(legacyRecord),
  });
  return deserializeFromStorage(legacyRecord);
}

function isVisibleToOwner(
  record: StoredBinaryClip | StoredBinaryClipMetadata | PersistedStoredBinaryClip,
  ownerTabId: string
) {
  return record.ownerTabId === ownerTabId || record.ownerTabId === LEGACY_OWNER_TAB_ID;
}

export async function listStoredBinaryClipsBySession(
  sessionToken: string,
  ownerTabId: string
): Promise<StoredBinaryClip[]> {
  if (!hasIndexedDb()) {
    const records = Array.from(memoryStore.values())
      .filter((record) => record.sessionToken === sessionToken)
      .map(deserializeFromStorage)
      .filter((record): record is StoredBinaryClip => (
        record !== null && isVisibleToOwner(record, ownerTabId)
      ))
      .sort(compareCreatedAtDesc);
    logRestoreDebug("clip-store", "listed stored clips from memory", {
      sessionToken,
      ownerTabId,
      recordCount: records.length,
      transferIds: records.map((record) => record.transferId),
    });
    return records;
  }

  const db = await openDatabase();
  const records = await withRequest<PersistedStoredBinaryClip[]>(
    db
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .index(SESSION_TOKEN_INDEX)
      .getAll(sessionToken)
  );

  const visibleRecords = records
    .map(deserializeFromStorage)
    .filter((record): record is StoredBinaryClip => (
      record !== null && isVisibleToOwner(record, ownerTabId)
    ))
    .sort(compareCreatedAtDesc);
  logRestoreDebug("clip-store", "listed stored clips from indexeddb", {
    sessionToken,
    ownerTabId,
    recordCount: visibleRecords.length,
    transferIds: visibleRecords.map((record) => record.transferId),
    ownerTabIds: visibleRecords.map((record) => record.ownerTabId),
  });
  return visibleRecords;
}

export async function listStoredBinaryClipMetadataBySession(
  sessionToken: string,
  ownerTabId: string
): Promise<StoredBinaryClipMetadata[]> {
  if (!hasIndexedDb()) {
    return Array.from(memoryStore.values())
      .filter((record) => record.sessionToken === sessionToken)
      .map(toPersistedMetadata)
      .filter((record) => isVisibleToOwner(record, ownerTabId))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  const db = await openDatabase();
  const results: StoredBinaryClipMetadata[] = [];

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const index = tx.objectStore(STORE_NAME).index(SESSION_TOKEN_INDEX);
    const request = index.openCursor(IDBKeyRange.only(sessionToken));
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to list binary clip metadata"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const record = cursor.value as PersistedStoredBinaryClip;
      if (isVisibleToOwner(record, ownerTabId)) {
        results.push(toPersistedMetadata(record));
      }
      cursor.continue();
    };
  });

  return results.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export async function updateClipNote(
  transferId: string,
  sessionToken: string,
  note: string | null
): Promise<void> {
  if (!hasIndexedDb()) {
    for (const record of memoryStore.values()) {
      if (record.transferId === transferId && record.sessionToken === sessionToken) {
        record.note = note;
        return;
      }
    }
    return;
  }

  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const all = await withRequest<PersistedStoredBinaryClip[]>(store.getAll());
  for (const record of all) {
    if (record.transferId === transferId && record.sessionToken === sessionToken) {
      record.note = note;
      store.put(record);
      break;
    }
  }
  await waitForTransaction(tx);
}

export async function deleteStoredBinaryClip(
  transferId: string,
  ownerTabId: string
): Promise<void> {
  if (!hasIndexedDb()) {
    memoryStore.delete(makeStorageKey(ownerTabId, transferId));
    memoryStore.delete(makeStorageKey(LEGACY_OWNER_TAB_ID, transferId));
    return;
  }

  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  store.delete(makeStorageKey(ownerTabId, transferId));
  store.delete(makeStorageKey(LEGACY_OWNER_TAB_ID, transferId));
  await waitForTransaction(tx);
}

export async function deleteStoredBinaryClipsBySession(
  sessionToken: string,
  ownerTabId?: string
): Promise<void> {
  if (!hasIndexedDb()) {
    for (const [storageKey, record] of memoryStore.entries()) {
      if (
        record.sessionToken === sessionToken
        && (
          !ownerTabId
          || record.ownerTabId === ownerTabId
          || record.ownerTabId === LEGACY_OWNER_TAB_ID
        )
      ) {
        memoryStore.delete(storageKey);
      }
    }
    return;
  }

  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const index = tx.objectStore(STORE_NAME).index(SESSION_TOKEN_INDEX);
  const range = IDBKeyRange.only(sessionToken);

  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(range);
    request.onerror = () => {
      reject(request.error ?? new Error("Failed to delete stored binary clips"));
    };
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const record = cursor.value as PersistedStoredBinaryClip;
      if (
        !ownerTabId
        || record.ownerTabId === ownerTabId
        || record.ownerTabId === LEGACY_OWNER_TAB_ID
      ) {
        cursor.delete();
      }
      cursor.continue();
    };
  });

  await waitForTransaction(tx);
}

function hasIndexedDb() {
  return typeof indexedDB !== "undefined";
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!openDatabasePromise) {
    openDatabasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(TOMBSTONE_STORE_NAME)) {
          const tombstoneStore = db.createObjectStore(TOMBSTONE_STORE_NAME, { keyPath: "transferId" });
          tombstoneStore.createIndex("sessionToken", "sessionToken", { unique: false });
        }

        const existingStore = db.objectStoreNames.contains(STORE_NAME)
          ? request.transaction?.objectStore(STORE_NAME)
          : null;

        if (!existingStore) {
          createClipStore(db);
          return;
        }

        if (existingStore.keyPath === "storageKey") {
          ensureSessionTokenIndex(existingStore);
          logRestoreDebug("clip-store", "opened current clip store schema", {
            keyPath: existingStore.keyPath,
          });
          return;
        }

        const migrateRequest = existingStore.getAll() as IDBRequest<LegacyPersistedStoredBinaryClip[]>;
        migrateRequest.onerror = () => {
          request.transaction?.abort();
        };
        migrateRequest.onsuccess = () => {
          const legacyRecords = migrateRequest.result ?? [];
          logRestoreDebug("clip-store", "migrating legacy clip store schema", {
            legacyRecordCount: legacyRecords.length,
            transferIds: legacyRecords.map((record) => record.transferId),
          });
          db.deleteObjectStore(STORE_NAME);
          const store = createClipStore(db);
          for (const legacyRecord of legacyRecords) {
            store.put(migrateLegacyRecord(legacyRecord));
          }
        };
      };

      request.onerror = () => {
        openDatabasePromise = null;
        reject(request.error ?? new Error("Failed to open binary clip database"));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  return openDatabasePromise;
}

function withRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

function waitForTransaction(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.oncomplete = () => resolve();
  });
}

function createClipStore(db: IDBDatabase) {
  const store = db.createObjectStore(STORE_NAME, { keyPath: "storageKey" });
  ensureSessionTokenIndex(store);
  return store;
}

function ensureSessionTokenIndex(store: IDBObjectStore) {
  if (!store.indexNames.contains(SESSION_TOKEN_INDEX)) {
    store.createIndex(SESSION_TOKEN_INDEX, SESSION_TOKEN_INDEX, { unique: false });
  }
}

function serializeForStorage(clip: StoredBinaryClip): PersistedStoredBinaryClip {
  return {
    ...clip,
    storageKey: makeStorageKey(clip.ownerTabId, clip.transferId),
    senderFileBytes: clip.senderFileBytes ? clip.senderFileBytes.slice(0) as ArrayBuffer : undefined,
    ciphertext: clip.ciphertext
      ? clip.ciphertext.buffer.slice(
        clip.ciphertext.byteOffset,
        clip.ciphertext.byteOffset + clip.ciphertext.byteLength
      ) as ArrayBuffer
      : undefined,
  };
}

function deserializeFromStorage(
  clip: PersistedStoredBinaryClip | undefined
): StoredBinaryClip | null {
  if (!clip) {
    return null;
  }

  return {
    ...clip,
    senderFileBytes: clip.senderFileBytes ? clip.senderFileBytes.slice(0) as ArrayBuffer : undefined,
    ciphertext: clip.ciphertext ? new Uint8Array(clip.ciphertext.slice(0) as ArrayBuffer) : undefined,
  };
}

function toPersistedMetadata(clip: PersistedStoredBinaryClip): StoredBinaryClipMetadata {
  return {
    transferId: clip.transferId,
    sessionToken: clip.sessionToken,
    ownerTabId: clip.ownerTabId,
    zone: clip.zone,
    kind: clip.kind,
    mimeType: clip.mimeType,
    originalName: clip.originalName,
    sizeBytes: clip.sizeBytes,
    encryptionVersion: clip.encryptionVersion,
    encryptionMeta: clip.encryptionMeta,
    createdAt: clip.createdAt,
    origin: clip.origin,
    note: clip.note,
    hasSenderFileBytes: Boolean(clip.senderFileBytes?.byteLength),
    hasCiphertext: Boolean(clip.ciphertext?.byteLength),
  };
}

export async function migrateStoredBinaryClips(
  sessionToken: string,
  fromTabId: string,
  toTabId: string
): Promise<number> {
  if (fromTabId === toTabId) {
    return 0;
  }
  if (!hasIndexedDb()) {
    let migrated = 0;
    for (const [key, record] of memoryStore.entries()) {
      if (record.sessionToken === sessionToken && record.ownerTabId === fromTabId) {
        memoryStore.delete(key);
        record.ownerTabId = toTabId;
        record.storageKey = makeStorageKey(toTabId, record.transferId);
        memoryStore.set(record.storageKey, record);
        migrated++;
      }
    }
    return migrated;
  }

  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const index = store.index(SESSION_TOKEN_INDEX);
  const records = await withRequest<PersistedStoredBinaryClip[]>(
    index.getAll(sessionToken)
  );

  let migrated = 0;
  for (const record of records) {
    if (record.ownerTabId !== fromTabId) {
      continue;
    }
    const oldKey = record.storageKey;
    record.ownerTabId = toTabId;
    record.storageKey = makeStorageKey(toTabId, record.transferId);
    store.delete(oldKey);
    store.put(record);
    migrated++;
  }

  await waitForTransaction(tx);
  logRestoreDebug("clip-store", "migrated clips to new tab id", {
    sessionToken,
    fromTabId,
    toTabId,
    migrated,
  });
  return migrated;
}

/**
 * Adopt orphaned clips whose ownerTabId no longer matches any live tab
 * (e.g. after a full browser restart clears sessionStorage).
 * Re-keys them to the current ownerTabId so the normal restore path finds them.
 * Returns the adopted clips (already re-keyed).
 */
export async function adoptOrphanedClips(
  sessionToken: string,
  ownerTabId: string,
  excludeTransferIds?: ReadonlySet<string>
): Promise<StoredBinaryClip[]> {
  if (!hasIndexedDb()) {
    const adopted: StoredBinaryClip[] = [];
    for (const [key, record] of memoryStore.entries()) {
      if (
        record.sessionToken === sessionToken
        && record.ownerTabId !== ownerTabId
        && record.ownerTabId !== LEGACY_OWNER_TAB_ID
      ) {
        memoryStore.delete(key);
        if (excludeTransferIds?.has(record.transferId)) {
          continue;
        }
        record.ownerTabId = ownerTabId;
        record.storageKey = makeStorageKey(ownerTabId, record.transferId);
        memoryStore.set(record.storageKey, record);
        const deserialized = deserializeFromStorage(record);
        if (deserialized) adopted.push(deserialized);
      }
    }
    return adopted;
  }

  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const index = store.index(SESSION_TOKEN_INDEX);
  const records = await withRequest<PersistedStoredBinaryClip[]>(
    index.getAll(sessionToken)
  );

  const adopted: PersistedStoredBinaryClip[] = [];
  for (const record of records) {
    if (record.ownerTabId === ownerTabId || record.ownerTabId === LEGACY_OWNER_TAB_ID) {
      continue;
    }

    const oldKey = record.storageKey;
    if (excludeTransferIds?.has(record.transferId)) {
      store.delete(oldKey);
      continue;
    }
    record.ownerTabId = ownerTabId;
    record.storageKey = makeStorageKey(ownerTabId, record.transferId);
    store.delete(oldKey);
    store.put(record);
    adopted.push(record);
  }

  await waitForTransaction(tx);
  logRestoreDebug("clip-store", "adopted orphaned clips after browser restart", {
    sessionToken,
    ownerTabId,
    adopted: adopted.length,
    transferIds: adopted.map((r) => r.transferId),
  });
  return adopted
    .map(deserializeFromStorage)
    .filter((r): r is StoredBinaryClip => r !== null)
    .sort(compareCreatedAtDesc);
}

function compareCreatedAtDesc(a: StoredBinaryClip, b: StoredBinaryClip) {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function migrateLegacyRecord(clip: LegacyPersistedStoredBinaryClip): PersistedStoredBinaryClip {
  return {
    ...clip,
    ownerTabId: LEGACY_OWNER_TAB_ID,
    storageKey: makeStorageKey(LEGACY_OWNER_TAB_ID, clip.transferId),
  };
}

function makeStorageKey(ownerTabId: string, transferId: string) {
  return `${ownerTabId}:${transferId}`;
}

export async function addTombstone(transferId: string, sessionToken: string): Promise<void> {
  const record: TombstoneRecord = { transferId, sessionToken, deletedAt: Date.now() };
  if (!hasIndexedDb()) {
    tombstoneMemoryStore.set(transferId, record);
    await pruneTombstones(sessionToken, TOMBSTONE_MAX_COUNT);
    return;
  }
  const db = await openDatabase();
  const tx = db.transaction(TOMBSTONE_STORE_NAME, "readwrite");
  tx.objectStore(TOMBSTONE_STORE_NAME).put(record);
  await waitForTransaction(tx);
  await pruneTombstones(sessionToken, TOMBSTONE_MAX_COUNT);
}

export async function getTombstones(sessionToken: string): Promise<Set<string>> {
  if (!hasIndexedDb()) {
    const result = new Set<string>();
    for (const record of tombstoneMemoryStore.values()) {
      if (record.sessionToken === sessionToken) {
        result.add(record.transferId);
      }
    }
    return result;
  }
  const db = await openDatabase();
  const records = await withRequest<TombstoneRecord[]>(
    db.transaction(TOMBSTONE_STORE_NAME, "readonly")
      .objectStore(TOMBSTONE_STORE_NAME)
      .index("sessionToken")
      .getAll(sessionToken)
  );
  return new Set(records.map((r) => r.transferId));
}

export async function pruneTombstones(sessionToken: string, maxCount = 500): Promise<void> {
  if (!hasIndexedDb()) {
    const entries = Array.from(tombstoneMemoryStore.values())
      .filter((r) => r.sessionToken === sessionToken)
      .sort((a, b) => a.deletedAt - b.deletedAt);
    const excess = entries.length - maxCount;
    for (let i = 0; i < excess; i++) {
      tombstoneMemoryStore.delete(entries[i]!.transferId);
    }
    return;
  }
  const db = await openDatabase();
  // Read phase — readonly
  const records = await withRequest<TombstoneRecord[]>(
    db.transaction(TOMBSTONE_STORE_NAME, "readonly")
      .objectStore(TOMBSTONE_STORE_NAME)
      .index("sessionToken")
      .getAll(sessionToken)
  );
  if (records.length <= maxCount) return;
  // Write phase — readwrite only when there are excess entries
  records.sort((a, b) => a.deletedAt - b.deletedAt);
  const tx = db.transaction(TOMBSTONE_STORE_NAME, "readwrite");
  const store = tx.objectStore(TOMBSTONE_STORE_NAME);
  const excess = records.length - maxCount;
  for (let i = 0; i < excess; i++) {
    store.delete(records[i]!.transferId);
  }
  await waitForTransaction(tx);
}
