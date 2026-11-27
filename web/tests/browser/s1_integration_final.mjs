// S1 FINAL INTEGRATION suite (SYNTHETIC data only). Exit code != 0 on any failed check.
// Mandatory scenarios (PO authorization): logout with series loaded, recovery after REAL reload, transmission with the REAL ledger,
// lost response, duplication, conflict (real HASH_CONFLICT produced against the real ledger), isolation between participants,
// block new session with pending report, dismissal without silent loss, reauthorization before sending recovered events,
// tab-closure warning, orphan session flag, PT/EN.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { hashCanonical } from "../../v3/canonical.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const origin = args.origin || "http://127.0.0.1:8080";
const ORG = "o_localdemo01";
const FROM = "2026-01-01", TO = "2027-12-31";
const pwDir = process.env.ELO_PLAYWRIGHT_DIR || path.join(os.homedir(), "hackathons/elo-platform/workspace/tools/playwright");
const { chromium } = await import(pathToFileURL(path.join(pwDir, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ headless: true });
const results = [];
const check = async (id, fn) => {
  try { await fn(); results.push({ id, ok: true }); }
  catch (e) { results.push({ id, ok: false, error: String(e.message).split("\n")[0] }); console.error("FAIL", id, String(e.message).split("\n").slice(0, 3).join(" / ")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newCtx = async (lang = "pt-BR") => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: lang });
  await c.addInitScript((l) => { try { if (!localStorage.getItem("elo_lang")) localStorage.setItem("elo_lang", l === "en" ? "en" : "pt-BR"); } catch {} }, lang === "en" ? "en" : "pt-BR");
  return c;
};

// ---------- therapist-side fixtures (through the real pages) ----------
const tctx = await newCtx();
const t = await tctx.newPage();
await t.goto(origin + "/v3/therapist.html");
await t.fill("#signin-username", "terapeuta_demo");
await t.fill("#signin-password", "senha-sintetica-demo");
await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
const tToken = await t.evaluate(() => JSON.parse(sessionStorage.getItem("elo_v3_therapist_session")).token);

async function seedParticipant(alias) {
  const prev = await t.inputValue("#active-participant-id").catch(() => "");
  await t.fill("#participant-alias", alias);
  await t.selectOption("#participant-side", "right");
  await t.click("#btn-create-participant");
  await t.waitForFunction((p) => { const v = document.getElementById("active-participant-id")?.value; return v && v !== p; }, prev, { timeout: 15000 });
  const id = await t.inputValue("#active-participant-id");
  await t.click("#btn-create-assessment"); await t.waitForSelector("#assessment-result:not([hidden])");
  await t.click("#btn-create-goal"); await t.waitForSelector("#goal-result:not([hidden])");
  await t.fill("#rx-valid-from", FROM); await t.fill("#rx-valid-to", TO);
  await t.click("#btn-publish-prescription"); await t.waitForSelector("#prescription-result:not([hidden])");
  await sleep(300);
  return id;
}
async function invite(pid) {
  const r = await fetch(`${origin}/api/v3/invites`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tToken}` }, body: JSON.stringify({ participant_id: pid, ttl_seconds: 86400 }) });
  return (await r.json()).invite_token;
}
const A = await seedParticipant("Int Alfa");
const B = await seedParticipant("Int Beta");
const C = await seedParticipant("Int Conflito");
const D = await seedParticipant("Int Series");

// ---------- participant helpers ----------
async function openParticipant(ctx, pid) {
  const page = await ctx.newPage();
  await page.goto(origin + "/v3/participant.html");
  await signIn(page, pid);
  return page;
}
async function signIn(page, pid) {
  const tok = await invite(pid);
  await page.fill("#invite-token", tok);
  await page.click("#btn-invite-signin");
  await page.waitForSelector("#signin-result:not([hidden])");
  await page.waitForFunction(() => !document.getElementById("sync-panel").hidden);
}
async function loadPlan(page) {
  await page.click("#btn-load-plan");
  await page.waitForSelector('#prescription-view[data-prescription-loaded="true"]');
}
const recKey = (pid) => "elo:arq05:v1:" + JSON.stringify([ORG, pid]);
const record = (page, pid) => page.evaluate((k) => { const r = sessionStorage.getItem(k); return r ? JSON.parse(r) : null; }, recKey(pid));
const ptoken = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("elo_v3_participant_session")).token);
const syncStatus = (page) => page.getAttribute("#sync-panel", "data-sync-status");
const waitSync = (page, st, ms = 15000) => page.waitForSelector(`#sync-panel[data-sync-status="${st}"]`, { timeout: ms });
async function postDirect(token, events) {
  const r = await fetch(`${origin}/api/v3/events:batch`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ events }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
// Transport gate in front of the REAL server: pass | block (nothing reaches the server) | lose (server stores, response is lost).
async function gate(page) {
  const g = { mode: "pass", lose: 0, posts: [] };
  await page.route("**/api/v3/events:batch", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    g.posts.push(JSON.parse(route.request().postData()).events.map((e) => e.event_id));
    if (g.mode === "block") return route.abort("failed");
    if (g.mode === "lose" && g.lose > 0) { g.lose--; await route.fetch(); return route.abort("failed"); }
    return route.continue();
  });
  return g;
}
const countType = (rec, type) => rec.events.filter((e) => e.type === type).length;
const bannerCode = (page) => page.evaluate(() => { const e = document.getElementById("error-banner"); return e && !e.hidden ? e.dataset.errorCode || "" : ""; });
async function chooseReport(page, exec = "complete", assist = "some") {
  await page.click(`button[data-choice-group="execution"][data-choice-value="${exec}"]`);
  await page.click(`button[data-choice-group="assistance"][data-choice-value="${assist}"]`);
}

const ctxA = await newCtx();
const pa = await openParticipant(ctxA, A);
const gA = await gate(pa);
let aSessionEvents = [];

await check("INT-01 start grava local primeiro e transmite ao ledger real (sincronizado)", async () => {
  await loadPlan(pa);
  await pa.click("#btn-session-start");
  await pa.waitForSelector('#session-result[data-session-phase="active"]');
  await waitSync(pa, "synced");
  const r = await record(pa, A);
  assert.equal(r.events.length, 2); assert.equal(r.acknowledged, 2); assert.equal(r.conflict, null);
  assert.equal(await pa.getAttribute("#sync-panel", "data-sync-pending"), "0");
});
await check("INT-02 ledger real: reenvio direto dos mesmos eventos e 'duplicate' (ja armazenados)", async () => {
  const r = await record(pa, A);
  const out = await postDirect(await ptoken(pa), r.events);
  const statuses = (out.body?.results || out.body?.results || out.body?.data?.results || []).map((x) => x.status);
  assert.deepEqual(statuses, ["duplicate", "duplicate"], JSON.stringify(out.body).slice(0, 300));
});
await check("INT-03 bloqueia nova sessao com sessao aberta e com relato pendente (nenhum evento novo)", async () => {
  const before = (await record(pa, A)).events.length;
  assert.equal(await pa.isDisabled("#btn-session-start"), true, "start is disabled while a session is open");
  await pa.click("#btn-session-end");
  await pa.waitForSelector('#session-result[data-session-phase="ended"]');
  await waitSync(pa, "synced");
  await pa.click("#btn-session-start");
  await pa.waitForFunction(() => { const e = document.getElementById("error-banner"); return e && !e.hidden && e.dataset.errorCode === "SESSION_BLOCKED"; });
  assert.match(await pa.textContent("#error-banner-text"), /relato|report/i);
  assert.equal((await record(pa, A)).events.length, before + 1, "only the stop event was added");
});
await check("INT-04 recuperacao apos RECARGA REAL: fase 'ended' restaurada, nada e transmitido sozinho, relato conclui", async () => {
  const gp = [];
  pa.on("request", (rq) => { if (rq.method() === "POST" && /events:batch/.test(rq.url())) gp.push(1); });
  await pa.reload();
  await pa.waitForFunction(() => !document.getElementById("sync-panel").hidden);
  await sleep(1500);
  assert.equal(gp.length, 0, "no automatic transmission after reload");
  assert.equal(await syncStatus(pa), "synced");
  await loadPlan(pa);
  await chooseReport(pa);
  assert.equal(await pa.isDisabled("#btn-submit-report"), false);
  await pa.click("#btn-submit-report");
  await pa.waitForSelector('#report-result[data-report-assistance="some"]');
  await waitSync(pa, "synced");
  const r = await record(pa, A);
  assert.equal(countType(r, "report.submitted"), 1); assert.equal(r.acknowledged, r.events.length);
});
await check("INT-05 sessao orfa apos recarga e sinalizada, sem retomada nem envio automatico", async () => {
  await pa.click("#btn-session-start");
  await pa.waitForSelector('#session-result[data-session-phase="active"]');
  await waitSync(pa, "synced");
  const gp = [];
  pa.on("request", (rq) => { if (rq.method() === "POST" && /events:batch/.test(rq.url())) gp.push(1); });
  await pa.reload();
  await pa.waitForSelector('#sync-notice[data-notice-kind~="orphan"]');
  await sleep(1200);
  assert.equal(gp.length, 0);
  assert.equal(await pa.isDisabled("#btn-session-end"), false);
  await pa.click("#btn-session-end");
  await pa.waitForSelector('#session-result[data-session-phase="ended"]');
  await waitSync(pa, "synced");
});
await check("INT-06 resposta perdida: servidor armazena, cliente nao recebe; reenvio com os MESMOS ids vira 'duplicate'", async () => {
  // current state: ended session, report pending. Report with the response lost twice (initial attempt + the single automatic retry).
  gA.mode = "lose"; gA.lose = 2;
  const before = (await record(pa, A)).events.map((e) => e.event_id + e.hash);
  const seen = [];
  pa.on("response", async (rs) => { if (rs.request().method() === "POST" && /events:batch/.test(rs.url())) { try { seen.push((await rs.json()).results.map((x) => x.status)); } catch {} } });
  await chooseReport(pa, "partial", "none");
  await pa.click("#btn-submit-report");
  await pa.waitForSelector('#report-result[data-report-assistance="none"]');
  await sleep(4500); // auto retry window
  assert.equal(await syncStatus(pa), "pending");
  let r = await record(pa, A);
  assert.equal(r.acknowledged, r.events.length - 1, "report stays pending locally");
  await pa.click("#btn-sync-now");
  await waitSync(pa, "synced");
  r = await record(pa, A);
  assert.deepEqual(r.events.slice(0, before.length).map((e) => e.event_id + e.hash), before, "chain preserved");
  assert.equal(countType(r, "report.submitted"), 1, "report not rebuilt");
  assert.ok(seen.some((s) => s.includes("duplicate")), `expected a 'duplicate' receipt, got ${JSON.stringify(seen)}`);
  gA.mode = "pass";
});
await check("INT-07 duplicacao: duplo clique no relato gera 1 evento; reenvio da cadeia inteira e idempotente", async () => {
  await pa.click("#btn-session-start");
  await pa.waitForSelector('#session-result[data-session-phase="active"]');
  await pa.click("#btn-session-end");
  await pa.waitForSelector('#session-result[data-session-phase="ended"]');
  await waitSync(pa, "synced");
  await chooseReport(pa, "complete", "full");
  await pa.dblclick("#btn-submit-report");
  await pa.waitForSelector('#report-result[data-report-assistance="full"]');
  await waitSync(pa, "synced");
  const r = await record(pa, A);
  assert.equal(r.events.filter((e) => e.type === "report.submitted").length, 1);
  const out = await postDirect(await ptoken(pa), r.events);
  const sts = (out.body?.results || out.body?.data?.results || []).map((x) => x.status);
  assert.ok(sts.length === r.events.length && sts.every((s) => s === "duplicate"), JSON.stringify(sts));
});
await check("INT-08 dispensa: recusada com eventos nao confirmados; permitida (sem perda) quando tudo confirmado", async () => {
  await pa.click("#btn-session-start");
  await pa.waitForSelector('#session-result[data-session-phase="active"]');
  gA.mode = "block";
  await pa.click("#btn-session-end");
  await pa.waitForSelector('#session-result[data-session-phase="ended"]');
  await pa.waitForSelector('#sync-panel[data-sync-status="pending"]');
  const before = (await record(pa, A)).events.map((e) => e.event_id);
  await pa.click("#btn-dismiss-report");
  await pa.waitForFunction(() => { const e = document.getElementById("error-banner"); return e && !e.hidden && e.dataset.errorCode === "DISMISS_REFUSED"; });
  assert.deepEqual((await record(pa, A)).events.map((e) => e.event_id), before, "nothing lost");
  gA.mode = "pass";
  await pa.click("#btn-sync-now");
  await waitSync(pa, "synced");
  await pa.click("#btn-dismiss-report");
  await pa.waitForSelector("#btn-dismiss-report", { state: "hidden" });
  await pa.click("#btn-session-start");
  await pa.waitForSelector('#session-result[data-session-phase="active"]');
  await waitSync(pa, "synced");
  await pa.click("#btn-session-end");
  await pa.waitForSelector('#session-result[data-session-phase="ended"]');
  await chooseReport(pa, "complete", "none");
  await pa.click("#btn-submit-report");
  await pa.waitForSelector('#report-result[data-report-assistance="none"]');
  await waitSync(pa, "synced");
});
await check("INT-09 aviso de perda ao fechar a aba visivel e traduzido PT/EN", async () => {
  const pt = await pa.textContent("#sync-loss-warning");
  assert.match(pt, /fechar esta aba/i);
  assert.equal(await pa.isVisible("#sync-loss-warning"), true);
  await pa.click('[data-lang-option="en"]');
  await pa.waitForFunction(() => /close this tab/i.test(document.getElementById("sync-loss-warning").textContent));
  assert.match(await pa.textContent("#sync-status"), /uploaded|pending|conflict/i);
  await pa.click('[data-lang-option="pt-BR"]');
  await pa.waitForFunction(() => /fechar esta aba/i.test(document.getElementById("sync-loss-warning").textContent));
});

// ---------- isolation between participants / principals ----------
await sleep(62000); // stay under the API rate limit (120 req/60 s)
const ctxI = await newCtx();
const pi = await openParticipant(ctxI, B);
const gI = await gate(pi);
await check("INT-10 isolamento: pendencias de B nao saem com sessao de outro; logout preserva o registro isolado; reautorizacao antes de enviar", async () => {
  await loadPlan(pi);
  gI.mode = "block";
  await pi.click("#btn-session-start");
  await pi.waitForSelector('#session-result[data-session-phase="active"]');
  await pi.waitForSelector('#sync-panel[data-sync-status="pending"]');
  const recB = await record(pi, B);
  const idsB = recB.events.map((e) => e.event_id);
  assert.equal(recB.acknowledged, 0);
  // logout with pending local events: surfaces cleared, stored record kept (never erased silently)
  await pi.click("#btn-participant-signout");
  await pi.waitForFunction(() => document.getElementById("sync-panel").hidden);
  assert.equal(await pi.evaluate(() => document.getElementById("session-result").hidden), true);
  assert.deepEqual((await record(pi, B)).events.map((e) => e.event_id), idsB, "record kept after logout");
  // another participant on the same tab: sees none of B's pendings and sends none of them
  gI.mode = "pass"; gI.posts.length = 0;
  await signIn(pi, A);
  await sleep(1500);
  assert.equal(await syncStatus(pi), "synced");
  assert.equal(await pi.getAttribute("#sync-panel", "data-sync-pending"), "0");
  assert.equal(gI.posts.flat().some((id) => idsB.includes(id)), false, "B events never sent under A");
  await pi.click("#btn-participant-signout");
  await pi.waitForFunction(() => document.getElementById("sync-panel").hidden);
  // B returns with a NEW invite: pendings are recovered but NOT sent without an explicit action
  gI.posts.length = 0;
  await signIn(pi, B);
  await pi.waitForSelector('#sync-notice[data-notice-kind~="recovered"]');
  await sleep(4000);
  assert.equal(gI.posts.length, 0, "no transmission before explicit reauthorization");
  assert.equal(await syncStatus(pi), "pending");
  await pi.click("#btn-sync-now");
  await waitSync(pi, "synced");
  assert.deepEqual((await record(pi, B)).events.map((e) => e.event_id), idsB, "ids preserved");
  const out = await postDirect(await ptoken(pi), (await record(pi, B)).events);
  assert.ok((out.body?.results || out.body?.data?.results || []).every((x) => x.status === "duplicate"));
});

// ---------- conflict (REAL HASH_CONFLICT against the real ledger) ----------
await sleep(62000); // stay under the API rate limit (120 req/60 s)
const ctxC = await newCtx();
const pc = await openParticipant(ctxC, C);
const gC = await gate(pc);
await check("INT-11 conflito real: reenvio suspenso, cadeia nao reconstruida, nova sessao bloqueada", async () => {
  await loadPlan(pc);
  gC.mode = "block";
  await pc.click("#btn-session-start");
  await pc.waitForSelector('#session-result[data-session-phase="active"]');
  await pc.waitForSelector('#sync-panel[data-sync-status="pending"]');
  const local = await record(pc, C);
  const first = local.events[0];
  // Another writer stores a DIFFERENT event with the same event_id/seq (valid, re-hashed) before the app can send its own.
  const { hash: _h, ...body } = first;
  const forgedBody = { ...body, occurred_at: new Date(Date.parse(first.occurred_at) - 1000).toISOString() };
  const forged = { ...forgedBody, hash: await hashCanonical(forgedBody) };
  const pre = await postDirect(await ptoken(pc), [forged]);
  assert.equal((pre.body?.results || pre.body?.data?.results || [])[0]?.status, "stored", JSON.stringify(pre.body).slice(0, 300));
  gC.mode = "pass"; gC.posts.length = 0;
  await pc.click("#btn-sync-now");
  await waitSync(pc, "conflict");
  const after = await record(pc, C);
  assert.ok(after.conflict && /HASH_CONFLICT|CHAIN_BROKEN/.test(after.conflict.code), JSON.stringify(after.conflict));
  assert.deepEqual(after.events.map((e) => e.hash), local.events.map((e) => e.hash), "chain NOT rebuilt");
  const n = gC.posts.length;
  await sleep(4500);
  assert.equal(gC.posts.length, n, "automatic resend suspended after a definitive conflict");
  await pc.click("#btn-session-end");
  await pc.waitForSelector('#session-result[data-session-phase="ended"]');
  await sleep(500);
  assert.equal(gC.posts.length, n, "stop does not resume transmission while in conflict");
  assert.equal(await pc.isVisible("#btn-sync-now"), false);
  await pc.click("#btn-dismiss-report");
  await pc.waitForFunction(() => { const e = document.getElementById("error-banner"); return e && !e.hidden && e.dataset.errorCode === "DISMISS_REFUSED"; });
  await pc.click("#btn-session-start");
  await pc.waitForFunction(() => { const e = document.getElementById("error-banner"); return e && !e.hidden && e.dataset.errorCode === "SESSION_BLOCKED"; });
});

// ---------- logout with series loaded (painel) ----------
await sleep(62000); // stay under the API rate limit (120 req/60 s)
const ctxD = await newCtx();
const pd = await openParticipant(ctxD, D);
for (const [ex, as] of [["partial", "full"], ["complete", "some"], ["complete", "none"]]) {
  if (!(await pd.$('#prescription-view[data-prescription-loaded="true"]'))) await loadPlan(pd);
  await pd.click("#btn-session-start"); await pd.waitForSelector('#session-result[data-session-phase="active"]');
  await pd.click("#btn-session-end"); await pd.waitForSelector('#session-result[data-session-phase="ended"]');
  await chooseReport(pd, ex, as);
  await pd.click("#btn-submit-report"); await pd.waitForSelector(`#report-result[data-report-assistance="${as}"]`);
  await waitSync(pd, "synced");
}
await t.waitForFunction((id) => document.getElementById("active-participant-id")?.value === id, D, { timeout: 5000 }).catch(() => {});
await t.click("#btn-load-facts");
await t.waitForSelector("#facts-list li[data-fact-item]");
const factIds = await t.evaluate(() => Array.from(document.querySelectorAll("#facts-list li[data-fact-item]")).map((li) => li.getAttribute("data-fact-item")));
for (const id of factIds) { await t.click(`button[data-review-decision="approve"][data-fact-id="${id}"]`); await t.waitForSelector(`li[data-fact-item="${id}"] [data-review-status="approved"]`); }

await sleep(62000); // stay under the API rate limit (120 req/60 s)
const ctxP = await newCtx();
const pp = await ctxP.newPage();
await pp.goto(origin + "/v3/painel.html");
await pp.fill("#signin-username", "terapeuta_demo");
await pp.fill("#signin-password", "senha-sintetica-demo");
await pp.click("#btn-signin");
await pp.waitForSelector("#painel-conteudo:not([hidden])");
const emptyIds = ["evolution-chart", "transition-list", "session-list", "kpi-list", "approved-list", "verify-session", "timeline-list"];
const filled = () => pp.evaluate((ids) => Object.fromEntries(ids.map((i) => [i, document.getElementById(i)?.childElementCount || 0])), emptyIds);
await check("INT-12 logout com series carregadas esvazia grafico, transicoes, sessoes, KPIs, evidencias e linha do tempo", async () => {
  await pp.fill("#participant-id", D);
  await pp.click("#btn-open");
  await pp.waitForFunction(() => document.querySelectorAll("#session-list li").length >= 1, null, { timeout: 15000 });
  const loaded = await filled();
  assert.ok(loaded["evolution-chart"] > 0 && loaded["session-list"] >= 1 && loaded["kpi-list"] > 0 && loaded["approved-list"] > 0, JSON.stringify(loaded));
  await pp.click("#btn-signout");
  const z = await filled();
  assert.ok(Object.values(z).every((n) => n === 0), `surfaces not emptied: ${JSON.stringify(z)}`);
  assert.equal(await pp.evaluate(() => document.getElementById("evolution-chart-desc").textContent), "");
  await sleep(2000);
  assert.ok(Object.values(await filled()).every((n) => n === 0), "no late repopulation");
});
await check("INT-13 logout durante leitura em voo nao repovoa a tela (resposta tardia)", async () => {
  await pp.fill("#signin-username", "terapeuta_demo");
  await pp.fill("#signin-password", "senha-sintetica-demo");
  await pp.click("#btn-signin");
  await pp.waitForSelector("#painel-conteudo:not([hidden])");
  let seen = 0;
  const h = async (route) => { if (route.request().method() !== "GET") return route.continue(); seen++; const resp = await route.fetch(); await sleep(1500); await route.fulfill({ response: resp }); };
  await pp.route("**/api/**", h);
  await pp.fill("#participant-id", D);
  await pp.click("#btn-open");
  await sleep(400);
  await pp.click("#btn-signout");
  await sleep(4500);
  await pp.unroute("**/api/**", h);
  assert.ok(seen > 0, "reads were in flight");
  assert.ok(Object.values(await filled()).every((n) => n === 0), JSON.stringify(await filled()));
  assert.equal(await pp.evaluate(() => document.getElementById("paciente").hidden), true);
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ suite: "s1_integration_final", total: results.length, failed: failed.length, results }, null, 2));
process.exit(failed.length ? 1 : 0);
