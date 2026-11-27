// ARQ-04 Phase 0 CHARACTERIZATION (current behaviour, SYNTHETIC data). Records what happens TODAY; it does not assert the target behaviour.
// Findings flagged `defect:true` are expected to flip in later phases (see docs/arch/ARQ-04_IMPLEMENTATION_PLAN.md). (SYNTHETIC data). Usage: node s1_arq03_domain.mjs [--origin URL] [--only goals|...]
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
await ctx.addInitScript(() => { try { localStorage.setItem("elo_lang", "en"); } catch {} });
const t = await ctx.newPage();
const writes = [];
t.on("request", (r) => { if (/\/api\/v3\//.test(r.url()) && r.method() !== "GET") writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
const count = (re) => writes.filter((w) => re.test(w)).length;


const obs = {};
const settle = (ms = 900) => t.waitForTimeout(ms);
function hold(pattern, method, { status = null } = {}) {
  let release; const gate = new Promise((r) => (release = r)); let armed = true; let hit;
  const hitP = Promise.race([new Promise((r) => (hit = r)), new Promise((_, rej) => setTimeout(() => rej(new Error(`route ${pattern} never hit`)), 10000))]);
  const handler = async (route) => {
    const u = new URL(route.request().url());
    if (armed && route.request().method() === method && (!status || true)) {
      armed = false; hit();
      const resp = await route.fetch();
      await gate;
      if (status) await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "synthetic late failure" } }) });
      else await route.fulfill({ response: resp });
    } else await route.continue();
  };
  return { arm: () => t.route(pattern, handler), release: async () => { release(); }, hit: hitP, off: () => t.unroute(pattern, handler) };
}
const vis = (sel) => t.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.textContent.trim().length > 0; }, sel);
const bannerErr = () => vis("#error-banner");
const bannerOk = () => vis("#success-banner");
const activeId = () => t.inputValue("#active-participant-id");
async function mk(alias) {
  await t.fill("#participant-alias", alias);
  await t.click("#btn-create-participant");
  await t.waitForFunction((a) => document.getElementById("participant-result") && !document.getElementById("participant-result").hidden && document.getElementById("active-participant-id").value, alias);
  return t.inputValue("#active-participant-id");
}
async function switchTo(id) {
  const sel = `#participant-list li[data-participant-id="${id}"] button`;
  if (!(await t.$(sel))) { await t.fill("#participant-search", "Carac"); await t.press("#participant-search", "Enter"); await t.waitForSelector(sel); }
  await t.click(sel); await settle(500);
}

await t.goto(origin + "/v3/therapist.html");
await t.fill("#signin-username", "terapeuta_demo");
await t.fill("#signin-password", "senha-sintetica-demo");
await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
const ALFA = await mk("Alfa Carac");
await t.waitForTimeout(400);
const BETA = await mk("Beta Carac");
await t.waitForFunction(() => document.getElementById("goal-target-unit").dataset.unit === "sessions");

async function lateWrite(name, patternRx, armBtn, prep, resultSel) {
  await switchTo(ALFA);
  await prep();
  const h = hold(patternRx, "POST"); await h.arm();
  await t.click(armBtn);
  await h.hit;
  await switchTo(BETA);
  const before = { active: await activeId(), resultVisible: await vis(resultSel) };
  await h.release(); await settle(1200);
  const bannerText = await t.evaluate(() => document.getElementById("success-banner-text")?.textContent || "");
  const after = { active: await activeId(), resultVisibleInBeta: await vis(resultSel), successBanner: await bannerOk(), bannerText, errorBanner: await bannerErr() };
  await h.off();
  obs[name] = { before, after, defect: after.resultVisibleInBeta || /saved|salv|gravad|recorded|registr/i.test(after.bannerText) && !/active|ativo/i.test(after.bannerText) };
}

await check("C0-1 FX37.1 meta tardia (G-01)", async () => {
  await lateWrite("fx37_1_goal", "**/api/v3/participants/*/goals", "#btn-create-goal", async () => { await t.fill("#goal-text", "Meta tardia Alfa"); }, "#goal-result");
});
await check("C0-2 FX37.1 avaliação tardia (G-02)", async () => {
  await lateWrite("fx37_1_assessment", "**/api/v3/participants/*/assessments", "#btn-create-assessment", async () => {
    await t.fill("#assessment-date", "2026-03-10"); await t.selectOption("#assessment-item-value-type", "number"); await t.selectOption("#assessment-item-unit", "deg");
    await t.fill("#assessment-item-key", "grip_key"); await t.fill("#assessment-item-value", "5");
  }, "#assessment-result");
});
await check("C0-3 FX37.1 convite tardio (G-04)", async () => {
  await switchTo(ALFA);
  const h = hold("**/api/v3/invites", "POST"); await h.arm();
  await t.click("#btn-create-invite"); await h.hit;
  await switchTo(BETA);
  await h.release(); await settle(1200);
  const inviteFor = await t.evaluate(() => document.getElementById("invite-result")?.dataset.inviteFor || null);
  obs.fx37_1_invite = { active: await activeId(), inviteResultVisible: await vis("#invite-result"), inviteLabelledFor: inviteFor === ALFA ? "ALFA" : inviteFor === BETA ? "BETA" : inviteFor, defect: (await vis("#invite-result")) && inviteFor === BETA };
  await h.off();
});
await check("C0-4 FX37.2 erro tardio da linha do tempo (G-05)", async () => {
  await switchTo(ALFA);
  const h = hold("**/api/v3/participants/*/timeline", "GET", { status: 500 }); await h.arm();
  await t.click("#btn-load-timeline"); await h.hit;
  await switchTo(BETA);
  await h.release(); await settle(1200);
  obs.fx37_2_timeline = { errorBannerInBeta: await bannerErr(), defect: await bannerErr() };
  await h.off();
});
await check("C0-5 FX37.2 erro tardio da série de evolução (G-05)", async () => {
  await switchTo(ALFA);
  const h = hold("**/api/v3/participants/*/evolution/series*", "GET", { status: 500 }); await h.arm();
  await t.click("#btn-load-evolution-series"); await h.hit;
  await switchTo(BETA);
  await h.release(); await settle(1200);
  obs.fx37_2_series = { errorBannerInBeta: await bannerErr(), defect: await bannerErr() };
  await h.off();
});
await check("C0-6 logout com leitura de lista em voo (G-09)", async () => {
  const h = hold(/\/api\/console\/v1\/participants(\?.*)?$/, "GET"); await h.arm();
  await t.fill("#participant-search", "Carac"); await t.press("#participant-search", "Enter"); await h.hit;
  await t.click("#btn-signout"); await settle(300);
  const listBefore = await t.evaluate(() => document.querySelectorAll("#participant-list li").length);
  await h.release(); await settle(1200);
  const listAfter = await t.evaluate(() => document.querySelectorAll("#participant-list li").length);
  obs.logout_inflight_list = { listBefore, listAfter, defect: listAfter > 0 };
  await h.off();
});
await check("C0-7 I-01 unidade não retraduz na troca de idioma", async () => {
  await t.fill("#signin-username", "terapeuta_demo"); await t.fill("#signin-password", "senha-sintetica-demo"); await t.click("#btn-signin");
  await t.waitForSelector("#signin-result:not([hidden])");
  const texts = async () => t.$$eval("#assessment-item-unit option", (o) => o.map((x) => x.textContent.trim()));
  const en = await texts();
  await t.evaluate(() => { const m = [...document.querySelectorAll("button,a")].find((b) => /^(PT|pt)$/.test(b.textContent.trim()) || b.dataset.lang === "pt"); if (m) m.click(); else { localStorage.setItem("elo_lang", "pt"); document.dispatchEvent(new Event("elo:lang")); } });
  await settle(600);
  const pt = await texts();
  obs.i01_units = { en, pt, defect: JSON.stringify(en.slice(1)) === JSON.stringify(pt.slice(1)) };
});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ phase: 0, passed: failed.length === 0, observations: obs, results }, null, 2));
process.exit(failed.length ? 1 : 0);
