/** Shared banner helper: technical details (code, HTTP status) live in a collapsed block for audit/diagnostics only. */
import { t } from "./i18n.mjs";

export function renderErrorTechnical(banner, technical) {
  if (!banner) return;
  let box = banner.querySelector("[data-error-tech]");
  if (!technical) {
    if (box) box.remove();
    return;
  }
  if (!box) {
    box = document.createElement("details");
    box.setAttribute("data-error-tech", "");
    const sum = document.createElement("summary");
    box.appendChild(sum);
    const pre = document.createElement("p");
    pre.className = "mono";
    box.appendChild(pre);
    banner.appendChild(box);
  }
  box.querySelector("summary").textContent = t("err.tech_summary");
  box.querySelector("p").textContent = technical;
}
