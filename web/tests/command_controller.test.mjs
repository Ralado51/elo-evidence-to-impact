import test from "node:test";
import assert from "node:assert/strict";
import { createCommandController, isAmbiguousFailure, MAX_AUTO_RETRY_MS } from "../v3/command_controller.mjs";

const HOUR = 3600 * 1000;
function setup(over = {}) {
  const clock = { t: 1_000_000 };
  let n = 0;
  const c = createCommandController({ now: () => clock.t, uuid: () => `key-${++n}`, burstMs: 0, ...over });
  return { c, clock };
}
const net = () => Object.assign(new Error("net"), { status: 0 });
const e400 = () => Object.assign(new Error("bad"), { status: 400, code: "TYPE" });

test("double click / Enter+click: second submit is ignored while in flight", async () => {
  const { c } = setup();
  let release; const gate = new Promise((r) => (release = r));
  let sends = 0;
  const first = c.run("goal", async () => { sends++; await gate; return "ok"; });
  const second = await c.run("goal", async () => { sends++; return "dup"; });
  assert.equal(second.status, "ignored");
  assert.equal(c.stateOf("goal"), "in_flight");
  release();
  assert.equal((await first).status, "ok");
  assert.equal(sends, 1);
});

test("new intention after success gets a new key even with identical content", async () => {
  const { c } = setup();
  const keys = [];
  await c.run("goal", async (k) => keys.push(k));
  await c.run("goal", async (k) => keys.push(k));
  assert.deepEqual(keys, ["key-1", "key-2"]);
});

test("ambiguous failure keeps and reuses the same key (lost response after commit)", async () => {
  const { c } = setup();
  const keys = [];
  const r1 = await c.run("goal", async (k) => { keys.push(k); throw net(); });
  assert.equal(r1.status, "ambiguous");
  assert.equal(c.stateOf("goal"), "pending_retry");
  const r2 = await c.run("goal", async (k) => { keys.push(k); return "replayed"; });
  assert.equal(r2.status, "ok");
  assert.deepEqual(keys, ["key-1", "key-1"]);
  assert.equal(c.stateOf("goal"), "idle");
});

test("5xx and 408 are ambiguous; 4xx and 409 close the intention", async () => {
  assert.ok(isAmbiguousFailure({ status: 503 }) && isAmbiguousFailure({ status: 408 }) && isAmbiguousFailure({ status: 0 }));
  assert.ok(!isAmbiguousFailure({ status: 400 }) && !isAmbiguousFailure({ status: 409 }));
  const { c } = setup();
  const r = await c.run("goal", async () => { throw e400(); });
  assert.equal(r.status, "error");
  assert.equal(c.stateOf("goal"), "idle");
});

test("window is min(24h, retention - margin); default assumes 1 day", () => {
  const { c } = setup();
  assert.equal(c.windowMs(), 23 * HOUR);
  c.setRetentionDays(7);
  assert.equal(c.windowMs(), MAX_AUTO_RETRY_MS);
  c.setRetentionDays("garbage"); c.setRetentionDays(0); c.setRetentionDays(91);
  assert.equal(c.windowMs(), MAX_AUTO_RETRY_MS);
});

test("after the window: unknown state, NO automatic resend, no silent new key; explicit new intention clears", async () => {
  const { c, clock } = setup();
  await c.run("goal", async () => { throw net(); });
  clock.t += 24 * HOUR;
  assert.equal(c.stateOf("goal"), "unknown");
  let sent = 0;
  const r = await c.run("goal", async () => { sent++; return "x"; });
  assert.equal(r.status, "unknown");
  assert.equal(r.key, "key-1");
  assert.equal(sent, 0);
  assert.equal(c.startNewIntention("goal"), true);
  const keys = [];
  await c.run("goal", async (k) => keys.push(k));
  assert.deepEqual(keys, ["key-2"]);
});

test("forms are isolated from each other", async () => {
  const { c } = setup();
  await c.run("goal", async () => { throw net(); });
  const keys = [];
  await c.run("assessment", async (k) => keys.push(k));
  assert.deepEqual(keys, ["key-2"]);
  assert.equal(c.stateOf("goal"), "pending_retry");
});

test("startNewIntention refuses while a command is in flight", async () => {
  const { c } = setup();
  let release; const gate = new Promise((r) => (release = r));
  const p = c.run("goal", () => gate);
  assert.equal(c.startNewIntention("goal"), false);
  release(); await p;
});

test("singleFlightOnly: no key, nothing retained, second call ignored", async () => {
  const { c } = setup();
  let release; const gate = new Promise((r) => (release = r));
  let args;
  const p = c.singleFlightOnly("invite", async (...a) => { args = a; await gate; return "secret"; });
  assert.equal((await c.singleFlightOnly("invite", async () => "dup")).status, "ignored");
  release();
  assert.equal((await p).status, "ok");
  assert.deepEqual(args, []);
  assert.equal(c.stateOf("invite"), "idle");
  const failed = await c.singleFlightOnly("invite", async () => { throw net(); });
  assert.equal(failed.status, "error");
  assert.equal(c.stateOf("invite"), "idle");
});

test("burst guard: a repeat right after success is ignored; after the guard it is a new intention", async () => {
  const { c, clock } = setup({ burstMs: 500 });
  const keys = [];
  assert.equal((await c.run("goal", async (k) => keys.push(k))).status, "ok");
  assert.equal((await c.run("goal", async (k) => keys.push(k))).status, "ignored");
  clock.t += 600;
  assert.equal((await c.run("goal", async (k) => keys.push(k))).status, "ok");
  assert.deepEqual(keys, ["key-1", "key-2"]);
  // ambiguous failures are never blocked by the guard: the retry reuses the key
  const r = await c.run("rx", async () => { throw net(); });
  assert.equal(r.status, "ambiguous");
  assert.equal((await c.run("rx", async () => "ok")).status, "ok");
});

test("burst guard never blocks when the clock moves backwards", async () => {
  const { c, clock } = setup({ burstMs: 500 });
  await c.run("goal", async () => "ok");
  clock.t -= 10 * HOUR;
  assert.equal((await c.run("goal", async () => "ok")).status, "ok");
});

test("burst guard compares content: different content right after a success is a new intention", async () => {
  const { c } = setup({ burstMs: 500 });
  assert.equal((await c.run("p", async () => 1, { signature: ["Right", "right"] })).status, "ok");
  assert.equal((await c.run("p", async () => 1, { signature: ["Right", "right"] })).status, "ignored");
  assert.equal((await c.run("p", async () => 1, { signature: ["Left", "left"] })).status, "ok");
});
