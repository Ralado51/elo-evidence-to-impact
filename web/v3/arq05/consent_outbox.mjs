// Camera consent stream ("consent:<participant_id>") kept in its own local chain and transmitted by the SAME EventDispatcher
// (same transport, same receipts and reconciliation rules as EventOutbox). The chain outlives a session record, so it uses its own key.
import { hashCanonical } from "../canonical.mjs";
import { buildConsentEvent } from "../../s2/arq08/capture_events.mjs";
import { nextMonotonicIso } from "../participant_model.mjs";

const CONFLICT = new Set(["HASH_CONFLICT", "CHAIN_BROKEN"]);

export class ConsentOutbox {
  #store;
  constructor(store) { this.#store = store; }
  get scope() { return this.#store.scope; }

  async read() {
    const record = await this.#store.read();
    const { orgId, participantId } = this.scope;
    let previous = null;
    let active = false;
    for (const event of record.events) {
      const { hash, ...body } = event;
      if (!["consent.accepted", "consent.revoked"].includes(event.type) || event.stream_id !== "consent:" + participantId ||
          event.scope?.org_id !== orgId || event.scope?.participant_id !== participantId ||
          event.seq !== (previous?.seq ?? 0) + 1 || event.prev_hash !== (previous?.hash ?? null) ||
          (previous && Date.parse(event.occurred_at) <= Date.parse(previous.occurred_at)) ||
          event.event_id !== await hashCanonical({ seq: event.seq, stream_id: event.stream_id }) ||
          hash !== await hashCanonical(body)) throw new Error("RECOVERY_RECORD_INVALID");
      active = event.type === "consent.accepted" ? event.payload.scopes.includes("camera") : active && !event.payload.scopes.includes("camera");
      previous = event;
    }
    return { ...record, active, last: previous };
  }

  /** Append the next consent event (accepted/revoked) on the participant's chain. Idempotent when already in that state. */
  async record(type) {
    const current = await this.read();
    if ((type === "consent.accepted") === current.active) return current;
    if (current.conflict) throw new Error("CONSENT_CHAIN_UNRESOLVED");
    const { orgId, participantId } = this.scope;
    const event = await buildConsentEvent({
      type, orgId, participantId, seq: (current.last?.seq ?? 0) + 1, prevHash: current.last?.hash ?? null,
      occurredAt: nextMonotonicIso(current.last?.occurred_at),
    });
    await this.#store.write(current, { events: [...current.events, event], acknowledged: current.acknowledged, conflict: current.conflict });
    return this.read();
  }

  async reconcile(sent, results) {
    const receipts = new Map();
    for (const result of Array.isArray(results) ? results : []) {
      if (receipts.has(result?.event_id)) return;
      receipts.set(result?.event_id, result);
    }
    let count = 0;
    let conflict = null;
    for (const event of sent) {
      const receipt = receipts.get(event.event_id);
      if (receipt?.status === "stored" || receipt?.status === "duplicate") { count++; continue; }
      const code = Array.isArray(receipt?.codes) && receipt.codes.find((c) => CONFLICT.has(c));
      if (receipt?.status === "rejected" && code) conflict = { eventId: event.event_id, code };
      break;
    }
    if (!count && !conflict) return;
    const current = await this.read();
    if (current.conflict || !sent.every((e, i) => current.events[current.acknowledged + i]?.hash === e.hash)) return;
    await this.#store.write(current, { events: current.events, acknowledged: current.acknowledged + count, conflict });
  }
}
