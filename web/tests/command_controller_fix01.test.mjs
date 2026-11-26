// ARQ-02 fix01 (D04, S1-03): intention identity = edit, not elapsed time. Existing command_controller tests are untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { createCommandController } from "../v3/command_controller.mjs";

function setup() {
  const clock = { t: 1_000_000 };
  let n = 0;
  const c = createCommandController({ now: () => clock.t, uuid: () => `key-${++n}`, consumeUntilEdit: true });
  return { c, clock };
}

test("fulfilled intention is settled at ANY latency: no request, same key, no new effect", async () => {
  const { c, clock } = setup();
  const sent = [];
  assert.equal((await c.run("goal", async (k) => { sent.push(k); return "r1"; })).status, "ok");
  for (const dt of [0, 100, 600, 5000, 60_000]) {
    clock.t += dt;
    const r = await c.run("goal", async (k) => { sent.push(k); return "dup"; });
    assert.equal(r.status, "settled");
    assert.equal(r.key, "key-1");
    assert.equal(r.result, "r1");
  }
  assert.deepEqual(sent, ["key-1"]);
  assert.equal(c.stateOf("goal"), "settled");
});

test("an explicit edit starts a NEW intention with a new key, even with identical content", async () => {
  const { c } = setup();
  const keys = [];
  await c.run("goal", async (k) => keys.push(k), { signature: "same" });
  assert.equal(c.release("goal"), true);
  assert.equal((await c.run("goal", async (k) => keys.push(k), { signature: "same" })).status, "ok");
  assert.deepEqual(keys, ["key-1", "key-2"]);
});

test("in flight: repeats are ignored; an edit made during the flight means the success does not consume the next intention", async () => {
  const { c } = setup();
  let release; const gate = new Promise((r) => (release = r));
  const p = c.run("goal", async () => { await gate; return 1; });
  assert.equal((await c.run("goal", async () => 2)).status, "ignored");
  c.release("goal"); // user edits while the request is in flight
  release();
  assert.equal((await p).status, "ok");
  assert.equal((await c.run("goal", async () => 3)).status, "ok"); // not settled: content changed after submit
});

test("ambiguous failure keeps its key across edits; only a definite outcome closes it", async () => {
  const { c } = setup();
  const keys = [];
  const net = () => Object.assign(new Error("net"), { status: 0 });
  assert.equal((await c.run("goal", async (k) => { keys.push(k); throw net(); })).status, "ambiguous");
  c.release("goal"); // editing does not discard the pending key
  assert.equal((await c.run("goal", async (k) => { keys.push(k); return "ok"; })).status, "ok");
  assert.deepEqual(keys, ["key-1", "key-1"]);
});

test("beyond the dedup window a consumed intention no longer blocks (key cannot be guaranteed)", async () => {
  const { c, clock } = setup();
  await c.run("goal", async () => 1);
  clock.t += c.windowMs() + 1;
  assert.equal((await c.run("goal", async () => 2)).status, "ok");
});

test("slots are isolated (form@participant): Alfa's settled intention does not block Beta", async () => {
  const { c } = setup();
  await c.run("goal@alfa", async () => 1);
  assert.equal((await c.run("goal@beta", async () => 2)).status, "ok");
  assert.equal((await c.run("goal@alfa", async () => 3)).status, "settled");
});

test("without consumeUntilEdit the legacy behavior is unchanged", async () => {
  const c = createCommandController({ burstMs: 0 });
  assert.equal((await c.run("goal", async () => 1)).status, "ok");
  assert.equal((await c.run("goal", async () => 2)).status, "ok");
});
