import test from "node:test";
import assert from "node:assert/strict";
import { createContextStore, isAbortError } from "../v3/context_store.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("CS-01 switch changes generation only when the participant changes", () => {
  const s = createContextStore();
  assert.equal(s.switchTo({ principalId: "t1", role: "therapist", participantId: "A" }), true);
  const g = s.current().generation;
  assert.equal(s.switchTo({ participantId: "A" }), false);
  assert.equal(s.current().generation, g);
  assert.equal(s.switchTo({ participantId: "B" }), true);
  assert.equal(s.current().generation, g + 1);
});

test("CS-02 read: a switch makes the pending read obsolete and aborts it; commit and fail are dropped", () => {
  const s = createContextStore();
  s.switchTo({ principalId: "t1", role: "therapist", participantId: "A" });
  const op = s.begin("timeline");
  s.switchTo({ participantId: "B" });
  assert.equal(op.signal.aborted, true);
  assert.equal(op.isCurrent(), false);
  let ran = 0;
  op.commit(() => ran++);
  op.fail(new Error("late"), () => ran++);
  assert.equal(ran, 0);
});

test("CS-03 same channel: the LAST REQUESTED wins and the previous read is aborted", () => {
  const s = createContextStore();
  s.switchTo({ principalId: "t1", role: "therapist", participantId: "A" });
  const first = s.begin("facts");
  const second = s.begin("facts");
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  assert.equal(second.commit(() => "ok"), "ok");
});

test("CS-04 AbortError is silent even in the current context", () => {
  const s = createContextStore();
  s.switchTo({ principalId: "t1", role: "therapist", participantId: "A" });
  const op = s.begin("x");
  let ran = 0;
  assert.equal(isAbortError(Object.assign(new Error("a"), { name: "AbortError" })), true);
  op.fail(Object.assign(new Error("a"), { name: "AbortError" }), () => ran++);
  assert.equal(ran, 0);
  op.fail(new Error("real"), () => ran++);
  assert.equal(ran, 1);
});

test("CS-05 principal-level reads survive a participant switch but not logout/principal change", () => {
  const s = createContextStore();
  s.switchTo({ principalId: "t1", role: "therapist", participantId: "A" });
  const list = s.begin("list", { level: "principal" });
  s.switchTo({ participantId: "B" });
  assert.equal(list.isCurrent(), true);
  s.reset("logout");
  assert.equal(list.isCurrent(), false);
  assert.equal(list.signal.aborted, true);
});

test("CS-06 write: ticket captured before the await; switch -> orphan, never commit; the write itself is not abortable", async () => {
  const s = createContextStore();
  s.switchTo({ principalId: "t1", role: "therapist", participantId: "A" });
  const ticket = s.capture();
  s.switchTo({ participantId: "B" });
  await tick();
  const seen = [];
  ticket.commit(() => seen.push("commit"));
  ticket.orphan((at) => seen.push(`orphan:${at.participantId}`));
  assert.deepEqual(seen, ["orphan:A"]);
  assert.equal("signal" in ticket, false);
});

test("CS-07 write in the same context commits and does not orphan", () => {
  const s = createContextStore();
  s.switchTo({ principalId: "t1", role: "therapist", participantId: "A" });
  const t = s.capture();
  const seen = [];
  t.commit(() => seen.push("c"));
  t.orphan(() => seen.push("o"));
  assert.deepEqual(seen, ["c"]);
});

test("CS-08 reset is a boundary even when ids are unchanged; resetters run; notices and secrets die", () => {
  const s = createContextStore();
  s.switchTo({ principalId: "t1", role: "therapist", participantId: "A" });
  const reasons = [];
  s.onReset((r) => reasons.push(r));
  s.addNotice("A", { kind: "goal" });
  const t = s.capture();
  s.reset("logout");
  assert.equal(t.isCurrent(), false);
  assert.deepEqual(reasons, ["logout"]);
  assert.deepEqual(s.takeNotices("A"), []);
});

test("CS-09 notices are per participant, taken once, in memory", () => {
  const s = createContextStore();
  s.switchTo({ principalId: "t1", role: "therapist", participantId: "A" });
  s.addNotice("A", { kind: "goal", entityId: "g1" });
  assert.equal(s.takeNotices("B").length, 0);
  assert.equal(s.takeNotices("A").length, 1);
  assert.equal(s.takeNotices("A").length, 0);
});

test("CS-10 a throwing resetter does not break the switch", () => {
  const s = createContextStore();
  s.switchTo({ principalId: "t1", role: "therapist", participantId: "A" });
  s.onReset(() => { throw new Error("boom"); });
  assert.equal(s.switchTo({ participantId: "B" }), true);
});
