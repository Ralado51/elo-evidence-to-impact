// Elo CL06.3 reference library (JavaScript). Contract-level only; mirrors reference/python/elo_ref.py.
// Independent of the CL06.1 implementation (no imports from it). Uses node:crypto.
import { createHash } from "node:crypto";

export class CanonicalizationError extends Error {}

function ser(v) {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean": return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new CanonicalizationError("non-finite number");
      return JSON.stringify(Object.is(v, -0) ? 0 : v);
    case "string":
      if (!v.isWellFormed()) throw new CanonicalizationError("lone surrogate");
      return JSON.stringify(v);
    case "object":
      if (Array.isArray(v)) return "[" + v.map(ser).join(",") + "]";
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new CanonicalizationError("not plain");
      return "{" + Object.keys(v).sort().map((k) => ser(k) + ":" + ser(v[k])).join(",") + "}";
    default: throw new CanonicalizationError("unsupported " + typeof v);
  }
}
export const canonicalize = ser;
export const sha256Hex = (t) => createHash("sha256").update(t, "utf8").digest("hex");
export const hashCanonical = (v) => sha256Hex(canonicalize(v));
export const computeEventId = (stream_id, seq) => hashCanonical({ seq, stream_id });
export const computeEventHash = (e) => { const { hash, ...rest } = e; return hashCanonical(rest); };

const typeOk = (t, v) => ({
  null: v === null, boolean: typeof v === "boolean",
  integer: typeof v === "number" && Number.isInteger(v), number: typeof v === "number",
  string: typeof v === "string", array: Array.isArray(v),
  object: v !== null && typeof v === "object" && !Array.isArray(v),
}[t] ?? false);

// JSON Schema subset: same keywords as the Python validator.
export function validate(schema, value, root = schema, path = "$") {
  let errs = [];
  if (schema.$ref) return validate(root.$defs[schema.$ref.slice(8)], value, root, path);
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => validate(s, value, root, path).length === 0).length;
    return ok === 1 ? [] : [[path, "ONEOF"]];
  }
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) return [[path, "LITERAL"]];
  if (schema.type) {
    const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!ts.some((t) => typeOk(t, value))) return [[path, value === null ? "NULL_NOT_ALLOWED" : "TYPE"]];
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push([path, "ENUM"]);
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errs.push([path, "PATTERN"]);
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errs.push([path, "LENGTH"]);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errs.push([path, "LENGTH"]);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push([path, "OUT_OF_RANGE"]);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push([path, "OUT_OF_RANGE"]);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push([path, "LENGTH"]);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push([path, "LENGTH"]);
    if (schema.uniqueItems && new Set(value.map(canonicalize)).size !== value.length) errs.push([path, "DUPLICATE_ITEM"]);
    if (schema["x-sorted"] && value.some((v, i) => i < value.length - 1 && !(v < value[i + 1]))) errs.push([path, "NOT_SORTED"]);
    if (schema.items) value.forEach((it, i) => errs.push(...validate(schema.items, it, root, `${path}[${i}]`)));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const r of schema.required ?? []) if (!(r in value)) errs.push([`${path}.${r}`, "MISSING_FIELD"]);
    for (const [k, v] of Object.entries(value)) {
      if (k in props) errs.push(...validate(props[k], v, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push([`${path}.${k}`, "UNKNOWN_FIELD"]);
    }
  }
  return errs;
}

export function checkEventIntegrity(e) {
  const errs = [];
  if (e.event_id !== computeEventId(e.stream_id, e.seq)) errs.push("EVENT_ID_INVALID");
  if (e.hash !== computeEventHash(e)) errs.push("HASH_INVALID");
  if ((e.seq === 1) !== (e.prev_hash === null)) errs.push("GENESIS_INVALID");
  return errs;
}
export function checkStreamChain(events) {
  const errs = [], bySeq = new Map();
  for (const e of events) {
    errs.push(...checkEventIntegrity(e));
    if (bySeq.has(e.seq) && bySeq.get(e.seq).hash !== e.hash) errs.push("HASH_CONFLICT");
    if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  }
  for (const [s, e] of bySeq) if (s > 1 && bySeq.has(s - 1) && e.prev_hash !== bySeq.get(s - 1).hash) errs.push("CHAIN_BROKEN");
  return errs;
}

// ---------------- CL06.3 semantic rules (contract layer; NOT the fact verifier) ----------------
const STREAM_OF = {
  session: (e) => "session:" + (e.scope.session_id ?? ""), prescription: (e) => "prescription:" + (e.scope.prescription_id ?? ""),
  consent: (e) => "consent:" + e.scope.participant_id, review: (e) => `review:${e.actor.id}.${e.scope.participant_id}`,
  privacy: (e) => "privacy:" + e.scope.participant_id,
};
const START_SOURCE = { camera: "camera", simulation: "simulation", report_only: "participant_report" };
const uniqSorted = (a) => [...new Set(a)].sort();

export function checkEventSemantics(e, cat, limits, realDataGateOpen = false) {
  const errs = [], t = cat.types[e.type], sc = e.scope;
  if (!t.actors.includes(e.actor.role)) errs.push("ACTOR_NOT_ALLOWED");
  if (!t.sources.includes(e.source.type)) errs.push("SOURCE_NOT_ALLOWED");
  for (const k of t.scope.required) if (!(k in sc)) errs.push("SCOPE_INVALID");
  for (const k of t.scope.forbidden) if (k in sc) errs.push("SCOPE_INVALID");
  if (e.stream_id !== STREAM_OF[t.stream](e)) errs.push("STREAM_MISMATCH");
  const alg = t.algorithm, has = "algorithm_version" in e.source;
  if ((alg === "required" && !has) || (alg === "forbidden" && has) || (alg === "capture-only" && has !== ["camera", "simulation"].includes(e.source.type))) errs.push("VERSION_MISMATCH");
  const mono = "t_mono_ms" in e;
  if ((t.mono === "required" && !mono) || (t.mono === "forbidden" && mono)) errs.push("RULE_VIOLATION");
  const em = e.execution_mode;
  if (t.stream !== "session") { if (em !== "not_applicable") errs.push("EXECUTION_MODE_MISMATCH"); }
  else {
    if (em === "not_applicable") errs.push("EXECUTION_MODE_MISMATCH");
    if (e.type === "session.started") {
      if (e.seq !== 1) errs.push("RULE_VIOLATION");
      if (e.payload.source_mode !== em || START_SOURCE[em] !== e.source.type) errs.push("EXECUTION_MODE_MISMATCH");
      if ((em === "report_only") !== (e.payload.capture_context === null)) errs.push("RULE_VIOLATION");
    } else if (JSON.stringify(t.sources) === '["camera","simulation"]' && e.source.type !== em) errs.push("EXECUTION_MODE_MISMATCH");
  }
  if (cat.rules.origin_ref_required_for.includes(e.data_origin) && !("origin_ref" in e)) errs.push("ORIGIN_REF_REQUIRED");
  if (e.data_origin === "live" && !realDataGateOpen) errs.push("REAL_DATA_GATE_CLOSED");
  if (e.type === "prescription.published") {
    const p = e.payload;
    if (p.limits_version !== limits.limits_version || p.target_sets > limits.max_sets || p.target_repetitions > limits.max_repetitions || p.target_sets * p.target_repetitions > limits.max_product) errs.push("LIMITS_EXCEEDED");
    if (e.seq !== p.revision || sc.prescription_revision !== p.revision) errs.push("RULE_VIOLATION");
    if ((p.revision > 1 ? p.supersedes_revision : null) !== (p.revision > 1 ? p.revision - 1 : null)) errs.push("RULE_VIOLATION");
  }
  return uniqSorted(errs);
}

export function checkSessionStream(events, prescriptionPayload) {
  const errs = [], side = prescriptionPayload.side, start = events.find((e) => e.type === "session.started");
  for (const e of events) {
    if (start && e.execution_mode !== start.execution_mode) errs.push("EXECUTION_MODE_MISMATCH");
    if (e.type === "cycle.accepted") { const h = e.payload.handedness; if (h !== null && h.label !== side) errs.push("HANDEDNESS_INCOMPATIBLE_ACCEPTED"); }
    if (e.type === "cycle.rejected" && e.payload.reason === "handedness_incompatible") { const h = e.payload.handedness; if (h === null || h.label === side) errs.push("RULE_VIOLATION"); }
  }
  return uniqSorted(errs);
}

const ENTITY_PREFIX = { participant: "p", therapist: "t", care_link: "cl", functional_assessment: "fa", goal: "gl", encounter: "en", reassessment: "ra", instrumental_measurement: "im", draft: "dr" };
export const computeEntityHash = (ent) => { const { hash, ...rest } = ent; return hashCanonical(rest); };
export function checkEntitySemantics(ent, cat, realDataGateOpen = false) {
  const errs = [], p = ent.payload;
  if (ent.entity_id.split("_")[0] !== ENTITY_PREFIX[ent.entity_type]) errs.push("RULE_VIOLATION");
  if (ent.hash !== computeEntityHash(ent)) errs.push("ENTITY_HASH_INVALID");
  if ((ent.version === 1) !== (ent.prev_hash === null)) errs.push("ENTITY_CHAIN_BROKEN");
  if (cat.rules.origin_ref_required_for.includes(ent.data_origin) && !("origin_ref" in ent)) errs.push("ORIGIN_REF_REQUIRED");
  if (ent.data_origin === "live" && !realDataGateOpen) errs.push("REAL_DATA_GATE_CLOSED");
  if (ent.entity_type === "goal") {
    const achieved = p.status === "achieved_confirmed";
    if (achieved !== (p.confirmed_by !== null && p.confirmed_at !== null) || (p.confirmed_by === null) !== (p.confirmed_at === null)) errs.push("GOAL_CONFIRMATION_REQUIRED");
    if (achieved && ent.author.role !== "therapist") errs.push("GOAL_CONFIRMATION_REQUIRED");
  }
  if (["care_link", "functional_assessment", "goal", "encounter", "reassessment", "instrumental_measurement"].includes(ent.entity_type) && ent.author.role !== "therapist") errs.push("ROLE_NOT_ALLOWED");
  if (ent.entity_type === "draft" && p.status === "confirmed" && p.confirmed_by === null) errs.push("DRAFT_NOT_CONFIRMED");
  if (ent.entity_type === "draft" && p.draft_kind === "session_report_proposal" && ent.author.role !== "participant") errs.push("ROLE_NOT_ALLOWED");
  return uniqSorted(errs);
}
export function checkEntityChain(versions) {
  const errs = [], vs = [...versions].sort((a, b) => a.version - b.version);
  vs.forEach((v, i) => { if (v.version !== i + 1) errs.push("ENTITY_VERSION_CONFLICT"); if (i > 0 && v.prev_hash !== vs[i - 1].hash) errs.push("ENTITY_CHAIN_BROKEN"); });
  return uniqSorted(errs);
}
