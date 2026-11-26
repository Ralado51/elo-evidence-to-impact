// Field error mechanism (ARQ-03 / CMP-05): one shared way to show or clear an error on a form control.
// Extracted unchanged from DateField (ARQ-01/ARQ-02 fix01): aria-invalid + aria-describedby + visible text,
// cleared on input/change/form reset. Errors are structured messages (key + params) so a language switch re-renders them.

import { bindText } from "./i18n.mjs";

const ERROR_CLASS = "field-error";

function errorNode(input) {
  let node = input.ownerDocument.getElementById(`${input.id}-error`);
  if (!node) {
    node = input.ownerDocument.createElement("p");
    node.id = `${input.id}-error`;
    node.className = ERROR_CLASS;
    node.hidden = true;
    input.insertAdjacentElement("afterend", node);
    const clear = () => setFieldError(input, null);
    input.addEventListener("input", clear);
    input.addEventListener("change", clear);
    // A native form reset (participant switch, draft discard) invalidates the whole validation state of the field:
    // message, aria-invalid and the aria-describedby reference (ARQ-02 fix01, S1-08).
    if (input.form) input.form.addEventListener("reset", clear);
  }
  return node;
}

/** Show (Msg) or clear (null) the error attached to a field: aria-invalid + aria-describedby + visible text. */
export function setFieldError(input, msg) {
  const node = errorNode(input);
  const ids = new Set((input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
  if (msg) {
    bindText(node, msg);
    node.hidden = false;
    input.setAttribute("aria-invalid", "true");
    ids.add(node.id);
  } else {
    bindText(node, "");
    node.hidden = true;
    input.removeAttribute("aria-invalid");
    ids.delete(node.id);
  }
  if (ids.size) input.setAttribute("aria-describedby", [...ids].join(" "));
  else input.removeAttribute("aria-describedby");
}

