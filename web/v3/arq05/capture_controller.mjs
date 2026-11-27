// Experimental capture (S2) on the SAME outbox/recovery/dispatch used by the S1 report-only flow.
// Phases: created -> calibrated -> active -> ended -> reported. Mode is "simulation" (synthetic) or "camera" (real local capture, experimental_capture).
import { generateSessionId, nextMonotonicIso } from "../participant_model.mjs";
import { buildCaptureEvent, PROTOCOL_VERSION } from "../../s2/arq08/capture_events.mjs";
import { SESSION_PHASE } from "./session_state.mjs";

const median = (v) => { const o = [...v].sort((a, b) => a - b); const m = o.length >> 1; return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2; };
const newCalId = () => "cal_" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
const MIN_SAMPLES = 8; // calibration.applied schema floor

export class CaptureController {
  #outbox;
  #sessionId;
  constructor(outbox, { sessionIdFactory = generateSessionId } = {}) { this.#outbox = outbox; this.#sessionId = sessionIdFactory; }

  async restore() {
    const record = await this.#outbox.read();
    const last = record.events.at(-1);
    const stop = record.events.find((e) => e.type === "session.control" && ["end", "pain", "fatigue", "interrupt"].includes(e.payload.action));
    const cycles = record.events.filter((e) => e.type.startsWith("cycle."));
    const applied = record.events.findLast((e) => e.type === "calibration.applied");
    return {
      phase: record.phase, mode: record.mode, sessionId: last?.scope.session_id ?? null,
      endAction: stop?.payload.action ?? null, pending: record.events.length - record.acknowledged, conflict: record.conflict,
      accepted: cycles.filter((e) => e.type === "cycle.accepted").length, candidates: cycles.length,
      calibration: applied ? { ...applied.payload } : null,
    };
  }

  async begin({ prescriptionId, prescriptionRevision, exerciseId, frame = { width: 640, height: 480 }, deviceHint = "desktop-other", mode = "simulation", algorithmVersion = PROTOCOL_VERSION }, { dismissReport = false } = {}) {
    if (mode !== "simulation" && mode !== "camera") throw new Error("INVALID_SESSION_MODE");
    if (!/^[a-z0-9][a-z0-9.-]{1,40}$/.test(algorithmVersion)) throw new Error("INVALID_ALGORITHM_VERSION");
    const current = await this.#outbox.read();
    const dismissed = dismissReport && current.phase === SESSION_PHASE.ENDED;
    const completed = current.phase === SESSION_PHASE.REPORTED || dismissed;
    if (current.events.length && !completed) throw new Error("INVALID_SESSION_TRANSITION");
    if (current.conflict || (completed && current.acknowledged !== current.events.length)) throw new Error("RECOVERY_STREAM_UNRESOLVED");
    if (typeof prescriptionId !== "string" || !prescriptionId || !Number.isSafeInteger(prescriptionRevision) || prescriptionRevision < 1) throw new Error("PRESCRIPTION_REQUIRED");
    const sessionId = this.#sessionId();
    if (!/^s_[A-Za-z0-9-]{8,64}$/.test(sessionId) || sessionId === current.events.at(-1)?.scope.session_id) throw new Error("INVALID_SESSION_ID");
    const scope = { ...this.#outbox.scope, session_id: sessionId, prescription_id: prescriptionId, prescription_revision: prescriptionRevision, exercise_id: exerciseId || "organizar-a-mesa" };
    const first = await buildCaptureEvent({
      type: "session.started", scope: { org_id: scope.orgId, participant_id: scope.participantId, session_id: sessionId, prescription_id: prescriptionId, prescription_revision: prescriptionRevision, exercise_id: scope.exercise_id },
      seq: 1, prevHash: null, occurredAt: nextMonotonicIso(), tMonoMs: 0,
      mode, algorithmVersion, payload: { source_mode: mode, prescription_id: prescriptionId, prescription_revision: prescriptionRevision,
        capture_context: { device_hint: deviceHint, frame_width: frame.width, frame_height: frame.height } },
    });
    await this.#outbox.append(current, [first], { replaceCompleted: completed, dismissed });
    return this.restore();
  }

  /** Records two attempts (open/closed) and then calibration.applied or calibration.failed. Never edits an earlier event. */
  async calibrate({ open, closed, minSpan }) {
    return this.#append("created|calibrated", async (ctx) => {
      const attempts = [];
      const prior = ctx.record.events.filter((e) => e.type === "calibration.attempted").length;
      for (const [i, [posture, samples]] of [["open", open], ["closed", closed]].entries()) {
        const ok = Array.isArray(samples) && samples.length >= MIN_SAMPLES && samples.length <= 10_000 && samples.every((v) => Number.isFinite(v) && Math.abs(v) <= 10);
        const med = ok ? median(samples) : null;
        const mad = ok ? median(samples.map((v) => Math.abs(v - med))) : null;
        attempts.push(await ctx.add("calibration.attempted", { attempt: prior + i + 1, posture, n_samples: Array.isArray(samples) ? Math.min(samples.length, 10_000) : 0, median: med, mad, accepted: ok, reason: ok ? null : "insufficient_samples" }));
      }
      if (!attempts.every((a) => a.payload.accepted)) return { status: "insufficient" };
      const refs = attempts.map((a) => a.event_id).sort();
      const o = attempts[0].payload.median, c = attempts[1].payload.median, span = o - c;
      if (!(span >= minSpan)) {
        await ctx.add("calibration.failed", { reason: "below_min_span", attempt_refs: refs, span });
        return { status: "invalid_span" };
      }
      const id = newCalId();
      await ctx.add("calibration.applied", { calibration_id: id, open: o, closed: c, span, open_samples: open.length, closed_samples: closed.length, attempt_refs: refs, min_span_required: minSpan });
      return { status: "ready", calibration: { status: "ready", id, open: o, closed: c, span } };
    });
  }

  start(tMonoMs) { return this.#append("calibrated", (ctx) => ctx.add("session.control", { action: "start", interrupt_reason: null }, tMonoMs)); }

  /** Appends cycle candidates (from the motion core) and, when the prescribed dose is reached, the mandatory session.completed. */
  async recordCycles(candidates, { target }) {
    return this.#append("active", async (ctx) => {
      let accepted = ctx.record.events.filter((e) => e.type === "cycle.accepted").length;
      let last;
      for (const c of candidates) {
        last = await ctx.add(c.type, c.payload, c.t_mono_ms);
        if (c.type === "cycle.accepted") accepted += 1;
      }
      if (accepted >= target) await ctx.add("session.completed", { accepted, target }, last?.t_mono_ms);
    });
  }

  async stop(action, { interruptReason = null, tMonoMs } = {}) {
    if (!["end", "pain", "fatigue", "interrupt"].includes(action)) throw new Error("INVALID_STOP_ACTION");
    return this.#append("created|calibrated|active", (ctx) => ctx.add("session.control", { action, interrupt_reason: action === "interrupt" ? interruptReason : null }, tMonoMs));
  }

  captureSummary(stats, tMonoMs) {
    return this.#append("ended", (ctx) => ctx.add("session.capture_summary", stats, tMonoMs));
  }

  submitReport({ execution, assistance }) {
    return this.#append("ended", (ctx) => ctx.add("report.submitted", { execution, assistance, reporter_role: "participant" }));
  }

  async #append(allowed, build) {
    const record = await this.#outbox.read();
    const phase = record.phase;
    const ok = allowed.split("|").includes(phase);
    if ((record.mode !== "simulation" && record.mode !== "camera") || !ok) throw new Error("INVALID_SESSION_TRANSITION");
    if (record.conflict) throw new Error("RECOVERY_STREAM_UNRESOLVED");
    const events = [];
    let prev = record.events.at(-1);
    const scopeOf = prev.scope;
    const ctx = {
      record,
      add: async (type, payload, tMonoMs) => {
        const last = events.at(-1) ?? prev;
        const ev = await buildCaptureEvent({
          type, scope: scopeOf, seq: last.seq + 1, prevHash: last.hash, occurredAt: nextMonotonicIso(last.occurred_at),
          tMonoMs: Math.max(Number.isFinite(tMonoMs) ? Math.round(tMonoMs) : 0, last.t_mono_ms ?? 0), payload,
          algorithmVersion: prev.source?.algorithm_version ?? PROTOCOL_VERSION, mode: record.mode,
        });
        events.push(ev);
        return ev;
      },
    };
    const out = await build(ctx);
    if (events.length) await this.#outbox.append(record, events);
    return { ...(await this.restore()), ...(out ?? {}) };
  }
}
