// DateField (ARQ-01 / CMP-04): the one way the front validates and reports civil-date inputs.
// Native <input type="date"> is used (keyboard, picker, screen-reader support come from the platform). The control's
// value is always canonical YYYY-MM-DD or "" (incomplete/impossible entries leave it empty and set validity.badInput).
// Nothing is corrected or normalized: an invalid entry is reported on the field. The backend stays the authority.
//
//   validateDateFields([{ input, required: true }, { input: end, notBefore: start }]) -> boolean
//
// Errors are structured messages (key + params) bound to the error node, so a language switch re-renders them.

import { announce } from "./a11y.mjs";
import { isCivilDate, isRangeInverted } from "./civil_date.mjs";
import { tm } from "./i18n.mjs";
import { setFieldError } from "./field_error.mjs";

export { setFieldError };


/** @returns {import("./i18n.mjs").Msg | null} */
export function dateFieldProblem(input, { required = false, notBefore = null } = {}) {
  const value = input.value;
  if (value === "") return input.validity && input.validity.badInput ? tm("date.err.invalid") : required ? tm("date.err.required") : null;
  if (!isCivilDate(value)) return tm("date.err.invalid");
  if (notBefore && notBefore.value !== "" && isRangeInverted(notBefore.value, value)) return tm("date.err.range");
  return null;
}

/**
 * Validate several date fields; every invalid one shows its own error, the first receives focus and is announced.
 * @param {Array<{input: HTMLInputElement, required?: boolean, notBefore?: HTMLInputElement|null}>} specs
 * @returns {boolean} true when all fields are acceptable
 */
export function validateDateFields(specs) {
  let first = null;
  for (const spec of specs) {
    const problem = dateFieldProblem(spec.input, spec);
    setFieldError(spec.input, problem);
    if (problem && !first) first = { input: spec.input, problem };
  }
  if (first) {
    first.input.focus();
    announce(first.problem, { politeness: "assertive" });
    return false;
  }
  return true;
}
