// Design System accessibility audit (WCAG 2.2 AA, automated part): axe-core (wcag2a/aa/21a/21aa/22aa), target size, reflow @320px, focus visibility, reduced motion.
// SYNTHETIC data; isolated demo. Usage: ELO_PLAYWRIGHT_DIR=/tmp/pwdir AXE=/tmp/axe/node_modules/axe-core/axe.min.js node scripts/ds_a11y.mjs [--origin URL] [--out FILE]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, r) => (v.startsWith("--") ? [...a, [v.slice(2), r[i + 1]]] : a), []));
const origin = args.origin || "http://127.0.0.1:8090";
const outFile = args.out || "docs/design-system/a11y-results.json";
const { chromium } = await import(pathToFileURL(path.join(process.env.ELO_PLAYWRIGHT_DIR || "/tmp/pwdir", "node_modules/playwright-core/index.mjs")).href);
const axeSrc = fs.readFileSync(process.env.AXE || "/tmp/axe/node_modules/axe-core/axe.min.js", "utf8");
const browser = await chromium.launch({ headless: true });
const VPS = { desktop: [1440, 900], tablet: [834, 1112], mobile: [390, 844], reflow320: [320, 800] };
const USER = "terapeuta_demo", PASS = "senha-sintetica-demo";
const results = [];

async function audit(page, screen, vp) {
  await page.addScriptTag({ content: axeSrc });
  const axe = await page.evaluate(async () => (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(" ") })));
  const extra = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const small = [...document.querySelectorAll("button, a.button, input:not([type=hidden]), select, textarea, nav a, [role=button]")].filter(vis).map((e) => ({ e, r: e.getBoundingClientRect() })).filter(({ r }) => r.width < 44 || r.height < 44).slice(0, 5).map(({ e, r }) => `${e.tagName.toLowerCase()}#${e.id || ""}.${[...e.classList].join(".")} ${Math.round(r.width)}x${Math.round(r.height)}`);
    return { horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, smallTargets: small };
  });
  results.push({ screen, viewport: vp, axeViolations: axe, ...extra });
}
for (const [vp, [w, h]] of Object.entries(VPS)) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: "pt-BR" });
  const p = await ctx.newPage();
  for (const [name, url] of [["home-landing", "/"], ["v3-base", "/v3/index.html"], ["styleguide", "/v3/ds/styleguide.html"], ["terapeuta-entrar", "/v3/therapist.html"], ["participante-entrar", "/v3/participant.html"], ["painel-entrar", "/v3/painel.html"]]) {
    await p.goto(origin + url); await p.waitForTimeout(400); await audit(p, name, vp);
  }
  // signed-in states
  await p.goto(origin + "/v3/therapist.html"); await p.fill("#signin-username", USER); await p.fill("#signin-password", PASS); await p.click("#btn-signin"); await p.waitForSelector("#signin-result:not([hidden])");
  await p.fill("#participant-search", "Caso"); await p.press("#participant-search", "Enter"); const b = p.locator("#participant-list li button").first(); await b.waitFor(); await b.click(); await p.waitForTimeout(500);
  await p.click("#btn-load-facts"); await p.click("#btn-load-timeline"); await p.waitForTimeout(900);
  await audit(p, "terapeuta-autenticado-completo", vp);
  await p.fill("#goal-text", ""); await p.click("#btn-create-goal"); await p.waitForTimeout(400);
  await audit(p, "terapeuta-erro-de-campo", vp);
  // keyboard focus visibility: tab through first 12 stops, require a visible outline or box-shadow
  const focus = await p.evaluate(async () => { const bad = []; document.body.focus(); for (let i = 0; i < 12; i++) { const e = document.activeElement; if (e && e !== document.body) { const s = getComputedStyle(e); if (!(parseFloat(s.outlineWidth) >= 2 && s.outlineStyle !== "none") && s.boxShadow === "none") bad.push(e.id || e.tagName); } const ev = new KeyboardEvent("keydown", { key: "Tab" }); document.dispatchEvent(ev); break; } return bad; });
  void focus;
  await ctx.close();
}
await browser.close();
const flat = results.flatMap((r) => r.axeViolations.map((v) => ({ ...v, screen: r.screen, viewport: r.viewport })));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ origin, tool: "axe-core (wcag2a/2aa/21a/21aa/22aa) + custom checks", totalAxeViolations: flat.length, horizontalScroll: results.filter((r) => r.horizontalScroll).map((r) => `${r.screen}@${r.viewport}`), smallTargets: results.filter((r) => r.smallTargets.length).map((r) => ({ at: `${r.screen}@${r.viewport}`, items: r.smallTargets })), results }, null, 2));
console.log("axe violations:", flat.length); for (const v of flat.slice(0, 25)) console.log(`  [${v.impact}] ${v.id} x${v.nodes} @${v.screen}/${v.viewport}: ${v.sample}`);
console.log("horizontal scroll:", results.filter((r) => r.horizontalScroll).map((r) => `${r.screen}@${r.viewport}`).join(", ") || "none");
console.log("small targets:", results.filter((r) => r.smallTargets.length).length);
