#!/usr/bin/env node
/**
 * S1-05 Integrated End-to-End Browser Harness (E).
 *
 * Drives the complete S1 product loop in headless Chromium (playwright-core by path)
 * using ONLY web/v3 screens (/v3/therapist.html and /v3/participant.html) against a live
 * loopback Python /api/v3 FastAPI server on synthetic data:
 *
 *   Step 1: Therapist registers and links a participant, records an assessment, a goal,
 *           and publishes an "Organizar a mesa" prescription (report-only).
 *   Step 2: Participant signs in, runs two report-only sessions, and submits zero-typing reports.
 *   Step 3: Therapist loads verified facts, verifies zero publication before review (UI + API),
 *           approves all facts, and publishes a summary and a two-session cmp-v1 evolution.
 *   Step 4: Participant opens their simplified summary and evolution views.
 *   Step 5: Therapist opens the participant timeline (R4 order, origin labels, execution modes).
 *
 * Runs two full passes:
 *   1. Pointer pass (+ Row 3 unreviewed UI/API gates + Row 4 R2/R11 unreported-session barrier)
 *   2. Keyboard-only pass (zero pointer events across both therapist and participant screens)
 *
 * Verifies S1-05 ACCEPTANCE Rows 1–9 (and Row 12 disposable mutations).
 * Exits 0 iff every check passes; prints deterministic JSON summary to stdout.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  scanForbiddenOutputs,
  scanParticipantSensitiveLeaks,
} from "../../v3/participant_model.mjs";

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

const THERAPIST_SEED = {
  therapist_id: "t_s105therapistA",
  username: "terapeuta_s105_e2e",
  password: "senha-sintetica-s105-2026",
  org_id: "o_s105demo001",
  display_label: "Terapeuta Sintético S105",
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const PERIOD_FROM = "2026-01-01";
const PERIOD_TO = "2027-12-31";

function resolvePlaywrightDir() {
  return (
    process.env.ELO_PLAYWRIGHT_DIR ||
    process.env.PW ||
    path.join(os.homedir(), "hackathons", "elo-platform", "workspace", "tools", "playwright")
  );
}

function buildPythonPath() {
  const apiSrc = path.join(REPO_ROOT, "api", "src");
  return process.env.PYTHONPATH ? `${apiSrc}${path.delimiter}${process.env.PYTHONPATH}` : apiSrc;
}

function pythonHasApiDeps(pyBin, pythonPath) {
  const probe = spawnSync(pyBin, ["-c", "import fastapi, uvicorn, jsonschema"], {
    env: { ...process.env, PYTHONPATH: pythonPath },
    stdio: "ignore",
  });
  return probe.status === 0;
}

function resolvePythonBin() {
  const pythonPath = buildPythonPath();
  if (process.env.ELO_PYTHON) {
    return process.env.ELO_PYTHON;
  }
  const candidates = [
    "python3",
    path.join(REPO_ROOT, "api", ".venv", "bin", "python3"),
    path.join(REPO_ROOT, ".venv", "bin", "python3"),
    path.join(os.homedir(), "hackathons", "elo-platform", "workspace", "scratch", "S1-05", "venv", "bin", "python3"),
    path.join(os.homedir(), "hackathons", "elo-platform", "workspace", "scratch", "S1-04", "venv", "bin", "python3"),
    path.join(os.homedir(), "hackathons", "elo-platform", "workspace", "scratch", "S1-03", "venv", "bin", "python3"),
    path.join(os.homedir(), "hackathons", "elo-platform", "workspace", "scratch", "S1-01", "venv", "bin", "python3"),
  ];
  for (const cand of candidates) {
    if (cand !== "python3" && !fs.existsSync(cand)) continue;
    if (pythonHasApiDeps(cand, pythonPath)) return cand;
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
      ep.path
        .replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "{" || ch === "}" ? ch : `\\${ch}`))
        .replace(/\{[^}]+\}/g, "[^/]+") +
      "$";
    return {
      id: ep.id,
      method: ep.method.toUpperCase(),
      pathTemplate: ep.path,
      roles: ep.roles,
      regex: new RegExp(regexStr),
    };
  });
}

function matchContractEndpoint(matchers, method, pathname) {
  const upper = method.toUpperCase();
  return matchers.find((m) => m.method === upper && m.regex.test(pathname)) || null;
}

/**
 * Row 9 static scan across web/v3/**: zero references to /api/v1, legacy web assets, or pediatric paths.
 */
function assertStaticV3NoLegacyOrPediatric() {
  const forbiddenPatterns = [
    { name: "api_v1", re: /\/api\/v1\b/i },
    { name: "api_home", re: /\/api\/home\b/i },
    { name: "legacy_counter_js", re: /\bcounter\.js\b/i },
    { name: "legacy_hand_js", re: /\bhand\.js\b/i },
    { name: "legacy_root_index", re: /["']\/index\.html["']|\.\.\/index\.html/i },
    { name: "pediatric_ref", re: /\bpediatr(?:ic|ia|ico|ica)\b/i },
  ];

  const scannedFiles = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const rel = path.relative(REPO_ROOT, full);
        const content = fs.readFileSync(full, "utf8");
        scannedFiles.push(rel);
        for (const pat of forbiddenPatterns) {
          assert.equal(
            pat.re.test(content),
            false,
            `Row 9 static scan violation (${pat.name}) in ${rel}`
          );
        }
      }
    }
  }
  walk(V3_DIR);
  assert.ok(scannedFiles.length >= 10, `Expected >= 10 web/v3 files scanned, got ${scannedFiles.length}`);
  return scannedFiles.length;
}

async function startPythonApi() {
  const apiPort = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "elo-s105-api-"));
  const pythonBin = resolvePythonBin();
  const pythonPath = buildPythonPath();
  const seeds = JSON.stringify([THERAPIST_SEED]);

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
        PYTHONPATH: pythonPath,
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
      throw new Error(`Python API exited early (${child.exitCode}): ${stderrChunks.join("")}`);
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
    dataDir,
    dbPath: path.join(dataDir, "v3.db"),
    pythonBin,
    pythonPath,
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
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = reqUrl.pathname;
    const method = (req.method || "GET").toUpperCase();

    if (pathname.startsWith("/api/v3/")) {
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

    if (pathname.startsWith("/v3/")) {
      const rel = pathname.slice("/v3/".length);
      const filePath = path.resolve(V3_DIR, rel);
      if (!filePath.startsWith(V3_DIR + path.sep) && filePath !== V3_DIR) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
      res.end(fs.readFileSync(filePath));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    origin: `http://127.0.0.1:${port}`,
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

function attachLoopbackGuardAndLog(context, allowedOrigin, browserRequests, actorTag) {
  return context.route("**/*", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const origin = `${url.protocol}//${url.host}`;
    if (origin !== allowedOrigin) {
      route.abort("blockedbyclient");
      throw new Error(`Blocked non-loopback request from ${actorTag} browser: ${req.url()}`);
    }
    browserRequests.push({
      actor: actorTag,
      method: req.method().toUpperCase(),
      pathname: url.pathname,
      url: req.url(),
    });
    route.continue();
  });
}

function assertNetworkLogValid(browserRequests, contractMatchers) {
  const calledRoutes = new Set();
  for (const req of browserRequests) {
    assert.equal(
      req.pathname.startsWith("/api/v1") || req.pathname.startsWith("/api/home"),
      false,
      `Row 9 violation: legacy API request ${req.method} ${req.pathname}`
    );
    assert.equal(
      /pediatr/i.test(req.url),
      false,
      `Row 9 violation: pediatric route/asset request ${req.url}`
    );
    assert.ok(
      req.pathname.startsWith("/v3/") || req.pathname.startsWith("/api/v3/"),
      `Row 9 violation: non-v3 request ${req.method} ${req.pathname}`
    );
    if (req.pathname.startsWith("/api/v3/")) {
      const matched = matchContractEndpoint(contractMatchers, req.method, req.pathname);
      assert.ok(matched, `Undeclared /api/v3 request: ${req.method} ${req.pathname}`);
      if (req.actor === "participant") {
        assert.ok(
          matched.roles.includes("participant") || matched.roles.includes("anonymous"),
          `Non-participant route called by participant screen: ${matched.id} (${req.method} ${req.pathname})`
        );
      }
      calledRoutes.add(`${matched.id} (${matched.method} ${matched.pathTemplate})`);
    }
  }
  return Array.from(calledRoutes).sort();
}

async function installMediaTrap(page) {
  await page.addInitScript(() => {
    window.__eloMediaCalls = 0;
    const trap = async () => {
      window.__eloMediaCalls += 1;
      throw new Error("Camera/microphone APIs must never be called in S1 report-only flow");
    };
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        value: { getUserMedia: trap, getDisplayMedia: trap },
        configurable: true,
      });
    } else {
      navigator.mediaDevices.getUserMedia = trap;
      navigator.mediaDevices.getDisplayMedia = trap;
    }
  });
}

async function assertOriginAndModeOnElements(page, itemSelector, expectedOrigin, expectedMode, label) {
  const details = await page.evaluate((sel) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    return nodes.map((node) => {
      const originEl = node.querySelector("[data-origin-label]");
      const modeEl = node.querySelector("[data-execution-mode]");
      const originVisible =
        originEl &&
        getComputedStyle(originEl).display !== "none" &&
        getComputedStyle(originEl).visibility !== "hidden";
      const modeVisible =
        modeEl &&
        getComputedStyle(modeEl).display !== "none" &&
        getComputedStyle(modeEl).visibility !== "hidden";
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
    if (expectedMode) {
      assert.ok(
        item.modeText.includes(expectedMode) || item.modeAttr === expectedMode,
        `${label} missing visible execution mode "${expectedMode}": got "${item.modeText}"`
      );
    }
  }
  return details.length;
}

async function assertParticipantDomClean(page, label) {
  const text = await page.evaluate(() => document.body.innerText || "");
  const forbidden = scanForbiddenOutputs(text);
  assert.deepEqual(forbidden, [], `Forbidden cmp-v1 outputs in ${label}: ${JSON.stringify(forbidden)}`);
  const leaks = scanParticipantSensitiveLeaks(text);
  assert.deepEqual(leaks, [], `Sensitive hashes/actor-ids/note_refs leaked in ${label}: ${JSON.stringify(leaks)}`);
}

async function assertTherapistDomClean(page, label) {
  const text = await page.evaluate(() => document.body.innerText || "");
  const forbidden = scanForbiddenOutputs(text);
  assert.deepEqual(forbidden, [], `Forbidden cmp-v1 outputs in ${label}: ${JSON.stringify(forbidden)}`);
}

async function assertBasicReportZeroTyping(page) {
  const count = await page.evaluate(() => {
    const form = document.getElementById("form-report");
    if (!form) return -1;
    return form.querySelectorAll(
      'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea'
    ).length;
  });
  assert.equal(count, 0, `Expected 0 typing inputs in #form-report, found ${count}`);
}

/**
 * Row 2 & Row 7 Python oracle: validates EVERY stored event for participantId across ALL streams
 * via S0-03 validate_event, CL06.3 REF (elo_ref.py), and S1b-01 evaluate_session_stream,
 * and confirms all stored events and clinical entities are synthetic_fixture with 0 camera/consent.
 */
function verifyStoredStateWithRefAndPhaseRules(api, participantId, expectedSessionCount) {
  const pyCode = `
import json, sqlite3, sys
from pathlib import Path

repo = Path(sys.argv[1])
db_path = sys.argv[2]
pid = sys.argv[3]
expected_sessions = int(sys.argv[4])

sys.path.insert(0, str(repo / "api" / "src"))
sys.path.insert(0, str(repo / "contracts" / "CL06_3-r1" / "reference" / "python"))

import elo_ref
from elo.v3.validation import validate_event, load_event_catalog, load_limits_catalog
from elo.v3.session_rules import evaluate_session_stream

conn = sqlite3.connect(db_path)
ev_rows = conn.execute(
    "SELECT data FROM v3_events WHERE participant_id = ? ORDER BY stream_id, seq",
    (pid,),
).fetchall()
events = [json.loads(r[0]) for r in ev_rows]
assert len(events) > 0, f"No events stored for {pid}"

ent_rows = conn.execute(
    "SELECT entity_type, entity_id, version, data FROM v3_entities WHERE participant_id = ? OR entity_id = ?",
    (pid, pid),
).fetchall()
assert len(ent_rows) > 0, f"No entities stored for {pid}"
for etype, eid, ver, raw_data in ent_rows:
    ent = json.loads(raw_data)
    dorig = ent.get("data_origin")
    assert dorig == "synthetic_fixture", f"Non-synthetic entity {etype} {eid}@v{ver}: {dorig}"

cat = load_event_catalog()
limits = load_limits_catalog()

by_stream = {}
rx_payload = None
consent_count = 0
for ev in events:
    assert ev["data_origin"] == "synthetic_fixture", f"Non-synthetic event: {ev}"
    v_errs = validate_event(ev, gate_open=False)
    assert v_errs == [], f"S0-03 validate_event failed on {ev['type']} ({ev['event_id']}): {v_errs}"
    ref_sem = elo_ref.check_event_semantics(ev, cat, limits)
    assert ref_sem == [], f"REF check_event_semantics failed on {ev['type']}: {ref_sem}"
    ref_int = elo_ref.check_event_integrity(ev)
    assert ref_int == [], f"REF check_event_integrity failed on {ev['type']}: {ref_int}"
    by_stream.setdefault(ev["stream_id"], []).append(ev)
    if ev["type"] == "prescription.published":
        rx_payload = ev["payload"]
    if ev["type"] == "consent.accepted":
        consent_count += 1
    if ev["stream_id"].startswith("session:"):
        assert ev["execution_mode"] == "report_only", f"Non report_only session event: {ev}"
        assert ev["type"] != "session.completed", "session.completed forbidden in report_only"

assert rx_payload is not None, "Missing prescription.published event"
assert consent_count == 0, f"Expected 0 consent.accepted events, got {consent_count}"

for stream_id, s_evs in by_stream.items():
    chain_errs = elo_ref.check_stream_chain(s_evs)
    assert chain_errs == [], f"REF check_stream_chain failed on {stream_id}: {chain_errs}"

session_streams = sorted(sid for sid in by_stream if sid.startswith("session:"))
assert len(session_streams) == expected_sessions, (
    f"Expected exactly {expected_sessions} session streams, got {len(session_streams)}"
)
for sid in session_streams:
    rep = evaluate_session_stream(by_stream[sid], rx_payload)
    assert rep.errors == [], f"S1b-01 evaluate_session_stream failed on {sid}: {rep.errors}"
    assert rep.state.phase == "ended", f"Expected phase='ended' on {sid}, got {rep.state.phase}"

print(json.dumps({
    "ok": True,
    "total_events_validated": len(events),
    "total_streams_validated": len(by_stream),
    "session_streams_validated": len(session_streams),
    "entities_synthetic_checked": len(ent_rows),
    "consent_accepted_count": consent_count,
}))
`;
  const proc = spawnSync(
    api.pythonBin,
    ["-c", pyCode, REPO_ROOT, api.dbPath, participantId, String(expectedSessionCount)],
    {
      env: { ...process.env, PYTHONPATH: api.pythonPath },
      encoding: "utf8",
    }
  );
  assert.equal(
    proc.status,
    0,
    `Row 2 Python REF/S0-03/S1b-01 oracle failed:\nSTDOUT: ${proc.stdout}\nSTDERR: ${proc.stderr}`
  );
  return JSON.parse(proc.stdout.trim());
}

/**
 * Row 6: assert API timeline items obey R3 inclusion/exclusion and R4 total ascending order
 * (occurred_at, source_rank [entity=0, event=1], kind, ref), and match rendered DOM 1-to-1.
 */
async function assertTimelineRow6(apiBase, therapistToken, participantId, therapistPage) {
  const tlRes = await apiJson(
    apiBase,
    "GET",
    `/api/v3/participants/${participantId}/timeline`,
    therapistToken
  );
  assert.equal(tlRes.status, 200, `timeline.get failed: ${JSON.stringify(tlRes.data)}`);
  const items = tlRes.data.items || [];
  assert.ok(items.length >= 5, `Expected >= 5 timeline items, got ${items.length}`);

  const excludedKinds = new Set(["participant", "therapist", "care_link", "draft"]);
  const presentKinds = new Set();
  const sortKeys = [];

  for (const item of items) {
    assert.equal(excludedKinds.has(item.kind), false, `R3 excluded kind appeared in timeline: ${item.kind}`);
    assert.equal(item.data_origin, "synthetic_fixture", `Timeline item non-synthetic: ${JSON.stringify(item)}`);
    assert.equal(item.origin_label, "[Dados sintéticos]", `Timeline item missing origin_label: ${JSON.stringify(item)}`);
    assert.ok(
      typeof item.execution_mode === "string" && item.execution_mode.length > 0,
      `Timeline item missing execution_mode: ${JSON.stringify(item)}`
    );
    presentKinds.add(item.kind);
    const sourceRank = item.ref.includes("@v") ? 0 : 1;
    sortKeys.push([item.occurred_at, sourceRank, item.kind, item.ref]);
  }

  for (const requiredKind of [
    "functional_assessment",
    "goal",
    "prescription.published",
    "summary.published",
    "evolution.published",
  ]) {
    assert.ok(
      presentKinds.has(requiredKind),
      `Row 6 violation: timeline missing "${requiredKind}", found ${JSON.stringify(Array.from(presentKinds))}`
    );
  }

  // Verify strict R4 ascending total order: (occurred_at, source_rank, kind, ref)
  for (let i = 1; i < sortKeys.length; i += 1) {
    const a = sortKeys[i - 1];
    const b = sortKeys[i];
    const cmp =
      a[0] !== b[0]
        ? a[0] < b[0]
          ? -1
          : 1
        : a[1] !== b[1]
          ? a[1] - b[1]
          : a[2] !== b[2]
            ? a[2] < b[2]
              ? -1
              : 1
            : a[3] < b[3]
              ? -1
              : a[3] > b[3]
                ? 1
                : 0;
    assert.ok(
      cmp < 0,
      `Row 6 R4 order violation between index ${i - 1} (${JSON.stringify(a)}) and ${i} (${JSON.stringify(b)})`
    );
  }

  // Verify rendered DOM matches exact API R4 order & shows origin_label + execution_mode on every row
  const domRefs = await therapistPage.evaluate(() =>
    Array.from(document.querySelectorAll("#timeline-list li[data-timeline-item]")).map((li) =>
      li.getAttribute("data-timeline-item")
    )
  );
  assert.deepEqual(
    domRefs,
    items.map((it) => it.ref),
    "Rendered timeline DOM order/refs must match R4 API order 1-to-1"
  );

  await assertOriginAndModeOnElements(
    therapistPage,
    "#timeline-list li[data-timeline-item]",
    "[Dados sintéticos]",
    "not_applicable",
    "timeline item"
  );

  return items.length;
}

/**
 * Row 3 & Row 4 API assertions on published summary and two-session evolution.
 */
async function assertPublishedSummaryAndEvolution({
  apiBase,
  therapistToken,
  participantToken,
  summaryId,
  evolutionId,
  approvedHashByFactId,
  expectedTransitionDirection,
}) {
  // 1. Summary cites ONLY approved facts at exact current content_hash
  const sumRes = await apiJson(apiBase, "GET", `/api/v3/summaries/${summaryId}`, therapistToken);
  assert.equal(sumRes.status, 200);
  const sumEv = sumRes.data;
  assert.equal(sumEv.data_origin, "synthetic_fixture");
  const sumItems = sumEv.payload.items || [];
  assert.ok(sumItems.length >= 6, `Expected >= 6 summary items from 2 sessions, got ${sumItems.length}`);
  for (const it of sumItems) {
    assert.ok(
      approvedHashByFactId.has(it.fact_id),
      `Row 3 violation: published summary cites unapproved fact ${it.fact_id}`
    );
    assert.equal(
      it.content_hash,
      approvedHashByFactId.get(it.fact_id),
      `Row 3 violation: published summary cites stale content_hash for ${it.fact_id}`
    );
  }

  // 2. Therapist evolution view (cmp-v1, 2 sessions, approved content_hashes, R2/R11 transitions)
  const evoTher = await apiJson(apiBase, "GET", `/api/v3/evolution/${evolutionId}`, therapistToken);
  assert.equal(evoTher.status, 200);
  const evoEv = evoTher.data.event;
  assert.equal(evoEv.data_origin, "synthetic_fixture");
  assert.equal(evoEv.payload.comparability_rules_version, "cmp-v1");

  const seriesKeysMap = evoTher.data.series_keys || {};
  const seriesArr = evoEv.payload.series || [];
  assert.ok(seriesArr.length >= 3, `Expected >= 3 comparable series (F02/F03/F04), got ${seriesArr.length}`);

  const seriesByFactType = new Map();
  for (const s of seriesArr) {
    const sKey = seriesKeysMap[s.series_key_hash];
    assert.ok(sKey, `Missing series_key metadata for ${s.series_key_hash}`);
    assert.equal(sKey.execution_mode, "report_only");
    assert.equal(sKey.data_origin_class, "synthetic_fixture");
    assert.equal(
      s.items.length,
      2,
      `Row 4 violation: expected 2-session items in series ${sKey.fact_type}, got ${s.items.length}`
    );
    for (const item of s.items) {
      assert.ok(
        approvedHashByFactId.has(item.fact_id),
        `Row 3 violation: published evolution cites unapproved fact ${item.fact_id}`
      );
      assert.equal(
        item.content_hash,
        approvedHashByFactId.get(item.fact_id),
        `Row 3 violation: published evolution cites stale content_hash for ${item.fact_id}`
      );
    }
    seriesByFactType.set(sKey.fact_type, s);
  }

  for (const reqType of ["F02", "F03", "F04"]) {
    assert.ok(seriesByFactType.has(reqType), `Row 4 violation: evolution missing ${reqType} series`);
  }

  const transitions = evoEv.payload.assistance_transitions || [];
  assert.equal(
    transitions.length,
    1,
    `Row 4 violation: expected 1 assistance transition across 2 reported sessions, got ${JSON.stringify(transitions)}`
  );
  assert.equal(transitions[0].from_level, "some");
  assert.equal(transitions[0].to_level, "none");
  assert.equal(transitions[0].direction, expectedTransitionDirection);

  // 3. Participant simplified views (Row 5 + R8: no hashes, no note_refs, no actor ids, nested transitions)
  const sumPart = await apiJson(apiBase, "GET", `/api/v3/summaries/${summaryId}`, participantToken);
  assert.equal(sumPart.status, 200);
  assert.equal(JSON.stringify(sumPart.data).includes("note_refs"), false);
  assert.deepEqual(scanParticipantSensitiveLeaks(JSON.stringify(sumPart.data)), []);

  const evoPart = await apiJson(apiBase, "GET", `/api/v3/evolution/${evolutionId}`, participantToken);
  assert.equal(evoPart.status, 200);
  assert.equal("assistance_transitions" in evoPart.data, false, "R8: participant view must nest transitions under series[]");
  const partSeries = evoPart.data.series || [];
  assert.equal(partSeries.length, seriesArr.length);
  const nestedTransitions = partSeries.flatMap((s) => s.assistance_transitions || []);
  assert.equal(nestedTransitions.length, 1);
  assert.equal(nestedTransitions[0].direction, expectedTransitionDirection);
  assert.deepEqual(scanParticipantSensitiveLeaks(JSON.stringify(evoPart.data)), []);

  return {
    summary_items: sumItems.length,
    evolution_series: seriesArr.length,
    assistance_transition_direction: transitions[0].direction,
  };
}

/**
 * Keyboard-only helpers (Row 8): strictly Tab / Shift+Tab / Enter / Space / type — 0 pointer events.
 */
async function tabToSelector(page, selector, maxTabs = 220) {
  const isAlready = await page.evaluate(
    (sel) => Boolean(document.activeElement && document.activeElement.matches(sel)),
    selector
  );
  if (isAlready) return;

  for (let i = 0; i < maxTabs; i += 1) {
    await page.keyboard.press("Tab");
    const hit = await page.evaluate(
      (sel) => Boolean(document.activeElement && document.activeElement.matches(sel)),
      selector
    );
    if (hit) return;
  }
  throw new Error(`Keyboard-only Tab could not reach selector: ${selector}`);
}

async function keyboardFillInput(page, selector, text) {
  await tabToSelector(page, selector);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
}

/**
 * Pass 1: Full integrated pointer pass (Steps 1–5 + Row 3 unreviewed API/UI gate
 * + Row 4 R2/R11 unreported-session barrier check).
 */
async function runPointerPass(browser, contractMatchers) {
  const api = await startPythonApi();
  const gateway = await startGateway(api.apiBase);
  const browserRequests = [];

  try {
    const therapistCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const participantCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await attachLoopbackGuardAndLog(therapistCtx, gateway.origin, browserRequests, "therapist");
    await attachLoopbackGuardAndLog(participantCtx, gateway.origin, browserRequests, "participant");

    const tPage = await therapistCtx.newPage();
    const pPage = await participantCtx.newPage();
    await installMediaTrap(tPage);
    await installMediaTrap(pPage);

    // =========================================================================
    // STEP 1: Therapist registers/links participant, assessment, goal, Rx
    // =========================================================================
    await tPage.goto(`${gateway.origin}/v3/therapist.html`, { waitUntil: "load" });
    await tPage.fill("#signin-username", THERAPIST_SEED.username);
    await tPage.fill("#signin-password", THERAPIST_SEED.password);
    await tPage.click("#btn-signin");
    await tPage.waitForSelector("#signin-result:not([hidden])");

    const tSession = await tPage.evaluate(() =>
      JSON.parse(window.sessionStorage.getItem("elo_v3_therapist_session") || "null")
    );
    assert.ok(tSession && tSession.token, "Therapist session token missing");

    await tPage.fill("#participant-alias", "Participante E2E Ponteiro");
    await tPage.selectOption("#participant-side", "right");
    await tPage.click("#btn-create-participant");
    await tPage.waitForSelector("#participant-result:not([hidden])");
    const participantId = await tPage.locator("#active-participant-id").inputValue();
    assert.match(participantId, /^p_[A-Za-z0-9-]{8,64}$/);
    const clMatch = (await tPage.locator("#participant-result").textContent()).match(/cl_[A-Za-z0-9-]{8,64}/);
    assert.ok(clMatch, "Care link id not displayed after participant creation");
    const careLinkId = clMatch[0];

    const pEntRes = await apiJson(api.apiBase, "GET", `/api/v3/entities/${participantId}/versions`, tSession.token);
    assert.equal(pEntRes.status, 200);
    assert.equal(pEntRes.data[0].data_origin, "synthetic_fixture");
    const clEntRes = await apiJson(api.apiBase, "GET", `/api/v3/entities/${careLinkId}/versions`, tSession.token);
    assert.equal(clEntRes.status, 200);
    assert.equal(clEntRes.data[0].payload.status, "active");

    await tPage.click("#btn-create-assessment");
    await tPage.waitForSelector("#assessment-result:not([hidden])");
    const assessRes = await apiJson(api.apiBase, "GET", `/api/v3/participants/${participantId}/assessments`, tSession.token);
    assert.equal(assessRes.status, 200);
    assert.equal(assessRes.data.length, 1);

    await tPage.click("#btn-create-goal");
    await tPage.waitForSelector("#goal-result:not([hidden])");
    const goalRes = await apiJson(api.apiBase, "GET", `/api/v3/participants/${participantId}/goals`, tSession.token);
    assert.equal(goalRes.status, 200);
    assert.equal(goalRes.data.length, 1);

    await tPage.fill("#rx-valid-from", PERIOD_FROM);
    await tPage.fill("#rx-valid-to", PERIOD_TO);
    await tPage.click("#btn-publish-prescription");
    await tPage.waitForSelector("#prescription-result:not([hidden])");
    const rxRes = await apiJson(
      api.apiBase,
      "GET",
      `/api/v3/participants/${participantId}/prescription/current`,
      tSession.token
    );
    assert.equal(rxRes.status, 200);
    assert.equal(rxRes.data.payload.exercise_id, "organizar-a-mesa");

    // Issue participant invite via live therapist API (no invite UI feature per PO-F31)
    const invRes = await apiJson(api.apiBase, "POST", "/api/v3/invites", tSession.token, {
      participant_id: participantId,
      ttl_seconds: 3600,
    });
    assert.equal(invRes.status, 201);

    // =========================================================================
    // STEP 2: Participant runs 2 report-only sessions and submits reports
    // =========================================================================
    await pPage.goto(`${gateway.origin}/v3/participant.html`, { waitUntil: "load" });
    await pPage.fill("#invite-token", invRes.data.invite_token);
    await pPage.click("#btn-invite-signin");
    await pPage.waitForSelector("#signin-result:not([hidden])");

    const pSession = await pPage.evaluate(() =>
      JSON.parse(window.sessionStorage.getItem("elo_v3_participant_session") || "null")
    );
    assert.ok(pSession && pSession.token, "Participant session token missing");

    await pPage.click("#btn-load-plan");
    await pPage.waitForSelector('#prescription-view[data-prescription-loaded="true"]');
    await pPage.waitForSelector('#goals-list li[data-goal-item="true"]');
    await assertOriginAndModeOnElements(pPage, "#prescription-view", "[Dados sintéticos]", "report_only", "prescription");
    await assertBasicReportZeroTyping(pPage);

    // Session 1: assistance = some
    await pPage.click("#btn-session-start");
    await pPage.waitForSelector('#session-result[data-session-phase="active"]');
    await pPage.click("#btn-session-end");
    await pPage.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="end"]');
    await pPage.click('button[data-choice-group="execution"][data-choice-value="complete"]');
    await pPage.click('button[data-choice-group="assistance"][data-choice-value="some"]');
    await pPage.click("#btn-submit-report");
    await pPage.waitForSelector('#report-result[data-report-assistance="some"]');

    // Session 2: assistance = none
    await pPage.click("#btn-session-start");
    await pPage.waitForSelector('#session-result[data-session-phase="active"]');
    await pPage.click("#btn-session-end");
    await pPage.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="end"]');
    await pPage.click('button[data-choice-group="execution"][data-choice-value="complete"]');
    await pPage.click('button[data-choice-group="assistance"][data-choice-value="none"]');
    await pPage.click("#btn-submit-report");
    await pPage.waitForSelector('#report-result[data-report-assistance="none"]');

    const preFactsRes = await apiJson(
      api.apiBase,
      "GET",
      `/api/v3/participants/${participantId}/facts`,
      tSession.token
    );
    assert.equal(preFactsRes.status, 200);
    assert.ok((preFactsRes.data.facts || []).length >= 6, "Expected >= 6 derived facts from 2 sessions");

    // =========================================================================
    // STEP 3: Therapist loads facts, verifies Row 3 zero-pub gate, approves & publishes
    // =========================================================================
    await tPage.click("#btn-load-facts");
    await tPage.waitForSelector("#facts-list li[data-fact-item]");
    await assertOriginAndModeOnElements(
      tPage,
      "#facts-list li[data-fact-item]",
      "[Dados sintéticos]",
      "report_only",
      "verified fact"
    );

    const domFacts = await tPage.evaluate(() =>
      Array.from(document.querySelectorAll("#facts-list li[data-fact-item]")).map((li) => ({
        factId: li.getAttribute("data-fact-item"),
        factType: li.getAttribute("data-fact-type"),
        contentHash: (li.textContent.match(/content_hash:\s*([0-9a-f]{64})/) || [])[1] || "",
      }))
    );
    assert.ok(domFacts.length >= 6);

    // Row 3: Before ANY approval, UI blocks publication and API rejects publication
    assert.equal(await tPage.locator("#btn-publish-summary").isDisabled(), true, "Row 3: summary button must be disabled pre-review");
    assert.equal(await tPage.locator("#btn-publish-evolution").isDisabled(), true, "Row 3: evolution button must be disabled pre-review");

    const preSeries = await apiJson(
      api.apiBase,
      "GET",
      `/api/v3/participants/${participantId}/evolution/series`,
      tSession.token
    );
    assert.equal(preSeries.status, 200);
    assert.equal((preSeries.data.series || []).length, 0, "Row 3 / R5: unreviewed facts must not appear in evolution.series");

    const unrevSum = await apiJson(api.apiBase, "POST", "/api/v3/summaries", tSession.token, {
      participant_id: participantId,
      items: [{ fact_id: domFacts[0].factId, content_hash: domFacts[0].contentHash }],
      period: { from: PERIOD_FROM, to: PERIOD_TO },
      note_refs: [],
    });
    assert.ok(
      unrevSum.status === 422 || unrevSum.status === 409,
      `Row 3: unreviewed summary must be rejected, got HTTP ${unrevSum.status}: ${JSON.stringify(unrevSum.data)}`
    );

    const unrevEvo = await apiJson(api.apiBase, "POST", "/api/v3/evolution", tSession.token, {
      participant_id: participantId,
      period: { from: PERIOD_FROM, to: PERIOD_TO },
      series: [
        {
          series_key_hash: "0".repeat(64),
          items: [{ fact_id: domFacts[0].factId, content_hash: domFacts[0].contentHash }],
        },
      ],
    });
    assert.equal(
      unrevEvo.status,
      409,
      `Row 3: unreviewed evolution must be rejected with 409, got ${unrevEvo.status}: ${JSON.stringify(unrevEvo.data)}`
    );
    assert.equal(unrevEvo.data.error?.code, "UNREVIEWED_FACT_IN_EVOLUTION");

    const preTl = await apiJson(
      api.apiBase,
      "GET",
      `/api/v3/participants/${participantId}/timeline`,
      tSession.token
    );
    assert.equal(
      (preTl.data.items || []).some((it) => it.kind === "summary.published" || it.kind === "evolution.published"),
      false,
      "Row 3: rejected pre-review publications must store nothing"
    );

    // Approve all verified facts in the UI (mutation 12a skips this block)
    const approvedHashByFactId = new Map();
    for (const f of domFacts) {
      assert.match(f.contentHash, /^[0-9a-f]{64}$/);
      await tPage.click(`button[data-review-decision="approve"][data-fact-id="${f.factId}"]`);
      await tPage.waitForSelector(`li[data-fact-item="${f.factId}"] [data-review-status="approved"]`);
      approvedHashByFactId.set(f.factId, f.contentHash);
    }

    // Publish summary in UI
    await tPage.fill("#summary-period-from", PERIOD_FROM);
    await tPage.fill("#summary-period-to", PERIOD_TO);
    await tPage.click("#btn-publish-summary");
    await tPage.waitForSelector("#summary-result [data-published-summary]");
    const summaryId = await tPage
      .locator("#summary-result [data-published-summary]")
      .getAttribute("data-published-summary");
    assert.match(summaryId, /^sum_[A-Za-z0-9-]{8,64}$/);

    // Load comparable evolution series & publish evolution in UI
    await tPage.click("#btn-load-evolution-series");
    await tPage.waitForSelector("#evolution-series-container [data-evolution-series]");
    await tPage.fill("#evolution-period-from", PERIOD_FROM);
    await tPage.fill("#evolution-period-to", PERIOD_TO);
    await tPage.click("#btn-publish-evolution");
    await tPage.waitForSelector("#evolution-result [data-published-evolution]");
    const evolutionId = await tPage
      .locator("#evolution-result [data-published-evolution]")
      .getAttribute("data-published-evolution");
    assert.match(evolutionId, /^evo_[A-Za-z0-9-]{8,64}$/);

    const pubMetrics = await assertPublishedSummaryAndEvolution({
      apiBase: api.apiBase,
      therapistToken: tSession.token,
      participantToken: pSession.token,
      summaryId,
      evolutionId,
      approvedHashByFactId,
      expectedTransitionDirection: "less_help_reported",
    });

    // =========================================================================
    // STEP 4: Participant opens their published summary and evolution
    // =========================================================================
    await pPage.fill("#summary-id-input", summaryId);
    await pPage.click("#btn-open-summary");
    await pPage.waitForSelector(`#summary-view [data-participant-summary="${summaryId}"]`);
    await assertOriginAndModeOnElements(pPage, "#summary-view [data-participant-summary]", "[Dados sintéticos]", null, "participant summary");
    await assertOriginAndModeOnElements(pPage, "#summary-view [data-summary-rendered-fact]", "[Dados sintéticos]", null, "participant summary fact");

    await pPage.fill("#evolution-id-input", evolutionId);
    await pPage.click("#btn-open-evolution");
    await pPage.waitForSelector(`#evolution-view [data-participant-evolution="${evolutionId}"]`);
    await assertOriginAndModeOnElements(pPage, "#evolution-view [data-participant-evolution-series]", "[Dados sintéticos]", "report_only", "participant evolution series");
    const pEvoItemsCount = await assertOriginAndModeOnElements(
      pPage,
      "#evolution-view [data-participant-evolution-item]",
      "[Dados sintéticos]",
      "report_only",
      "participant evolution item"
    );
    assert.ok(pEvoItemsCount >= 6, `Expected >= 6 participant evolution items across 2 sessions, got ${pEvoItemsCount}`);
    await assertParticipantDomClean(pPage, "pointer pass Step 4");

    // =========================================================================
    // STEP 5: Therapist opens the timeline (Row 6: R4 order, origin_label, mode)
    // =========================================================================
    await tPage.click("#btn-load-timeline");
    await tPage.waitForSelector("#timeline-list li[data-timeline-item]");
    const timelineItemsCount = await assertTimelineRow6(
      api.apiBase,
      tSession.token,
      participantId,
      tPage
    );
    await assertTherapistDomClean(tPage, "pointer pass Step 5");

    // Row 2 & Row 7 oracle on primary 2-session participant
    const primaryOracle = verifyStoredStateWithRefAndPhaseRules(api, participantId, 2);

    // =========================================================================
    // ROW 4 BARRIER CHECK (R2/R11): nothing bridged across an unreported session
    // Driven through real web/v3 screens: some -> unreported -> none => 0 transitions
    // =========================================================================
    await tPage.fill("#participant-alias", "Participante E2E Barreira R2");
    await tPage.selectOption("#participant-side", "right");
    await tPage.click("#btn-create-participant");
    await tPage.waitForFunction(
      (prevId) => {
        const el = document.getElementById("active-participant-id");
        return el && el.value && el.value !== prevId;
      },
      participantId
    );
    const barrierPid = await tPage.locator("#active-participant-id").inputValue();

    await tPage.fill("#rx-valid-from", PERIOD_FROM);
    await tPage.fill("#rx-valid-to", PERIOD_TO);
    await tPage.click("#btn-publish-prescription");
    await tPage.waitForSelector("#prescription-result:not([hidden])");

    const barrierInv = await apiJson(api.apiBase, "POST", "/api/v3/invites", tSession.token, {
      participant_id: barrierPid,
      ttl_seconds: 3600,
    });
    assert.equal(barrierInv.status, 201);

    const pBarrierCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await attachLoopbackGuardAndLog(pBarrierCtx, gateway.origin, browserRequests, "participant");
    const pBarrierPage = await pBarrierCtx.newPage();
    await installMediaTrap(pBarrierPage);

    await pBarrierPage.goto(`${gateway.origin}/v3/participant.html`, { waitUntil: "load" });
    await pBarrierPage.fill("#invite-token", barrierInv.data.invite_token);
    await pBarrierPage.click("#btn-invite-signin");
    await pBarrierPage.waitForSelector("#signin-result:not([hidden])");
    const pBarrierSession = await pBarrierPage.evaluate(() =>
      JSON.parse(window.sessionStorage.getItem("elo_v3_participant_session") || "null")
    );
    await pBarrierPage.click("#btn-load-plan");
    await pBarrierPage.waitForSelector('#prescription-view[data-prescription-loaded="true"]');

    for (const assistChoice of ["some", "unreported", "none"]) {
      await pBarrierPage.click("#btn-session-start");
      await pBarrierPage.waitForSelector('#session-result[data-session-phase="active"]');
      await pBarrierPage.click("#btn-session-end");
      await pBarrierPage.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="end"]');
      await pBarrierPage.click('button[data-choice-group="execution"][data-choice-value="complete"]');
      await pBarrierPage.click(`button[data-choice-group="assistance"][data-choice-value="${assistChoice}"]`);
      await pBarrierPage.click("#btn-submit-report");
      await pBarrierPage.waitForSelector(`#report-result[data-report-assistance="${assistChoice}"]`);
    }

    await tPage.click("#btn-load-facts");
    await tPage.waitForSelector("#facts-list li[data-fact-item]");
    const barrierFacts = await tPage.evaluate(() =>
      Array.from(document.querySelectorAll("#facts-list li[data-fact-item]")).map((li) => ({
        factId: li.getAttribute("data-fact-item"),
        factType: li.getAttribute("data-fact-type"),
      }))
    );
    // 3 sessions -> 3 F02 + 3 F03 + 2 F04 (no F04 fabricated for unreported session!) = 8 facts
    assert.equal(
      barrierFacts.filter((f) => f.factType === "F04").length,
      2,
      "R2: no F04 fact may be fabricated for the unreported session"
    );
    for (const f of barrierFacts) {
      await tPage.click(`button[data-review-decision="approve"][data-fact-id="${f.factId}"]`);
      await tPage.waitForSelector(`li[data-fact-item="${f.factId}"] [data-review-status="approved"]`);
    }

    await tPage.click("#btn-load-evolution-series");
    await tPage.waitForSelector("#evolution-series-container [data-evolution-series]");
    await tPage.fill("#evolution-period-from", PERIOD_FROM);
    await tPage.fill("#evolution-period-to", PERIOD_TO);
    await tPage.click("#btn-publish-evolution");
    await tPage.waitForFunction(
      (prevEvoId) => {
        const node = document.querySelector("#evolution-result [data-published-evolution]");
        return node && node.getAttribute("data-published-evolution") !== prevEvoId;
      },
      evolutionId
    );
    const barrierEvoId = await tPage
      .locator("#evolution-result [data-published-evolution]")
      .getAttribute("data-published-evolution");

    const barrierEvoTher = await apiJson(api.apiBase, "GET", `/api/v3/evolution/${barrierEvoId}`, tSession.token);
    assert.equal(barrierEvoTher.status, 200);
    assert.deepEqual(
      barrierEvoTher.data.event.payload.assistance_transitions,
      [],
      "Row 4 / R2/R11 violation: assistance transition was bridged across an unreported session"
    );
    const barrierEvoPart = await apiJson(
      api.apiBase,
      "GET",
      `/api/v3/evolution/${barrierEvoId}`,
      pBarrierSession.token
    );
    assert.equal(barrierEvoPart.status, 200);
    const barrierPartTransitions = (barrierEvoPart.data.series || []).flatMap(
      (s) => s.assistance_transitions || []
    );
    assert.deepEqual(barrierPartTransitions, [], "Row 4 / R8 violation: participant view must have 0 bridged transitions");

    const barrierOracle = verifyStoredStateWithRefAndPhaseRules(api, barrierPid, 3);

    // Row 7: zero camera/microphone calls across all pages
    const mediaCalls =
      (await tPage.evaluate(() => window.__eloMediaCalls || 0)) +
      (await pPage.evaluate(() => window.__eloMediaCalls || 0)) +
      (await pBarrierPage.evaluate(() => window.__eloMediaCalls || 0));
    assert.equal(mediaCalls, 0, `Camera/microphone APIs called ${mediaCalls} times`);

    await pBarrierCtx.close();
    await participantCtx.close();
    await therapistCtx.close();

    const calledRoutes = assertNetworkLogValid(browserRequests, contractMatchers);

    return {
      passed: true,
      media_calls: mediaCalls,
      timeline_items: timelineItemsCount,
      publications: pubMetrics,
      unreported_barrier_transitions: 0,
      ref_and_phase_oracle: primaryOracle,
      barrier_oracle: barrierOracle,
      called_routes: calledRoutes,
    };
  } finally {
    await gateway.stop();
    await api.stop();
  }
}

/**
 * Pass 2: Complete TASK Steps 1–5 loop driven strictly via keyboard (pointer_events_used: 0)
 * across BOTH /v3/therapist.html and /v3/participant.html.
 */
async function runKeyboardOnlyPass(browser, contractMatchers) {
  const api = await startPythonApi();
  const gateway = await startGateway(api.apiBase);
  const browserRequests = [];

  try {
    const therapistCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const participantCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await attachLoopbackGuardAndLog(therapistCtx, gateway.origin, browserRequests, "therapist");
    await attachLoopbackGuardAndLog(participantCtx, gateway.origin, browserRequests, "participant");

    const tPage = await therapistCtx.newPage();
    const pPage = await participantCtx.newPage();
    await installMediaTrap(tPage);
    await installMediaTrap(pPage);

    // ZERO pointer events allowed anywhere in this pass!
    // --- Step 1 (Therapist keyboard-only) ---
    await tPage.goto(`${gateway.origin}/v3/therapist.html`, { waitUntil: "load" });
    await keyboardFillInput(tPage, "#signin-username", THERAPIST_SEED.username);
    await keyboardFillInput(tPage, "#signin-password", THERAPIST_SEED.password);
    await tabToSelector(tPage, "#btn-signin");
    await tPage.keyboard.press("Enter");
    await tPage.waitForSelector("#signin-result:not([hidden])");

    const tSession = await tPage.evaluate(() =>
      JSON.parse(window.sessionStorage.getItem("elo_v3_therapist_session") || "null")
    );
    assert.ok(tSession && tSession.token);

    await keyboardFillInput(tPage, "#participant-alias", "Participante E2E Teclado");
    await tabToSelector(tPage, "#btn-create-participant");
    await tPage.keyboard.press("Enter");
    await tPage.waitForSelector("#participant-result:not([hidden])");
    const participantId = await tPage.locator("#active-participant-id").inputValue();
    assert.match(participantId, /^p_[A-Za-z0-9-]{8,64}$/);

    await tabToSelector(tPage, "#btn-create-assessment");
    await tPage.keyboard.press("Enter");
    await tPage.waitForSelector("#assessment-result:not([hidden])");

    await tabToSelector(tPage, "#btn-create-goal");
    await tPage.keyboard.press("Enter");
    await tPage.waitForSelector("#goal-result:not([hidden])");

    await keyboardFillInput(tPage, "#rx-valid-from", PERIOD_FROM);
    await keyboardFillInput(tPage, "#rx-valid-to", PERIOD_TO);
    await tabToSelector(tPage, "#btn-publish-prescription");
    await tPage.keyboard.press("Enter");
    await tPage.waitForSelector("#prescription-result:not([hidden])");

    const invRes = await apiJson(api.apiBase, "POST", "/api/v3/invites", tSession.token, {
      participant_id: participantId,
      ttl_seconds: 3600,
    });
    assert.equal(invRes.status, 201);

    // --- Step 2 (Participant keyboard-only: 2 report-only sessions) ---
    await pPage.goto(`${gateway.origin}/v3/participant.html`, { waitUntil: "load" });
    await keyboardFillInput(pPage, "#invite-token", invRes.data.invite_token);
    await tabToSelector(pPage, "#btn-invite-signin");
    await pPage.keyboard.press("Enter");
    await pPage.waitForSelector("#signin-result:not([hidden])");

    const pSession = await pPage.evaluate(() =>
      JSON.parse(window.sessionStorage.getItem("elo_v3_participant_session") || "null")
    );
    assert.ok(pSession && pSession.token);

    await tabToSelector(pPage, "#btn-load-plan");
    await pPage.keyboard.press("Enter");
    await pPage.waitForSelector('#prescription-view[data-prescription-loaded="true"]');
    await pPage.waitForSelector('#goals-list li[data-goal-item="true"]');
    await assertBasicReportZeroTyping(pPage);

    // Session 1: complete + some (keyboard-only)
    await tabToSelector(pPage, "#btn-session-start");
    await pPage.keyboard.press("Enter");
    await pPage.waitForSelector('#session-result[data-session-phase="active"]');
    await tabToSelector(pPage, "#btn-session-end");
    await pPage.keyboard.press("Enter");
    await pPage.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="end"]');
    await tabToSelector(pPage, 'button[data-choice-group="execution"][data-choice-value="complete"]');
    await pPage.keyboard.press("Space");
    await tabToSelector(pPage, 'button[data-choice-group="assistance"][data-choice-value="some"]');
    await pPage.keyboard.press("Space");
    await tabToSelector(pPage, "#btn-submit-report");
    await pPage.keyboard.press("Enter");
    await pPage.waitForSelector('#report-result[data-report-assistance="some"]');

    // Session 2: complete + none (keyboard-only)
    await tabToSelector(pPage, "#btn-session-start");
    await pPage.keyboard.press("Enter");
    await pPage.waitForSelector('#session-result[data-session-phase="active"]');
    await tabToSelector(pPage, "#btn-session-end");
    await pPage.keyboard.press("Enter");
    await pPage.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="end"]');
    await tabToSelector(pPage, 'button[data-choice-group="execution"][data-choice-value="complete"]');
    await pPage.keyboard.press("Space");
    await tabToSelector(pPage, 'button[data-choice-group="assistance"][data-choice-value="none"]');
    await pPage.keyboard.press("Space");
    await tabToSelector(pPage, "#btn-submit-report");
    await pPage.keyboard.press("Enter");
    await pPage.waitForSelector('#report-result[data-report-assistance="none"]');

    // --- Step 3 (Therapist keyboard-only: load facts, verify gate, approve, publish) ---
    await tabToSelector(tPage, "#btn-load-facts");
    await tPage.keyboard.press("Enter");
    await tPage.waitForSelector("#facts-list li[data-fact-item]");

    assert.equal(await tPage.locator("#btn-publish-summary").isDisabled(), true);
    assert.equal(await tPage.locator("#btn-publish-evolution").isDisabled(), true);

    const domFacts = await tPage.evaluate(() =>
      Array.from(document.querySelectorAll("#facts-list li[data-fact-item]")).map((li) => ({
        factId: li.getAttribute("data-fact-item"),
        contentHash: (li.textContent.match(/content_hash:\s*([0-9a-f]{64})/) || [])[1] || "",
      }))
    );
    assert.ok(domFacts.length >= 6);

    const approvedHashByFactId = new Map();
    for (const f of domFacts) {
      await tabToSelector(tPage, `button[data-review-decision="approve"][data-fact-id="${f.factId}"]`, 240);
      await tPage.keyboard.press("Enter");
      await tPage.waitForSelector(`li[data-fact-item="${f.factId}"] [data-review-status="approved"]`);
      approvedHashByFactId.set(f.factId, f.contentHash);
    }

    await keyboardFillInput(tPage, "#summary-period-from", PERIOD_FROM);
    await keyboardFillInput(tPage, "#summary-period-to", PERIOD_TO);
    await tabToSelector(tPage, "#btn-publish-summary", 240);
    await tPage.keyboard.press("Enter");
    await tPage.waitForSelector("#summary-result [data-published-summary]");
    const summaryId = await tPage
      .locator("#summary-result [data-published-summary]")
      .getAttribute("data-published-summary");

    await tabToSelector(tPage, "#btn-load-evolution-series", 240);
    await tPage.keyboard.press("Enter");
    await tPage.waitForSelector("#evolution-series-container [data-evolution-series]");

    await keyboardFillInput(tPage, "#evolution-period-from", PERIOD_FROM);
    await keyboardFillInput(tPage, "#evolution-period-to", PERIOD_TO);
    await tabToSelector(tPage, "#btn-publish-evolution", 240);
    await tPage.keyboard.press("Enter");
    await tPage.waitForSelector("#evolution-result [data-published-evolution]");
    const evolutionId = await tPage
      .locator("#evolution-result [data-published-evolution]")
      .getAttribute("data-published-evolution");

    const pubMetrics = await assertPublishedSummaryAndEvolution({
      apiBase: api.apiBase,
      therapistToken: tSession.token,
      participantToken: pSession.token,
      summaryId,
      evolutionId,
      approvedHashByFactId,
      expectedTransitionDirection: "less_help_reported",
    });

    // --- Step 4 (Participant keyboard-only: open summary & evolution) ---
    await keyboardFillInput(pPage, "#summary-id-input", summaryId);
    await tabToSelector(pPage, "#btn-open-summary");
    await pPage.keyboard.press("Enter");
    await pPage.waitForSelector(`#summary-view [data-participant-summary="${summaryId}"]`);

    await keyboardFillInput(pPage, "#evolution-id-input", evolutionId);
    await tabToSelector(pPage, "#btn-open-evolution");
    await pPage.keyboard.press("Enter");
    await pPage.waitForSelector(`#evolution-view [data-participant-evolution="${evolutionId}"]`);
    await assertOriginAndModeOnElements(pPage, "#evolution-view [data-participant-evolution-series]", "[Dados sintéticos]", "report_only", "keyboard participant evolution series");
    await assertParticipantDomClean(pPage, "keyboard-only pass Step 4");

    // --- Step 5 (Therapist keyboard-only: open timeline) ---
    await tabToSelector(tPage, "#btn-load-timeline", 240);
    await tPage.keyboard.press("Enter");
    await tPage.waitForSelector("#timeline-list li[data-timeline-item]");
    const timelineItemsCount = await assertTimelineRow6(
      api.apiBase,
      tSession.token,
      participantId,
      tPage
    );
    await assertTherapistDomClean(tPage, "keyboard-only pass Step 5");

    const oracle = verifyStoredStateWithRefAndPhaseRules(api, participantId, 2);
    const mediaCalls =
      (await tPage.evaluate(() => window.__eloMediaCalls || 0)) +
      (await pPage.evaluate(() => window.__eloMediaCalls || 0));
    assert.equal(mediaCalls, 0);

    await participantCtx.close();
    await therapistCtx.close();

    const calledRoutes = assertNetworkLogValid(browserRequests, contractMatchers);

    return {
      passed: true,
      pointer_events_used: 0,
      media_calls: mediaCalls,
      timeline_items: timelineItemsCount,
      publications: pubMetrics,
      ref_and_phase_oracle: oracle,
      called_routes: calledRoutes,
    };
  } finally {
    await gateway.stop();
    await api.stop();
  }
}

async function main() {
  const staticV3FilesScanned = assertStaticV3NoLegacyOrPediatric();
  const contractMatchers = loadContractMatchers();
  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });

  try {
    const pointerPass = await runPointerPass(browser, contractMatchers);
    const keyboardPass = await runKeyboardOnlyPass(browser, contractMatchers);

    const allRoutes = Array.from(
      new Set([...pointerPass.called_routes, ...keyboardPass.called_routes])
    ).sort();

    const report = {
      passed: pointerPass.passed && keyboardPass.passed,
      task: "S1-05",
      screens: ["/v3/therapist.html", "/v3/participant.html"],
      static_v3_files_scanned: staticV3FilesScanned,
      pointer_pass: {
        passed: pointerPass.passed,
        media_calls: pointerPass.media_calls,
        timeline_items: pointerPass.timeline_items,
        publications: pointerPass.publications,
        unreported_barrier_transitions: pointerPass.unreported_barrier_transitions,
        ref_and_phase_oracle: pointerPass.ref_and_phase_oracle,
        barrier_oracle: pointerPass.barrier_oracle,
      },
      keyboard_pass: {
        passed: keyboardPass.passed,
        pointer_events_used: keyboardPass.pointer_events_used,
        media_calls: keyboardPass.media_calls,
        timeline_items: keyboardPass.timeline_items,
        publications: keyboardPass.publications,
        ref_and_phase_oracle: keyboardPass.ref_and_phase_oracle,
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
