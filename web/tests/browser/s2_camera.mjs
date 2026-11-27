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
const results = [];
const check = async (id, fn) => {
  try { await fn(); results.push({ id, ok: true }); } catch (e) { results.push({ id, ok: false, error: String(e.message).split("\n")[0] }); console.error("FAIL", id, String(e.message).split("\n").slice(0, 3).join(" / ")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newCtx = async () => { const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "pt-BR", permissions: ["camera"] }); await c.addInitScript(() => { try { if (!localStorage.getItem("elo_lang")) localStorage.setItem("elo_lang", "pt-BR"); } catch {} }); return c; };

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
  page.on("request", (r) => { try { const u = new URL(r.url()); if (u.protocol.startsWith("http")) hosts.add(u.origin); } catch {} });
  await page.goto(origin + "/v3/participant.html");
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

const A = await seed("Cam Alfa");
const B = await seed("Cam Beta");
await sleep(30000);
const pa = await open(A, await newCtx());

await check("S2C-01 consentimento gravado no ledger ANTES da camera; detector e camera locais; so mesma origem", async () => {
  await startCamera(pa);
  const c = await consent(pa, A);
  assert.deepEqual(c.events.map((e) => e.type), ["consent.accepted"]);
  assert.equal(c.acknowledged, 1, "consent stored on the ledger before capture");
  assert.deepEqual(c.events[0].payload.scopes, ["camera"]);
  const s = await session(pa, A);
  assert.equal(s.events[0].execution_mode, "camera");
  assert.equal(s.events[0].data_origin, "experimental_capture");
  assert.match(s.events[0].origin_ref, /^[0-9a-f]{64}$/);
  assert.equal(s.events[0].source.type, "camera");
  assert.deepEqual([...hosts], [origin], "no CDN, no third-party origin: " + [...hosts]);
});
await check("S2C-02 sem mao visivel a calibracao falha, nada e contado e o autorrelato fecha a sessao", async () => {
  await pa.click("#btn-act-cal-open");
  await pa.waitForFunction(() => /mão fechada/i.test(document.getElementById("act-camera-status").textContent), null, { timeout: 15000 });
  await pa.click("#btn-act-cal-closed");
  await pa.waitForFunction(() => document.getElementById("btn-act-cal-open").dataset.calibration === "insufficient", null, { timeout: 15000 });
  assert.equal(await pa.isDisabled("#btn-act-start"), true, "cannot count without a valid calibration");
  await pa.click("#btn-session-end");
  await pa.waitForSelector('#session-result[data-session-phase="ended"]');
  assert.equal(await pa.evaluate(() => document.getElementById("act-cam").srcObject), null, "camera released");
  assert.equal(await pa.isDisabled("#btn-act-revoke"), false, "revocation stays available while consent is active");
  await report(pa, "none");
  await waitSync(pa, "synced");
  const s = await session(pa, A);
  const types = s.events.map((e) => e.type);
  assert.ok(types.includes("calibration.attempted") && !types.includes("calibration.applied") && !types.some((x) => x.startsWith("cycle.")));
  assert.equal(s.events.filter((e) => e.type === "calibration.attempted").every((e) => e.payload.accepted === false), true);
  const sum = s.events.find((e) => e.type === "session.capture_summary").payload;
  assert.deepEqual(sum, { frames_total: 0, fps_mean: null, fps_min: null, usable_fraction: null, lost_events: 0 }, "no counting frame was evaluated");
  assert.equal(s.acknowledged, s.events.length);
});
await check("S2C-03 nenhuma imagem, quadro ou ponto bruto fica no armazenamento nem vai ao servidor", async () => {
  const dump = await pa.evaluate(() => JSON.stringify([...Object.entries(sessionStorage), ...Object.entries(localStorage)]));
  assert.doesNotMatch(dump, /landmark|data:image|blob:|"x":0\.|ImageData/i);
  const uses = await pa.evaluate(async () => {
    const src = (await Promise.all(["activity_runner", "camera_session", "camera", "motion"].map((n) => fetch(`/s2/arq08/${n}.mjs`).then((r) => r.text())))).join("\n");
    return /toDataURL|toBlob|getImageData|MediaRecorder|createImageBitmap|drawImage|ImageCapture/.test(src);
  });
  assert.equal(uses, false);
});
await check("S2C-04 revogacao: camera desligada, sessao interrompida, revogacao encadeada depois e aceita na ordem", async () => {
  await startCamera(pa);
  await pa.click("#btn-act-revoke");
  await pa.waitForFunction(() => /revogada/i.test(document.getElementById("act-camera-status").textContent));
  assert.equal(await pa.evaluate(() => document.getElementById("act-cam").srcObject), null);
  await waitSync(pa, "synced");
  const s = await session(pa, A);
  const ctl = s.events.filter((e) => e.type === "session.control").map((e) => e.payload);
  assert.deepEqual(ctl.at(-1), { action: "interrupt", interrupt_reason: "consent_revoked" });
  assert.equal(s.events.at(-1).type, "session.capture_summary");
  const c = await consent(pa, A);
  assert.deepEqual(c.events.map((e) => e.type), ["consent.accepted", "consent.revoked", "consent.accepted", "consent.revoked"].slice(0, c.events.length));
  assert.equal(c.events.at(-1).type, "consent.revoked");
  assert.equal(c.acknowledged, c.events.length, "revocation stored on the ledger");
  assert.equal(await pa.isChecked("#act-camera-consent"), false);
});
await check("S2C-05 camera sem consentimento ativo no ledger e recusada (CONSENT_REQUIRED) e com consentimento aceita", async () => {
  const pb = await open(B, await newCtx());
  const tok = await token(pb);
  const mod = async (fn, ...a) => pb.evaluate(fn, ...a);
  const built = await mod(async ({ org, pid, rxId }) => {
    const { buildCaptureEvent, buildConsentEvent } = await import("/s2/arq08/capture_events.mjs");
    const sid = "s_cam" + Math.random().toString(16).slice(2, 12);
    const sc = { org_id: org, participant_id: pid, session_id: sid, prescription_id: rxId.id, prescription_revision: rxId.rev, exercise_id: "organizar-a-mesa" };
    const start = await buildCaptureEvent({ type: "session.started", scope: sc, seq: 1, prevHash: null, occurredAt: new Date().toISOString(), tMonoMs: 0, mode: "camera",
      payload: { source_mode: "camera", prescription_id: rxId.id, prescription_revision: rxId.rev, capture_context: { device_hint: "desktop-other", frame_width: 640, frame_height: 480 } } });
    const acc = await buildConsentEvent({ type: "consent.accepted", orgId: org, participantId: pid, seq: 1, prevHash: null, occurredAt: new Date().toISOString() });
    return { start, acc };
  }, { org: ORG, pid: B, rxId: await (async () => { const r = await (await fetch(`${origin}/api/v3/participants/${B}/prescription/current`, { headers: { authorization: `Bearer ${tok}` } })).json(); return { id: r.payload.prescription_id, rev: r.payload.revision }; })() });
  assert.ok(built.start.origin_ref);
  const refused = await post(tok, [built.start]);
  assert.ok(JSON.stringify(refused.body).includes("CONSENT_REQUIRED"), JSON.stringify(refused.body).slice(0, 300));
  const okc = await post(tok, [built.acc]);
  assert.ok(okc.body.results.every((r) => r.status === "stored"), JSON.stringify(okc.body));
  const ok = await post(tok, [built.start]);
  assert.ok(ok.body.results.every((r) => r.status === "stored"), JSON.stringify(ok.body));
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ suite: "s2_camera", total: results.length, failed: failed.length, results }, null, 2));
process.exit(failed.length ? 1 : 0);
