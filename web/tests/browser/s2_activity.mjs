// S2 ARQ-08 integration suite (SYNTHETIC data, simulation only; no camera). Real API, real ledger and verifier.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const origin = args.origin || "http://127.0.0.1:8080";
const ORG = "o_localdemo01";
const pwDir = process.env.ELO_PLAYWRIGHT_DIR || path.join(os.homedir(), "hackathons/elo-platform/workspace/tools/playwright");
const { chromium } = await import(pathToFileURL(path.join(pwDir, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ headless: true });
const results = [];
const check = async (id, fn) => {
  try { await fn(); results.push({ id, ok: true }); }
  catch (e) { results.push({ id, ok: false, error: String(e.message).split("\n")[0] }); console.error("FAIL", id, String(e.message).split("\n").slice(0, 3).join(" / ")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newCtx = async () => { const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "pt-BR" }); await c.addInitScript(() => { try { if (!localStorage.getItem("elo_lang")) localStorage.setItem("elo_lang", "pt-BR"); } catch {} }); return c; };

const tctx = await newCtx();
const t = await tctx.newPage();
await t.goto(origin + "/v3/therapist.html");
await t.fill("#signin-username", "terapeuta_demo");
await t.fill("#signin-password", "senha-sintetica-demo");
await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
const tToken = await t.evaluate(() => JSON.parse(sessionStorage.getItem("elo_v3_therapist_session")).token);
async function seed(alias, side = "right") {
  const prev = await t.inputValue("#active-participant-id").catch(() => "");
  await t.fill("#participant-alias", alias);
  await t.selectOption("#participant-side", side);
  await t.click("#btn-create-participant");
  await t.waitForFunction((p) => { const v = document.getElementById("active-participant-id")?.value; return v && v !== p; }, prev, { timeout: 15000 });
  const id = await t.inputValue("#active-participant-id");
  await t.click("#btn-create-assessment"); await t.waitForSelector("#assessment-result:not([hidden])");
  await t.click("#btn-create-goal"); await t.waitForSelector("#goal-result:not([hidden])");
  await t.fill("#rx-valid-from", "2026-01-01"); await t.fill("#rx-valid-to", "2027-12-31");
  await t.fill("#rx-sets", "1"); await t.fill("#rx-reps", "3");
  await t.click("#btn-publish-prescription"); await t.waitForSelector("#prescription-result:not([hidden])");
  await sleep(300);
  return id;
}
const invite = async (pid) => (await (await fetch(`${origin}/api/v3/invites`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tToken}` }, body: JSON.stringify({ participant_id: pid, ttl_seconds: 86400 }) })).json()).invite_token;
async function open(pid, ctx) {
  const page = await ctx.newPage();
  const cam = [];
  await page.addInitScript(() => { window.__gum = 0; const md = navigator.mediaDevices; if (md) { const o = md.getUserMedia?.bind(md); md.getUserMedia = (...a) => { window.__gum++; return o ? o(...a) : Promise.reject(new Error("none")); }; } });
  await page.goto(origin + "/v3/participant.html");
  await page.fill("#invite-token", await invite(pid));
  await page.click("#btn-invite-signin");
  await page.waitForSelector("#signin-result:not([hidden])");
  await page.waitForFunction(() => !document.getElementById("activity-panel").hidden);
  await page.click("#btn-load-plan");
  await page.waitForSelector('#prescription-view[data-prescription-loaded="true"]');
  return page;
}
const key = (pid) => "elo:arq05:v1:" + JSON.stringify([ORG, pid]);
const rec = (page, pid) => page.evaluate((k) => JSON.parse(sessionStorage.getItem(k)), key(pid));
const token = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("elo_v3_participant_session")).token);
const waitSync = (page, st, ms = 20000) => page.waitForSelector(`#sync-panel[data-sync-status="${st}"]`, { timeout: ms });
const post = async (tok, events) => { const r = await fetch(`${origin}/api/v3/events:batch`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ events }) }); return { status: r.status, body: await r.json().catch(() => null) }; };
async function calibrateAndStart(p) {
  await p.click("#btn-act-begin");
  await p.waitForSelector('#session-result[data-session-phase="created"]');
  await p.click("#btn-act-calibrate");
  await p.waitForFunction(() => !document.getElementById("btn-act-start").disabled);
  await p.click("#btn-act-start");
  await p.waitForFunction(() => !document.getElementById("btn-act-cycle").disabled);
}
const progress = (p) => p.textContent("#act-progress-text");
async function report(p, a = "some") {
  await p.click('button[data-choice-group="execution"][data-choice-value="complete"]');
  await p.click(`button[data-choice-group="assistance"][data-choice-value="${a}"]`);
  await p.click("#btn-submit-report");
  await p.waitForSelector(`#report-result[data-report-assistance="${a}"]`);
}

const A = await seed("S2 Alfa");
const B = await seed("S2 Beta");
await sleep(30000);
const ctxA = await newCtx();
const pa = await open(A, ctxA);
let eventsA;

await check("S2-01 jornada completa em simulacao ate a dose, aceita pelo ledger real (stream completo)", async () => {
  await calibrateAndStart(pa);
  assert.match(await pa.textContent("#act-dose"), /1 série.*3 repetição/i);
  for (let i = 1; i <= 3; i++) {
    await pa.selectOption("#act-sim-side", "right");
    await pa.click("#btn-act-cycle");
    await pa.waitForFunction((n) => document.getElementById("act-progress-text").textContent.startsWith(n + " de 3"), i);
  }
  await pa.waitForSelector("#act-status", { state: "attached" });
  await pa.waitForFunction(() => document.getElementById("act-progress").value === 3);
  await waitSync(pa, "synced");
  await report(pa);
  await waitSync(pa, "synced");
  const r = await rec(pa, A);
  eventsA = r.events;
  assert.deepEqual([...new Set(r.events.map((e) => e.execution_mode))], ["simulation"]);
  assert.equal(r.acknowledged, r.events.length);
  assert.deepEqual(r.events.map((e) => e.type).filter((x) => x === "cycle.accepted").length, 3);
  const out = await post(await token(pa), r.events);
  const sts = (out.body?.results || []).map((x) => x.status);
  assert.ok(sts.length === r.events.length && sts.every((s) => s === "duplicate"), JSON.stringify(sts));
});
await check("S2-02 verificador: fatos derivados do stream de simulacao pelo servidor", async () => {
  await t.waitForFunction((id) => document.getElementById("active-participant-id")?.value === id, B).catch(() => {});
  const r = await fetch(`${origin}/api/v3/participants/${A}/facts`, { headers: { authorization: `Bearer ${tToken}` } });
  assert.equal(r.status, 200, "facts endpoint");
  const j = await r.json();
  const types = new Set(j.facts.map((x) => x.type));
  for (const need of ["F01", "F02", "F03", "F04", "F09"]) assert.ok(types.has(need), `verifier fact ${need} missing: ${[...types]}`);
  assert.ok(j.facts.every((x) => x.data_origin === "synthetic_fixture"), "origin preserved, never promoted");
  assert.equal(types.has("F10"), false, "opening index (F10) is not derived for the experimental counter");
});
await check("S2-03 camera indisponivel: nenhuma chamada a getUserMedia, consentimento desabilitado, autorrelato disponivel", async () => {
  assert.equal(await pa.evaluate(() => window.__gum), 0);
  assert.equal(await pa.isDisabled("#btn-act-camera"), true);
  assert.equal(await pa.isDisabled("#act-camera-consent"), true);
  assert.match(await pa.textContent("#act-camera-status"), /indispon/i);
  assert.equal(await pa.isDisabled("#btn-session-start"), false, "self-report alternative stays available");
});
await check("S2-04 autorrelato continua funcionando no mesmo outbox apos atividade com contagem", async () => {
  await pa.click("#btn-session-start");
  await pa.waitForSelector('#session-result[data-session-phase="active"]');
  await pa.click("#btn-session-end");
  await pa.waitForSelector('#session-result[data-session-phase="ended"]');
  await report(pa, "none");
  await waitSync(pa, "synced");
  const r = await rec(pa, A);
  assert.equal(r.events[0].execution_mode, "report_only");
});
await check("S2-05 lateralidade: mao indeterminada e mao incompativel nao contam para a dose", async () => {
  await pa.click("#btn-act-begin");
  await pa.waitForSelector('#session-result[data-session-phase="created"]');
  await pa.click("#btn-act-calibrate");
  await pa.waitForFunction(() => !document.getElementById("btn-act-start").disabled);
  await pa.click("#btn-act-start");
  await pa.waitForFunction(() => !document.getElementById("btn-act-cycle").disabled);
  await pa.selectOption("#act-sim-side", "unknown"); await pa.click("#btn-act-cycle");
  await pa.waitForFunction(() => /não conta/i.test(document.getElementById("act-status").textContent));
  await pa.selectOption("#act-sim-side", "left"); await pa.click("#btn-act-cycle");
  await pa.waitForFunction(() => /não corresponde/i.test(document.getElementById("act-status").textContent));
  assert.match(await progress(pa), /^0 de 3 ciclos aceitos \(1 ciclos avaliados\)/);
  await waitSync(pa, "synced");
  const r = await rec(pa, A);
  const cyc = r.events.filter((e) => e.type.startsWith("cycle."));
  assert.deepEqual(cyc.map((e) => e.type), ["cycle.rejected"]);
  assert.equal(cyc[0].payload.reason, "handedness_incompatible");
});
await check("S2-06 recarga real no meio da atividade: sessao orfa sinalizada, so pode ser interrompida, depois relato", async () => {
  await pa.reload();
  await pa.waitForSelector('#sync-notice[data-notice-kind~="orphan"]');
  assert.equal(await pa.isDisabled("#btn-act-cycle"), true);
  assert.equal(await pa.isDisabled("#btn-act-begin"), true, "new activity blocked while one is open");
  await pa.click("#btn-load-plan");
  await pa.click("#btn-stop-fatigue");
  await pa.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="fatigue"]');
  await report(pa, "full");
  await waitSync(pa, "synced");
  const r = await rec(pa, A);
  assert.ok(r.events.some((e) => e.type === "session.capture_summary"));
  const out = await post(await token(pa), r.events);
  assert.ok((out.body?.results || []).every((x) => x.status === "duplicate"));
});
await check("S2-07 resposta perdida na captura: mesmos ids, reenvio vira duplicate", async () => {
  await pa.route("**/api/v3/events:batch", async (route) => { if (route.request().method() !== "POST") return route.continue(); await route.fetch(); return route.abort("failed"); }, { times: 2 });
  await pa.click("#btn-act-begin");
  await pa.waitForSelector('#session-result[data-session-phase="created"]');
  await sleep(4500);
  assert.equal(await pa.getAttribute("#sync-panel", "data-sync-status"), "pending");
  const before = (await rec(pa, A)).events.map((e) => e.event_id + e.hash);
  const seen = [];
  pa.on("response", async (rs) => { if (rs.request().method() === "POST" && /events:batch/.test(rs.url())) { try { seen.push((await rs.json()).results.map((x) => x.status)); } catch {} } });
  await pa.click("#btn-sync-now");
  await waitSync(pa, "synced");
  assert.deepEqual((await rec(pa, A)).events.map((e) => e.event_id + e.hash), before);
  assert.ok(seen.flat().includes("duplicate"), JSON.stringify(seen));
});
await check("S2-08 bloqueio: nova atividade bloqueada com sessao aberta; PT/EN do painel de atividade", async () => {
  assert.equal(await pa.isDisabled("#btn-act-begin"), true);
  await pa.click('[data-lang-option="en"]');
  await pa.waitForFunction(() => /Counted activity/i.test(document.querySelector("#activity-panel h3").textContent));
  assert.match(await pa.textContent("#act-dose"), /set\(s\)/);
  await pa.click('[data-lang-option="pt-BR"]');
  await pa.waitForFunction(() => /Atividade com contagem/i.test(document.querySelector("#activity-panel h3").textContent));
});
await check("S2-09 isolamento: outro participante nao ve nem envia a atividade pendente de A", async () => {
  const ctxB = await newCtx();
  const pb = await open(B, ctxB);
  assert.equal(await pb.getAttribute("#sync-panel", "data-sync-pending"), "0", "B pending");
  assert.equal(await pb.evaluate(() => document.getElementById("act-progress-text").textContent), "0 de 3 ciclos aceitos (0 ciclos avaliados)", "B progress");
  assert.equal(await pb.evaluate((k) => sessionStorage.getItem(k), key(A)), null, "A record not visible in B's tab");
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ suite: "s2_activity", total: results.length, failed: failed.length, results }, null, 2));
process.exit(failed.length ? 1 : 0);
