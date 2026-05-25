const DB_NAME = "elpasto-crypto";
const DB_VERSION = 1;
const STORE_NAME = "master-keys";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function storeMasterKey(sessionToken: string, masterKey: CryptoKey): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(masterKey, sessionToken);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function loadMasterKey(sessionToken: string): Promise<CryptoKey | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(sessionToken);
    request.onsuccess = () => {
      db.close();
      const result = request.result;
      resolve(result instanceof CryptoKey ? result : null);
    };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

export async function deleteMasterKey(sessionToken: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(sessionToken);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function probeParanoidSupport(): Promise<boolean> {
  try {
    if (!globalThis.crypto?.subtle || !globalThis.indexedDB) return false;
    const keyMaterial = await crypto.subtle.importKey(
      "raw", new Uint8Array(16), "PBKDF2", false, ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(32), iterations: 1 },
      keyMaterial, 256
    );
    const hkdfKey = await crypto.subtle.importKey(
      "raw", bits, "HKDF", false, ["deriveKey"]
    );
    const testToken = "__probe__";
    await storeMasterKey(testToken, hkdfKey);
    const loaded = await loadMasterKey(testToken);
    await deleteMasterKey(testToken);
    return loaded instanceof CryptoKey;
  } catch {
    return false;
  }
}
