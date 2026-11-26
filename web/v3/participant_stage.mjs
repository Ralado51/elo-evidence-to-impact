// Presentation-only layer: derives the current step from the DOM state
// that participant_app.mjs already maintains, and sets body[data-stage].
// It never changes API behavior or the data-* hooks used by the harnesses.
const $ = (id) => document.getElementById(id);

import { t } from "./i18n.mjs";

const STAGES = ["signin", "plan", "practice", "report", "done"];

export function computeStage() {
  const signedIn = !$("btn-participant-signout")?.hidden;
  if (!signedIn) return "signin";
  if ($("report-result")?.dataset.reportSubmitted) return "done";
  const phase = $("session-result")?.dataset.sessionPhase;
  if (phase === "ended") return "report";
  if (phase === "active") return "practice";
  return $("prescription-view")?.dataset.prescriptionLoaded === "true" ? "practice" : "plan";
}

// Only write when the text changes, otherwise the MutationObserver would loop on its own edit.
function setText(id, text) {
  const node = $(id);
  if (node && node.textContent !== text) node.textContent = text;
}

function apply() {
  const stage = computeStage();
  if (document.body.dataset.stage !== stage) document.body.dataset.stage = stage;
  setText("hero-title", t(`pa.hero.${stage}.title`));
  setText("hero-lead", t(`pa.hero.${stage}.lead`));
}

function autoLoadPlan() {
  const btn = $("btn-load-plan");
  if (!btn || !$("signin-result") || $("signin-result").hidden) return;
  if ($("prescription-view")?.dataset.prescriptionLoaded === "true") return;
  if (autoLoadPlan.done) return;
  autoLoadPlan.done = true;
  btn.click();
}

if (typeof document !== "undefined") {
  const obs = new MutationObserver(() => { apply(); autoLoadPlan(); });
  obs.observe(document.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["hidden", "data-session-phase", "data-prescription-loaded", "data-report-submitted"] });
  apply();
  document.addEventListener("elo:lang", apply);
}
