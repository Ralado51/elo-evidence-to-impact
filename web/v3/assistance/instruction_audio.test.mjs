import assert from "node:assert/strict";
import test from "node:test";
import { createInstructionAudio } from "./instruction_audio.mjs";

const text = "Leia esta instrução sintética.";

test("text remains available with no playback or opt-in", async () => {
  const noPort = createInstructionAudio(text);
  noPort.enable();
  assert.equal(await noPort.start(), "unavailable");
  assert.equal(noPort.text, text);
  let calls = 0;
  const audio = createInstructionAudio(text, { play: async () => { calls++; } });
  assert.equal(await audio.start(), "disabled");
  assert.equal(calls, 0);
  assert.equal(audio.snapshot().text, text);
});

test("only explicit start plays the same text; stopping fences late completion", async () => {
  const pending = [];
  const audio = createInstructionAudio(text, { play(value, { signal }) {
    assert.equal(value, text);
    return new Promise((resolve) => pending.push({ resolve, signal }));
  } });
  audio.enable();
  assert.equal(pending.length, 0);
  const first = audio.start();
  assert.equal(await audio.start(), "playing");
  audio.stop();
  assert.equal(pending[0].signal.aborted, true);
  const second = audio.start();
  pending[0].resolve();
  assert.equal(await first, "stopped");
  assert.equal(audio.snapshot().status, "playing");
  pending[1].resolve();
  assert.equal(await second, "idle");
  audio.disable();
  assert.equal(await audio.start(), "disabled");
});

test("playback failure leaves equivalent text and allows a user retry", async () => {
  let failing = true;
  const audio = createInstructionAudio(text, { play: async () => {
    if (failing) throw new Error("unavailable fixture");
  } });
  audio.enable();
  assert.equal(await audio.start(), "unavailable");
  assert.equal(audio.snapshot().text, text);
  failing = false;
  assert.equal(await audio.start(), "idle");
});
