import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { StorageAdapter } from "./storage_adapter.mjs";
import { RecoveryStore } from "./recovery_store.mjs";
import { EventOutbox } from "./event_outbox.mjs";
import { SessionController } from "./session_controller.mjs";
import { EventDispatcher } from "./event_dispatcher.mjs";
import { retentionState, RETENTION_MS } from "./retention.mjs";
globalThis.crypto ??= webcrypto;
const rx = { prescriptionId: "rx_fixture01", prescriptionRevision: 1 };
function open() {
  const data = new Map();
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const outbox = new EventOutbox(new RecoveryStore({ orgId: "o_fixture01", participantId: "p_fixture01" }, new StorageAdapter(storage)));
  let n = 0;
  return { outbox, controller: new SessionController(outbox, { sessionIdFactory: () => `s_fixture-${++n}-abcdefgh` }) };
}
const okTransport = async events => ({ data: { results: events.map(e => ({ event_id: e.event_id, status: "stored" })) } });

test("DS-01 dismissing the report is refused while events are unconfirmed (no silent loss)", async () => {
  const { controller } = open();
  await controller.start(rx); await controller.stop("end");
  await assert.rejects(controller.start(rx, { dismissReport: true }), /RECOVERY_STREAM_UNRESOLVED/);
  assert.equal((await controller.restore()).pending, 3);
});
test("DS-02 dismissing is allowed once everything is confirmed; the new stream replaces the old one", async () => {
  const { controller, outbox } = open();
  await controller.start(rx); await controller.stop("pain");
  await new EventDispatcher(outbox, okTransport).dispatch();
  const next = await controller.start(rx, { dismissReport: true });
  assert.equal(next.phase, "active"); assert.equal(next.pending, 2);
});
test("DS-03 without the explicit flag an ended session still blocks a new one", async () => {
  const { controller, outbox } = open();
  await controller.start(rx); await controller.stop("end");
  await new EventDispatcher(outbox, okTransport).dispatch();
  await assert.rejects(controller.start(rx), /INVALID_SESSION_TRANSITION/);
});
test("DS-04 an active session cannot be dismissed", async () => {
  const { controller } = open();
  await controller.start(rx);
  await assert.rejects(controller.start(rx, { dismissReport: true }), /INVALID_SESSION_TRANSITION/);
});
test("RT-01 retention: 7 days, expired-with-pending is kept and flagged", () => {
  const ev = { occurred_at: "2026-01-01T00:00:00.000Z" };
  const now = Date.parse(ev.occurred_at);
  assert.equal(retentionState({ events: [ev], acknowledged: 0 }, now + RETENTION_MS - 1).expired, false);
  const st = retentionState({ events: [ev], acknowledged: 0 }, now + RETENTION_MS + 1);
  assert.deepEqual(st, { expired: true, fullyConfirmed: false });
  assert.equal(retentionState({ events: [ev], acknowledged: 1 }, now + RETENTION_MS + 1).fullyConfirmed, true);
});
