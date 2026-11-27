// Async interface with synchronous compare-and-set for one sessionStorage area.
export class StorageAdapter {
  #storage;
  constructor(storage = globalThis.sessionStorage) {
    if (!storage) throw new Error("SESSION_STORAGE_UNAVAILABLE");
    this.#storage = storage;
  }

  async read(key) {
    const raw = this.#storage.getItem(key);
    if (raw === null) return null;
    const record = JSON.parse(raw);
    if (!Number.isSafeInteger(record?.revision) || record.revision < 1) {
      throw new Error("RECOVERY_RECORD_INVALID");
    }
    return record;
  }

  async compareAndSet(key, revision, record) {
    // No await between the read and write. This is not a cross-tab lock.
    const raw = this.#storage.getItem(key);
    const current = raw === null ? 0 : JSON.parse(raw)?.revision;
    if (current !== revision) return false;
    this.#storage.setItem(key, JSON.stringify({ ...record, revision: revision + 1 }));
    return true;
  }
}
