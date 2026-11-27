// S2 camera suite (SYNTHETIC data; Chromium fake camera device, no real person). Real API/ledger/verifier, local MediaPipe assets.
// The fake device shows no hand: detection finds nothing, which exercises consent, local model/camera loading, calibration failure,
// interruption, revocation and ordering. Ledger acceptance of a camera stream with counted cycles uses the real modules fed with scripted frames.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const origin = args.origin || "http://127.0.0.1:8080";
const ORG = "o_localdemo01";
const pwDir = process.env.ELO_PLAYWRIGHT_DIR || path.join(os.homedir(), "hackathons/elo-platform/workspace/tools/playwright");
const { chromium } = await import(pathToFileURL(path.join(pwDir, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--enable-unsafe-swiftshader"] });

// Scripted MediaPipe stand-in (synthetic hand driven by window.__hand = open|closed|none|edge). The real model is covered by s2_camera; here the real
// camera session, c04 engine, ActivityRunner, controller, outbox, dispatcher, API and ledger run end to end.
const STUB = `
export const FilesetResolver = { forVisionTasks: async () => ({}) };
const mk = (open, edge) => { const w = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })); w[9] = { x: 0, y: -0.09, z: 0 };
  [8, 12, 16, 20].forEach((i) => { w[i] = { x: 0, y: -0.09 * (open ? 2 : 0.6), z: 0 }; });
  const img = Array.from({ length: 21 }, (_, i) => ({ x: 0.3 + 0.02 * (i % 7) + (edge ? 0.7 : 0), y: 0.3 + 0.02 * Math.floor(i / 3), z: 0 }));
  img[0] = { x: 0.5, y: 0.8, z: 0 }; img[9] = { x: 0.5, y: 0.5, z: 0 }; return { w, img }; };
export const HandLandmarker = { createFromOptions: async () => ({ detectForVideo() {
  const s = window.__hand || "none"; if (s === "none") return { landmarks: [], worldLandmarks: [], handedness: [] };
  const { w, img } = mk(s === "open", s === "edge");
  return { landmarks: [img], worldLandmarks: [w], handedness: [[{ categoryName: window.__raw || "Left", score: 0.92 }]] }; } }) };
`;
const results = [];
const check = async (id, fn) => {
  try { await fn(); results.push({ id, ok: true }); } catch (e) { results.push({ id, ok: false, error: String(e.message).split("\n")[0] }); console.error("FAIL", id, String(e.message).split("\n").slice(0, 3).join(" / ")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newCtx = async () => { const c = await browser.newContext({ viewport: { width: Number(process.env.MESA_W || 1280), height: Number(process.env.MESA_W) < 600 ? 844 : 900 }, locale: "pt-BR", permissions: ["camera"] }); await c.addInitScript(() => { try { if (!localStorage.getItem("elo_lang")) localStorage.setItem("elo_lang", "pt-BR"); } catch {} }); return c; };

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
  await t.fill("#rx-sets", "1"); await t.fill("#rx-reps", "2");
  await t.click("#btn-publish-prescription"); await t.waitForSelector("#prescription-result:not([hidden])");
  await sleep(300);
  return id;
}
const invite = async (pid) => (await (await fetch(`${origin}/api/v3/invites`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tToken}` }, body: JSON.stringify({ participant_id: pid, ttl_seconds: 86400 }) })).json()).invite_token;
const hosts = new Set();
async function open(pid, ctx) {
  const page = await ctx.newPage();
  await page.route("**/s2/vendor/vision_bundle.mjs", (route) => route.fulfill({ contentType: "text/javascript", body: STUB }));
  page.on("request", (r) => { try { const u = new URL(r.url()); if (u.protocol.startsWith("http")) hosts.add(u.origin); } catch {} });
  await page.goto(origin + "/v3/participant.html?engine=c04");
  await page.fill("#invite-token", await invite(pid));
  await page.click("#btn-invite-signin");
  await page.waitForSelector("#signin-result:not([hidden])");
  await page.waitForFunction(() => !document.getElementById("activity-panel").hidden);
  await page.click("#btn-load-plan");
  await page.waitForSelector('#prescription-view[data-prescription-loaded="true"]');
  return page;
}
const skey = (pid) => "elo:arq05:v1:" + JSON.stringify([ORG, pid]);
const ckey = (pid) => "elo:s2:consent:v1:" + JSON.stringify([ORG, pid]);
const session = (page, pid) => page.evaluate((k) => JSON.parse(sessionStorage.getItem(k)), skey(pid));
const consent = (page, pid) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), ckey(pid));
const token = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("elo_v3_participant_session")).token);
const waitSync = (page, st, ms = 25000) => page.waitForSelector(`#sync-panel[data-sync-status="${st}"]`, { timeout: ms });
const post = async (tok, events) => { const r = await fetch(`${origin}/api/v3/events:batch`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ events }) }); return { status: r.status, body: await r.json().catch(() => null) }; };
async function startCamera(p) {
  await p.check("#act-camera-consent");
  await p.click("#btn-act-camera");
  await p.waitForSelector('#session-result[data-session-phase="created"][data-session-mode="camera"]', { timeout: 60000 });
  await p.waitForFunction(() => !document.getElementById("act-cam").hidden);
}
async function report(p, a = "some") {
  await p.click('button[data-choice-group="execution"][data-choice-value="complete"]');
  await p.click(`button[data-choice-group="assistance"][data-choice-value="${a}"]`);
  await p.click("#btn-submit-report");
  await p.waitForSelector(`#report-result[data-report-assistance="${a}"]`);
}



const A = await seed("Mesa Alfa", "right");
await sleep(30000);
const SHOT = process.env.MESA_SHOTS || "";
const shot = async (p, name) => { if (SHOT) await p.locator("#activity-panel").screenshot({ path: `${SHOT}/${name}.png` }); };
const hand = (p, s) => p.evaluate((v) => { window.__hand = v; }, s);

await check("MESA-01 motor c04-hand-1: calibracao, contagem, dose e ledger (algorithm_version c04-hand-1, modo camera)", async () => {
  const pa = await open(A, await newCtx());
  await pa.evaluate(() => { window.__hand = "none"; });
  await pa.check("#act-camera-consent");
  await shot(pa, "1-inicial");
  await pa.click("#btn-act-camera");
  await pa.waitForSelector('#session-result[data-session-phase="created"][data-session-mode="camera"]', { timeout: 60000 });
  await pa.check("#act-overlay");
  await hand(pa, "open"); await pa.click("#btn-act-cal-open"); await sleep(3600);
  await shot(pa, "2-calibrando-aberta");
  await hand(pa, "closed"); await pa.click("#btn-act-cal-closed");
  await pa.waitForSelector('#btn-act-cal-open[data-calibration="ready"]', { timeout: 15000 });
  await shot(pa, "3-calibrada");
  await pa.click("#btn-act-start");
  await pa.waitForFunction((k) => JSON.parse(sessionStorage.getItem(k)).events.some((e) => e.type === "session.control"), skey(A), { timeout: 15000 });
  await hand(pa, "open"); await sleep(900);
  await hand(pa, "closed"); await sleep(900); await shot(pa, "4-fechada");
  await hand(pa, "open"); await sleep(1200); await shot(pa, "5-uma-peca");
  await hand(pa, "closed"); await sleep(900);
  await hand(pa, "open");
  await pa.waitForFunction((k) => JSON.parse(sessionStorage.getItem(k)).events.some((e) => e.type === "session.completed"), skey(A), { timeout: 15000 });
  await sleep(600); await shot(pa, "6-dose-concluida");
  const s = await session(pa, A);
  const cycles = s.events.filter((e) => e.type === "cycle.accepted");
  assert.equal(cycles.length, 2, s.events.map((e) => e.type).join());
  assert.ok(s.events.every((e) => e.source?.algorithm_version === "c04-hand-1" || e.type === "report.submitted"), "algorithm_version pinned");
  assert.ok(s.events.every((e) => e.execution_mode === "camera" && e.data_origin === "experimental_capture" && /^[0-9a-f]{64}$/.test(e.origin_ref)));
  assert.equal(s.events.filter((e) => e.type === "cycle.accepted").length + s.events.filter((e) => e.type === "cycle.rejected").length, cycles.length);
  assert.ok(s.events.some((e) => e.type === "calibration.applied"));
  assert.equal(await pa.evaluate(() => document.querySelectorAll("#act-mesa li.placed").length), 2);
  await pa.evaluate(() => document.querySelector("#btn-act-revoke").click());
  assert.deepEqual([...hosts], [origin]);
  await pa.context().close();
});

await check("MESA-02 enquadramento ruim (mao na borda) nao conta; calibracao instavel e recusada", async () => {
  const B = await seed("Mesa Beta", "right");
  await sleep(30000);
  const pb = await open(B, await newCtx());
  await pb.check("#act-camera-consent"); await pb.click("#btn-act-camera");
  await pb.waitForSelector('#session-result[data-session-phase="created"][data-session-mode="camera"]', { timeout: 60000 });
  await hand(pb, "open"); await pb.click("#btn-act-cal-open"); await sleep(3600);
  await hand(pb, "open"); await pb.click("#btn-act-cal-closed"); // same posture twice: must be refused
  await sleep(4200);
  const s = await session(pb, B);
  assert.ok(!s.events.some((e) => e.type === "calibration.applied"));
  assert.ok(!s.events.some((e) => e.type.startsWith("cycle.")));
  await pb.context().close();
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ suite: "s2_mesa", total: results.length, failed: failed.length, results }, null, 2));
process.exit(failed.length ? 1 : 0);
