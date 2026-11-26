// Seeds a complete SYNTHETIC demo case through the real v3 pages (no shortcuts to the API).
// Usage: node web/tests/browser/seed_demo.mjs --origin http://127.0.0.1:8080 [--alias "Caso demonstrativo"]
// Env: ELO_PLAYWRIGHT_DIR (playwright-core dir), ELO_CHROME (optional executablePath).
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
const origin = args.origin || "http://127.0.0.1:8080";
const alias = args.alias || "Caso Demonstrativo 01";
const USER = args.user || "terapeuta_demo";
const PASS = args.pass || "senha-sintetica-demo";
const FROM = "2026-01-01", TO = "2027-12-31";
// assistance reported per session: progression from full help to none
const SESSIONS = [
  { execution: "partial", assistance: "full" },
  { execution: "partial", assistance: "some" },
  { execution: "complete", assistance: "some" },
  { execution: "complete", assistance: "none" },
  { execution: "complete", assistance: "none" },
];

const pwDir = process.env.ELO_PLAYWRIGHT_DIR || path.join(os.homedir(), "hackathons/elo-platform/workspace/tools/playwright");
const { chromium } = await import(pathToFileURL(path.join(pwDir, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ headless: true, ...(process.env.ELO_CHROME ? { executablePath: process.env.ELO_CHROME, args: ["--no-sandbox"] } : {}) });
const tCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const t = await tCtx.newPage();
const p = await pCtx.newPage();

await t.goto(`${origin}/v3/therapist.html`, { waitUntil: "load" });
await t.fill("#signin-username", USER);
await t.fill("#signin-password", PASS);
await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
const tSession = await t.evaluate(() => JSON.parse(sessionStorage.getItem("elo_v3_therapist_session")));

await t.fill("#participant-alias", alias);
await t.selectOption("#participant-side", "right");
await t.click("#btn-create-participant");
await t.waitForSelector("#participant-result:not([hidden])");
const participantId = await t.locator("#active-participant-id").inputValue();
await t.click("#btn-create-assessment");
await t.waitForSelector("#assessment-result:not([hidden])");
await t.click("#btn-create-goal");
await t.waitForSelector("#goal-result:not([hidden])");
await t.fill("#rx-valid-from", FROM);
await t.fill("#rx-valid-to", TO);
await t.click("#btn-publish-prescription");
await t.waitForSelector("#prescription-result:not([hidden])");

const inv = await (await fetch(`${origin}/api/v3/invites`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${tSession.token}` },
  body: JSON.stringify({ participant_id: participantId, ttl_seconds: 86400 }),
})).json();

await p.goto(`${origin}/v3/participant.html`, { waitUntil: "load" });
await p.fill("#invite-token", inv.invite_token);
await p.click("#btn-invite-signin");
await p.waitForSelector("#signin-result:not([hidden])");
await p.click("#btn-load-plan");
await p.waitForSelector('#prescription-view[data-prescription-loaded="true"]');

for (const s of SESSIONS) {
  await p.click("#btn-session-start");
  await p.waitForSelector('#session-result[data-session-phase="active"]');
  await p.click("#btn-session-end");
  await p.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="end"]');
  await p.click(`button[data-choice-group="execution"][data-choice-value="${s.execution}"]`);
  await p.click(`button[data-choice-group="assistance"][data-choice-value="${s.assistance}"]`);
  await p.click("#btn-submit-report");
  await p.waitForSelector(`#report-result[data-report-assistance="${s.assistance}"]`);
}

await t.click("#btn-load-facts");
await t.waitForSelector("#facts-list li[data-fact-item]");
const factIds = await t.evaluate(() => Array.from(document.querySelectorAll("#facts-list li[data-fact-item]")).map((li) => li.getAttribute("data-fact-item")));
for (const id of factIds) {
  await t.click(`button[data-review-decision="approve"][data-fact-id="${id}"]`);
  await t.waitForSelector(`li[data-fact-item="${id}"] [data-review-status="approved"]`);
}
await t.fill("#summary-period-from", FROM);
await t.fill("#summary-period-to", TO);
await t.click("#btn-publish-summary");
await t.waitForSelector("#summary-result [data-published-summary]");
const summaryId = await t.locator("#summary-result [data-published-summary]").getAttribute("data-published-summary");
await t.click("#btn-load-evolution-series");
await t.waitForSelector("#evolution-series-container [data-evolution-series]");
await t.fill("#evolution-period-from", FROM);
await t.fill("#evolution-period-to", TO);
await t.click("#btn-publish-evolution");
await t.waitForSelector("#evolution-result [data-published-evolution]");
const evolutionId = await t.locator("#evolution-result [data-published-evolution]").getAttribute("data-published-evolution");

await browser.close();
console.log(JSON.stringify({ participant_id: participantId, invite_token: inv.invite_token, summary_id: summaryId, evolution_id: evolutionId, facts: factIds.length, sessions: SESSIONS.length }, null, 2));
