import { hashCanonical } from "../canonical.mjs";
import { isStopAction, SESSION_PHASE, transition } from "./session_state.mjs";

const CONFLICT = new Set(["HASH_CONFLICT", "CHAIN_BROKEN"]);

export class EventOutbox {
  #store;
  constructor(store) { this.#store = store; }
  get scope() { return this.#store.scope; }

  async read() {
    const record = await this.#store.read();
    let previous = null;
    let phase = SESSION_PHASE.IDLE;
    for (const event of record.events) {
      const { hash, ...body } = event;
      const scope = event.scope;
      const previousScope = previous?.scope;
      if (event.data_origin !== "synthetic_fixture" || event.execution_mode !== "report_only" ||
          event.actor?.role !== "participant" || event.actor.id !== this.scope.participantId ||
          event.stream_id !== "session:" + scope.session_id ||
          event.seq !== (previous?.seq ?? 0) + 1 || event.prev_hash !== (previous?.hash ?? null) ||
          (previous && (event.stream_id !== previous.stream_id ||
            scope.prescription_id !== previousScope.prescription_id ||
            scope.prescription_revision !== previousScope.prescription_revision ||
            scope.exercise_id !== previousScope.exercise_id ||
            Date.parse(event.occurred_at) <= Date.parse(previous.occurred_at))) ||
          event.event_id !== await hashCanonical({ seq: event.seq, stream_id: event.stream_id }) ||
          hash !== await hashCanonical(body)) {
        throw new Error("RECOVERY_RECORD_INVALID");
      }
      if (event.seq === 1 && event.type === "session.started") {
        // session.started and control/start are persisted as one local operation.
      } else if (event.type === "session.control" &&
          ((event.seq === 2 && event.payload.action === "start") || isStopAction(event.payload.action))) {
        phase = transition(phase, event.payload.action);
      } else if (event.type === "report.submitted") {
        phase = transition(phase, "report");
      } else {
        throw new Error("RECOVERY_RECORD_INVALID");
      }
      previous = event;
    }
    if (record.events.length === 1) throw new Error("RECOVERY_RECORD_INVALID");
    return { ...record, phase };
  }

  async append(previous, events, { replaceCompleted = false } = {}) {
    if (replaceCompleted && (previous.conflict ||
        previous.phase !== SESSION_PHASE.REPORTED || previous.acknowledged !== previous.events.length)) {
      throw new Error("RECOVERY_STREAM_UNRESOLVED");
    }
    const copy = structuredClone(events);
    const save = current => this.#store.write(current, {
      events: replaceCompleted ? copy : [...current.events, ...copy],
      acknowledged: replaceCompleted ? 0 : current.acknowledged,
      conflict: replaceCompleted ? null : current.conflict,
    });
    try {
      await save(previous);
    } catch (error) {
      if (error.message !== "RECOVERY_CONCURRENT_WRITE") throw error;
      const current = await this.read();
      // A receipt update can race a stop. Retry only over metadata changes.
      if (replaceCompleted || current.events.length !== previous.events.length ||
          !current.events.every((event, index) => event.hash === previous.events[index].hash)) throw error;
      await save(current);
    }
  }

  async reconcile(sent, results) {
    // Only a contiguous prefix of explicit confirmations can advance the cursor.
    const receipts = new Map();
    for (const result of Array.isArray(results) ? results : []) {
      if (receipts.has(result?.event_id)) return;
      receipts.set(result?.event_id, result);
    }
    let count = 0;
    let conflict = null;
    for (const event of sent) {
      const receipt = receipts.get(event.event_id);
      if (receipt?.status === "stored" || receipt?.status === "duplicate") {
        count++;
        continue;
      }
      const code = Array.isArray(receipt?.codes) && receipt.codes.find(c => CONFLICT.has(c));
      if (receipt?.status === "rejected" && code) conflict = { eventId: event.event_id, code };
      break;
    }
    if (!count && !conflict) return;

    // A local stop/report may be appended while the transport is in flight.
    // Re-read and update only if the same immutable prefix is still pending.
    const current = await this.read();
    if (current.conflict || !sent.every((event, i) =>
      current.events[current.acknowledged + i]?.hash === event.hash)) return;
    await this.#store.write(current, {
      events: current.events,
      acknowledged: current.acknowledged + count,
      conflict,
    });
  }
}
