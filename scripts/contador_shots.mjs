// Captures the hand-counter page (initial, demo running, result, fake-camera) and reports JS/network errors. Synthetic only.
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
const dir = process.env.ELO_PLAYWRIGHT_DIR || "/tmp/pwdir";
const { chromium } = await import(pathToFileURL(`${dir}/node_modules/playwright-core/index.mjs`).href);
const out = process.argv[2] || "/tmp/contador"; const origin = process.argv[3] || "http://127.0.0.1:8090";
const VPS = { desktop: [1440, 900], mobile: [390, 844] };
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const report = {};
for (const [vp, [width, height]] of Object.entries(VPS)) {
  mkdirSync(`${out}/${vp}`, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width, height }, permissions: ["camera"] });
  const page = await ctx.newPage(); const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  page.on("requestfailed", (r) => errs.push("requestfailed: " + r.url()));
  page.on("response", (r) => { if (r.status() >= 400) errs.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(`${origin}/s2/contador.html`); await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${vp}/1-inicial.png`, fullPage: true });
  await page.click("#btn-demo"); await page.waitForTimeout(9500);
  await page.screenshot({ path: `${out}/${vp}/2-demonstracao.png`, fullPage: true });
  await page.click("#btn-stop"); await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${vp}/3-resultado.png`, fullPage: true });
  await page.click("#btn-start"); await page.waitForTimeout(6000);
  await page.screenshot({ path: `${out}/${vp}/4-camera.png`, fullPage: true });
  report[vp] = { msg: await page.textContent("#counter-msg"), overflowX: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), errors: errs };
  await ctx.close();
}
await browser.close(); console.log(JSON.stringify(report, null, 1));
