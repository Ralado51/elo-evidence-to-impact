import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { StorageAdapter } from "./storage_adapter.mjs";
import { RecoveryStore } from "./recovery_store.mjs";
import { EventOutbox } from "./event_outbox.mjs";
import { EventDispatcher } from "./event_dispatcher.mjs";
import { SessionController } from "./session_controller.mjs";

globalThis.crypto ??= webcrypto;
const scope = { orgId: "o_fixture01", participantId: "p_fixture01" };
const rx = { prescriptionId: "rx_fixture01", prescriptionRevision: 1 };
function fixture() {
  const data = new Map();
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
  function open(identity = scope) {
    const outbox = new EventOutbox(new RecoveryStore(identity, new StorageAdapter(storage)));
    return { outbox, controller: new SessionController(outbox) };
  }
  return { open, storage, data };
}

test("reload recovers an active stream, offline stop and pending report without a new stream", async () => {
  const { open } = fixture();
  const initial = await open().controller.start(rx);
  const restored = open().controller;
  assert.deepEqual(await restored.restore(), initial);
  await restored.stop("pain");
  const after = open().controller;
  assert.deepEqual(await after.restore(), { ...initial, phase: "ended", endAction: "pain", pending: 3 });
  await assert.rejects(after.start(rx), /INVALID_SESSION_TRANSITION/);
  await after.submitReport({ execution: "partial", assistance: "some" });
  assert.equal((await open().controller.restore()).phase, "reported");
  await assert.rejects(after.start(rx), /RECOVERY_STREAM_UNRESOLVED/);
});

test("lost response after durable write retries identical event IDs, sequence and hashes", async () => {
  const { open, data } = fixture();
  const { controller, outbox } = open();
  await controller.start({ ...rx, token: "do-not-persist" });
  await controller.stop("end");
  await controller.submitReport({ execution: "complete", assistance: "none" });
  const ledger = new Map();
  const sent = [];
  const transport = async events => {
    sent.push(structuredClone(events));
    const results = events.map(event => {
      const prior = ledger.get(event.event_id);
      if (prior) assert.deepEqual(prior, event);
      else ledger.set(event.event_id, event);
      return { event_id: event.event_id, status: prior ? "duplicate" : "stored" };
    });
    if (sent.length === 1) throw new TypeError("response lost");
    return { data: { results } };
  };
  const first = new EventDispatcher(outbox, transport);
  const flight = first.dispatch();
  assert.equal(first.dispatch(), flight);
  assert.deepEqual(await flight, { pending: 4, status: "pending", conflict: null });
  const recovered = open();
  const retry = new EventDispatcher(recovered.outbox, transport);
  assert.deepEqual(await retry.dispatch(), { pending: 0, status: "synced", conflict: null });
  await retry.dispatch();
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent.length, 2);
  assert.equal(ledger.size, 4);
  assert.ok([...data.values()].every(v => !v.includes("do-not-persist")));
  assert.notEqual((await recovered.controller.start(rx)).sessionId, sent[0][0].scope.session_id);
});

test("partial acknowledgement preserves the suffix and hash conflict survives reload", async () => {
  const { open } = fixture();
  const { controller, outbox } = open();
  await controller.start(rx);
  const sender = new EventDispatcher(outbox, async ([first, second]) => {
    throw { details: [
      { event_id: first.event_id, status: "stored" },
      { event_id: second.event_id, status: "rejected", codes: ["HASH_CONFLICT"] },
    ] };
  });
  const result = await sender.dispatch();
  assert.equal(result.pending, 1);
  assert.equal(result.conflict.code, "HASH_CONFLICT");
  const next = open();
  await next.controller.stop("fatigue");
  assert.equal((await next.controller.restore()).endAction, "fatigue");
  let calls = 0;
  assert.equal((await new EventDispatcher(next.outbox, async () => { calls++; }).dispatch()).status, "conflict");
  assert.equal(calls, 0);
});

test("scope isolation and concurrent report do not overwrite a persisted event", async () => {
  const { open } = fixture();
  const { controller, outbox } = open();
  await controller.start(rx);
  await controller.stop("end");
  const other = open({ ...scope, participantId: "p_fixture02" });
  assert.equal((await other.controller.restore()).phase, "idle");
  const result = await Promise.allSettled([
    controller.submitReport({ execution: "complete", assistance: "none" }),
    open().controller.submitReport({ execution: "partial", assistance: "some" }),
  ]);
  assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await outbox.read()).events.filter(e => e.type === "report.submitted").length, 1);
});

test("reload after partial receipts retries only unconfirmed suffix", async () => {
  const { open } = fixture();
  const original = open();
  await original.controller.start(rx);
  await original.controller.stop("end");
  let suffix;
  await new EventDispatcher(original.outbox, async events => {
    suffix = events.slice(1);
    return { data: { results: [{ event_id: events[0].event_id, status: "stored" }] } };
  }).dispatch();
  const next = open();
  const result = await new EventDispatcher(next.outbox, async events => {
    assert.deepEqual(events, suffix);
    return { data: { results: events.map(e => ({ event_id: e.event_id, status: "duplicate" })) } };
  }).dispatch();
  assert.equal(result.status, "synced");
});

test("an in-flight acknowledgement cannot erase a stop recorded locally", async () => {
  const { open } = fixture();
  const { controller, outbox } = open();
  await controller.start(rx);
  let notifySent, resolveResponse;
  const sent = new Promise(resolve => { notifySent = resolve; });
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const dispatch = new EventDispatcher(outbox, events => { notifySent(events); return response; }).dispatch();
  const events = await sent;
  await controller.stop("pain");
  resolveResponse({ data: { results: events.map(e => ({ event_id: e.event_id, status: "stored" })) } });
  assert.equal((await dispatch).pending, 1);
  const current = await outbox.read();
  assert.equal(current.events.at(-1).payload.action, "pain");
  assert.equal(current.acknowledged, 2);
});

test("storage failure aborts the local mutation and leaves nothing to dispatch", async () => {
  const { open, storage } = fixture();
  const session = open();
  storage.setItem = () => { throw new Error("quota"); };
  await assert.rejects(session.controller.start(rx), /quota/);
  let calls = 0;
  const result = await new EventDispatcher(session.outbox, async () => { calls++; }).dispatch();
  assert.equal(result.pending, 0);
  assert.equal(calls, 0);
});

test("a mutated persisted event is rejected before transmission", async () => {
  const { open, data } = fixture();
  await open().controller.start(rx);
  const [key, value] = [...data][0];
  const parsed = JSON.parse(value);
  parsed.events[1].payload.action = "pain";
  data.set(key, JSON.stringify(parsed));
  let calls = 0;
  const dispatcher = new EventDispatcher(open().outbox, async () => { calls++; });
  await assert.rejects(dispatcher.dispatch(), /RECOVERY_RECORD_INVALID/);
  assert.equal(calls, 0);
});
