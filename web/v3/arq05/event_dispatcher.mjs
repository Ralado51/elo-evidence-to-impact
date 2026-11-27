// The injected transport uses the existing participant API client and an in-memory
// authenticated session. No credentials enter the persisted record.
const BATCH_SIZE = 100; // below the ledger limit (500 events per request)
export class EventDispatcher {
  #outbox;
  #transport;
  #inFlight;

  constructor(outbox, postEventsBatch) {
    if (typeof postEventsBatch !== "function") throw new TypeError("TRANSPORT_REQUIRED");
    this.#outbox = outbox;
    this.#transport = postEventsBatch;
  }

  dispatch() {
    if (!this.#inFlight) {
      this.#inFlight = this.#send().finally(() => { this.#inFlight = null; });
    }
    return this.#inFlight;
  }

  async #send() {
    // Capture streams can hold many events: send contiguous chunks (a prefix each time) until done or the first failure.
    let record = await this.#outbox.read();
    while (!record.conflict && record.acknowledged < record.events.length) {
      const sent = record.events.slice(record.acknowledged, record.acknowledged + BATCH_SIZE);
      let receipts;
      try {
        const response = await this.#transport(structuredClone(sent));
        receipts = response?.data?.results;
      } catch (error) {
        // The current participant client throws for rejected batches, with item receipts.
        receipts = Array.isArray(error?.details) ? error.details : null;
      }
      await this.#outbox.reconcile(sent, receipts);
      const next = await this.#outbox.read();
      const progressed = next.acknowledged > record.acknowledged || next.conflict;
      record = next;
      if (!progressed) break;
    }
    return this.#result(record);
  }

  #result(record) {
    const pending = record.events.length - record.acknowledged;
    return { pending, status: record.conflict ? "conflict" : pending ? "pending" : "synced",
      conflict: record.conflict };
  }
}
