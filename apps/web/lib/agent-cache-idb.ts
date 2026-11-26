import type { CacheStore } from "./agent-cache";

const DATABASE = "dilee-agent-cache";
const STORE = "kv";

let database: Promise<IDBDatabase> | null = null;
let instance: CacheStore | null = null;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("本地缓存被占用"));
  }).catch((error: unknown) => {
    database = null;
    throw error;
  });
  return database;
}

async function run<T>(mode: IDBTransactionMode, operate: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const connection = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = connection.transaction(STORE, mode);
    const request = operate(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function openAgentCacheStore(): CacheStore | null {
  if (typeof indexedDB === "undefined") return null;
  instance ??= {
    get: (key) => run<unknown>("readonly", (store) => store.get(key)),
    set: async (key, value) => { await run("readwrite", (store) => store.put(value, key)); },
    delete: async (key) => { await run("readwrite", (store) => store.delete(key)); },
    clear: async () => { await run("readwrite", (store) => store.clear()); },
    keys: async () => (await run("readonly", (store) => store.getAllKeys())).map(String),
  };
  return instance;
}
