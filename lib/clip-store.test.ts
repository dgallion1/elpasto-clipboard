import { afterEach, describe, expect, test, vi } from "vitest";
import {
  _resetForTesting,
  addTombstone,
  adoptOrphanedClips,
  deleteStoredBinaryClip,
  deleteStoredBinaryClipsBySession,
  getStoredBinaryClip,
  getTombstones,
  listStoredBinaryClipMetadataBySession,
  listStoredBinaryClipsBySession,
  migrateStoredBinaryClips,
  pruneTombstones,
  putStoredBinaryClip,
} from "./clip-store";

const baseRecord = {
  transferId: "transfer-1",
  sessionToken: "session-1",
  ownerTabId: "tab-a",
  zone: "A" as const,
  kind: "file" as const,
  mimeType: "application/pdf",
  originalName: "report.pdf",
  sizeBytes: 42,
  encryptionVersion: 1,
  encryptionMeta: {
    v: 1 as const,
    kdf: "PBKDF2-SHA256" as const,
    iterations: 210000,
    salt: "salt",
    iv: "iv",
    payload: "binary" as const,
  },
  createdAt: "2026-03-10T12:00:00.000Z",
  origin: "receiver" as const,
};

type StoredBinaryClipInput = Parameters<typeof putStoredBinaryClip>[0] & {
  storageKey: string;
};

type LegacyStoredBinaryClipInput = Omit<StoredBinaryClipInput, "ownerTabId" | "storageKey" | "ciphertext"> & {
  ciphertext?: ArrayBuffer;
};

class FakeKeyRange {
  constructor(readonly value: string) {}

  static only(value: string) {
    return new FakeKeyRange(value);
  }
}

class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

interface FakeStoreData {
  records: Map<string, Record<string, unknown>>;
  keyPath: string;
  indexes: Set<string>;
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private completeScheduled = false;

  constructor(
    private readonly database: FakeDatabase,
    readonly mode: IDBTransactionMode
  ) {}

  objectStore(name: string) {
    return new FakeObjectStore(this.database, this, name);
  }

  abort() {
    // no-op for tests
  }

  scheduleComplete() {
    if (this.completeScheduled || this.mode !== "readwrite") {
      return;
    }
    this.completeScheduled = true;
    queueMicrotask(() => {
      this.completeScheduled = false;
      this.oncomplete?.();
    });
  }
}

class FakeCursor {
  value: Record<string, unknown>;

  constructor(
    private readonly values: Record<string, unknown>[],
    private index: number,
    private readonly request: FakeRequest<FakeCursor | null>,
    private readonly transaction: FakeTransaction,
    private readonly storeData: FakeStoreData
  ) {
    this.value = structuredClone(this.values[this.index]!);
  }

  delete() {
    const record = this.values[this.index];
    if (!record) {
      return;
    }
    const key = record[this.storeData.keyPath] as string;
    this.storeData.records.delete(key);
  }

  continue() {
    this.index += 1;
    if (this.index >= this.values.length) {
      this.request.result = null;
      this.request.onsuccess?.();
      this.transaction.scheduleComplete();
      return;
    }

    this.request.result = new FakeCursor(this.values, this.index, this.request, this.transaction, this.storeData);
    this.request.onsuccess?.();
  }
}

class FakeIndex {
  constructor(
    private readonly storeData: FakeStoreData,
    private readonly transaction: FakeTransaction,
    private readonly indexName: string
  ) {}

  getAll(value: string) {
    const request = new FakeRequest<Record<string, unknown>[]>();
    queueMicrotask(() => {
      request.result = Array.from(this.storeData.records.values())
        .filter((record) => record[this.indexName] === value)
        .map((record) => structuredClone(record));
      request.onsuccess?.();
    });
    return request;
  }

  openCursor(range: FakeKeyRange) {
    const request = new FakeRequest<FakeCursor | null>();
    queueMicrotask(() => {
      const matches = Array.from(this.storeData.records.values())
        .filter((record) => record[this.indexName] === range.value)
        .map((record) => structuredClone(record));
      request.result = matches.length
        ? new FakeCursor(matches, 0, request, this.transaction, this.storeData)
        : null;
      request.onsuccess?.();
      if (matches.length === 0) {
        this.transaction.scheduleComplete();
      }
    });
    return request;
  }
}

class FakeObjectStore {
  indexNames: { contains: (name: string) => boolean };
  keyPath: string;

  constructor(
    private readonly database: FakeDatabase,
    private readonly transaction: FakeTransaction,
    private readonly storeName: string
  ) {
    const storeData = this.database.stores.get(storeName);
    this.indexNames = {
      contains: (name: string) => storeData?.indexes.has(name) ?? false,
    };
    this.keyPath = storeData?.keyPath ?? "storageKey";
  }

  private getStoreData(): FakeStoreData {
    const data = this.database.stores.get(this.storeName);
    if (!data) throw new Error(`Store ${this.storeName} not found`);
    return data;
  }

  put(record: Record<string, unknown>) {
    const storeData = this.getStoreData();
    const key = record[storeData.keyPath] as string;
    storeData.records.set(key, structuredClone(record));
    this.transaction.scheduleComplete();
  }

  get(key: string) {
    const storeData = this.getStoreData();
    const request = new FakeRequest<Record<string, unknown> | undefined>();
    queueMicrotask(() => {
      request.result = storeData.records.has(key)
        ? structuredClone(storeData.records.get(key)!)
        : undefined;
      request.onsuccess?.();
    });
    return request;
  }

  getAll() {
    const storeData = this.getStoreData();
    const request = new FakeRequest<Record<string, unknown>[]>();
    queueMicrotask(() => {
      request.result = Array.from(storeData.records.values()).map((record) => structuredClone(record));
      request.onsuccess?.();
    });
    return request;
  }

  delete(key: string) {
    const storeData = this.getStoreData();
    storeData.records.delete(key);
    this.transaction.scheduleComplete();
  }

  index(name: string) {
    return new FakeIndex(this.getStoreData(), this.transaction, name);
  }

  createIndex(name: string) {
    const storeData = this.getStoreData();
    storeData.indexes.add(name);
  }
}

class FakeDatabase {
  readonly stores = new Map<string, FakeStoreData>();
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };

  transaction(name: string, mode: IDBTransactionMode) {
    return new FakeTransaction(this, mode);
  }

  createObjectStore(name: string, options: { keyPath: string }) {
    const storeData: FakeStoreData = {
      records: new Map(),
      keyPath: options.keyPath,
      indexes: new Set(),
    };
    this.stores.set(name, storeData);
    return new FakeObjectStore(this, new FakeTransaction(this, "versionchange"), name);
  }

  deleteObjectStore(name: string) {
    this.stores.delete(name);
  }
}

class FakeIndexedDb {
  readonly database = new FakeDatabase();
  private version: number;

  constructor(options?: {
    version?: number;
    stores?: Map<string, { keyPath: string; indexes?: string[]; records?: Map<string, Record<string, unknown>> }>;
  }) {
    this.version = options?.version ?? 0;
    if (options?.stores) {
      for (const [name, config] of options.stores) {
        const storeData: FakeStoreData = {
          records: config.records ?? new Map(),
          keyPath: config.keyPath,
          indexes: new Set(config.indexes ?? []),
        };
        this.database.stores.set(name, storeData);
      }
    }
  }

  open(_name: string, _version: number) {
    const needsUpgrade = _version > this.version;
    const db = this.database;
    const upgradeTransaction = needsUpgrade
      ? new FakeTransaction(db, "versionchange")
      : null;
    const request = {
      result: db,
      error: null,
      transaction: db.stores.size > 0 && upgradeTransaction
        ? {
            objectStore: (storeName: string) =>
              new FakeObjectStore(db, upgradeTransaction, storeName),
            abort: () => undefined,
          }
        : null,
      onupgradeneeded: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };

    queueMicrotask(() => {
      if (needsUpgrade) {
        this.version = _version;
        request.onupgradeneeded?.();
        queueMicrotask(() => {
          request.onsuccess?.();
        });
        return;
      }
      request.onsuccess?.();
    });

    return request;
  }
}

const originalIndexedDb = globalThis.indexedDB;
const originalIdbKeyRange = globalThis.IDBKeyRange;

function installFakeIndexedDb() {
  const fake = new FakeIndexedDb();
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: fake,
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: FakeKeyRange,
  });
  return fake.database;
}

function installLegacyIndexedDb(records: LegacyStoredBinaryClipInput[]) {
  const recordsMap = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    recordsMap.set(String(record.transferId), record as unknown as Record<string, unknown>);
  }
  const fake = new FakeIndexedDb({
    version: 1,
    stores: new Map([
      ["binary-clips", { keyPath: "transferId", indexes: ["sessionToken"], records: recordsMap }],
    ]),
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: fake,
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: FakeKeyRange,
  });
  return fake.database;
}

afterEach(async () => {
  _resetForTesting();

  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: originalIndexedDb,
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: originalIdbKeyRange,
  });
});

describe("clip-store", () => {
  test("stores, reads, and lists binary clips", async () => {
    await putStoredBinaryClip({
      ...baseRecord,
      senderFileBytes: new Uint8Array([1, 2, 3]).buffer,
      ciphertext: new Uint8Array([4, 5, 6]),
    });

    const stored = await getStoredBinaryClip("transfer-1", "tab-a");
    expect(stored).toMatchObject({
      transferId: "transfer-1",
      sessionToken: "session-1",
      ownerTabId: "tab-a",
      originalName: "report.pdf",
      origin: "receiver",
    });
    expect(stored?.ciphertext).toEqual(new Uint8Array([4, 5, 6]));

    const listed = await listStoredBinaryClipsBySession("session-1", "tab-a");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.senderFileBytes).toEqual(new Uint8Array([1, 2, 3]).buffer);

    const metadata = await listStoredBinaryClipMetadataBySession("session-1", "tab-a");
    expect(metadata).toEqual([
      expect.objectContaining({
        transferId: "transfer-1",
        hasSenderFileBytes: true,
        hasCiphertext: true,
      }),
    ]);
  });

  test("deletes individual clips and session-scoped records", async () => {
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "transfer-a",
      sessionToken: "session-1",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "transfer-b",
      sessionToken: "session-2",
    });

    await deleteStoredBinaryClip("transfer-a", "tab-a");
    expect(await getStoredBinaryClip("transfer-a", "tab-a")).toBeNull();
    expect(await getStoredBinaryClip("transfer-b", "tab-a")).not.toBeNull();

    await deleteStoredBinaryClipsBySession("session-2");
    expect(await listStoredBinaryClipsBySession("session-2", "tab-a")).toEqual([]);
  });

  test("openDatabase rejects and resets cached promise on error", async () => {
    // Install a fake IndexedDB that fires onerror instead of onsuccess.
    // This must run before any test that successfully opens the database,
    // because openDatabasePromise is a module-level singleton.
    const failingFake = {
      open(_name: string, _version: number) {
        const request = {
          result: null,
          error: new Error("Simulated IndexedDB open failure"),
          onupgradeneeded: null as (() => void) | null,
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
        };
        queueMicrotask(() => {
          request.onerror?.();
        });
        return request;
      },
    };
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: failingFake,
    });
    Object.defineProperty(globalThis, "IDBKeyRange", {
      configurable: true,
      value: FakeKeyRange,
    });

    // putStoredBinaryClip calls openDatabase which should reject
    await expect(
      putStoredBinaryClip({ ...baseRecord, transferId: "fail-test" })
    ).rejects.toThrow("Simulated IndexedDB open failure");

    // The cached promise is reset, so the next attempt can succeed
    // Restore indexedDB before the next test
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: originalIndexedDb,
    });
  });

  test("migrates legacy indexeddb data and continues serving indexed reads and deletes", async () => {
    const database = installLegacyIndexedDb([
      {
        ...baseRecord,
        transferId: "legacy-transfer",
        sessionToken: "session-3",
        ciphertext: new Uint8Array([4, 5]).buffer,
      },
    ]);

    const legacyStored = await getStoredBinaryClip("legacy-transfer", "tab-a");
    expect(legacyStored).toMatchObject({
      transferId: "legacy-transfer",
      sessionToken: "session-3",
      ownerTabId: "__legacy__",
      originalName: "report.pdf",
    });
    expect(legacyStored?.ciphertext).toEqual(new Uint8Array([4, 5]));

    const binaryClips = database.stores.get("binary-clips")!;
    expect(binaryClips.keyPath).toBe("storageKey");
    expect(Array.from(binaryClips.records.keys())).toEqual(["__legacy__:legacy-transfer"]);

    const legacyListed = await listStoredBinaryClipsBySession("session-3", "tab-a");
    expect(legacyListed).toHaveLength(1);
    expect(legacyListed[0]?.transferId).toBe("legacy-transfer");

    const legacyMetadata = await listStoredBinaryClipMetadataBySession("session-3", "tab-a");
    expect(legacyMetadata).toEqual([
      expect.objectContaining({
        transferId: "legacy-transfer",
        ownerTabId: "__legacy__",
        hasCiphertext: true,
      }),
    ]);

    await deleteStoredBinaryClip("legacy-transfer", "tab-a");
    expect(await getStoredBinaryClip("legacy-transfer", "tab-a")).toBeNull();

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "transfer-idb-1",
      sessionToken: "session-3",
      createdAt: "2026-03-10T12:00:00.000Z",
      senderFileBytes: new Uint8Array([1, 2]).buffer,
      ciphertext: new Uint8Array([7, 8]),
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "transfer-idb-2",
      sessionToken: "session-3",
      createdAt: "2026-03-10T12:01:00.000Z",
      senderFileBytes: undefined,
      ciphertext: undefined,
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "transfer-idb-3",
      sessionToken: "session-2",
      createdAt: "2026-03-10T12:02:00.000Z",
      ciphertext: new Uint8Array([9]),
    });

    expect(await getStoredBinaryClip("missing-idb", "tab-a")).toBeNull();

    const stored = await getStoredBinaryClip("transfer-idb-1", "tab-a");
    expect(stored).toMatchObject({
      transferId: "transfer-idb-1",
      sessionToken: "session-3",
      ownerTabId: "tab-a",
      originalName: "report.pdf",
    });
    expect(stored?.ciphertext).toEqual(new Uint8Array([7, 8]));

    const listed = await listStoredBinaryClipsBySession("session-3", "tab-a");
    expect(listed.map((clip) => clip.transferId)).toEqual([
      "transfer-idb-2",
      "transfer-idb-1",
    ]);

    const metadata = await listStoredBinaryClipMetadataBySession("session-3", "tab-a");
    expect(metadata).toEqual([
      expect.objectContaining({
        transferId: "transfer-idb-2",
        hasSenderFileBytes: false,
        hasCiphertext: false,
      }),
      expect.objectContaining({
        transferId: "transfer-idb-1",
        hasSenderFileBytes: true,
        hasCiphertext: true,
      }),
    ]);

    await deleteStoredBinaryClip("transfer-idb-1", "tab-a");
    expect(await getStoredBinaryClip("transfer-idb-1", "tab-a")).toBeNull();

    await deleteStoredBinaryClipsBySession("session-3");
    expect(await listStoredBinaryClipsBySession("session-3", "tab-a")).toEqual([]);
    expect(await getStoredBinaryClip("transfer-idb-3", "tab-a")).toMatchObject({
      transferId: "transfer-idb-3",
      sessionToken: "session-2",
    });
  });

  test("isolates clips by tab owner even when transfer ids match", async () => {
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "shared-transfer",
      ownerTabId: "tab-a",
      originalName: "receiver.jpg",
      origin: "receiver",
      ciphertext: new Uint8Array([1, 2, 3]),
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "shared-transfer",
      ownerTabId: "tab-b",
      originalName: "sender.jpg",
      origin: "sender",
      senderFileBytes: new Uint8Array([9, 8, 7]).buffer,
      ciphertext: new Uint8Array([9, 8, 7]),
    });

    expect(await getStoredBinaryClip("shared-transfer", "tab-a")).toMatchObject({
      ownerTabId: "tab-a",
      originalName: "receiver.jpg",
      origin: "receiver",
    });
    expect(await getStoredBinaryClip("shared-transfer", "tab-b")).toMatchObject({
      ownerTabId: "tab-b",
      originalName: "sender.jpg",
      origin: "sender",
    });
    expect(await listStoredBinaryClipsBySession("session-1", "tab-a")).toHaveLength(1);
    expect(await listStoredBinaryClipsBySession("session-1", "tab-b")).toHaveLength(1);
  });

  test("migrateStoredBinaryClips re-keys clips from one tab to another (memory fallback)", async () => {
    // Remove indexedDB to use memory store
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "migrate-1",
      ownerTabId: "old-tab",
      sessionToken: "session-1",
      createdAt: "2026-03-10T12:00:00.000Z",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "migrate-2",
      ownerTabId: "old-tab",
      sessionToken: "session-1",
      createdAt: "2026-03-10T12:01:00.000Z",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "other-session-clip",
      ownerTabId: "old-tab",
      sessionToken: "session-2",
      createdAt: "2026-03-10T12:02:00.000Z",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "different-tab-clip",
      ownerTabId: "other-tab",
      sessionToken: "session-1",
      createdAt: "2026-03-10T12:03:00.000Z",
    });

    const migrated = await migrateStoredBinaryClips("session-1", "old-tab", "new-tab");
    expect(migrated).toBe(2);

    // Migrated clips are now accessible under new-tab
    const clip1 = await getStoredBinaryClip("migrate-1", "new-tab");
    expect(clip1).toMatchObject({ transferId: "migrate-1", ownerTabId: "new-tab" });
    const clip2 = await getStoredBinaryClip("migrate-2", "new-tab");
    expect(clip2).toMatchObject({ transferId: "migrate-2", ownerTabId: "new-tab" });

    // Old tab key no longer finds migrated clips
    expect(await getStoredBinaryClip("migrate-1", "old-tab")).toBeNull();

    // Different session clip still under old tab
    const otherSession = await getStoredBinaryClip("other-session-clip", "old-tab");
    expect(otherSession).toMatchObject({ sessionToken: "session-2", ownerTabId: "old-tab" });

    // Different tab clip unaffected
    const otherTab = await getStoredBinaryClip("different-tab-clip", "other-tab");
    expect(otherTab).toMatchObject({ ownerTabId: "other-tab" });

    // Listed clips under new-tab include migrated ones
    const listed = await listStoredBinaryClipsBySession("session-1", "new-tab");
    expect(listed).toHaveLength(2);
    expect(listed.map((c) => c.transferId)).toEqual(["migrate-2", "migrate-1"]);
  });

  test("migrateStoredBinaryClips returns 0 when fromTabId equals toTabId", async () => {
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "no-op-clip",
      ownerTabId: "same-tab",
      sessionToken: "session-1",
    });

    const migrated = await migrateStoredBinaryClips("session-1", "same-tab", "same-tab");
    expect(migrated).toBe(0);

    // Clip still accessible
    expect(await getStoredBinaryClip("no-op-clip", "same-tab")).toMatchObject({
      transferId: "no-op-clip",
    });
  });

  test("openDatabase with current schema store triggers ensureSessionTokenIndex path", async () => {
    // Pre-install a FakeIndexedDb at version 2 with the current schema (keyPath: "storageKey")
    // When the module opens at version 3, onupgradeneeded fires and hits the
    // "existingStore.keyPath === 'storageKey'" branch (line 324-329).
    const fake = new FakeIndexedDb({
      version: 2,
      stores: new Map([
        ["binary-clips", { keyPath: "storageKey", indexes: ["sessionToken"] }],
      ]),
    });
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: fake,
    });
    Object.defineProperty(globalThis, "IDBKeyRange", {
      configurable: true,
      value: FakeKeyRange,
    });

    // Opening the database should succeed — the store already has the right schema
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "current-schema-test",
    });
    const stored = await getStoredBinaryClip("current-schema-test", "tab-a");
    expect(stored).toMatchObject({ transferId: "current-schema-test" });
  });

  test("migrateStoredBinaryClips re-keys clips in IndexedDB via legacy migration test", async () => {
    installLegacyIndexedDb([]);

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "idb-migrate-1",
      ownerTabId: "tab-old",
      sessionToken: "session-3",
      createdAt: "2026-03-10T12:00:00.000Z",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "idb-migrate-2",
      ownerTabId: "tab-old",
      sessionToken: "session-3",
      createdAt: "2026-03-10T12:01:00.000Z",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "idb-keep",
      ownerTabId: "tab-other",
      sessionToken: "session-3",
      createdAt: "2026-03-10T12:02:00.000Z",
    });

    const migrated = await migrateStoredBinaryClips("session-3", "tab-old", "tab-new");
    expect(migrated).toBe(2);

    // Reading through the API confirms migration
    const clip1 = await getStoredBinaryClip("idb-migrate-1", "tab-new");
    expect(clip1).toMatchObject({ ownerTabId: "tab-new", transferId: "idb-migrate-1" });
    const clip2 = await getStoredBinaryClip("idb-migrate-2", "tab-new");
    expect(clip2).toMatchObject({ ownerTabId: "tab-new", transferId: "idb-migrate-2" });

    // Old tab key no longer finds migrated clips
    expect(await getStoredBinaryClip("idb-migrate-1", "tab-old")).toBeNull();

    // Other-tab clip unaffected
    const kept = await getStoredBinaryClip("idb-keep", "tab-other");
    expect(kept).toMatchObject({ ownerTabId: "tab-other" });
  });

  test("deleteStoredBinaryClipsBySession with ownerTabId only deletes owned and legacy clips (memory)", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "owned-clip",
      ownerTabId: "tab-a",
      sessionToken: "session-1",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "other-tab-clip",
      ownerTabId: "tab-b",
      sessionToken: "session-1",
    });

    await deleteStoredBinaryClipsBySession("session-1", "tab-a");

    // tab-a clip deleted
    expect(await getStoredBinaryClip("owned-clip", "tab-a")).toBeNull();
    // tab-b clip preserved
    expect(await getStoredBinaryClip("other-tab-clip", "tab-b")).toMatchObject({
      transferId: "other-tab-clip",
    });
  });

  test("deleteStoredBinaryClipsBySession with ownerTabId filters in IndexedDB cursor", async () => {
    installLegacyIndexedDb([]);

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "delete-me",
      ownerTabId: "tab-x",
      sessionToken: "session-3",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "keep-me",
      ownerTabId: "tab-y",
      sessionToken: "session-3",
    });

    await deleteStoredBinaryClipsBySession("session-3", "tab-x");

    expect(await getStoredBinaryClip("delete-me", "tab-x")).toBeNull();
    expect(await getStoredBinaryClip("keep-me", "tab-y")).toMatchObject({
      transferId: "keep-me",
    });
  });

  test("legacy clips are visible to any tab owner (memory)", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    // Store a clip with the legacy owner ID
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "legacy-visible",
      ownerTabId: "__legacy__",
      sessionToken: "session-1",
    });

    // Any tab can see legacy clips
    const fromTabA = await listStoredBinaryClipsBySession("session-1", "tab-a");
    expect(fromTabA).toHaveLength(1);
    expect(fromTabA[0]?.ownerTabId).toBe("__legacy__");

    const fromTabB = await listStoredBinaryClipsBySession("session-1", "tab-b");
    expect(fromTabB).toHaveLength(1);

    // Metadata also visible from any tab
    const metaA = await listStoredBinaryClipMetadataBySession("session-1", "tab-a");
    expect(metaA).toHaveLength(1);
    const metaB = await listStoredBinaryClipMetadataBySession("session-1", "tab-b");
    expect(metaB).toHaveLength(1);
  });

  test("clips from other tabs are invisible to list operations (memory)", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "tab-a-clip",
      ownerTabId: "tab-a",
      sessionToken: "session-1",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "tab-b-clip",
      ownerTabId: "tab-b",
      sessionToken: "session-1",
    });

    const listedA = await listStoredBinaryClipsBySession("session-1", "tab-a");
    expect(listedA).toHaveLength(1);
    expect(listedA[0]?.transferId).toBe("tab-a-clip");

    const listedB = await listStoredBinaryClipsBySession("session-1", "tab-b");
    expect(listedB).toHaveLength(1);
    expect(listedB[0]?.transferId).toBe("tab-b-clip");

    // Metadata also filtered
    const metaA = await listStoredBinaryClipMetadataBySession("session-1", "tab-a");
    expect(metaA).toHaveLength(1);
    expect(metaA[0]?.transferId).toBe("tab-a-clip");
  });

  test("memory store: get falls back to legacy key", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    // Manually store under legacy owner to simulate pre-migration data
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "legacy-mem",
      ownerTabId: "__legacy__",
      sessionToken: "session-1",
    });

    // Any tab can retrieve via legacy fallback
    const clip = await getStoredBinaryClip("legacy-mem", "tab-whatever");
    expect(clip).toMatchObject({ transferId: "legacy-mem", ownerTabId: "__legacy__" });
  });

  test("migrateStoredBinaryClips returns 0 when no matching clips exist (memory)", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "unrelated",
      ownerTabId: "tab-z",
      sessionToken: "session-2",
    });

    const migrated = await migrateStoredBinaryClips("session-1", "tab-z", "tab-new");
    expect(migrated).toBe(0);
  });

  test("deleteStoredBinaryClipsBySession without ownerTabId deletes all clips for session (memory)", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "clip-1",
      ownerTabId: "tab-a",
      sessionToken: "session-1",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "clip-2",
      ownerTabId: "tab-b",
      sessionToken: "session-1",
    });

    await deleteStoredBinaryClipsBySession("session-1");
    expect(await listStoredBinaryClipsBySession("session-1", "tab-a")).toEqual([]);
    expect(await listStoredBinaryClipsBySession("session-1", "tab-b")).toEqual([]);
  });

  test("deleteStoredBinaryClipsBySession deletes legacy-owned clips when ownerTabId is specified (memory)", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "legacy-clip",
      ownerTabId: "__legacy__",
      sessionToken: "session-1",
    });

    // Deleting with any ownerTabId should also remove legacy clips
    await deleteStoredBinaryClipsBySession("session-1", "tab-a");
    expect(await getStoredBinaryClip("legacy-clip", "tab-a")).toBeNull();
  });

  test("memory store: delete removes both scoped and legacy keys", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "del-target",
      ownerTabId: "tab-a",
      sessionToken: "session-1",
    });
    // Also store a legacy version
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "del-target",
      ownerTabId: "__legacy__",
      sessionToken: "session-1",
    });

    await deleteStoredBinaryClip("del-target", "tab-a");
    expect(await getStoredBinaryClip("del-target", "tab-a")).toBeNull();
  });

  test("serialization round-trips senderFileBytes and ciphertext correctly", async () => {
    const original = new Uint8Array([10, 20, 30, 40, 50]);
    const senderBytes = new Uint8Array([100, 200]).buffer;

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "roundtrip",
      ciphertext: original,
      senderFileBytes: senderBytes,
    });

    const stored = await getStoredBinaryClip("roundtrip", "tab-a");
    expect(stored?.ciphertext).toBeInstanceOf(Uint8Array);
    expect(stored?.ciphertext).toEqual(new Uint8Array([10, 20, 30, 40, 50]));
    expect(stored?.senderFileBytes).toEqual(new Uint8Array([100, 200]).buffer);

    // Verify it's a copy, not the same reference
    expect(stored?.ciphertext?.buffer).not.toBe(original.buffer);
  });

  test("lists clips sorted by createdAt descending", async () => {
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "oldest",
      createdAt: "2026-03-10T10:00:00.000Z",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "newest",
      createdAt: "2026-03-10T14:00:00.000Z",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "middle",
      createdAt: "2026-03-10T12:00:00.000Z",
    });

    const listed = await listStoredBinaryClipsBySession("session-1", "tab-a");
    expect(listed.map((c) => c.transferId)).toEqual(["newest", "middle", "oldest"]);

    const metadata = await listStoredBinaryClipMetadataBySession("session-1", "tab-a");
    expect(metadata.map((m) => m.transferId)).toEqual(["newest", "middle", "oldest"]);
  });

  test("memory store: listStoredBinaryClipMetadataBySession returns sorted metadata", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "meta-older",
      ownerTabId: "tab-a",
      sessionToken: "session-1",
      createdAt: "2026-03-10T10:00:00.000Z",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "meta-newer",
      ownerTabId: "tab-a",
      sessionToken: "session-1",
      createdAt: "2026-03-10T14:00:00.000Z",
    });

    const meta = await listStoredBinaryClipMetadataBySession("session-1", "tab-a");
    expect(meta.map((m) => m.transferId)).toEqual(["meta-newer", "meta-older"]);
  });

  test("memory store: listStoredBinaryClipMetadataBySession filters by visibility", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "meta-visible",
      ownerTabId: "tab-a",
      sessionToken: "session-1",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "meta-hidden",
      ownerTabId: "tab-b",
      sessionToken: "session-1",
    });

    const meta = await listStoredBinaryClipMetadataBySession("session-1", "tab-a");
    expect(meta).toHaveLength(1);
    expect(meta[0]?.transferId).toBe("meta-visible");
  });

  test("records without senderFileBytes or ciphertext report false in metadata", async () => {
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "no-binary",
      senderFileBytes: undefined,
      ciphertext: undefined,
    });

    const metadata = await listStoredBinaryClipMetadataBySession("session-1", "tab-a");
    expect(metadata).toEqual([
      expect.objectContaining({
        transferId: "no-binary",
        hasSenderFileBytes: false,
        hasCiphertext: false,
      }),
    ]);
  });

  test("adoptOrphanedClips re-keys orphaned clips to new tab id (memory)", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "orphan-1",
      ownerTabId: "old-tab",
      sessionToken: "session-1",
      createdAt: "2025-01-01T00:00:00Z",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "orphan-2",
      ownerTabId: "old-tab",
      sessionToken: "session-1",
      createdAt: "2025-01-01T00:01:00Z",
    });
    // Different session — should not be adopted
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "other-session",
      ownerTabId: "old-tab",
      sessionToken: "session-2",
    });

    const adopted = await adoptOrphanedClips("session-1", "new-tab");
    expect(adopted).toHaveLength(2);
    expect(adopted.map((c) => c.transferId).sort()).toEqual(["orphan-1", "orphan-2"]);
    expect(adopted.every((c) => c.ownerTabId === "new-tab")).toBe(true);

    // Adopted clips are now findable under the new tab id
    const listed = await listStoredBinaryClipsBySession("session-1", "new-tab");
    expect(listed).toHaveLength(2);

    // Old tab id finds nothing
    expect(await listStoredBinaryClipsBySession("session-1", "old-tab")).toEqual([]);

    // Other session untouched
    expect(await listStoredBinaryClipsBySession("session-2", "old-tab")).toHaveLength(1);
  });

  test("adoptOrphanedClips skips legacy-owned clips", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "orphan-a",
      ownerTabId: "dead-tab",
      sessionToken: "session-1",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "legacy-clip",
      ownerTabId: "__legacy__",
      sessionToken: "session-1",
    });

    const adopted = await adoptOrphanedClips("session-1", "fresh-tab");
    expect(adopted).toHaveLength(1);
    expect(adopted[0].transferId).toBe("orphan-a");
  });

  test("adoptOrphanedClips deletes tombstoned orphans instead of re-keying them", async () => {
    installFakeIndexedDb();

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "live-orphan",
      ownerTabId: "old-tab",
      sessionToken: "session-1",
      createdAt: "2025-01-01T00:00:00Z",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "dead-orphan",
      ownerTabId: "old-tab",
      sessionToken: "session-1",
      createdAt: "2025-01-01T00:01:00Z",
    });

    const adopted = await adoptOrphanedClips("session-1", "new-tab", new Set(["dead-orphan"]));
    expect(adopted).toHaveLength(1);
    expect(adopted[0]?.transferId).toBe("live-orphan");

    expect(await getStoredBinaryClip("live-orphan", "new-tab")).toMatchObject({
      transferId: "live-orphan",
      ownerTabId: "new-tab",
    });
    expect(await getStoredBinaryClip("dead-orphan", "new-tab")).toBeNull();
    expect(await getStoredBinaryClip("dead-orphan", "old-tab")).toBeNull();
  });

  test("adoptOrphanedClips excludes tombstoned orphans in memory store", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "adopt-live",
      ownerTabId: "dead-tab",
      sessionToken: "session-1",
      createdAt: "2025-01-01T00:00:00Z",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "adopt-excluded",
      ownerTabId: "dead-tab",
      sessionToken: "session-1",
      createdAt: "2025-01-01T00:01:00Z",
    });

    const adopted = await adoptOrphanedClips("session-1", "new-tab", new Set(["adopt-excluded"]));
    expect(adopted).toHaveLength(1);
    expect(adopted[0].transferId).toBe("adopt-live");
    // Excluded record is deleted but not re-keyed
    expect(await getStoredBinaryClip("adopt-excluded", "new-tab")).toBeNull();
    expect(await getStoredBinaryClip("adopt-excluded", "dead-tab")).toBeNull();
  });

  test("adoptOrphanedClips skips own and legacy clips in IndexedDB", async () => {
    installFakeIndexedDb();

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "own-clip",
      ownerTabId: "my-tab",
      sessionToken: "session-1",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "legacy-clip",
      ownerTabId: "__legacy__",
      sessionToken: "session-1",
    });
    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "orphan-clip",
      ownerTabId: "other-tab",
      sessionToken: "session-1",
    });

    const adopted = await adoptOrphanedClips("session-1", "my-tab");
    expect(adopted).toHaveLength(1);
    expect(adopted[0].transferId).toBe("orphan-clip");
  });

  test("adoptOrphanedClips returns empty when no orphans exist", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });

    await putStoredBinaryClip({
      ...baseRecord,
      transferId: "my-clip",
      ownerTabId: "current-tab",
      sessionToken: "session-1",
    });

    const adopted = await adoptOrphanedClips("session-1", "current-tab");
    expect(adopted).toEqual([]);
  });
});

describe("tombstones", () => {
  test("addTombstone and getTombstones round-trip with session isolation", async () => {
    installFakeIndexedDb();

    await addTombstone("t-1", "session-1");
    await addTombstone("t-2", "session-1");
    await addTombstone("t-3", "session-2");

    const session1 = await getTombstones("session-1");
    expect(session1).toEqual(new Set(["t-1", "t-2"]));

    const session2 = await getTombstones("session-2");
    expect(session2).toEqual(new Set(["t-3"]));
  });

  test("addTombstone is idempotent", async () => {
    installFakeIndexedDb();

    await addTombstone("t-1", "session-1");
    await addTombstone("t-1", "session-1");
    await addTombstone("t-1", "session-1");

    const tombstones = await getTombstones("session-1");
    expect(tombstones).toEqual(new Set(["t-1"]));
    expect(tombstones.size).toBe(1);
  });

  test("getTombstones returns empty set for unknown session", async () => {
    installFakeIndexedDb();

    const tombstones = await getTombstones("nonexistent");
    expect(tombstones).toEqual(new Set());
    expect(tombstones.size).toBe(0);
  });

  test("pruneTombstones evicts oldest entries beyond cap", async () => {
    installFakeIndexedDb();

    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1000);
      await addTombstone("t-1", "session-1");
      now.mockReturnValue(2000);
      await addTombstone("t-2", "session-1");
      now.mockReturnValue(3000);
      await addTombstone("t-3", "session-1");
      now.mockReturnValue(4000);
      await addTombstone("t-4", "session-1");
      now.mockReturnValue(5000);
      await addTombstone("t-5", "session-1");

      now.mockReturnValue(6000);
      await pruneTombstones("session-1", 3);

      const tombstones = await getTombstones("session-1");
      expect(tombstones).toEqual(new Set(["t-3", "t-4", "t-5"]));
      expect(tombstones.has("t-1")).toBe(false);
      expect(tombstones.has("t-2")).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("addTombstone auto-prunes when count exceeds cap", async () => {
    installFakeIndexedDb();

    const now = vi.spyOn(Date, "now");
    try {
      for (let i = 0; i < 501; i++) {
        now.mockReturnValue(i * 1000);
        await addTombstone(`t-${i}`, "session-1");
      }

      const tombstones = await getTombstones("session-1");
      expect(tombstones.size).toBe(500);
      expect(tombstones.has("t-0")).toBe(false);
      expect(tombstones.has("t-1")).toBe(true);
      expect(tombstones.has("t-500")).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("tombstones work with memory fallback", async () => {
    // No installFakeIndexedDb() — uses memory fallback
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1000);
      await addTombstone("t-1", "session-1");
      now.mockReturnValue(2000);
      await addTombstone("t-2", "session-1");
      now.mockReturnValue(3000);
      await addTombstone("t-3", "session-2");

      const session1 = await getTombstones("session-1");
      expect(session1).toEqual(new Set(["t-1", "t-2"]));

      const session2 = await getTombstones("session-2");
      expect(session2).toEqual(new Set(["t-3"]));

      // Test prune on memory path
      now.mockReturnValue(4000);
      await addTombstone("t-4", "session-1");

      await pruneTombstones("session-1", 2);

      const pruned = await getTombstones("session-1");
      expect(pruned.size).toBe(2);
      expect(pruned.has("t-2")).toBe(true);
      expect(pruned.has("t-4")).toBe(true);

      // Empty for unknown session
      const empty = await getTombstones("nonexistent");
      expect(empty.size).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
