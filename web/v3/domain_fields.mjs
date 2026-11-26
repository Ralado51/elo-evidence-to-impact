// Domain fields (ARQ-03 / CMP-13): pure helpers behind GoalTargetField (more fields are added by later phases).
// Rules come from the generated catalogs (web/v3/catalogs, parity-tested against contracts/CL06_3-A2); the server stays the authority.
// Nothing is corrected or normalized silently: the derived unit is a visible, read-only consequence of the chosen kind.

export async function loadCatalogs(fetchFn = fetch, base = new URL("./catalogs/", import.meta.url)) {
  const names = { goalRules: "goal-target-rules.v1.json", itemRules: "assessment-item-rules.v1.json", instruments: "instrument-registry.json", units: "units.json", limits: "limits.v1.json" };
  const out = {};
  for (const [k, f] of Object.entries(names)) {
    const r = await fetchFn(new URL(f, base));
    if (!r.ok) throw new Error(`catalog ${f}: ${r.status}`);
    out[k] = await r.json();
  }
  return out;
}

const TV = "$.payload.target.value";
const TU = "$.payload.target.unit";

/** Field behaviour for a goal kind. numeric=false -> no value, no unit. unit=null -> measure_value (legacy, free). */
export function goalTargetSpec(goalRules, kind) {
  const k = goalRules.kinds[kind];
  if (!k) return null;
  if (kind === "descriptive_text") return { kind, numeric: false, unit: null, min: null, max: null, integer: false };
  if (!k.unit) return { kind, numeric: true, unit: null, min: 0, max: 100000, integer: false, legacy: true };
  return { kind, numeric: true, unit: k.unit.derived, min: k.value.min, max: k.value.max, integer: true };
}

/** Build the target to send. Unit is derived by the component (no free edit); invalid raw text becomes NaN and is reported, never fixed. */
export function buildGoalTarget(goalRules, kind, rawValue) {
  const s = goalTargetSpec(goalRules, kind);
  if (!s || !s.numeric) return { kind, value: null, unit: null };
  const raw = String(rawValue ?? "").trim();
  return { kind, value: raw === "" ? null : Number(raw), unit: s.unit };
}

/** Same rule ids as the server (goal-target-rules.v1). Returns [{rule, path}]. */
export function goalTargetViolations(goalRules, target) {
  const s = goalTargetSpec(goalRules, target.kind);
  if (!s || s.legacy) return [];
  const { value, unit } = target;
  if (!s.numeric) return value !== null || unit !== null ? [{ rule: "goal.descriptive_no_numeric", path: value !== null ? TV : TU }] : [];
  if (value === null) return [{ rule: "goal.count_value_required", path: TV }];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return [{ rule: "goal.count_integer", path: TV }];
  if (value < s.min) return [{ rule: "goal.count_floor", path: TV }];
  if (unit !== null && unit !== s.unit) return [{ rule: "goal.count_unit_compatible", path: TU }];
  return [];
}

export const FIELD_FOR_PATH = {
  "$.payload.target.value": "goal-target-value",
  "$.payload.target.unit": "goal-target-unit",
  "$.payload.deadline": "goal-deadline",
};

// ---- InstrumentSelector (A2-04): the user picks a registry entry; version and status are derived, never typed. ----
export function instrumentEntries(registry) {
  return registry.instruments.map((e) => ({ id: e.instrument_id, version: e.instrument_version, status: e.status }));
}

export function instrumentFromSelection(registry, instrumentId) {
  const e = instrumentEntries(registry).find((x) => x.id === instrumentId);
  return e ? { instrument_id: e.id, instrument_version: e.version, status: e.status } : null;
}

export function instrumentViolations(registry, inst) {
  const ok = instrumentEntries(registry).some((e) => e.id === inst.instrument_id && e.version === inst.instrument_version && e.status === inst.status);
  return ok ? [] : [{ rule: "instrument.registry_mismatch", path: "$.payload.instrument" }];
}

FIELD_FOR_PATH["$.payload.instrument"] = "assessment-instrument-id";

// ---- MeasurementField (A2-05, R1–R5): value/unit/not-assessed of one assessment item ----
const NUMERIC = ["integer", "number"];

/** Parse the raw text for a value_type. Invalid text stays a string/NaN so the rule reports it; nothing is coerced silently. */
export function parseItemValue(valueType, raw, notAssessed) {
  if (notAssessed) return null;
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  if (NUMERIC.includes(valueType)) return Number(s);
  if (valueType === "boolean") return s === "true" ? true : s === "false" ? false : s;
  return s;
}

export function buildItem({ key, valueType, rawValue, unit, notAssessed, assistance, source = "therapist_observed" }) {
  const numeric = NUMERIC.includes(valueType);
  return { item_key: key, value_type: valueType, value: parseItemValue(valueType, rawValue, notAssessed), unit: numeric && unit ? unit : null, source, assistance, not_assessed: !!notAssessed };
}

/** Same rule ids/paths as the server (assessment-item-rules.v1). */
export function itemViolations(items) {
  const out = [];
  const seen = new Set();
  items.forEach((it, i) => {
    const base = `$.payload.items[${i}]`;
    const { item_key: key, value_type: vt, value: val, unit } = it;
    if (seen.has(key)) out.push({ rule: "item.key_duplicate", path: `${base}.item_key` });
    seen.add(key);
    if (it.not_assessed === true && val !== null) out.push({ rule: "item.not_assessed_requires_null", path: `${base}.value` });
    if (val !== null) {
      const ok = (vt === "integer" && typeof val === "number" && Number.isInteger(val)) || (vt === "number" && typeof val === "number" && Number.isFinite(val)) ||
        (vt === "boolean" && typeof val === "boolean") || (vt === "category" && typeof val === "string");
      if (!ok) out.push({ rule: "item.value_type_mismatch", path: `${base}.value` });
    }
    if (unit !== null && !NUMERIC.includes(vt)) out.push({ rule: "item.unit_not_allowed", path: `${base}.unit` });
    if (it.source === "therapist_instrumental" && NUMERIC.includes(vt) && val !== null && unit === null) out.push({ rule: "item.instrumental_requires_unit", path: `${base}.unit` });
  });
  return out;
}

FIELD_FOR_PATH["$.payload.items[0].value"] = "assessment-item-value";
FIELD_FOR_PATH["$.payload.items[0].unit"] = "assessment-item-unit";
FIELD_FOR_PATH["$.payload.items[0].item_key"] = "assessment-item-key";
