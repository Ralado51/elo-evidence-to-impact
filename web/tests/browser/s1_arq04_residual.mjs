// ARQ-04 FIX-01 residual handlers (TH-01, TH-03, TH-07, PA-01, PN-01): characterization + protection. SYNTHETIC data.
// Blocking: exit code != 0 on any failed assertion. On the baseline b1e7a51 it is the BEFORE record.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const origin = args.origin || "http://127.0.0.1:8080";
const pwDir = process.env.ELO_PLAYWRIGHT_DIR || path.join(os.homedir(), "hackathons/elo-platform/workspace/tools/playwright");
const { chromium } = await import(pathToFileURL(path.join(pwDir, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ headless: true });
const results = [];
const check = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); } catch (e) { results.push({ id, ok: false, error: String(e.message).split("\n")[0] }); console.error("FAIL", id, String(e.message).split("\n").slice(0, 3).join(" / ")); } };
const SESSION_KEY = "elo_v3_therapist_session";
const PSESSION_KEY = "elo_v3_participant_session";
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await ctx.addInitScript(() => { try { localStorage.setItem("elo_lang", "en"); } catch {} });
  const p = await ctx.newPage();
  p.reqs = [];
  p.on("request", (r) => { if (/\/api\//.test(r.url())) p.reqs.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  return p;
}
function hold(pg, pattern, method) {
  let release; const gate = new Promise((r) => (release = r)); let armed = true; let hit;
  const hitP = Promise.race([new Promise((r) => (hit = r)), new Promise((_, rej) => setTimeout(() => rej(new Error(`route ${pattern} never hit`)), 10000))]);
  const handler = async (route) => {
    if (armed && route.request().method() === method) { armed = false; hit(); const resp = await route.fetch(); await gate; await route.fulfill({ response: resp }); }
    else await route.continue();
  };
  return { arm: () => pg.route(pattern, handler), release: () => release(), hit: hitP, off: () => pg.unroute(pattern, handler) };
}
const tokenOf = (pg, key) => pg.evaluate((k) => { try { return JSON.parse(sessionStorage.getItem(k) || "null")?.token || null; } catch { return null; } }, key);
async function therapistLogin(pg) {
  await pg.goto(origin + "/v3/therapist.html");
  await pg.fill("#signin-username", "terapeuta_demo"); await pg.fill("#signin-password", "senha-sintetica-demo");
  await pg.click("#btn-signin"); await pg.waitForSelector("#signin-result:not([hidden])");
}

await check("TH-01 duas tentativas de login: resposta tardia da primeira nao sobrescreve a sessao da segunda", async () => {
  const p = await newPage(); await therapistLogin(p);
  const h = hold(p, "**/api/v3/auth/therapist", "POST"); await h.arm();
  await p.click("#btn-signin"); await h.hit; // first attempt held
  await p.click("#btn-signin"); await p.waitForTimeout(1200); // second attempt completes
  const second = await tokenOf(p, SESSION_KEY);
  await h.release(); await p.waitForTimeout(1200); await h.off();
  assert.ok(second, "precondition: second attempt installed a session");
  assert.equal(await tokenOf(p, SESSION_KEY), second, "late response of the superseded attempt must be discarded");
});
await check("TH-01 login em voo e logout: resposta tardia nao reinstala sessao", async () => {
  const p = await newPage(); await therapistLogin(p);
  const h = hold(p, "**/api/v3/auth/therapist", "POST"); await h.arm();
  await p.click("#btn-signin"); await h.hit;
  await p.click("#btn-signout"); await p.waitForTimeout(300);
  assert.equal(await tokenOf(p, SESSION_KEY), null, "precondition: logged out");
  await h.release(); await p.waitForTimeout(1500); await h.off();
  assert.equal(await tokenOf(p, SESSION_KEY), null, "a login response that arrives after logout must not install a session");
  assert.equal(await p.evaluate(() => document.getElementById("btn-signout").hidden), true);
});
await check("TH-03 participante criado e logout: nada e exibido, nenhuma leitura sem sessao", async () => {
  const p = await newPage(); await therapistLogin(p);
  const h = hold(p, "**/api/v3/participants", "POST"); await h.arm();
  await p.fill("#participant-alias", "Tardio Residual"); await p.click("#btn-create-participant"); await h.hit;
  await p.click("#btn-signout"); await p.waitForTimeout(300);
  const mark = p.reqs.length;
  await h.release(); await p.waitForTimeout(1800); await h.off();
  const txt = await p.evaluate(() => { const e = document.getElementById("success-banner"); return e && !e.hidden ? e.textContent : ""; });
  assert.doesNotMatch(txt, /Tardio Residual|registered|cadastr/i, `late creation must not be announced after logout (got: ${txt.trim().slice(0, 100)})`);
  const after = p.reqs.slice(mark).filter((r) => /console\/v1\/participants/.test(r));
  assert.deepEqual(after, [], `no participant-list request may follow a logout: ${after.join(",")}`);
  assert.equal(await p.evaluate(() => document.getElementById("active-participant-id").value), "");
});
await check("TH-07 restauracao de contexto: selecao/criacao manual durante a restauracao prevalece (caracterizacao)", async () => {
  const p = await newPage(); await therapistLogin(p);
  await p.fill("#participant-alias", "Restaurado"); await p.click("#btn-create-participant");
  await p.waitForFunction(() => document.getElementById("active-participant-id").value);
  const restored = await p.inputValue("#active-participant-id");
  const h = hold(p, "**/api/console/v1/participants*", "GET"); await h.arm();
  await p.reload(); await h.hit; // restoreContext is waiting for the list
  await p.fill("#participant-alias", "Manual Depois"); await p.click("#btn-create-participant");
  await p.waitForFunction((r) => { const v = document.getElementById("active-participant-id").value; return v && v !== r; }, restored);
  const manual = await p.inputValue("#active-participant-id");
  await h.release(); await p.waitForTimeout(1500); await h.off();
  assert.equal(await p.inputValue("#active-participant-id"), manual, "the manual choice must not be overridden by a late restore");
});
await check("PA-01 login por convite em voo e logout: resposta tardia nao instala sessao", async () => {
  const t = await newPage(); await therapistLogin(t);
  await t.fill("#participant-alias", "Convite Residual"); await t.click("#btn-create-participant");
  await t.waitForFunction(() => document.getElementById("active-participant-id").value);
  const invite = async (prev) => { await t.click("#btn-create-invite"); await t.waitForFunction((pv) => { const v = document.getElementById("invite-link")?.value || ""; return v.includes("invite=") && v !== pv; }, prev || "", { timeout: 15000 }); const v = await t.inputValue("#invite-link"); return [v, decodeURIComponent(v.split("invite=")[1])]; };
  const [l1, inv1] = await invite(); await t.waitForTimeout(800);
  const [, inv2] = await invite(l1);
  assert.notEqual(inv1, inv2, "fixture: two distinct invites");
  const p = await newPage(); await p.goto(origin + "/v3/participant.html");
  await p.fill("#invite-token", inv1); await p.click("#btn-invite-signin"); await p.waitForSelector("#signin-result:not([hidden])");
  const h = hold(p, "**/api/v3/auth/invite", "POST"); await h.arm();
  await p.fill("#invite-token", inv2); await p.click("#btn-invite-signin"); await h.hit;
  await p.click("#btn-participant-signout"); await p.waitForTimeout(300);
  assert.equal(await tokenOf(p, PSESSION_KEY), null, "precondition: logged out");
  await h.release(); await p.waitForTimeout(1500); await h.off();
  assert.equal(await tokenOf(p, PSESSION_KEY), null, "late invite sign-in must not install a session after logout");
});
await check("PN-01 painel: duas tentativas de login, resposta tardia da primeira nao sobrescreve a segunda", async () => {
  const p = await newPage();
  await p.goto(origin + "/v3/painel.html");
  await p.fill("#signin-username", "terapeuta_demo"); await p.fill("#signin-password", "senha-sintetica-demo");
  const h = hold(p, "**/api/v3/auth/therapist", "POST"); await h.arm();
  await p.click("#btn-signin"); await h.hit;
  await p.fill("#signin-password", "senha-sintetica-demo");
  await p.click("#btn-signin"); await p.waitForFunction((k) => !!sessionStorage.getItem(k), SESSION_KEY, { timeout: 8000 });
  const second = await tokenOf(p, SESSION_KEY);
  await h.release(); await p.waitForTimeout(1500); await h.off();
  assert.equal(await tokenOf(p, SESSION_KEY), second, "late response of the superseded attempt must be discarded");
});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ phase: "arq04-fix01-residual", passed: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
