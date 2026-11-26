// Presentation-only layer: derives the current step from the DOM state
// that participant_app.mjs already maintains, and sets body[data-stage].
// It never changes API behavior or the data-* hooks used by the harnesses.
const $ = (id) => document.getElementById(id);

const HERO = {
  signin: ["Olá! Vamos praticar hoje?", "Entre com o código que seu terapeuta enviou. Leva menos de um minuto."],
  plan: ["Tudo certo, você entrou", "Veja o que foi combinado e, quando quiser, comece."],
  practice: ["Hora de praticar", "Organize a mesa no seu ritmo. Parar por dor ou cansaço é sempre permitido."],
  report: ["Muito bem! Conte como foi", "Duas perguntas rápidas e pronto."],
  done: ["Relato enviado. Obrigado!", "Seu terapeuta já pode acompanhar. Veja sua evolução abaixo quando ele liberar."],
};

export function computeStage() {
  const signedIn = !$("btn-participant-signout")?.hidden;
  if (!signedIn) return "signin";
  if ($("report-result")?.dataset.reportSubmitted) return "done";
  const phase = $("session-result")?.dataset.sessionPhase;
  if (phase === "ended") return "report";
  if (phase === "active") return "practice";
  return $("prescription-view")?.dataset.prescriptionLoaded === "true" ? "practice" : "plan";
}

function apply() {
  const stage = computeStage();
  if (document.body.dataset.stage === stage) return;
  document.body.dataset.stage = stage;
  const [t, l] = HERO[stage];
  if ($("hero-title")) $("hero-title").textContent = t;
  if ($("hero-lead")) $("hero-lead").textContent = l;
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
}
