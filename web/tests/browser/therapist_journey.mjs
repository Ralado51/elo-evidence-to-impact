#!/usr/bin/env node
/**
 * S1-03 Therapist Journey End-to-End Browser Harness (J).
 *
 * Runs web/v3/therapist.html against a live loopback Python /api/v3 FastAPI server
 * in real headless Chromium (playwright-core) in two full passes:
 *   1. Pointer pass (+ Row 3 review-gate UI & forced API errors + Row 9 authz checks)
 *   2. Keyboard-only pass (zero pointer events: Tab / Shift+Tab / Enter / Space / type)
 *
 * Verifies ACCEPTANCE Rows 1, 2, 3, 4, 5, 7, 8, and 9.
 * Exits 0 iff every check passes; prints deterministic JSON summary to stdout.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hashCanonical } from "../../v3/canonical.mjs";
import { scanForbiddenOutputs } from "../../v3/therapist_model.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "..");
const V3_DIR = path.join(WEB_DIR, "v3");
const REPO_ROOT = path.resolve(WEB_DIR, "..");
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  "contracts",
  "CL06_3-r1",
  "contracts",
  "api",
  "api-contract.v3.json"
);

const THERAPIST_A = {
  therapist_id: "t_s103therapistA",
  username: "terapeuta_sintetico_a",
  password: "senha-sintetica-a-2026",
  org_id: "o_s103demo001",
  display_label: "Terapeuta Sintético A",
};

const THERAPIST_B = {
  therapist_id: "t_s103therapistB",
  username: "terapeuta_sintetico_b",
  password: "senha-sintetica-b-2026",
  org_id: "o_s103demo001",
  display_label: "Terapeuta Sintético B",
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function resolvePlaywrightDir() {
  return (
    process.env.ELO_PLAYWRIGHT_DIR ||
    process.env.PW ||
    path.join(os.homedir(), "hackathons", "elo-platform", "workspace", "tools", "playwright")
  );
}

function resolvePythonBin() {
  if (process.env.ELO_PYTHON) {
    return process.env.ELO_PYTHON;
  }
  const candidates = [
    path.join(os.homedir(), "hackathons", "elo-platform", "workspace", "scratch", "S1-03", "venv", "bin", "python3"),
    path.join(os.homedir(), "hackathons", "elo-platform", "workspace", "scratch", "S1-01", "venv", "bin", "python3"),
    path.join(REPO_ROOT, "api", ".venv", "bin", "python3"),
    path.join(REPO_ROOT, ".venv", "bin", "python3"),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      return cand;
    }
  }
  return "python3";
}

async function loadPlaywright() {
  const pwDir = resolvePlaywrightDir();
  const entry = path.join(pwDir, "node_modules", "playwright-core", "index.mjs");
  const entryCjs = path.join(pwDir, "node_modules", "playwright-core", "index.js");
  const target = fs.existsSync(entry) ? entry : entryCjs;
  if (!fs.existsSync(target)) {
    throw new Error(`playwright-core not found under ${pwDir}`);
  }
  const mod = await import(pathToFileURL(target).href);
  return mod.default || mod;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function loadContractMatchers() {
  const raw = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8"));
  return raw.endpoints.map((ep) => {
    const regexStr =
      "^" +
      ep.path.replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
        ch === "{" || ch === "}" ? ch : `\\${ch}`
      ).replace(/\{[^}]+\}/g, "[^/]+") +
      "$";
    return {
      id: ep.id,
      method: ep.method.toUpperCase(),
      pathTemplate: ep.path,
      regex: new RegExp(regexStr),
    };
  });
}

function matchContractEndpoint(matchers, method, pathname) {
  const upper = method.toUpperCase();
  return matchers.find((m) => m.method === upper && m.regex.test(pathname)) || null;
}

async function startPythonApi() {
  const apiPort = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "elo-s103-api-"));
  const pythonBin = resolvePythonBin();
  const seeds = JSON.stringify([THERAPIST_A, THERAPIST_B]);

  const stderrChunks = [];
  const child = spawn(
    pythonBin,
    [
      "-m",
      "uvicorn",
      "--factory",
      "elo.api:app_factory",
      "--host",
      "127.0.0.1",
      "--port",
      String(apiPort),
      "--log-level",
      "warning",
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PYTHONPATH: process.env.PYTHONPATH
          ? `${path.join(REPO_ROOT, "api", "src")}${path.delimiter}${process.env.PYTHONPATH}`
          : path.join(REPO_ROOT, "api", "src"),
        ELO_DATA_DIR: dataDir,
        ELO_V3_DATA_ORIGIN: "synthetic_fixture",
        ELO_V3_THERAPIST_SEEDS: seeds,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child.stderr.on("data", (buf) => stderrChunks.push(buf.toString("utf8")));

  const apiBase = `http://127.0.0.1:${apiPort}`;
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Python API exited early (${child.exitCode}): ${stderrChunks.join("")}`
      );
    }
    try {
      const res = await fetch(`${apiBase}/api/v3/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // Wait for uvicorn startup.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!ready) {
    child.kill("SIGTERM");
    throw new Error(`Timed out waiting for Python API at ${apiBase}: ${stderrChunks.join("")}`);
  }

  return {
    apiBase,
    apiPort,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 250));
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Loopback gateway serving ONLY /v3/* from web/v3 and reverse-proxying /api/v3/* to apiBase.
 */
async function startGateway(apiBase) {
  const recordedRequests = [];

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = reqUrl.pathname;
    const method = (req.method || "GET").toUpperCase();

    if (pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyBuf = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

      const forwardHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() === "host" || k.toLowerCase() === "content-length") continue;
        if (typeof v === "string") forwardHeaders[k] = v;
      }

      try {
        const upstream = await fetch(`${apiBase}${reqUrl.pathname}${reqUrl.search}`, {
          method,
          headers: forwardHeaders,
          body: method === "GET" || method === "HEAD" ? undefined : bodyBuf,
        });
        const respBuf = Buffer.from(await upstream.arrayBuffer());
        recordedRequests.push({
          layer: "gateway",
          method,
          pathname,
          status: upstream.status,
        });
        const outHeaders = {};
        upstream.headers.forEach((val, key) => {
          if (key.toLowerCase() === "transfer-encoding") return;
          outHeaders[key] = val;
        });
        res.writeHead(upstream.status, outHeaders);
        res.end(respBuf);
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "BAD_GATEWAY", message: String(err) } }));
      }
      return;
    }

    if (pathname.startsWith("/s2/arq08/")) {
      // S2: exact allowlist of ARQ-08 modules imported by the participant app (no camera.mjs, no tests, no counter.js)
      const name = pathname.slice("/s2/arq08/".length);
      const ok = ["activity_runner.mjs", "simulation_source.mjs", "capture_events.mjs", "protocol.mjs", "motion.mjs", "c04_engine.mjs", "camera_session.mjs", "camera.mjs"].includes(name);
      const fp = path.join(WEB_DIR, "s2", "arq08", name);
      if (!ok || !fs.existsSync(fp)) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(fs.readFileSync(fp));
      return;
    }

    if (pathname.startsWith("/v3/")) {
      const rel = pathname.slice("/v3/".length);
      const filePath = path.resolve(V3_DIR, rel);
      if (!filePath.startsWith(V3_DIR + path.sep) && filePath !== V3_DIR) {
        recordedRequests.push({ layer: "gateway", method, pathname, status: 403 });
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        recordedRequests.push({ layer: "gateway", method, pathname, status: 404 });
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      recordedRequests.push({ layer: "gateway", method, pathname, status: 200 });
      res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
      res.end(fs.readFileSync(filePath));
      return;
    }

    recordedRequests.push({ layer: "gateway", method, pathname, status: 404 });
    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    recordedRequests,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function apiJson(base, method, pathname, token, body) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data, headers: res.headers };
}

/**
 * Build and upload 2 synthetic report-only sessions for participantId so verified facts
 * F02, F03, F04 (including an assistance transition some -> none) exist on the live API.
 */
async function seedReportOnlySessions(apiBase, therapistToken, participantId, orgId, rxId, rxRev) {
  const invRes = await apiJson(apiBase, "POST", "/api/v3/invites", therapistToken, {
    participant_id: participantId,
    ttl_seconds: 3600,
  });
  assert.equal(invRes.status, 201, `invites.create failed: ${JSON.stringify(invRes.data)}`);

  const authRes = await apiJson(apiBase, "POST", "/api/v3/auth/invite", null, {
    invite_token: invRes.data.invite_token,
  });
  assert.equal(authRes.status, 200, `auth.invite failed: ${JSON.stringify(authRes.data)}`);
  const participantToken = authRes.data.token;

  async function buildEvent({ streamId, seq, prevHash, occurredAt, type, sessionId, payload }) {
    const eventId = await hashCanonical({ seq, stream_id: streamId });
    const evNoHash = {
      event_id: eventId,
      schema_version: 3,
      type,
      stream_id: streamId,
      seq,
      prev_hash: prevHash,
      occurred_at: occurredAt,
      actor: { role: "participant", id: participantId },
      scope: {
        org_id: orgId,
        participant_id: participantId,
        session_id: sessionId,
        prescription_id: rxId,
        prescription_revision: rxRev,
        exercise_id: "organizar-a-mesa",
      },
      source: { type: "participant_report", device_hint: "desktop-chrome" },
      execution_mode: "report_only",
      data_origin: "synthetic_fixture",
      payload,
    };
    const evHash = await hashCanonical(evNoHash);
    return { ...evNoHash, hash: evHash };
  }

  const sessionsSpec = [
    {
      sessionId: `s_s103a${Date.now().toString(36)}1`,
      t1: "2026-10-05T13:00:00.000Z",
      t2: "2026-10-05T13:05:00.000Z",
      t3: "2026-10-05T13:06:00.000Z",
      assistance: "some",
    },
    {
      sessionId: `s_s103b${Date.now().toString(36)}2`,
      t1: "2026-10-08T13:00:00.000Z",
      t2: "2026-10-08T13:05:00.000Z",
      t3: "2026-10-08T13:06:00.000Z",
      assistance: "none",
    },
  ];

  const batchEvents = [];
  let lastSessionHead = null;
  for (const spec of sessionsSpec) {
    const streamId = `session:${spec.sessionId}`;
    const ev1 = await buildEvent({
      streamId,
      seq: 1,
      prevHash: null,
      occurredAt: spec.t1,
      type: "session.started",
      sessionId: spec.sessionId,
      payload: {
        source_mode: "report_only",
        prescription_id: rxId,
        prescription_revision: rxRev,
        capture_context: null,
      },
    });
    const ev2 = await buildEvent({
      streamId,
      seq: 2,
      prevHash: ev1.hash,
      occurredAt: spec.t2,
      type: "session.control",
      sessionId: spec.sessionId,
      payload: {
        action: "end",
        interrupt_reason: null,
      },
    });
    const ev3 = await buildEvent({
      streamId,
      seq: 3,
      prevHash: ev2.hash,
      occurredAt: spec.t3,
      type: "report.submitted",
      sessionId: spec.sessionId,
      payload: {
        execution: "complete",
        assistance: spec.assistance,
        reporter_role: "participant",
      },
    });
    batchEvents.push(ev1, ev2, ev3);
    lastSessionHead = {
      sessionId: spec.sessionId,
      streamId,
      lastSeq: 3,
      lastHash: ev3.hash,
    };
  }

  // Sort by (stream_id, seq) ascending per events:batch contract
  batchEvents.sort((a, b) =>
    a.stream_id < b.stream_id ? -1 : a.stream_id > b.stream_id ? 1 : a.seq - b.seq
  );

  const batchRes = await apiJson(apiBase, "POST", "/api/v3/events:batch", participantToken, {
    events: batchEvents,
  });
  assert.equal(batchRes.status, 200, `events:batch failed: ${JSON.stringify(batchRes.data)}`);
  for (const item of batchRes.data.results) {
    assert.equal(item.status, "stored", `Event rejected in seed batch: ${JSON.stringify(item)}`);
  }

  return { participantToken, seededSessions: sessionsSpec.length, lastSessionHead };
}

/**
 * Append a genuine later report.submitted (seq = lastSeq + 1) to an existing report-only
 * session so old F03/F04 become obsolete and new unreviewed F03/F04 derive (F1 regression).
 */
async function appendSupersedingReport(
  apiBase,
  participantToken,
  participantId,
  orgId,
  rxId,
  rxRev,
  sessionHead
) {
  const seq = sessionHead.lastSeq + 1;
  const eventId = await hashCanonical({ seq, stream_id: sessionHead.streamId });
  const evNoHash = {
    event_id: eventId,
    schema_version: 3,
    type: "report.submitted",
    stream_id: sessionHead.streamId,
    seq,
    prev_hash: sessionHead.lastHash,
    occurred_at: "2026-10-08T13:10:00.000Z",
    actor: { role: "participant", id: participantId },
    scope: {
      org_id: orgId,
      participant_id: participantId,
      session_id: sessionHead.sessionId,
      prescription_id: rxId,
      prescription_revision: rxRev,
      exercise_id: "organizar-a-mesa",
    },
    source: { type: "participant_report", device_hint: "desktop-chrome" },
    execution_mode: "report_only",
    data_origin: "synthetic_fixture",
    payload: {
      execution: "partial",
      assistance: "full",
      reporter_role: "participant",
    },
  };
  const ev = { ...evNoHash, hash: await hashCanonical(evNoHash) };
  const batchRes = await apiJson(apiBase, "POST", "/api/v3/events:batch", participantToken, {
    events: [ev],
  });
  assert.equal(batchRes.status, 200, `superseding report batch failed: ${JSON.stringify(batchRes.data)}`);
  assert.equal(batchRes.data.results[0].status, "stored");
}

function attachLoopbackGuardAndLog(context, allowedOrigin, browserRequests) {
  return context.route("**/*", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const origin = `${url.protocol}//${url.host}`;
    if (origin !== allowedOrigin) {
      route.abort("blockedbyclient");
      throw new Error(`Blocked non-loopback request from browser: ${req.url()}`);
    }
    browserRequests.push({
      method: req.method().toUpperCase(),
      pathname: url.pathname,
      url: req.url(),
    });
    route.continue();
  });
}

function assertAllBrowserRequestsValid(browserRequests, contractMatchers) {
  const calledContractIds = new Set();
  for (const req of browserRequests) {
    // S2: exact authorized ARQ-08 modules (GET, same-origin static ES modules); every other non-v3 path stays forbidden.
    if (req.method === "GET" && /^\/s2\/arq08\/(activity_runner|simulation_source|capture_events|protocol|motion|c04_engine|camera_session|camera)\.mjs$/.test(req.pathname)) continue;
    // Approved read-only index views (docs/PROPOSTA_API_CONSOLE.md): GET only, no record content.
    if (req.method === "GET" && /^\/api\/console\/v1\/participants(\/[^/]+\/publications)?$/.test(req.pathname)) continue;
    assert.equal(
      req.pathname.startsWith("/api/v1"),
      false,
      `Forbidden /api/v1 request detected: ${req.method} ${req.pathname}`
    );
    assert.equal(
      req.pathname === "/index.html" ||
        (req.pathname.startsWith("/") && !req.pathname.startsWith("/v3/") && !req.pathname.startsWith("/api/v3/")),
      false,
      `Forbidden legacy/non-v3 request detected: ${req.method} ${req.pathname}`
    );
    if (req.pathname.startsWith("/api/v3/")) {
      const matched = matchContractEndpoint(contractMatchers, req.method, req.pathname);
      assert.ok(
        matched,
        `Undeclared /api/v3 request not in api-contract.v3.json: ${req.method} ${req.pathname}`
      );
      calledContractIds.add(`${matched.id} (${matched.method} ${matched.pathTemplate})`);
    }
  }
  return Array.from(calledContractIds).sort();
}

async function assertOriginAndModeOnElements(page, itemSelector, expectedOrigin, expectedMode, label) {
  const details = await page.evaluate((sel) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    return nodes.map((node) => {
      const originEl = node.querySelector("[data-origin-label]");
      const modeEl = node.querySelector("[data-execution-mode]");
      const originVisible =
        originEl && getComputedStyle(originEl).display !== "none" && getComputedStyle(originEl).visibility !== "hidden";
      const modeVisible =
        modeEl && getComputedStyle(modeEl).display !== "none" && getComputedStyle(modeEl).visibility !== "hidden";
      return {
        originText: originVisible ? (originEl.textContent || "").trim() : "",
        modeText: modeVisible ? (modeEl.textContent || "").trim() : "",
        modeAttr: modeVisible ? modeEl.getAttribute("data-execution-mode") || "" : "",
      };
    });
  }, itemSelector);

  assert.ok(details.length > 0, `Expected >= 1 displayed ${label} matching ${itemSelector}`);
  for (const item of details) {
    assert.ok(
      item.originText.includes(expectedOrigin),
      `${label} missing visible origin label "${expectedOrigin}": got "${item.originText}"`
    );
    assert.ok(
      item.modeText.includes(expectedMode) || item.modeAttr === expectedMode,
      `${label} missing visible execution mode "${expectedMode}": got "${item.modeText}"`
    );
  }
  return details.length;
}

async function assertNoForbiddenOutputsInDom(page, phaseLabel) {
  const visibleText = await page.evaluate(() => document.body.innerText || "");
  const findings = scanForbiddenOutputs(visibleText);
  assert.deepEqual(
    findings,
    [],
    `Forbidden clinical outputs found in DOM during ${phaseLabel}: ${JSON.stringify(findings)}`
  );
}

/**
 * Keyboard-only helper (Row 7): moves focus exclusively via Tab / Shift+Tab (zero pointer events).
 */
async function tabToSelector(page, selector, maxTabs = 120) {
  const isAlready = await page.evaluate(
    (sel) => Boolean(document.activeElement && document.activeElement.matches(sel)),
    selector
  );
  if (isAlready) return;

  for (let i = 0; i < maxTabs; i += 1) {
    await page.keyboard.press("Tab");
    const matched = await page.evaluate(
      (sel) => Boolean(document.activeElement && document.activeElement.matches(sel)),
      selector
    );
    if (matched) return;
  }
  throw new Error(`Keyboard-only Tab could not reach selector: ${selector}`);
}

async function keyboardFillInput(page, selector, text) {
  await tabToSelector(page, selector);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
}

async function runPointerPass(browser, contractMatchers) {
  const api = await startPythonApi();
  const gateway = await startGateway(api.apiBase);
  const browserRequests = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await attachLoopbackGuardAndLog(context, gateway.origin, browserRequests);
    const page = await context.newPage();

    // --- Row 9(a): Unauthenticated access to protected section sends user to sign-in ---
    await page.goto(`${gateway.origin}/v3/therapist.html#sec-timeline`, { waitUntil: "load" });
    await page.waitForFunction(() => window.location.hash === "#sec-signin");
    const unauthErrCode = await page.locator("#error-banner").getAttribute("data-error-code");
    assert.equal(unauthErrCode, "UNAUTHENTICATED", "Expected UNAUTHENTICATED redirect banner");
    assert.equal(await page.locator("#error-banner").getAttribute("role"), "alert");
    assert.equal(await page.locator("#success-banner").isHidden(), true);
    const unauthApiCalls = browserRequests.filter((r) => r.pathname.startsWith("/api/"));
    assert.equal(unauthApiCalls.length, 0, "Unauthenticated view must make zero protected API calls");

    // --- Step 1: Sign in as therapist A ---
    await page.fill("#signin-username", THERAPIST_A.username);
    await page.fill("#signin-password", THERAPIST_A.password);
    await page.click("#btn-signin");
    await page.waitForSelector("#signin-result:not([hidden])");
    assert.ok((await page.locator("#signin-result").textContent()).includes(THERAPIST_A.therapist_id));

    const sessionA = await page.evaluate(() =>
      JSON.parse(window.sessionStorage.getItem("elo_v3_therapist_session") || "null")
    );
    assert.ok(sessionA && sessionA.token, "Therapist A token must be stored in sessionStorage");

    // --- Step 2: Register and link participant ---
    await page.fill("#participant-alias", "Participante Sintetico Ponteiro");
    await page.selectOption("#participant-side", "right");
    await page.click("#btn-create-participant");
    await page.waitForSelector("#participant-result:not([hidden])");
    const participantId = await page.locator("#active-participant-id").inputValue();
    assert.match(participantId, /^p_[A-Za-z0-9-]{8,64}$/);
    const partResultText = await page.locator("#participant-result").textContent();
    const careLinkMatch = partResultText.match(/cl_[A-Za-z0-9-]{8,64}/);
    assert.ok(careLinkMatch, `Expected care_link_id in UI result: ${partResultText}`);
    const careLinkId = careLinkMatch[0];

    // Live API verification of Step 2
    const pVer = await apiJson(api.apiBase, "GET", `/api/v3/entities/${participantId}/versions`, sessionA.token);
    assert.equal(pVer.status, 200);
    assert.equal(pVer.data.length, 1);
    const clVer = await apiJson(api.apiBase, "GET", `/api/v3/entities/${careLinkId}/versions`, sessionA.token);
    assert.equal(clVer.status, 200);
    assert.equal(clVer.data[0].payload.status, "active");

    // --- Step 3: Record functional assessment ---
    await page.click("#btn-create-assessment");
    await page.waitForSelector("#assessment-result:not([hidden])");
    const assessRes = await apiJson(
      api.apiBase,
      "GET",
      `/api/v3/participants/${participantId}/assessments`,
      sessionA.token
    );
    assert.equal(assessRes.status, 200);
    assert.equal(assessRes.data.length, 1);

    // --- Step 4: Create functional goal ---
    await page.click("#btn-create-goal");
    await page.waitForSelector("#goal-result:not([hidden])");
    const goalsRes = await apiJson(
      api.apiBase,
      "GET",
      `/api/v3/participants/${participantId}/goals`,
      sessionA.token
    );
    assert.equal(goalsRes.status, 200);
    assert.equal(goalsRes.data.length, 1);

    // --- Step 5: Publish prescription (organizar-a-mesa, report-only) ---
    await page.click("#btn-publish-prescription");
    await page.waitForSelector("#prescription-result:not([hidden])");
    const rxCur = await apiJson(
      api.apiBase,
      "GET",
      `/api/v3/participants/${participantId}/prescription/current`,
      sessionA.token
    );
    assert.equal(rxCur.status, 200);
    assert.equal(rxCur.data.payload.exercise_id, "organizar-a-mesa");
    const rxId = rxCur.data.payload.prescription_id;
    const rxRev = rxCur.data.payload.revision;

    // Seed 2 synthetic report-only sessions for this participant
    const { participantToken, lastSessionHead } = await seedReportOnlySessions(
      api.apiBase,
      sessionA.token,
      participantId,
      THERAPIST_A.org_id,
      rxId,
      rxRev
    );

    // --- Step 6: Load verified facts & check Row 3 review gate + Row 4 origin/mode ---
    await page.click("#btn-load-facts");
    await page.waitForSelector("#facts-list li[data-fact-item]");
    const factCount = await page.locator("#facts-list li[data-fact-item]").count();
    assert.ok(factCount >= 6, `Expected >= 6 verified facts from 2 report-only sessions, got ${factCount}`);

    // Row 3 UI gate: Publish Summary and Publish Evolution MUST be disabled while facts are unreviewed!
    assert.equal(
      await page.locator("#btn-publish-summary").isDisabled(),
      true,
      "Row 3 violation: Publish Summary must be disabled when facts are unreviewed"
    );
    assert.equal(
      await page.locator("#btn-publish-evolution").isDisabled(),
      true,
      "Row 3 violation: Publish Evolution must be disabled when facts are unreviewed"
    );

    // Row 4: Every displayed fact shows [Dados sintéticos] and report_only
    await assertOriginAndModeOnElements(
      page,
      "#facts-list li[data-fact-item]",
      "[Dados sintéticos]",
      "report_only",
      "verified fact"
    );

    // Collect fact metadata from DOM for forced-error tests
    const domFacts = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#facts-list li[data-fact-item]")).map((li) => ({
        factId: li.getAttribute("data-fact-item"),
        factType: li.getAttribute("data-fact-type"),
        contentHash: (li.textContent.match(/content_hash:\s*([0-9a-f]{64})/) || [])[1] || "",
      }))
    );

    // Annotate first fact -> publish summary MUST remain disabled
    await page.click(`button[data-review-decision="annotate"][data-fact-id="${domFacts[0].factId}"]`);
    await page.waitForSelector("#success-banner:not([hidden])");
    assert.equal(
      await page.locator("#btn-publish-summary").isDisabled(),
      true,
      "Annotating a fact must not unlock Publish Summary"
    );

    // Reject first fact -> publish summary MUST remain disabled
    await page.click(`button[data-review-decision="reject"][data-fact-id="${domFacts[0].factId}"]`);
    await page.waitForSelector("#success-banner:not([hidden])");
    assert.equal(
      await page.locator("#btn-publish-summary").isDisabled(),
      true,
      "Rejecting a fact must not unlock Publish Summary"
    );

    // Approve all facts EXCEPT the last one (keep last fact unreviewed for forced UNREVIEWED_FACT_IN_EVOLUTION)
    const unreviewedFact = domFacts[domFacts.length - 1];
    const approvedFacts = domFacts.slice(0, -1);
    for (const f of approvedFacts) {
      await page.click(`button[data-review-decision="approve"][data-fact-id="${f.factId}"]`);
      await page.waitForSelector(
        `li[data-fact-item="${f.factId}"] [data-review-status="approved"]`
      );
    }

    assert.equal(
      await page.locator("#btn-publish-summary").isDisabled(),
      false,
      "Publish Summary must enable once eligible facts are approved"
    );

    // --- Row 3 forced API error #1: CONTENT_HASH_STALE on POST /api/v3/summaries (real API response!) ---
    await page.route("**/api/v3/summaries", async (route) => {
      if (route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        body.items[0].content_hash = "0".repeat(64);
        await route.continue({ postData: JSON.stringify(body) });
      } else {
        await route.continue();
      }
    }, { times: 1 });
    await page.click("#btn-publish-summary");
    await page.waitForSelector('#error-banner[data-error-code="CONTENT_HASH_STALE"]:not([hidden])');
    assert.equal(await page.locator("#error-banner").getAttribute("role"), "alert");
    assert.equal(await page.locator("#success-banner").isHidden(), true, "No success may be shown on CONTENT_HASH_STALE");
    assert.equal(await page.locator("#elo-live-region").getAttribute("aria-live"), "assertive");
    { // S1 Etapa E: the announcement is a friendly message (no internal code); the code stays in data-error-code.
      const live = await page.locator("#elo-live-region").textContent();
      assert.ok(live.trim().length > 10 && !live.includes("CONTENT_HASH_STALE"), `live region must be a friendly message: ${live}`);
    }

    // --- Step 7a: Publish Summary cleanly ---
    await page.click("#btn-publish-summary");
    await page.waitForSelector("#summary-result [data-published-summary]");
    const summaryId = await page.locator("#summary-result [data-published-summary]").getAttribute("data-published-summary");
    assert.match(summaryId, /^sum_[A-Za-z0-9-]{8,64}$/);
    await assertOriginAndModeOnElements(
      page,
      "#summary-result [data-published-summary]",
      "[Dados sintéticos]",
      "not_applicable",
      "published summary"
    );
    await assertOriginAndModeOnElements(
      page,
      "#summary-result [data-summary-fact-item]",
      "[Dados sintéticos]",
      "report_only",
      "summary included fact"
    );
    const sumGet = await apiJson(api.apiBase, "GET", `/api/v3/summaries/${summaryId}`, sessionA.token);
    assert.equal(sumGet.status, 200);

    // --- Step 7b: Load comparable evolution series ---
    await page.click("#btn-load-evolution-series");
    await page.waitForSelector("#evolution-series-container [data-evolution-series]");
    await assertOriginAndModeOnElements(
      page,
      "#evolution-series-container [data-evolution-item]",
      "[Dados sintéticos]",
      "report_only",
      "evolution series item"
    );

    // --- Row 3 forced API error #2: UNREVIEWED_FACT_IN_EVOLUTION (real API response!) ---
    await page.route("**/api/v3/evolution", async (route) => {
      if (route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        const evoRes = await apiJson(
          api.apiBase,
          "GET",
          `/api/v3/participants/${participantId}/evolution/series`,
          sessionA.token
        );
        const firstHash = evoRes.data.series[0].series_key_hash;
        const mutated = {
          participant_id: body.participant_id,
          period: body.period,
          series: [
            {
              series_key_hash: firstHash,
              items: [{ fact_id: unreviewedFact.factId, content_hash: unreviewedFact.contentHash }],
            },
          ],
        };
        await route.continue({ postData: JSON.stringify(mutated) });
      } else {
        await route.continue();
      }
    }, { times: 1 });
    await page.click("#btn-publish-evolution");
    await page.waitForSelector('#error-banner[data-error-code="UNREVIEWED_FACT_IN_EVOLUTION"]:not([hidden])');
    assert.equal(await page.locator("#error-banner").getAttribute("role"), "alert");
    assert.equal(await page.locator("#success-banner").isHidden(), true);
    { // S1 Etapa E: the announcement is a friendly message (no internal code); the code stays in data-error-code.
      const live = await page.locator("#elo-live-region").textContent();
      assert.ok(live.trim().length > 10 && !live.includes("UNREVIEWED_FACT_IN_EVOLUTION"), `live region must be a friendly message: ${live}`);
    }

    // --- Row 3 forced API error #3: COMPARABILITY_VIOLATION (real API response: mix F02 + F03 in one series) ---
    const f02Approved = approvedFacts.find((f) => f.factType === "F02");
    const f03Approved = approvedFacts.find((f) => f.factType === "F03");
    assert.ok(f02Approved && f03Approved, "Need approved F02 and F03 for COMPARABILITY_VIOLATION check");
    await page.route("**/api/v3/evolution", async (route) => {
      if (route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        const evoRes = await apiJson(
          api.apiBase,
          "GET",
          `/api/v3/participants/${participantId}/evolution/series`,
          sessionA.token
        );
        const f02Series = evoRes.data.series.find((s) => s.series_key.fact_type === "F02");
        const mutated = {
          participant_id: body.participant_id,
          period: body.period,
          series: [
            {
              series_key_hash: f02Series.series_key_hash,
              items: [
                { fact_id: f02Approved.factId, content_hash: f02Approved.contentHash },
                { fact_id: f03Approved.factId, content_hash: f03Approved.contentHash },
              ],
            },
          ],
        };
        await route.continue({ postData: JSON.stringify(mutated) });
      } else {
        await route.continue();
      }
    }, { times: 1 });
    await page.click("#btn-publish-evolution");
    await page.waitForSelector('#error-banner[data-error-code="COMPARABILITY_VIOLATION"]:not([hidden])');
    assert.equal(await page.locator("#error-banner").getAttribute("role"), "alert");
    assert.equal(await page.locator("#success-banner").isHidden(), true);
    { // S1 Etapa E: the announcement is a friendly message (no internal code); the code stays in data-error-code.
      const live = await page.locator("#elo-live-region").textContent();
      assert.ok(live.trim().length > 10 && !live.includes("COMPARABILITY_VIOLATION"), `live region must be a friendly message: ${live}`);
    }

    // Approve remaining fact, reload comparable series, and verify F1 stale-refresh gate:
    // Append a genuine later report that invalidates 2 cached F03/F04 facts, refresh facts,
    // verify obsolete evolution cards are cleared and Publish Evolution is disabled until
    // the newly derived facts are approved and series are reloaded.
    await page.click(`button[data-review-decision="approve"][data-fact-id="${unreviewedFact.factId}"]`);
    await page.waitForSelector(`li[data-fact-item="${unreviewedFact.factId}"] [data-review-status="approved"]`);
    await page.click("#btn-load-evolution-series");
    await page.waitForSelector("#evolution-series-container [data-evolution-series]");
    assert.equal(await page.locator("#btn-publish-evolution").isDisabled(), false);

    await appendSupersedingReport(
      api.apiBase,
      participantToken,
      participantId,
      THERAPIST_A.org_id,
      rxId,
      rxRev,
      lastSessionHead
    );
    await page.click("#btn-load-facts");
    await page.waitForSelector('#facts-list [data-review-status="unreviewed"]');
    assert.equal(
      await page.locator("#evolution-series-container [data-evolution-series]").count(),
      0,
      "F1 regression: refreshing facts must clear cached obsolete evolution series cards"
    );
    assert.equal(
      await page.locator("#btn-publish-evolution").isDisabled(),
      true,
      "F1 regression: Publish Evolution must be disabled after fact refresh invalidates cached series"
    );

    // Approve the newly derived unreviewed facts, reload comparable series, and publish evolution cleanly
    const refreshedUnreviewedIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#facts-list li[data-fact-item]"))
        .filter((li) => li.querySelector('[data-review-status="unreviewed"]'))
        .map((li) => li.getAttribute("data-fact-item"))
    );
    assert.equal(refreshedUnreviewedIds.length, 2, "Expected 2 newly derived unreviewed facts (F03/F04)");
    for (const fid of refreshedUnreviewedIds) {
      await page.click(`button[data-review-decision="approve"][data-fact-id="${fid}"]`);
      await page.waitForSelector(`li[data-fact-item="${fid}"] [data-review-status="approved"]`);
    }
    await page.click("#btn-load-evolution-series");
    await page.waitForSelector("#evolution-series-container [data-evolution-series]");
    await page.click("#btn-publish-evolution");
    await page.waitForSelector("#evolution-result [data-published-evolution]");
    const evolutionId = await page
      .locator("#evolution-result [data-published-evolution]")
      .getAttribute("data-published-evolution");
    assert.match(evolutionId, /^evo_[A-Za-z0-9-]{8,64}$/);
    await assertOriginAndModeOnElements(
      page,
      "#evolution-result [data-published-evolution]",
      "[Dados sintéticos]",
      "not_applicable",
      "published evolution"
    );
    await assertOriginAndModeOnElements(
      page,
      "#evolution-result [data-published-evolution-item]",
      "[Dados sintéticos]",
      "report_only",
      "published evolution item"
    );
    const evoGet = await apiJson(api.apiBase, "GET", `/api/v3/evolution/${evolutionId}`, sessionA.token);
    assert.equal(evoGet.status, 200);

    // --- Step 8: Load participant timeline ---
    await page.click("#btn-load-timeline");
    await page.waitForSelector("#timeline-list li[data-timeline-item]");
    const timelineKinds = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#timeline-list li[data-timeline-item]")).map((li) =>
        li.getAttribute("data-timeline-kind")
      )
    );
    for (const expectedKind of [
      "functional_assessment",
      "goal",
      "prescription.published",
      "summary.published",
      "evolution.published",
    ]) {
      assert.ok(
        timelineKinds.includes(expectedKind),
        `Timeline missing expected kind "${expectedKind}": got ${JSON.stringify(timelineKinds)}`
      );
    }
    await assertOriginAndModeOnElements(
      page,
      "#timeline-list li[data-timeline-item]",
      "[Dados sintéticos]",
      "not_applicable",
      "timeline item"
    );

    // Row 5: Zero forbidden clinical outputs anywhere in DOM
    await assertNoForbiddenOutputsInDom(page, "pointer pass after Step 8");

    // --- Row 9(b): Participant token rejected with 403 FORBIDDEN & accessible denial in UI ---
    await page.evaluate(
      ({ ptok, pid }) => {
        window.sessionStorage.setItem(
          "elo_v3_therapist_session",
          JSON.stringify({
            token: ptok,
            expires_at: "2099-01-01T00:00:00.000Z",
            principal: { role: "participant", id: pid, org_id: "o_s103demo001" },
          })
        );
      },
      { ptok: participantToken, pid: participantId }
    );
    await page.reload({ waitUntil: "load" });
    // S1 correção A (D05/FIX-04): selection is validated against the authorized list, so the denial happens at selection.
    await page.evaluate(() => { document.getElementById("technical-select").open = true; });
    await page.fill("#active-participant-id", participantId);
    await page.click("#btn-select-participant");
    await page.waitForSelector('#error-banner[data-error-code="FORBIDDEN"]:not([hidden])');
    assert.equal(await page.locator("#error-banner").getAttribute("role"), "alert");
    assert.equal(await page.locator("#success-banner").isHidden(), true);

    // --- Row 9(c): Unlinked therapist B rejected with 403 SCOPE_VIOLATION / 404 & accessible denial ---
    await page.click("#btn-signout");
    await page.fill("#signin-username", THERAPIST_B.username);
    await page.fill("#signin-password", THERAPIST_B.password);
    await page.click("#btn-signin");
    await page.waitForSelector("#signin-result:not([hidden])");
    await page.evaluate(() => { document.getElementById("technical-select").open = true; });
    await page.fill("#active-participant-id", participantId);
    await page.click("#btn-select-participant");
    await page.waitForSelector("#error-banner:not([hidden])");
    assert.equal(await page.locator("#btn-create-invite").isDisabled(), true, "unauthorized id must not become the active participant");
    const unlinkCode = await page.locator("#error-banner").getAttribute("data-error-code");
    assert.ok(
      unlinkCode === "SCOPE_VIOLATION" || unlinkCode === "NOT_FOUND" || unlinkCode === "FORBIDDEN",
      `Expected SCOPE_VIOLATION/NOT_FOUND/FORBIDDEN for unlinked therapist, got ${unlinkCode}`
    );
    assert.equal(await page.locator("#error-banner").getAttribute("role"), "alert");
    assert.equal(await page.locator("#success-banner").isHidden(), true);

    await context.close();
    const calledRoutes = assertAllBrowserRequestsValid(browserRequests, contractMatchers);

    return {
      passed: true,
      participant_id: participantId,
      care_link_id: careLinkId,
      summary_id: summaryId,
      evolution_id: evolutionId,
      timeline_items: timelineKinds.length,
      forced_errors_verified: [
        "CONTENT_HASH_STALE",
        "UNREVIEWED_FACT_IN_EVOLUTION",
        "COMPARABILITY_VIOLATION",
      ],
      authz_checks_verified: [
        "unauthenticated_redirect_to_signin",
        "participant_token_403_forbidden",
        `unlinked_therapist_${unlinkCode.toLowerCase()}`,
      ],
      called_contract_routes: calledRoutes,
    };
  } finally {
    await gateway.stop();
    await api.stop();
  }
}

async function runKeyboardOnlyPass(browser, contractMatchers) {
  const api = await startPythonApi();
  const gateway = await startGateway(api.apiBase);
  const browserRequests = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await attachLoopbackGuardAndLog(context, gateway.origin, browserRequests);
    const page = await context.newPage();

    // ZERO pointer events allowed in this pass (no click, tap, hover, mouse.*).
    await page.goto(`${gateway.origin}/v3/therapist.html`, { waitUntil: "load" });

    // Step 1: Sign in strictly by keyboard
    await keyboardFillInput(page, "#signin-username", THERAPIST_A.username);
    await keyboardFillInput(page, "#signin-password", THERAPIST_A.password);
    await tabToSelector(page, "#btn-signin");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#signin-result:not([hidden])");

    const sessionA = await page.evaluate(() =>
      JSON.parse(window.sessionStorage.getItem("elo_v3_therapist_session") || "null")
    );
    assert.ok(sessionA && sessionA.token);

    // Step 2: Register and link participant strictly by keyboard
    await keyboardFillInput(page, "#participant-alias", "Participante Sintetico Teclado");
    await tabToSelector(page, "#btn-create-participant");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#participant-result:not([hidden])");
    const participantId = await page.locator("#active-participant-id").inputValue();
    assert.match(participantId, /^p_[A-Za-z0-9-]{8,64}$/);

    // Step 3: Record functional assessment strictly by keyboard
    await tabToSelector(page, "#btn-create-assessment");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#assessment-result:not([hidden])");

    // Step 4: Set goal strictly by keyboard
    await tabToSelector(page, "#btn-create-goal");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#goal-result:not([hidden])");

    // Step 5: Publish prescription strictly by keyboard
    await tabToSelector(page, "#btn-publish-prescription");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#prescription-result:not([hidden])");

    const rxCur = await apiJson(
      api.apiBase,
      "GET",
      `/api/v3/participants/${participantId}/prescription/current`,
      sessionA.token
    );
    assert.equal(rxCur.status, 200);
    await seedReportOnlySessions(
      api.apiBase,
      sessionA.token,
      participantId,
      THERAPIST_A.org_id,
      rxCur.data.payload.prescription_id,
      rxCur.data.payload.revision
    );

    // Step 6: Load facts & approve all facts strictly by keyboard
    await tabToSelector(page, "#btn-load-facts");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#facts-list li[data-fact-item]");

    assert.equal(await page.locator("#btn-publish-summary").isDisabled(), true);
    assert.equal(await page.locator("#btn-publish-evolution").isDisabled(), true);

    const factIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#facts-list li[data-fact-item]")).map((li) =>
        li.getAttribute("data-fact-item")
      )
    );
    assert.ok(factIds.length >= 6);

    for (const fid of factIds) {
      await tabToSelector(page, `button[data-review-decision="approve"][data-fact-id="${fid}"]`, 200);
      await page.keyboard.press("Enter");
      await page.waitForSelector(`li[data-fact-item="${fid}"] [data-review-status="approved"]`);
    }

    // Step 7a: Publish summary strictly by keyboard
    await tabToSelector(page, "#btn-publish-summary", 200);
    await page.keyboard.press("Enter");
    await page.waitForSelector("#summary-result [data-published-summary]");

    // Step 7b: Load series & publish evolution strictly by keyboard
    await tabToSelector(page, "#btn-load-evolution-series", 200);
    await page.keyboard.press("Enter");
    await page.waitForSelector("#evolution-series-container [data-evolution-series]");

    await tabToSelector(page, "#btn-publish-evolution", 200);
    await page.keyboard.press("Enter");
    await page.waitForSelector("#evolution-result [data-published-evolution]");

    // Step 8: Load timeline strictly by keyboard
    await tabToSelector(page, "#btn-load-timeline", 200);
    await page.keyboard.press("Enter");
    await page.waitForSelector("#timeline-list li[data-timeline-item]");

    const timelineCount = await page.locator("#timeline-list li[data-timeline-item]").count();
    assert.ok(timelineCount >= 5);

    await assertOriginAndModeOnElements(
      page,
      "#timeline-list li[data-timeline-item]",
      "[Dados sintéticos]",
      "not_applicable",
      "keyboard-pass timeline item"
    );
    await assertNoForbiddenOutputsInDom(page, "keyboard-only pass after Step 8");

    await context.close();
    const calledRoutes = assertAllBrowserRequestsValid(browserRequests, contractMatchers);

    return {
      passed: true,
      pointer_events_used: 0,
      participant_id: participantId,
      facts_approved: factIds.length,
      timeline_items: timelineCount,
      called_contract_routes: calledRoutes,
    };
  } finally {
    await gateway.stop();
    await api.stop();
  }
}

async function main() {
  const contractMatchers = loadContractMatchers();
  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });

  try {
    const pointerPass = await runPointerPass(browser, contractMatchers);
    const keyboardPass = await runKeyboardOnlyPass(browser, contractMatchers);

    const allRoutes = Array.from(
      new Set([
        ...pointerPass.called_contract_routes,
        ...keyboardPass.called_contract_routes,
      ])
    ).sort();

    const report = {
      passed: pointerPass.passed && keyboardPass.passed,
      task: "S1-03",
      page: "/v3/therapist.html",
      pointer_pass: {
        passed: pointerPass.passed,
        timeline_items: pointerPass.timeline_items,
        forced_errors_verified: pointerPass.forced_errors_verified,
        authz_checks_verified: pointerPass.authz_checks_verified,
      },
      keyboard_pass: {
        passed: keyboardPass.passed,
        pointer_events_used: keyboardPass.pointer_events_used,
        facts_approved: keyboardPass.facts_approved,
        timeline_items: keyboardPass.timeline_items,
      },
      called_contract_routes: allRoutes,
    };

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.passed ? 0 : 1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ passed: false, error: err?.stack || String(err) }, null, 2));
  process.exit(1);
});
