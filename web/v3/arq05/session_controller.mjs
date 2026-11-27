import {
  buildSessionStartedEvent, buildSessionControlEvent, buildReportSubmittedEvent,
  generateSessionId, nextMonotonicIso,
} from "../participant_model.mjs";
import { isStopAction, SESSION_PHASE, transition } from "./session_state.mjs";

export class SessionController {
  #outbox;
  #sessionId;

  constructor(outbox, { sessionIdFactory = generateSessionId } = {}) {
    this.#outbox = outbox;
    this.#sessionId = sessionIdFactory;
  }

  async restore() {
    const record = await this.#outbox.read();
    const last = record.events.at(-1);
    const end = record.events.find(event => event.type === "session.control" &&
      isStopAction(event.payload.action));
    return {
      phase: record.phase,
      sessionId: last?.scope.session_id ?? null,
      endAction: end?.payload.action ?? null,
      pending: record.events.length - record.acknowledged,
      conflict: record.conflict,
    };
  }

  // dismissReport (PO ratification): an ENDED session whose events are ALL confirmed may be left without a report on explicit
  // request. Unconfirmed events are never dropped silently: the call is refused (RECOVERY_STREAM_UNRESOLVED).
  async start({ prescriptionId, prescriptionRevision, exerciseId }, { dismissReport = false } = {}) {
    const current = await this.#outbox.read();
    const dismissed = dismissReport && current.phase === SESSION_PHASE.ENDED;
    const completed = current.phase === SESSION_PHASE.REPORTED || dismissed;
    transition(completed ? SESSION_PHASE.IDLE : current.phase, "start");
    if (current.conflict || (completed && current.acknowledged !== current.events.length)) {
      throw new Error("RECOVERY_STREAM_UNRESOLVED");
    }
    if (typeof prescriptionId !== "string" || !prescriptionId ||
        !Number.isSafeInteger(prescriptionRevision) || prescriptionRevision < 1 ||
        (exerciseId !== undefined && typeof exerciseId !== "string")) {
      throw new Error("PRESCRIPTION_REQUIRED");
    }
    const sessionId = this.#sessionId();
    if (!/^s_[A-Za-z0-9-]{8,64}$/.test(sessionId) ||
        sessionId === current.events.at(-1)?.scope.session_id) throw new Error("INVALID_SESSION_ID");
    const params = { ...this.#outbox.scope, sessionId, prescriptionId, prescriptionRevision, exerciseId };
    const first = await buildSessionStartedEvent(params);
    const second = await buildSessionControlEvent({
      ...params, seq: 2, prevHash: first.hash, occurredAt: nextMonotonicIso(first.occurred_at), action: "start",
    });
    await this.#outbox.append(current, [first, second], { replaceCompleted: completed, dismissed });
    return this.restore();
  }

  async stop(action) {
    if (!isStopAction(action)) throw new Error("INVALID_STOP_ACTION");
    return this.#append(action, params => buildSessionControlEvent({ ...params, action }));
  }

  async submitReport({ execution, assistance }) {
    return this.#append("report", params => buildReportSubmittedEvent({ ...params, execution, assistance }));
  }

  async #append(action, build) {
    const current = await this.#outbox.read();
    transition(current.phase, action);
    const last = current.events.at(-1);
    const scope = last.scope;
    const event = await build({
      ...this.#outbox.scope,
      sessionId: scope.session_id,
      prescriptionId: scope.prescription_id,
      prescriptionRevision: scope.prescription_revision,
      exerciseId: scope.exercise_id,
      seq: last.seq + 1,
      prevHash: last.hash,
      occurredAt: nextMonotonicIso(last.occurred_at),
    });
    await this.#outbox.append(current, [event]);
    return this.restore();
  }
}
