// CL06.3 contract tests (JavaScript, node:test). Mirrors tests/python/test_contracts.py. Gate C only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as R from "../../reference/js/elo_ref.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const J = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), "utf8"));
const C = (...p) => J("contracts", ...p), F = (...p) => J("fixtures", ...p);
const loadDir = (d, cut, key) => Object.fromEntries(fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith(".schema.json")).map((f) => [key(f), J(d, f)]));
const EVENT_CAT = C("catalogs", "event-catalog.v3.json"), LIMITS = C("catalogs", "limits.v1.json"), ERR = C("catalogs", "error-codes.v3.json").codes;
const ES = loadDir("contracts/schemas/events", 0, (f) => f.replace(".schema.json", ""));
const NS = loadDir("contracts/schemas/entities", 0, (f) => f.replace(".schema.json", ""));
const FPS = Object.fromEntries(fs.readdirSync(path.join(ROOT, "contracts/schemas/facts")).filter((f) => f.startsWith("fact-proposal.")).map((f) => [f.split(".")[1], J("contracts/schemas/facts", f)]));
const LEDGER = F("valid", "ledger.v3.json").events;
const RX = LEDGER.find((e) => e.type === "prescription.published").payload;
const INV = F("invalid", "contract-invalid.v3.json");

const codes = (errs) => new Set(errs.map((e) => e[1]));
const semEvents = (e) => { try { return new Set([...R.checkEventSemantics(e, EVENT_CAT, LIMITS), ...R.checkEventIntegrity(e)]); } catch { return new Set(); } };
const eventErrors = (e) => { const s = ES[e.type]; if (!s) return new Set(["UNKNOWN_TYPE"]); return new Set([...codes(R.validate(s, e)), ...semEvents(e)]); };
const entityErrors = (x) => { let sem = []; try { sem = R.checkEntitySemantics(x, EVENT_CAT); } catch {} return new Set([...codes(R.validate(NS[x.entity_type], x)), ...sem]); };
const streams = (evs) => { const d = {}; for (const e of evs) (d[e.stream_id] ??= []).push(e); return d; };
const sortedSet = (a) => [...new Set(a)].sort();

test("canonical vectors + sha256", () => {
  for (const x of F("valid", "canonical-vectors.v3.json").vectors) { assert.equal(R.canonicalize(x.value), x.canonical, x.id); assert.equal(R.sha256Hex(x.canonical), x.sha256, x.id); }
});
test("canonical must-reject", () => {
  for (const bad of [NaN, Infinity, { k: "\ud800" }]) assert.throws(() => R.canonicalize(bad));
});
test("CL06.1 vectors and ledger reproduced", () => {
  for (const x of J("legacy_cl06_1_reference", "canonical-vectors.json").vectors) assert.equal(R.canonicalize(x.value), x.canonical, x.id);
  const evs = J("legacy_cl06_1_reference", "ledger.json").events; assert.equal(evs.length, 21);
  for (const e of evs) assert.deepEqual(R.checkEventIntegrity(e), []);
  for (const ch of Object.values(streams(evs))) assert.deepEqual(R.checkStreamChain(ch), []);
});
test("schemas cover catalog", () => { assert.deepEqual(Object.keys(ES).sort(), Object.keys(EVENT_CAT.types).sort()); assert.equal(Object.keys(ES).length, 19); assert.equal(Object.keys(NS).length, 9); });
test("valid ledger events", () => {
  assert.equal(LEDGER.length, 22);
  for (const e of LEDGER) { assert.deepEqual(R.validate(ES[e.type], e), []); assert.deepEqual(R.checkEventSemantics(e, EVENT_CAT, LIMITS), []); assert.deepEqual(R.checkEventIntegrity(e), []); }
});
test("valid ledger chains and session rules", () => {
  for (const [sid, ch0] of Object.entries(streams(LEDGER))) {
    const ch = [...ch0].sort((a, b) => a.seq - b.seq); assert.deepEqual(R.checkStreamChain(ch), [], sid);
    if (sid.startsWith("session:")) assert.deepEqual(R.checkSessionStream(ch, RX), [], sid);
  }
});
test("handedness rejection present", () => {
  const rej = LEDGER.filter((e) => e.type === "cycle.rejected"); assert.deepEqual(rej.map((e) => e.payload.reason), ["handedness_incompatible"]); assert.notEqual(rej[0].payload.handedness.label, RX.side);
});
test("evolution content_hash", () => {
  const p = LEDGER.find((e) => e.type === "evolution.published").payload; const { content_hash, ...rest } = p; assert.equal(content_hash, R.hashCanonical(rest));
});
test("valid entities and chains", () => {
  const d = F("valid", "entities.v3.json");
  for (const x of Object.values(d.entities)) { assert.deepEqual(R.validate(NS[x.entity_type], x), []); assert.deepEqual(R.checkEntitySemantics(x, EVENT_CAT), []); }
  for (const ch of Object.values(d.chains)) assert.deepEqual(R.checkEntityChain(ch), []);
});
test("valid fact proposals", () => { for (const [k, p] of Object.entries(F("valid", "fact-proposals.v3.json").proposals)) assert.deepEqual(R.validate(FPS[k], p), [], k); });
test("limits boundary", () => {
  for (const c of F("valid", "prescription-limits-boundary.json").cases) {
    const e = structuredClone(LEDGER.find((x) => x.type === "prescription.published")); e.payload.target_sets = c.target_sets; e.payload.target_repetitions = c.target_repetitions;
    assert.equal(!R.checkEventSemantics(e, EVENT_CAT, LIMITS).includes("LIMITS_EXCEEDED"), c.valid, c.id);
  }
});
test("F01 oracle id", () => {
  const o = F("expected", "facts.oracle.v3.json"), f = o.facts[0]; assert.equal(f.type, "F01"); assert.equal(f.catalog_version, "2");
  const body = Object.fromEntries(["catalog_version", "data_origin", "evidence_refs", "params", "scope", "type"].map((k) => [k, f[k]]));
  assert.equal(f.fact_id, "f_" + R.hashCanonical(body)); assert.ok(f.fact_id in o.content_hashes);
});
test("invalid events", () => {
  for (const c of INV.events) {
    assert.ok(eventErrors(c.event).has(c.expect), c.id);
    if (c.expect_layer === "schema") assert.ok(codes(R.validate(ES[c.event.type], c.event)).has(c.expect), c.id);
    else assert.ok(semEvents(c.event).has(c.expect), c.id);
  }
});
test("invalid integrity / streams / stream rules / entities / chains", () => {
  for (const c of INV.integrity) assert.ok(R.checkEventIntegrity(c.event).includes(c.expect), c.id);
  for (const c of INV.streams) assert.deepEqual(sortedSet(R.checkStreamChain(c.events)), [...c.expect].sort(), c.id);
  for (const c of INV.stream_rules) assert.deepEqual(R.checkSessionStream(c.events, c.prescription), [...c.expect].sort(), c.id);
  for (const c of INV.entities) assert.ok(entityErrors(c.entity).has(c.expect), c.id);
  for (const c of INV.entity_chains) assert.deepEqual(R.checkEntityChain(c.versions), [...c.expect].sort(), c.id);
});
test("no caregiver/supervisor in valid fixtures", () => { const t = JSON.stringify([LEDGER, F("valid", "entities.v3.json")]); for (const w of ["caregiver", "supervisor"]) assert.ok(!t.includes(w)); });

function mutate(p, spec) {
  p = structuredClone(p); const i = spec.indexOf(":"), op = spec.slice(0, i), rest = spec.slice(i + 1); let pth, val;
  if (op === "add_unknown") { pth = rest; val = "x"; } else if (op === "set") { const j = rest.indexOf("="); pth = rest.slice(0, j); const v = rest.slice(j + 1); const m = { null: null, true: true, false: false }; val = v in m ? m[v] : v; } else { pth = rest; }
  const keys = pth.split("."); let o = p; for (const k of keys.slice(0, -1)) o = o[k];
  if (op === "drop") delete o[keys.at(-1)]; else o[keys.at(-1)] = val; return p;
}
test("adversarial EXECUTABLE_NOW (17) and PENDING (20)", () => {
  const cases = F("adversarial", "cases.v3.json").cases, base = F("valid", "fact-proposals.v3.json").proposals; let n = 0, pend = 0;
  for (const c of cases) {
    if (c.status === "PENDING_IMPLEMENTATION") { pend++; assert.ok(["verifier", "service"].includes(c.layer)); continue; }
    n++; const code = c.expect.code;
    if (c.kind === "proposal_schema") assert.ok(codes(R.validate(FPS[c.fact], mutate(base[c.fact], c.mutate))).has(code), c.id);
    else if (c.kind === "proposal_type") assert.ok(!(c.type in FPS), c.id);
    else if (c.kind === "see_invalid") assert.ok(eventErrors(INV.events.find((x) => x.id === c.ref).event).has(code), c.id);
    else if (c.kind === "see_invalid_entity") assert.ok(entityErrors(INV.entities.find((x) => x.id === c.ref).entity).has(code), c.id);
    else if (c.kind === "see_stream_rule") { const x = INV.stream_rules.find((y) => y.id === c.ref); assert.ok(R.checkSessionStream(x.events, x.prescription).includes(code), c.id); }
    else assert.fail("unknown kind " + c.kind);
  }
  assert.equal(n, 17); assert.equal(pend, 20);
});
test("catalogs", () => {
  const v = C("VERSIONS.json"); assert.equal(v.schema_version, 3); assert.equal(v.fact_catalog_version, "2"); assert.equal(v.legacy_read_only.schema_version, 2);
  const api = C("api", "api-contract.v3.json"), az = C("api", "authorization-matrix.v3.json");
  assert.deepEqual([...api.roles].sort(), ["participant", "therapist"]); assert.equal(api.endpoints.length, 36); assert.equal(az.rows.length, 27);
  for (const ep of api.endpoints) { for (const r of ep.roles) assert.ok(["participant", "therapist", "anonymous"].includes(r), ep.id); for (const c of ep.errors) assert.ok(c in ERR, ep.id + " " + c); }
  for (const row of az.rows) for (const k of Object.keys(row)) assert.ok(!["caregiver", "supervisor"].includes(k));
  for (const c of ["HANDEDNESS_INCOMPATIBLE_ACCEPTED", "REAL_DATA_GATE_CLOSED", "ORIGIN_REF_REQUIRED", "ROLE_NOT_ALLOWED", "LEGACY_STREAM_READ_ONLY"]) assert.ok(c in ERR, c);
  const fc = C("catalogs", "fact-catalog.v2.json"); assert.ok("F10" in fc.types); assert.equal(fc.types.F10.summary_eligible, false); assert.ok(!("F07" in fc.types));
  assert.equal(fc.types.F01.definition_version, 2); assert.equal(fc.types.F05.definition_version, 2);
  for (const k of ["F02", "F03", "F04", "F06", "F08", "F09"]) assert.equal(fc.types[k].definition_version, 1);
  assert.deepEqual([LIMITS.max_sets, LIMITS.max_repetitions, LIMITS.max_product], [10, 100, 100]);
  const r = C("catalogs", "comparability-rules.v1.json"); assert.ok(r.contextual_dimensions.dimensions.includes("assistance_level")); assert.ok(!r.technical_criteria.keys.includes("assistance_level"));
  const reg = C("registries", "instrument-registry.json"); assert.deepEqual(reg.instruments.map((i) => i.instrument_id), ["custom_unvalidated"]);
});
test("origin register hashes", () => {
  const r = F("origin-register", "legacy-origin-register.json"); assert.ok(r.entries.some((e) => e.origin_class === "experimental_capture"));
  for (const e of r.entries) { const { entry_hash, ...body } = e; assert.equal(entry_hash, R.hashCanonical(body), e.record_id); }
});
