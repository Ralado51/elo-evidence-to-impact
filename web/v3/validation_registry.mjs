// ValidationRegistry (ARQ-03 / CMP-05, front): ordered pure rules per scope, mirroring server rule ids (A2 rules-registry.v1).
// The server stays the authority; the front only gives early, field-level feedback with the same rule ids.
// A rule is (value) => Array<{ rule, path, key, params? }>. Nothing is corrected or normalized.

export function createRegistry() {
  const rules = new Map();
  return {
    register(scope, rule) {
      if (!rules.has(scope)) rules.set(scope, []);
      rules.get(scope).push(rule);
    },
    evaluate(scope, value) {
      return (rules.get(scope) || []).flatMap((r) => r(value));
    },
  };
}

/** Violation reported by the server envelope: error.details = { rule, path } (A2-06); anything else -> null. */
export function violationFromApiError(err) {
  const d = err && (err.details ?? (err.error && err.error.details));
  return d && typeof d === "object" && !Array.isArray(d) && typeof d.rule === "string" ? { rule: d.rule, path: String(d.path || "") } : null;
}
