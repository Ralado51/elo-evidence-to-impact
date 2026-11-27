// Design System screenshots: every screen at desktop / tablet / mobile. SYNTHETIC data only; runs against the ISOLATED demo (default :8090).
// Usage: PORT_WEB=8090 PORT_API=8010 scripts/demo_up.sh && ELO_PLAYWRIGHT_DIR=... node web/tests/browser/seed_demo.mjs --origin http://127.0.0.1:8090 && node scripts/ds_screenshots.mjs [--origin URL] [--out DIR]
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, r) => (v.startsWith("--") ? [...a, [v.slice(2), r[i + 1]]] : a), []));
const origin = args.origin || "http://127.0.0.1:8090";
const out = args.out || "docs/design-system/screens";
const pwDir = process.env.ELO_PLAYWRIGHT_DIR || "/tmp/pwdir";
const { chromium } = await import(pathToFileURL(path.join(pwDir, "node_modules/playwright-core/index.mjs")).href);
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, tablet: { width: 834, height: 1112 }, mobile: { width: 390, height: 844 } };
const USER = "terapeuta_demo", PASS = "senha-sintetica-demo";
const browser = await chromium.launch({ headless: true });
const manifest = [];
let n = 0;

async function shot(page, vp, name, target) {
  const dir = path.join(out, vp); fs.mkdirSync(dir, { recursive: true });
  n += 1; const file = path.join(dir, `${String(n).padStart(2, "0")}-${name}.png`);
  const loc = target ? page.locator(target).first() : null;
  if (loc) { await loc.scrollIntoViewIfNeeded(); await loc.screenshot({ path: file }); } else await page.screenshot({ path: file, fullPage: true });
  manifest.push({ viewport: vp, screen: name, file });
}

for (const [vp, size] of Object.entries(VIEWPORTS)) {
  if (args.vp && args.vp !== vp) continue;
  n = 0;
  const ctx = await browser.newContext({ viewport: size, locale: "pt-BR" });
  const page = await ctx.newPage();
  // 1 Home (landing — the visual reference) and the v3 base
  await page.goto(`${origin}/`); await page.waitForTimeout(400); await shot(page, vp, "home-landing");
  await page.goto(`${origin}/v3/index.html`); await shot(page, vp, "v3-base-controles");
  await page.goto(`${origin}/v3/ds/styleguide.html`); await shot(page, vp, "styleguide");

  // 2 Therapist
  await page.goto(`${origin}/v3/therapist.html?s4=1`); await page.waitForTimeout(300);
  await shot(page, vp, "terapeuta-autenticacao-entrar", "#sec-signin");
  await page.fill("#signin-username", USER); await page.fill("#signin-password", PASS); await page.click("#btn-signin");
  await page.waitForSelector("#signin-result:not([hidden])");
  const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem("elo_v3_therapist_session")));
  await page.fill("#participant-search", "Caso"); await page.press("#participant-search", "Enter");
  const btn = page.locator("#participant-list li button").first(); await btn.waitFor(); await btn.click(); await page.waitForTimeout(600);
  const participantId = await page.inputValue("#active-participant-id");
  await shot(page, vp, "terapeuta-gestao-participantes", "#sec-participant");
  await shot(page, vp, "terapeuta-avaliacao-funcional", "#sec-assessment");
  await page.click("#btn-draft-load").catch(() => {}); await page.waitForTimeout(500);
  await shot(page, vp, "terapeuta-s4-rascunho-assistido", "#assisted-draft");
  await page.click("#btn-draft-reviewed").catch(() => {}); await page.waitForTimeout(300);
  await shot(page, vp, "terapeuta-s4-rascunho-revisado", "#assisted-draft");
  await page.fill("#encounter-date", "2026-10-20").catch(() => {}); await page.fill("#encounter-note", "Atendimento remoto sintético.").catch(() => {});
  await page.click("#form-encounter button[type=submit]").catch(() => {}); await page.waitForTimeout(800);
  await shot(page, vp, "terapeuta-arq10-atendimento-remoto", ".ds-subsection:has(#form-encounter)");
  await shot(page, vp, "terapeuta-metas", "#sec-goal");
  await shot(page, vp, "terapeuta-prescricao", "#sec-prescription");
  await page.click("#btn-load-facts"); await page.waitForTimeout(900);
  await shot(page, vp, "terapeuta-revisao-evidencias", "#sec-facts");
  await page.click("#btn-load-evolution-series").catch(() => {}); await page.waitForTimeout(700);
  if (args.evolution) { await page.fill("#read-evolution-id", args.evolution); await page.click("#form-read-evolution button[type=submit]"); await page.waitForSelector("#evolution-result [data-published-evolution]", { timeout: 6000 }).catch((e) => console.log("s3 read", e.message.split("\n")[0])); }
  await shot(page, vp, "terapeuta-resumo-e-evolucao-funcional", "#sec-publications");
  if (await page.locator("#evolution-result:not([hidden])").count()) await shot(page, vp, "terapeuta-s3-explicacao-da-evolucao", "#evolution-result");
  await page.click("#btn-load-timeline"); await page.waitForTimeout(700);
  await shot(page, vp, "terapeuta-linha-do-tempo", "#sec-timeline");
  await shot(page, vp, "terapeuta-pagina-completa");
  // error + loading-free feedback states
  await page.fill("#goal-text", ""); await page.click("#btn-create-goal"); await page.waitForTimeout(500);
  await shot(page, vp, "terapeuta-feedback-erro-de-campo", "#sec-goal");

  // 3 Participant (journey)
  const inv = await (await fetch(`${origin}/api/v3/invites`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify({ participant_id: participantId, ttl_seconds: 3600 }) })).json();
  const pp = await ctx.newPage();
  await pp.goto(`${origin}/v3/participant.html?s4=1`); await pp.waitForTimeout(300);
  await shot(pp, vp, "participante-entrar", "#sec-signin");
  await pp.fill("#invite-token", inv.invite_token); await pp.click("#btn-invite-signin"); await pp.waitForSelector("#signin-result:not([hidden])");
  await pp.click("#btn-load-plan"); await pp.waitForSelector('#prescription-view[data-prescription-loaded="true"]');
  await shot(pp, vp, "participante-meu-plano", "#sec-plan");
  await pp.click("#btn-session-start"); await pp.waitForSelector('#session-result[data-session-phase="active"]');
  await shot(pp, vp, "participante-execucao-da-atividade", "#sec-session");
  await shot(pp, vp, "participante-s4-audio-das-instrucoes", "#instruction-audio");
  await pp.click("#btn-session-end"); await pp.waitForSelector('#session-result[data-session-phase="ended"]');
  await shot(pp, vp, "participante-relato", "#sec-report");
  await shot(pp, vp, "participante-pagina-completa");

  // 4 Painel (reports, evolution, published records)
  const pn = await ctx.newPage();
  await pn.goto(`${origin}/v3/painel.html`); await pn.waitForTimeout(300);
  await shot(pn, vp, "painel-autenticacao", "#sec-entrar");
  await pn.fill("#signin-username", USER); await pn.fill("#signin-password", PASS); await pn.click("#btn-signin");
  await pn.waitForSelector("#participant-id"); await pn.fill("#participant-id", participantId); await pn.click("#btn-open"); await pn.waitForTimeout(1500);
  await shot(pn, vp, "painel-resumo-e-jornada", "#sec-resumo");
  await shot(pn, vp, "painel-evolucao-funcional", "#sec-evolucao");
  await shot(pn, vp, "painel-verificador-relatorio", "#sec-verificador");
  await shot(pn, vp, "painel-registros-publicados", "#sec-registro");
  await shot(pn, vp, "painel-linha-do-tempo", "#sec-linha-tempo");
  await shot(pn, vp, "painel-pagina-completa");
  await ctx.close();
}
await browser.close();
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ origin, count: manifest.length, screens: manifest }, null, 2));
console.log(`screenshots: ${manifest.length}`);
