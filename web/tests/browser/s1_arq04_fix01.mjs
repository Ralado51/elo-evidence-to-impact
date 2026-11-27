// ARQ-04 FIX-01 BLOCKING suite (SYNTHETIC data). Exit code != 0 on any failed assertion.
// Covers: FIX-42 (TH-11 prescription leak), FIX-43 (logout, PA-02), FIX-41 (ARQ04-UAT-01), I-01 (derived unit i18n), FIX-44 (legacy unit).
// Run on the baseline b1e7a51 it is the BEFORE record (expected failures); on the FIX-01 revision it must pass entirely.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const origin = args.origin || "http://127.0.0.1:8080";
const pwDir = process.env.ELO_PLAYWRIGHT_DIR || path.join(os.homedir(), "hackathons/elo-platform/workspace/tools/playwright");
const { chromium } = await import(pathToFileURL(path.join(pwDir, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ headless: true });
const results = [];
const check = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); } catch (e) { results.push({ id, ok: false, error: String(e.message).split("\n")[0] }); console.error("FAIL", id, String(e.message).split("\n").slice(0, 3).join(" / ")); } };
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
await ctx.addInitScript(() => { try { if (!localStorage.getItem("elo_lang")) localStorage.setItem("elo_lang", "en"); } catch {} });
const t = await ctx.newPage();
const writes = [];
t.on("request", (r) => { if (/\/api\/v3\//.test(r.url()) && r.method() !== "GET") writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
const settle = (ms = 900, pg = t) => pg.waitForTimeout(ms);
const visOn = (pg, sel) => pg.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.textContent.trim().length > 0; }, sel);
const vis = (sel) => visOn(t, sel);
const okBannerText = (pg = t) => pg.evaluate(() => { const e = document.getElementById("success-banner"); return e && !e.hidden ? e.textContent.trim() : ""; });

function hold(pg, pattern, method) {
  let release; const gate = new Promise((r) => (release = r)); let armed = true; let hit;
  const hitP = Promise.race([new Promise((r) => (hit = r)), new Promise((_, rej) => setTimeout(() => rej(new Error(`route ${pattern} never hit`)), 10000))]);
  const handler = async (route) => {
    if (armed && route.request().method() === method) { armed = false; hit(); const resp = await route.fetch(); await gate; await route.fulfill({ response: resp }); }
    else await route.continue();
  };
  return { arm: () => pg.route(pattern, handler), release: () => release(), hit: hitP, off: () => pg.unroute(pattern, handler) };
}
async function mk(alias) {
  const prev = await t.inputValue("#active-participant-id").catch(() => "");
  await t.fill("#participant-alias", alias);
  await t.click("#btn-create-participant");
  await t.waitForFunction((p) => { const v = document.getElementById("active-participant-id")?.value; return v && v !== p; }, prev, { timeout: 10000 });
  return t.inputValue("#active-participant-id");
}
async function switchTo(id) {
  const sel = `#participant-list li[data-participant-id="${id}"] button`;
  if (!(await t.$(sel))) { await t.fill("#participant-search", "Fix01"); await t.press("#participant-search", "Enter"); await t.waitForSelector(sel); }
  await t.click(sel);
  await t.waitForFunction((x) => document.getElementById("active-participant-id")?.value === x, id, { timeout: 8000 });
  await settle(400);
}
const apiAsTherapist = (pg, method, url, body) => pg.evaluate(async ([method, url, body, key]) => {
  const tok = JSON.parse(sessionStorage.getItem("elo_v3_therapist_session")).token;
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", ...(method !== "GET" ? { "Idempotency-Key": key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}, [method, url, body, randomUUID()]);

await t.goto(origin + "/v3/therapist.html");
await t.fill("#signin-username", "terapeuta_demo");
await t.fill("#signin-password", "senha-sintetica-demo");
await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
const ALFA = await mk("Alfa Fix01");
await settle(400);
const BETA = await mk("Beta Fix01");
assert.notEqual(ALFA, BETA, "fixture: distinct participants");

// ---------------- FIX-42 / TH-11 ----------------
await check("FIX42-01 prescription.publish: leitura secundaria tardia nao vaza para Beta (TH-11)", async () => {
  await switchTo(ALFA);
  const h = hold(t, "**/api/v3/participants/*/prescription/current", "GET"); await h.arm();
  await t.click("#btn-publish-prescription"); await h.hit;
  await switchTo(BETA);
  assert.equal(await vis("#prescription-result"), false, "precondition: nothing in Beta before the late read");
  await h.release(); await settle(1500);
  const leaked = await vis("#prescription-result");
  const okText = await okBannerText();
  await h.off();
  assert.equal(await t.inputValue("#active-participant-id"), BETA);
  assert.equal(leaked, false, `prescription result leaked into Beta (rxLeakedIntoBeta=${leaked})`);
  assert.doesNotMatch(okText, /prescription|prescri|revision|revis/i, `no prescription confirmation in Beta (got: ${okText.slice(0, 100)})`);
  await switchTo(ALFA); await settle(1200);
  assert.match(await t.evaluate(() => document.body.innerText), /record\(s\) for this participant were saved|registro\(s\)/i, "reconciliation notice expected for the origin participant");
});
await check("FIX42-02 prescription.publish: leitura secundaria usa o participante de ORIGEM", async () => {
  await switchTo(ALFA);
  await t.fill("#rx-instructions", "Segunda intencao: instrucoes diferentes"); // a user edit starts a NEW intention (otherwise the write is correctly deduplicated)
  const urls = []; const rec = (r) => { if (/prescription\/current/.test(r.url())) urls.push(r.url()); }; t.on("request", rec);
  const h = hold(t, "**/api/v3/participants/*/prescription/current", "GET"); await h.arm();
  await t.click("#btn-publish-prescription"); await h.hit;
  await switchTo(BETA);
  await h.release(); await settle(1200); await h.off(); t.off("request", rec);
  assert.ok(urls.length >= 1 && urls.every((u) => u.includes(ALFA)), `secondary read must target ${ALFA}: ${urls.join(" | ")}`);
});

// ---------------- FIX-41 / ARQ04-UAT-01 ----------------
await check("FIX41-01 avaliacao valida e depois tentativa sem data: feedback anterior substituido (UAT-01)", async () => {
  await switchTo(BETA);
  await t.fill("#assessment-date", "2026-03-10"); await t.selectOption("#assessment-item-value-type", "number"); await t.selectOption("#assessment-item-unit", "deg");
  await t.fill("#assessment-item-key", "grip_key"); await t.fill("#assessment-item-value", "5");
  await t.click("#btn-create-assessment"); await t.waitForSelector("#assessment-result:not([hidden])");
  assert.ok((await okBannerText()).length > 0, "precondition: success banner after the valid assessment");
  const before = writes.length;
  await t.fill("#assessment-date", "");
  await t.click("#btn-create-assessment"); await settle(500);
  assert.equal(writes.length, before, "a locally invalid attempt must not write");
  assert.equal(await okBannerText(), "", "previous success feedback must be replaced/cleared");
  assert.equal(await vis("#assessment-result"), false, "previous result surface must be cleared");
});
await check("FIX41-02 meta valida e depois tentativa invalida: superficies de resultado limpas", async () => {
  await switchTo(BETA);
  await t.fill("#goal-text", "Meta Fix41");
  await t.click("#btn-create-goal"); await t.waitForSelector("#goal-result:not([hidden])");
  await t.fill("#goal-text", "");
  await t.click("#btn-create-goal"); await settle(500);
  assert.equal(await vis("#goal-result"), false, "goal result of the previous attempt must not stay visible");
  assert.equal(await okBannerText(), "");
});

// ---------------- I-01 ----------------
await check("I-01 unidade derivada (meta) traduzida; canonico preservado; sem escrita ao alternar idioma", async () => {
  await switchTo(BETA);
  const w0 = writes.length;
  const read = () => t.evaluate(() => { const u = document.getElementById("goal-target-unit"); return { shown: u.value, canon: u.dataset.unit }; });
  await t.evaluate(() => document.documentElement.lang); // no-op, keeps page alive
  await t.selectOption("#goal-target-kind", "session_count");
  let r = await read();
  assert.equal(r.canon, "sessions"); assert.match(r.shown, /^sessions$/i);
  await t.selectOption("#goal-target-kind", "repetitions");
  r = await read();
  assert.equal(r.canon, "reps"); assert.equal(r.shown, "repetitions", "derived unit must be translated, not the raw catalog code");
  await t.fill("#goal-text", "texto digitado");
  await t.click('[data-lang-option="pt-BR"]'); await settle(500);
  r = await read();
  assert.equal(r.canon, "reps"); assert.equal(r.shown, "repetições", "unit relabelled in Portuguese after the toggle");
  await t.selectOption("#goal-target-kind", "session_count");
  r = await read(); assert.equal(r.shown, "sessões"); assert.equal(r.canon, "sessions");
  await t.click('[data-lang-option="en"]'); await settle(500);
  r = await read(); assert.equal(r.shown, "sessions");
  assert.equal(await t.inputValue("#goal-text"), "texto digitado", "typed values preserved");
  assert.equal(writes.length, w0, "no write request on language toggle");
});

// ---------------- FIX-44 + FIX-43 / PA-02 (participant) ----------------
let participantPage; let gpid; let token;
await check("FIX44 meta historica com unidade fora do catalogo (cm): literal + marcador legado, nunca 'Nao informado'", async () => {
  await switchTo(ALFA);
  gpid = ALFA;
  const g = await apiAsTherapist(t, "POST", `/api/v3/participants/${gpid}/goals`, { goal_text: "Meta legada seed", body_segment: await t.inputValue("#goal-segment"), target: { kind: "session_count", value: 12, unit: "sessions" }, status: await t.inputValue("#goal-status"), confirmed_by: null, confirmed_at: null });
  assert.ok([200, 201].includes(g.status), `goal seed failed: HTTP ${g.status} ${JSON.stringify(g.body).slice(0, 160)}`);
  await t.click("#btn-create-invite"); await t.waitForSelector("#invite-link");
  token = decodeURIComponent((await t.inputValue("#invite-link")).split("invite=")[1]);
  participantPage = await ctx.newPage();
  // The API rejects units outside the current catalog on write, so the HISTORICAL record is emulated on the read path:
  // the participant app receives exactly what an old record stored (unit "cm", markup in the text).
  await participantPage.route("**/api/v3/participants/*/goals", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const resp = await route.fetch(); const j = await resp.json();
    const arr = (Array.isArray(j) ? j : j.data) || [];
    for (const it of arr) { it.target = { kind: "measure_value", value: 12, unit: "cm" }; it.goal_text = "<b>Meta legada</b>"; }
    await route.fulfill({ response: resp, json: j });
  });
  await participantPage.goto(origin + "/v3/participant.html");
  await participantPage.fill("#invite-token", token); await participantPage.click("#btn-invite-signin");
  await participantPage.waitForSelector("#signin-result:not([hidden])");
  await participantPage.click("#btn-load-plan"); await participantPage.waitForSelector("#goals-list li[data-goal-item]");
  const li = await participantPage.evaluate(() => { const e = document.querySelector("#goals-list li[data-goal-item]"); return { text: e.textContent, legacy: e.dataset.legacy === "true", html: e.innerHTML }; });
  assert.match(li.text, /12 cm/, `unit must be shown literally: ${li.text.slice(0, 160)}`);
  assert.doesNotMatch(li.text, /not informed|n[aã]o informado/i, "an existing unit must never become 'Not informed'");
  assert.ok(li.legacy, "legacy marker expected");
  assert.doesNotMatch(li.html, /<b>/i, "goal text must not be interpreted as HTML");
});
await check("FIX43 / PA-02 logout limpa todas as superficies e leitura tardia nao repopula", async () => {
  const p = participantPage;
  assert.ok(await p.evaluate(() => document.querySelectorAll("#goals-list li").length > 0), "precondition: plan loaded");
  const h = hold(p, "**/api/v3/participants/*/goals", "GET"); await h.arm();
  await p.click("#btn-load-plan"); await h.hit;
  await p.click("#btn-participant-signout"); await settle(300, p);
  const snap = () => p.evaluate(() => ({
    goals: document.querySelectorAll("#goals-list li").length, rx: document.getElementById("prescription-view").textContent.trim().length,
    signin: document.getElementById("signin-result").textContent.trim().length, pubs: document.querySelectorAll("#publication-list li").length,
    err: !document.getElementById("error-banner").hidden && document.getElementById("error-banner-text").textContent.trim().length > 0,
  }));
  let s = await snap();
  assert.deepEqual({ goals: s.goals, rx: s.rx, signin: s.signin, pubs: s.pubs }, { goals: 0, rx: 0, signin: 0, pubs: 0 }, `surfaces must be empty right after logout: ${JSON.stringify(s)}`);
  await h.release(); await settle(1500, p); await h.off();
  s = await snap();
  assert.deepEqual({ goals: s.goals, rx: s.rx, signin: s.signin, pubs: s.pubs }, { goals: 0, rx: 0, signin: 0, pubs: 0 }, `late response must not repopulate: ${JSON.stringify(s)}`);
  assert.equal(s.err, false, "no error banner for an aborted/obsolete read");
});
await check("FIX43 terapeuta: logout limpa participante, listas e resultados", async () => {
  await switchTo(BETA);
  await t.click("#btn-signout"); await settle(500);
  const s = await t.evaluate(() => ({ pid: document.getElementById("active-participant-id").value, list: document.querySelectorAll("#participant-list li").length,
    boxes: ["participant-result", "assessment-result", "goal-result", "prescription-result", "invite-result", "signin-result"].filter((id) => { const e = document.getElementById(id); return e && e.textContent.trim().length > 0; }),
    facts: document.querySelectorAll("#facts-list li").length, tl: document.querySelectorAll("#timeline-list li").length }));
  assert.deepEqual({ pid: s.pid, list: s.list, boxes: s.boxes, facts: s.facts, tl: s.tl }, { pid: "", list: 0, boxes: [], facts: 0, tl: 0 }, JSON.stringify(s));
});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ phase: "arq04-fix01-blocking", passed: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
