// ARQ-03 FIX-01 characterization probe (SYNTHETIC data). Records what the UI actually sends/persists. Usage: node arq03_fix01_probe.mjs
import path from "node:path"; import os from "node:os"; import { pathToFileURL } from "node:url";
const origin = process.env.ELO_ORIGIN || "http://127.0.0.1:8080";
const pwDir = process.env.ELO_PLAYWRIGHT_DIR || path.join(os.homedir(), "hackathons/elo-platform/workspace/tools/playwright");
const { chromium } = await import(pathToFileURL(path.join(pwDir, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
await ctx.addInitScript(() => { try { localStorage.setItem("elo_lang", "en"); } catch {} });
const t = await ctx.newPage();
let lastBody = null; const sent = [];
t.on("request", (r) => { if (/\/api\/v3\//.test(r.url()) && r.method() === "POST") { sent.push(new URL(r.url()).pathname); try { lastBody = JSON.parse(r.postData() || "null"); } catch { lastBody = null; } } });
await t.goto(origin + "/v3/therapist.html");
await t.fill("#signin-username", "terapeuta_demo"); await t.fill("#signin-password", "senha-sintetica-demo"); await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
await t.fill("#participant-alias", "Fix01 Sonda"); await t.click("#btn-create-participant"); await t.waitForSelector("#participant-result:not([hidden])");
const pid = await t.inputValue("#active-participant-id");
const login = await ctx.request.post(origin + "/api/v3/auth/therapist", { data: { username: "terapeuta_demo", password: "senha-sintetica-demo" } });
const H = { Authorization: `Bearer ${(await login.json()).token}` };
const list = async (k) => { const b = await (await ctx.request.get(`${origin}/api/v3/participants/${pid}/${k}`, { headers: H })).json(); return b.items ?? b.entities ?? b; };
await t.waitForFunction(() => document.getElementById("goal-target-unit").value === "sessions");
const out = {};
const snap = async (sel) => ({ ariaInvalid: await t.getAttribute(sel, "aria-invalid"), describedby: await t.getAttribute(sel, "aria-describedby"), focused: await t.evaluate(() => document.activeElement.id) });
const banner = async () => ({ error: await t.isVisible("#error-banner") ? (await t.textContent("#error-banner-text")).trim() : null });

// FIX-40 / ARQ03-02: empty goal description
await t.fill("#goal-text", ""); let n = sent.length;
await t.click("#btn-create-goal"); await t.waitForTimeout(1500);
out.fix40_empty_goal_text = { requests_sent: sent.length - n, field: await snap("#goal-text"), field_error_visible: await t.isVisible("#goal-text-error").catch(() => false), ...(await banner()) };
// FIX-38: 100000 and 100001
await t.fill("#goal-text", "Meta sintetica limite"); 
for (const v of ["100001", "100000"]) {
  await t.fill("#goal-target-value", v); n = sent.length; await t.click("#btn-create-goal"); await t.waitForTimeout(1500);
  out[`fix38_value_${v}`] = { requests_sent: sent.length - n, field: await snap("#goal-target-value"), field_error_visible: await t.isVisible("#goal-target-value-error").catch(() => false), ...(await banner()), persisted_last_value: (await list("goals")).at(-1)?.payload?.target?.value ?? null };
  if (v === "100001") await t.fill("#goal-text", "Meta sintetica limite 2");
}
// FIX-39 / ARQ03-01: numeric item, empty value, not_assessed unchecked
await t.selectOption("#assessment-item-value-type", "number"); await t.selectOption("#assessment-item-unit", "deg");
await t.fill("#assessment-date", "2026-03-10"); await t.fill("#assessment-item-value", ""); n = sent.length;
await t.click("#btn-create-assessment"); await t.waitForTimeout(1500);
out.fix39_numeric_empty_not_flagged = { requests_sent: sent.length - n, payload_item: sent.length - n ? lastBody?.items?.[0] : null, persisted_item: (await list("assessments")).at(-1)?.payload?.items?.[0] ?? null, ...(await banner()) };
// zero control
await t.fill("#assessment-item-key", "zero_control"); await t.fill("#assessment-item-value", "0"); n = sent.length;
await t.click("#btn-create-assessment"); await t.waitForTimeout(1500);
out.fix39_zero_control = { requests_sent: sent.length - n, payload_item: sent.length - n ? lastBody?.items?.[0] : null, persisted_item: (await list("assessments")).at(-1)?.payload?.items?.[0] ?? null };
// FIX-17 / D01 guide text EN and PT
const p = await ctx.newPage(); await p.goto(origin + "/v3/participant.html"); await p.waitForTimeout(1000);
const guide = async () => (await p.evaluate(() => [...document.querySelectorAll("li,p")].map((e) => e.textContent.trim()).filter((x) => /(stop button|botão único|botão de parada|stop|parada)/i.test(x) && /(pain|dor)/i.test(x)))) ;
out.d01_guide_en = await guide();
await p.evaluate(() => localStorage.setItem("elo_lang", "pt-BR")); await p.reload(); await p.waitForTimeout(1000);
out.d01_guide_pt = await guide();
await browser.close();
console.log(JSON.stringify(out, null, 1));
