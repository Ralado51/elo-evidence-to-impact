// CL06.3 canonical JSON, SHA-256 hashing, and ledger v3 integrity tests (Node built-ins only).
// Run: node --test web/tests/*.test.mjs  (signals pass/fail strictly through process exit code).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CanonicalizationError,
  canonicalBytes,
  canonicalize,
  checkEventIntegrity,
  checkStreamChain,
  computeEventHash,
  computeEventId,
  contentHash,
  hashCanonical,
  sha256Hex,
} from "../canonical.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = path.join(REPO_ROOT, "contracts", "CL06_3-r1", "fixtures", "valid");
const VECTORS_DOC = JSON.parse(fs.readFileSync(path.join(FIXTURES, "canonical-vectors.v3.json"), "utf8"));
const VECTORS = VECTORS_DOC.vectors;
const MUST_REJECT = VECTORS_DOC.must_reject;
const LEDGER_EVENTS = JSON.parse(fs.readFileSync(path.join(FIXTURES, "ledger.v3.json"), "utf8")).events;

const MUST_REJECT_VALUES = {
  "X01-nan": NaN,
  "X02-infinity": Infinity,
  "X03-lone-surrogate": { k: "\ud800" },
};

for (const vector of VECTORS) {
  test(`canonical vector ${vector.id}`, () => {
    const gotBytes = canonicalBytes(vector.value);
    const expectedBytes = Buffer.from(vector.canonical, "utf8");
    assert.deepEqual(gotBytes, expectedBytes);
    assert.equal(canonicalize(vector.value), vector.canonical);
    assert.equal(sha256Hex(canonicalize(vector.value)), vector.sha256);
    assert.equal(hashCanonical(vector.value), vector.sha256);
  });
}

for (const item of MUST_REJECT) {
  test(`canonical must_reject ${item.id}`, () => {
    assert.throws(() => canonicalize(MUST_REJECT_VALUES[item.id]), CanonicalizationError);
  });
}

test("additional must_reject edge cases (-Infinity, key lone surrogate)", () => {
  assert.throws(() => canonicalize(-Infinity), CanonicalizationError);
  assert.throws(() => canonicalize({ "\ud800": 1 }), CanonicalizationError);
});

test("ledger v3: 22 event_ids, hashes, prev_hash chains, and evolution content_hash", () => {
  assert.equal(LEDGER_EVENTS.length, 22);
  const streams = new Map();
  for (const event of LEDGER_EVENTS) {
    assert.equal(computeEventId(event.stream_id, event.seq), event.event_id);
    assert.equal(computeEventHash(event), event.hash);
    assert.deepEqual(checkEventIntegrity(event), []);
    if (!streams.has(event.stream_id)) streams.set(event.stream_id, []);
    streams.get(event.stream_id).push(event);
  }
  for (const [streamId, events] of streams.entries()) {
    assert.deepEqual(checkStreamChain(events), [], streamId);
  }
  const evo = LEDGER_EVENTS.find((e) => e.type === "evolution.published");
  assert.equal(contentHash(evo.payload), evo.payload.content_hash);
});

test("stream chain detects deliberately broken prev_hash link", () => {
  const s1 = structuredClone(LEDGER_EVENTS.filter((e) => e.stream_id === "session:s_fixture-0001"));
  const target = s1.find((e) => e.seq === 2);
  target.prev_hash = "0".repeat(64);
  target.hash = computeEventHash(target);
  const errs = checkStreamChain(s1);
  assert.ok(errs.includes("CHAIN_BROKEN"));
});

test("stream chain detects duplicate seq conflict", () => {
  const s1 = structuredClone(LEDGER_EVENTS.filter((e) => e.stream_id === "session:s_fixture-0001"));
  const dup = structuredClone(s1.find((e) => e.seq === 6));
  dup.payload.frames = dup.payload.frames + 1;
  dup.hash = computeEventHash(dup);
  s1.push(dup);
  const errs = checkStreamChain(s1);
  assert.ok(errs.includes("HASH_CONFLICT"));
});
