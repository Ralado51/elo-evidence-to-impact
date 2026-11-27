// The injected transport uses the existing participant API client and an in-memory
// authenticated session. No credentials enter the persisted record.
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
    const before = await this.#outbox.read();
    const sent = before.events.slice(before.acknowledged);
    if (before.conflict || !sent.length) return this.#result(before);

    let response;
    let receipts;
    try {
      response = await this.#transport(structuredClone(sent));
      receipts = response?.data?.results;
    } catch (error) {
      // The current participant client throws for rejected batches, with item receipts.
      receipts = Array.isArray(error?.details) ? error.details : null;
    }
    await this.#outbox.reconcile(sent, receipts);
    return this.#result(await this.#outbox.read());
  }

  #result(record) {
    const pending = record.events.length - record.acknowledged;
    return { pending, status: record.conflict ? "conflict" : pending ? "pending" : "synced",
      conflict: record.conflict };
  }
}
