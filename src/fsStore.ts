// Tiny IndexedDB helper for persisting the picked silent-save directory handle.
//
// A `FileSystemDirectoryHandle` is structured-cloneable, so it survives a round trip
// through IndexedDB (unlike JSON/localStorage). This lets the chosen save folder
// persist across panel remounts and page reloads. We only persist the handle here;
// permission is re-verified lazily at save time (no user gesture on mount).

const DB_NAME = "diy-dvr";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const HANDLE_KEY = "saveDir";

async function openDb(): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Failed to open IndexedDB"));
    };
  });
}

async function runInStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = operation(tx.objectStore(STORE_NAME));
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB operation failed"));
    };
    tx.oncomplete = () => {
      db.close();
    };
  });
}

/** Persist the picked directory handle (overwrites any previously stored handle). */
export async function saveDirHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await runInStore("readwrite", (store) => store.put(handle, HANDLE_KEY));
}

/** Load the previously stored directory handle, or `undefined` if none is stored. */
export async function loadDirHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  const value = await runInStore<unknown>("readonly", (store) => store.get(HANDLE_KEY));
  if (value == undefined) {
    return undefined;
  }
  return value as FileSystemDirectoryHandle;
}

/** Forget the stored directory handle (revert to browser download on next save). */
export async function clearDirHandle(): Promise<void> {
  await runInStore("readwrite", (store) => store.delete(HANDLE_KEY));
}
