// Domain fields (ARQ-03 / CMP-13): pure helpers behind GoalTargetField (more fields are added by later phases).
// Rules come from the generated catalogs (web/v3/catalogs, parity-tested against contracts/CL06_3-A2); the server stays the authority.
// Nothing is corrected or normalized silently: the derived unit is a visible, read-only consequence of the chosen kind.

export async function loadCatalogs(fetchFn = fetch, base = new URL("./catalogs/", import.meta.url)) {
  const names = { goalRules: "goal-target-rules.v1.json", itemRules: "assessment-item-rules.v1.json", instruments: "instrument-registry.json", limits: "limits.v1.json" };
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
