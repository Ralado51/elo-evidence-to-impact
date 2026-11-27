import test from "node:test";
import assert from "node:assert/strict";
import { createV3Client } from "../v3/api_client.mjs";
import { createParticipantClient } from "../v3/participant_api.mjs";

const json = (status, body) => ({ ok: status < 400, status, headers: { get: () => "application/json" }, json: async () => body });

test("HT-01 signal reaches fetch on reads; aborting yields code ABORTED (not NETWORK_ERROR)", async () => {
  let seen;
  const fetchImpl = (url, init) => new Promise((_, reject) => { seen = init; init.signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" }))); });
  const c = createV3Client({ fetchImpl, getToken: () => "t" });
  const ac = new AbortController();
  const p = c.getTimeline("p_1", { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.code === "ABORTED" && e.status === 0);
  assert.equal(seen.signal, ac.signal);
});

test("HT-02 writes never carry a signal", async () => {
  let init;
  const fetchImpl = async (u, i) => { init = i; return json(201, { ok: 1 }); };
  const c = createV3Client({ fetchImpl, getToken: () => "t" });
  await c.createGoal("p_1", { a: 1 }, { idempotencyKey: "k" });
  assert.equal("signal" in init, false);
});

test("HT-03 error envelope mapping identical in both clients", async () => {
  const fetchImpl = async () => json(400, { error: { code: "RULE_VIOLATION", message: "m", details: { rule: "r", path: "$.x" } } });
  const a = createV3Client({ fetchImpl, getToken: () => "t" });
  const b = createParticipantClient({ fetchImpl, getToken: () => "t" });
  const ea = await a.getTimeline("p").catch((e) => e);
  const eb = await b.getSummary("s").catch((e) => e);
  assert.deepEqual([ea.code, ea.status, ea.details], ["RULE_VIOLATION", 400, { rule: "r", path: "$.x" }]);
  assert.deepEqual([eb.code, eb.status, eb.details], ["RULE_VIOLATION", 400, { rule: "r", path: "$.x" }]);
});

test("HT-04 participant client still rejects therapist-only routes (capabilities not merged)", async () => {
  const b = createParticipantClient({ fetchImpl: async () => json(200, {}), getToken: () => "t" });
  assert.equal(typeof b.getTimeline, "undefined");
  assert.equal(typeof b.createGoal, "undefined");
});

test("HT-05 network failure keeps NETWORK_ERROR", async () => {
  const a = createV3Client({ fetchImpl: async () => { throw new Error("down"); }, getToken: () => "t" });
  await assert.rejects(a.getTimeline("p"), (e) => e.code === "NETWORK_ERROR");
});

test("HT-06 a signal handed to a write is ignored; aborting it later does not cancel the write", async () => {
  let init; let release;
  const fetchImpl = (u, i) => { init = i; return new Promise((r) => { release = () => r(json(201, { id: "g1" })); }); };
  const c = createV3Client({ fetchImpl, getToken: () => "t" });
  const ac = new AbortController();
  const p = c.createGoal("p_1", { a: 1 }, { idempotencyKey: "k", signal: ac.signal });
  ac.abort();
  release();
  const res = await p;
  assert.equal(res.status, 201);
  assert.equal(init.signal, undefined);
});

test("HT-07 a write that fails on the network is NETWORK_ERROR (unknown outcome), never ABORTED", async () => {
  const c = createV3Client({ fetchImpl: async () => { throw Object.assign(new Error("net"), { name: "AbortError" }); }, getToken: () => "t" });
  const err = await c.createGoal("p_1", { a: 1 }, { idempotencyKey: "k" }).catch((e) => e);
  assert.notEqual(err.code, "ABORTED");
});

test("HT-08 aborted READ is ABORTED and a settled write on the same client is unaffected", async () => {
  const calls = [];
  const fetchImpl = (u, i) => new Promise((res, rej) => {
    calls.push({ u, i });
    if (i.method === "GET") i.signal.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" })));
    else res(json(201, { ok: 1 }));
  });
  const c = createV3Client({ fetchImpl, getToken: () => "t" });
  const ac = new AbortController();
  const read = c.getTimeline("p_1", { signal: ac.signal });
  const write = c.createGoal("p_1", { a: 1 }, { idempotencyKey: "k" });
  ac.abort();
  await assert.rejects(read, (e) => e.code === "ABORTED");
  assert.equal((await write).status, 201);
});
