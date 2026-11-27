import { StorageAdapter } from "./storage_adapter.mjs";

// Exactly one local stream per authenticated organization/participant.
export class RecoveryStore {
  #adapter;
  #key;
  #scope;

  constructor({ orgId, participantId }, adapter = new StorageAdapter(), { keyPrefix = "elo:arq05:v1:" } = {}) {
    if (![orgId, participantId].every(v => typeof v === "string" && v.length > 0)) {
      throw new Error("RECOVERY_SCOPE_REQUIRED");
    }
    this.#scope = Object.freeze({ orgId, participantId });
    this.#key = keyPrefix + JSON.stringify([orgId, participantId]);
    this.#adapter = adapter;
  }

  get scope() { return this.#scope; }

  async read() {
    const record = await this.#adapter.read(this.#key);
    if (record === null) return { revision: 0, events: [], acknowledged: 0, conflict: null };
    if (record.version !== 1 || !Array.isArray(record.events) ||
        !Number.isInteger(record.acknowledged) || record.acknowledged < 0 ||
        record.acknowledged > record.events.length ||
        !record.events.every(e => e.scope?.org_id === this.#scope.orgId &&
          e.scope?.participant_id === this.#scope.participantId)) {
      throw new Error("RECOVERY_RECORD_INVALID");
    }
    return record;
  }

  async write(previous, { events, acknowledged, conflict }) {
    // Send only the local record schema to storage, never auth or transport objects.
    const record = { version: 1, events, acknowledged, conflict };
    if (!(await this.#adapter.compareAndSet(this.#key, previous.revision, record))) {
      throw new Error("RECOVERY_CONCURRENT_WRITE");
    }
  }
}
