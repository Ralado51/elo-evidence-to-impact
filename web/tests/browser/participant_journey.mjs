#!/usr/bin/env node
/**
 * S1-04 Participant Journey End-to-End Browser Harness (P).
 *
 * Runs web/v3/participant.html against a live loopback Python /api/v3 FastAPI server
 * in real headless Chromium (playwright-core) in two full passes:
 *   1. Pointer pass (+ Row 3 forced FORBIDDEN + Row 4 getUserMedia guard + Row 5 unreported
 *      + Row 6 symptom stop pain + Row 7 facts.verify + Row 8 simplified views + Row 9 authz/CONSENT_REQUIRED)
 *   2. Keyboard-only pass (zero pointer events: Tab / Enter / Space; normal + fatigue stop)
 *
 * Verifies ACCEPTANCE v2 Rows 1–10 and 12 (plus Row 14 mutations).
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

import { hashCanonical } from "../../v3/canonical.mjs";
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
  therapist_id: "t_s104therapistA",
  username: "terapeuta_s104_a",
  password: "senha-sintetica-s104-2026",
  org_id: "o_s104demo001",
  display_label: "Terapeuta Sintético S104",
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
    path.join(os.homedir(), "hackathons", "elo-platform", "workspace", "scratch", "S1-04", "venv", "bin", "python3"),
    path.join(os.homedir(), "hackathons", "elo-platform", "workspace", "scratch", "S1-03", "venv", "bin", "python3"),
    path.join(os.homedir(), "hackathons", "elo-platform", "workspace", "scratch", "S1-01", "venv", "bin", "python3"),
    path.join(REPO_ROOT, "api", ".venv", "bin", "python3"),
    path.join(REPO_ROOT, ".venv", "bin", "python3"),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return "python3";
}

function buildPythonPath() {
  const apiSrc = path.join(REPO_ROOT, "api", "src");
  return process.env.PYTHONPATH ? `${apiSrc}${path.delimiter}${process.env.PYTHONPATH}` : apiSrc;
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

async function startPythonApi() {
  const apiPort = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "elo-s104-api-"));
  const pythonBin = resolvePythonBin();
  const seeds = JSON.stringify([THERAPIST_SEED]);
  const pythonPath = buildPythonPath();

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

async function startGateway(apiBase) {
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
      const ok = ["activity_runner.mjs", "simulation_source.mjs", "capture_events.mjs", "protocol.mjs", "motion.mjs"].includes(name);
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

/**
 * Therapist-side setup (outside participant traffic): creates participant P1 (with prescription,
 * goal, and invite) and optionally P2 (with published summary & evolution for Row 9 404 checks).
 */
async function setupTherapistSide(apiBase, includeOtherParticipant = false) {
  const loginRes = await apiJson(apiBase, "POST", "/api/v3/auth/therapist", null, {
    username: THERAPIST_SEED.username,
    password: THERAPIST_SEED.password,
  });
  assert.equal(loginRes.status, 200);
  const therapistToken = loginRes.data.token;

  async function createParticipantWithPlan(alias) {
    const pRes = await apiJson(apiBase, "POST", "/api/v3/participants", therapistToken, {
      alias,
      side: "right",
    });
    assert.equal(pRes.status, 201);
    const participantId = pRes.data.entity_id;

    const goalRes = await apiJson(
      apiBase,
      "POST",
      `/api/v3/participants/${participantId}/goals`,
      therapistToken,
      {
        goal_text: "Realizar sessões de Organizar a mesa em modo apenas relato.",
        body_segment: "hand",
        target: { kind: "session_count", value: 3, unit: "sessions" },
        status: "active",
        confirmed_by: null,
        confirmed_at: null,
      }
    );
    assert.equal(goalRes.status, 201);

    const rxRes = await apiJson(apiBase, "POST", "/api/v3/prescriptions", therapistToken, {
      participant_id: participantId,
      exercise_id: "organizar-a-mesa",
      permitted_movement: "hand_open_close",
      side: "right",
      target_sets: 2,
      target_repetitions: 10,
      sessions_per_week: 3,
      valid_from: "2026-10-01",
      valid_to: "2027-12-31",
      timezone: "America/Sao_Paulo",
      min_calibration_span: null,
      instructions_ptbr: "Organize os objetos leves da mesa usando a mão direita no seu ritmo.",
    });
    assert.equal(rxRes.status, 201);

    const invRes = await apiJson(apiBase, "POST", "/api/v3/invites", therapistToken, {
      participant_id: participantId,
      ttl_seconds: 3600,
    });
    assert.equal(invRes.status, 201);

    return {
      participantId,
      prescriptionId: rxRes.data.prescription_id,
      prescriptionRevision: rxRes.data.revision,
      inviteToken: invRes.data.invite_token,
    };
  }

  const p1 = await createParticipantWithPlan("Participante S104 Principal");
  let other = null;

  if (includeOtherParticipant) {
    const p2 = await createParticipantWithPlan("Participante S104 Outro");
    const p2Auth = await apiJson(apiBase, "POST", "/api/v3/auth/invite", null, {
      invite_token: p2.inviteToken,
    });
    assert.equal(p2Auth.status, 200);
    const sid = `s_s104other${Date.now().toString(36)}`;
    const streamId = `session:${sid}`;
    async function mkEv(seq, prevHash, occurredAt, type, payload) {
      const evId = await hashCanonical({ seq, stream_id: streamId });
      const base = {
        event_id: evId,
        schema_version: 3,
        type,
        stream_id: streamId,
        seq,
        prev_hash: prevHash,
        occurred_at: occurredAt,
        actor: { role: "participant", id: p2.participantId },
        scope: {
          org_id: THERAPIST_SEED.org_id,
          participant_id: p2.participantId,
          session_id: sid,
          prescription_id: p2.prescriptionId,
          prescription_revision: p2.prescriptionRevision,
          exercise_id: "organizar-a-mesa",
        },
        source: { type: "participant_report", device_hint: "desktop-chrome" },
        execution_mode: "report_only",
        data_origin: "synthetic_fixture",
        payload,
      };
      return { ...base, hash: await hashCanonical(base) };
    }
    const e1 = await mkEv(1, null, "2026-10-05T14:00:00.000Z", "session.started", {
      source_mode: "report_only",
      prescription_id: p2.prescriptionId,
      prescription_revision: p2.prescriptionRevision,
      capture_context: null,
    });
    const e2 = await mkEv(2, e1.hash, "2026-10-05T14:05:00.000Z", "session.control", {
      action: "end",
      interrupt_reason: null,
    });
    const e3 = await mkEv(3, e2.hash, "2026-10-05T14:06:00.000Z", "report.submitted", {
      execution: "complete",
      assistance: "none",
      reporter_role: "participant",
    });
    const batch = await apiJson(apiBase, "POST", "/api/v3/events:batch", p2Auth.data.token, {
      events: [e1, e2, e3],
    });
    assert.equal(batch.status, 200);
    const pub = await therapistApproveAndPublish(apiBase, therapistToken, p2.participantId);
    other = { participantId: p2.participantId, ...pub };
  }

  return { therapistToken, p1, other };
}

/**
 * Therapist-side oracle (Rows 6, 7 & Step 6 setup): lists derived facts, verifies each via
 * POST /api/v3/facts/verify, approves summary-eligible facts, and publishes summary + evolution.
 */
async function therapistApproveAndPublish(apiBase, therapistToken, participantId) {
  const factsRes = await apiJson(
    apiBase,
    "GET",
    `/api/v3/participants/${participantId}/facts`,
    therapistToken
  );
  assert.equal(factsRes.status, 200);
  const facts = factsRes.data.facts || [];
  assert.ok(facts.length >= 3, `Expected >= 3 derived facts for ${participantId}, got ${facts.length}`);

  const verifiedTypes = new Set();
  const approvedItems = [];
  let minDate = null;
  let maxDate = null;

  for (const fact of facts) {
    const proposal = {
      type: fact.type,
      catalog_version: fact.catalog_version,
      params: fact.params,
      evidence_refs: fact.evidence_refs,
      scope: fact.scope,
      data_origin: fact.data_origin,
    };
    const verRes = await apiJson(apiBase, "POST", "/api/v3/facts/verify", therapistToken, proposal);
    assert.equal(verRes.status, 200, `facts.verify HTTP error: ${JSON.stringify(verRes.data)}`);
    assert.equal(verRes.data.valid, true, `facts.verify rejected derived fact ${fact.type}: ${JSON.stringify(verRes.data)}`);
    verifiedTypes.add(fact.type);

    const contentHash = verRes.data.content_hash;
    const revRes = await apiJson(apiBase, "POST", "/api/v3/reviews", therapistToken, {
      participant_id: participantId,
      fact_id: fact.fact_id,
      content_hash: contentHash,
      decision: "approve",
      note: "Aprovado no oracle S1-04.",
    });
    assert.equal(revRes.status, 201);

    if (fact.flags?.summary_eligible) {
      approvedItems.push({ fact_id: fact.fact_id, content_hash: contentHash });
      const d = fact.params.session_date_local;
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
  }

  const sumRes = await apiJson(apiBase, "POST", "/api/v3/summaries", therapistToken, {
    participant_id: participantId,
    items: approvedItems,
    period: { from: minDate, to: maxDate },
    note_refs: [],
  });
  assert.equal(sumRes.status, 201, `summaries.publish failed: ${JSON.stringify(sumRes.data)}`);

  const seriesRes = await apiJson(
    apiBase,
    "GET",
    `/api/v3/participants/${participantId}/evolution/series`,
    therapistToken
  );
  assert.equal(seriesRes.status, 200);
  const seriesKeys = (seriesRes.data.series || []).map((s) => s.series_key_hash);
  assert.ok(seriesKeys.length >= 1, "Expected >= 1 comparable evolution series");

  const evoRes = await apiJson(apiBase, "POST", "/api/v3/evolution", therapistToken, {
    participant_id: participantId,
    period: { from: minDate, to: maxDate },
    series_keys: seriesKeys,
  });
  assert.equal(evoRes.status, 201, `evolution.publish failed: ${JSON.stringify(evoRes.data)}`);

  return {
    facts,
    verifiedTypes: Array.from(verifiedTypes).sort(),
    summaryId: sumRes.data.summary_id,
    evolutionId: evoRes.data.evolution_id,
  };
}

/**
 * Row 1 / Row 4 / Row 5 / Row 6 oracle: inspect stored SQLite events via S0-03 validate_event,
 * CL06.3 REF (elo_ref.py), and S1b-01 evaluate_session_stream.
 */
function verifyStoredEventsWithRefAndPhaseRules(api, participantId, expectedControlAction) {
  const pyCode = `
import json, sqlite3, sys
from pathlib import Path

repo = Path(sys.argv[1])
db_path = sys.argv[2]
pid = sys.argv[3]
expected_symptom = sys.argv[4]

sys.path.insert(0, str(repo / "api" / "src"))
sys.path.insert(0, str(repo / "contracts" / "CL06_3-r1" / "reference" / "python"))

import elo_ref
from elo.v3.validation import validate_event, load_event_catalog, load_limits_catalog
from elo.v3.session_rules import evaluate_session_stream

conn = sqlite3.connect(db_path)
rows = conn.execute("SELECT data FROM v3_events WHERE participant_id = ? ORDER BY stream_id, seq", (pid,)).fetchall()
events = [json.loads(r[0]) for r in rows]

cat = load_event_catalog()
limits = load_limits_catalog()

by_stream = {}
rx_payload = None
consent_count = 0
report_unreported_found = False
symptom_stop_found = False

for ev in events:
    by_stream.setdefault(ev["stream_id"], []).append(ev)
    if ev["type"] == "prescription.published":
        rx_payload = ev["payload"]
    if ev["type"] == "consent.accepted":
        consent_count += 1
    if ev["stream_id"].startswith("session:"):
        assert ev["execution_mode"] == "report_only", f"Non report_only session event: {ev}"
        assert ev["data_origin"] == "synthetic_fixture", f"Non synthetic event: {ev}"
        assert ev["type"] != "session.completed", "session.completed forbidden in report_only"
        v_errs = validate_event(ev, gate_open=False)
        assert v_errs == [], f"S0-03 validate_event errors: {v_errs}"
        ref_sem = elo_ref.check_event_semantics(ev, cat, limits)
        assert ref_sem == [], f"REF check_event_semantics errors: {ref_sem}"
        ref_int = elo_ref.check_event_integrity(ev)
        assert ref_int == [], f"REF check_event_integrity errors: {ref_int}"
        if ev["type"] == "report.submitted" and ev["payload"]["assistance"] == "unreported":
            report_unreported_found = True
        if ev["type"] == "session.control" and ev["payload"]["action"] == expected_symptom:
            assert ev["payload"]["interrupt_reason"] is None
            symptom_stop_found = True

session_streams = [sid for sid in by_stream if sid.startswith("session:")]
assert len(session_streams) >= 2, f"Expected >= 2 session streams, got {len(session_streams)}"
for sid in session_streams:
    s_evs = by_stream[sid]
    chain_errs = elo_ref.check_stream_chain(s_evs)
    assert chain_errs == [], f"REF check_stream_chain errors on {sid}: {chain_errs}"
    rep = evaluate_session_stream(s_evs, rx_payload)
    assert rep.errors == [], f"S1b-01 evaluate_session_stream errors on {sid}: {rep.errors}"
    assert rep.state.phase == "ended", f"Expected ended phase on {sid}, got {rep.state.phase}"

assert consent_count == 0, f"Report-only journey must send 0 consent.accepted events, got {consent_count}"
assert report_unreported_found, "Expected report.submitted with assistance='unreported'"
assert symptom_stop_found, f"Expected session.control with action={expected_symptom!r}"

print(json.dumps({
    "ok": True,
    "session_streams": len(session_streams),
    "consent_accepted_count": consent_count,
    "unreported_stored": report_unreported_found,
    "symptom_stop_stored": expected_symptom,
}))
`;
  const proc = spawnSync(api.pythonBin, ["-c", pyCode, REPO_ROOT, api.dbPath, participantId, expectedControlAction], {
    env: { ...process.env, PYTHONPATH: api.pythonPath },
    encoding: "utf8",
  });
  assert.equal(proc.status, 0, `Python REF/phase oracle failed:\nSTDOUT: ${proc.stdout}\nSTDERR: ${proc.stderr}`);
  return JSON.parse(proc.stdout.trim());
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

function assertParticipantRequestsValid(browserRequests, contractMatchers) {
  const calledRoutes = new Set();
  for (const req of browserRequests) {
    // S2: exact authorized ARQ-08 modules (GET, same-origin static ES modules); every other non-v3 path stays forbidden.
    if (req.method === "GET" && /^\/s2\/arq08\/(activity_runner|simulation_source|capture_events|protocol|motion)\.mjs$/.test(req.pathname)) continue;
    // Approved read-only index views (docs/PROPOSTA_API_CONSOLE.md): GET only, no record content.
    if (req.method === "GET" && /^\/api\/console\/v1\/participants(\/[^/]+\/publications)?$/.test(req.pathname)) continue;
    assert.equal(
      req.pathname.startsWith("/api/v1"),
      false,
      `Forbidden /api/v1 request detected: ${req.method} ${req.pathname}`
    );
    assert.equal(
      req.pathname === "/index.html" ||
        (req.pathname.startsWith("/") &&
          !req.pathname.startsWith("/v3/") &&
          !req.pathname.startsWith("/api/v3/")),
      false,
      `Forbidden legacy/non-v3 request detected: ${req.method} ${req.pathname}`
    );
    if (req.pathname.startsWith("/api/v3/")) {
      const matched = matchContractEndpoint(contractMatchers, req.method, req.pathname);
      assert.ok(matched, `Undeclared /api/v3 request: ${req.method} ${req.pathname}`);
      assert.ok(
        matched.roles.includes("participant") || matched.roles.includes("anonymous"),
        `Non-participant route called during participant journey: ${matched.id} (${req.method} ${req.pathname})`
      );
      calledRoutes.add(`${matched.id} (${matched.method} ${matched.pathTemplate})`);
    }
  }
  return Array.from(calledRoutes).sort();
}

async function installGetUserMediaTrap(page) {
  await page.addInitScript(() => {
    window.__eloGetUserMediaCalls = 0;
    const trap = async () => {
      window.__eloGetUserMediaCalls += 1;
      throw new Error("getUserMedia must never be called in report-only mode");
    };
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        value: { getUserMedia: trap },
        configurable: true,
      });
    } else {
      navigator.mediaDevices.getUserMedia = trap;
    }
  });
}

async function assertOriginVisibleOnElements(page, selector, expectedOrigin, label) {
  const rows = await page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map((el) => {
      const badge = el.querySelector("[data-origin-label]");
      const visible =
        badge &&
        getComputedStyle(badge).display !== "none" &&
        getComputedStyle(badge).visibility !== "hidden";
      return visible ? (badge.textContent || "").trim() : "";
    });
  }, selector);
  assert.ok(rows.length > 0, `Expected >= 1 ${label} matching ${selector}`);
  for (const text of rows) {
    assert.ok(
      text.includes(expectedOrigin),
      `${label} missing visible origin label "${expectedOrigin}": got "${text}"`
    );
  }
}

async function assertParticipantDomClean(page, label) {
  const text = await page.evaluate(() => document.body.innerText || "");
  const forbidden = scanForbiddenOutputs(text);
  assert.deepEqual(forbidden, [], `Forbidden cmp-v1 outputs in ${label}: ${JSON.stringify(forbidden)}`);
  const leaks = scanParticipantSensitiveLeaks(text);
  assert.deepEqual(leaks, [], `Sensitive hashes/actor-ids/note_refs leaked in ${label}: ${JSON.stringify(leaks)}`);
}

async function assertBasicReportRequiresNoTyping(page) {
  const textInputCount = await page.evaluate(() => {
    const form = document.getElementById("form-report");
    if (!form) return -1;
    return form.querySelectorAll(
      'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea'
    ).length;
  });
  assert.equal(
    textInputCount,
    0,
    `Row 5 / Row 14(a) violation: basic report form (#form-report) must contain 0 text inputs/textareas, found ${textInputCount}`
  );
}

async function tabToSelector(page, selector, maxTabs = 120) {
  const already = await page.evaluate(
    (sel) => Boolean(document.activeElement && document.activeElement.matches(sel)),
    selector
  );
  if (already) return;
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

async function runPointerPass(browser, contractMatchers) {
  const api = await startPythonApi();
  const gateway = await startGateway(api.apiBase);
  const browserRequests = [];

  try {
    const { therapistToken, p1, other } = await setupTherapistSide(api.apiBase, true);

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await attachLoopbackGuardAndLog(context, gateway.origin, browserRequests);
    const page = await context.newPage();
    await installGetUserMediaTrap(page);

    // --- Row 9: Unauthenticated access redirects to sign-in with zero API calls ---
    await page.goto(`${gateway.origin}/v3/participant.html#sec-plan`, { waitUntil: "load" });
    await page.waitForFunction(() => window.location.hash === "#sec-signin");
    assert.equal(await page.locator("#error-banner").getAttribute("data-error-code"), "UNAUTHENTICATED");
    assert.equal(await page.locator("#error-banner").getAttribute("role"), "alert");
    assert.equal(await page.locator("#success-banner").isHidden(), true);
    assert.equal(browserRequests.filter((r) => r.pathname.startsWith("/api/")).length, 0);

    // --- Step 1: Sign in with invite token ---
    await page.fill("#invite-token", p1.inviteToken);
    await page.click("#btn-invite-signin");
    await page.waitForSelector("#signin-result:not([hidden])");

    const participantSession = await page.evaluate(() =>
      JSON.parse(window.sessionStorage.getItem("elo_v3_participant_session") || "null")
    );
    assert.ok(participantSession && participantSession.token);

    // --- Step 2: View prescription & goals ---
    await page.click("#btn-load-plan");
    await page.waitForSelector('#prescription-view[data-prescription-loaded="true"]');
    await page.waitForSelector('#goals-list li[data-goal-item="true"]');
    await assertOriginVisibleOnElements(page, "#prescription-view", "[Dados sintéticos]", "prescription view");
    await assertOriginVisibleOnElements(page, '#goals-list li[data-goal-item="true"]', "[Dados sintéticos]", "goal card");

    // --- Row 9 forced CONSENT_REQUIRED (D-S1-04-1): camera-mode session.started without camera consent ---
    await page.route(
      "**/api/v3/events:batch",
      async (route) => {
        if (route.request().method() === "POST") {
          const sid = `s_s104cam${Date.now().toString(36)}`;
          const streamId = `session:${sid}`;
          const evId = await hashCanonical({ seq: 1, stream_id: streamId });
          const camBase = {
            event_id: evId,
            schema_version: 3,
            type: "session.started",
            stream_id: streamId,
            seq: 1,
            prev_hash: null,
            occurred_at: new Date().toISOString(),
            actor: { role: "participant", id: p1.participantId },
            scope: {
              org_id: THERAPIST_SEED.org_id,
              participant_id: p1.participantId,
              session_id: sid,
              prescription_id: p1.prescriptionId,
              prescription_revision: p1.prescriptionRevision,
              exercise_id: "organizar-a-mesa",
            },
            source: { type: "camera", algorithm_version: "hand-v1", device_hint: "desktop-chrome" },
            execution_mode: "camera",
            data_origin: "synthetic_fixture",
            payload: {
              source_mode: "camera",
              prescription_id: p1.prescriptionId,
              prescription_revision: p1.prescriptionRevision,
              capture_context: { device_hint: "desktop-chrome", frame_width: 640, frame_height: 480 },
            },
          };
          const camEv = { ...camBase, hash: await hashCanonical(camBase) };
          await route.continue({ postData: JSON.stringify({ events: [camEv] }) });
        } else {
          await route.continue();
        }
      },
      { times: 1 }
    );
    await page.click("#btn-session-start");
    await page.waitForSelector('#error-banner[data-error-code="CONSENT_REQUIRED"]:not([hidden])');
    assert.equal(await page.locator("#error-banner").getAttribute("role"), "alert");
    assert.equal(await page.locator("#success-banner").isHidden(), true);
    assert.equal(await page.locator("#elo-live-region").getAttribute("aria-live"), "assertive");
    { // S1 Etapa E: the announcement is a friendly message (no internal code); the code stays in data-error-code.
      const live = await page.locator("#elo-live-region").textContent();
      assert.ok(live.trim().length > 10 && !live.includes("CONSENT_REQUIRED"), `live region must be a friendly message: ${live}`);
    }

    // --- Row 3 forced FORBIDDEN (D-S1-04-1): server-authored event through events:batch ---
    await page.route(
      "**/api/v3/events:batch",
      async (route) => {
        if (route.request().method() === "POST") {
          const streamId = `review:${THERAPIST_SEED.therapist_id}.${p1.participantId}`;
          const evId = await hashCanonical({ seq: 1, stream_id: streamId });
          const srvBase = {
            event_id: evId,
            schema_version: 3,
            type: "review.recorded",
            stream_id: streamId,
            seq: 1,
            prev_hash: null,
            occurred_at: new Date().toISOString(),
            actor: { role: "therapist", id: THERAPIST_SEED.therapist_id },
            scope: { org_id: THERAPIST_SEED.org_id, participant_id: p1.participantId },
            source: { type: "therapist" },
            execution_mode: "not_applicable",
            data_origin: "synthetic_fixture",
            payload: {
              fact_id: `f_${"a".repeat(64)}`,
              content_hash: "b".repeat(64),
              decision: "approve",
              note: null,
            },
          };
          const srvEv = { ...srvBase, hash: await hashCanonical(srvBase) };
          await route.continue({ postData: JSON.stringify({ events: [srvEv] }) });
        } else {
          await route.continue();
        }
      },
      { times: 1 }
    );
    // S1 integration (ARQ-05): the local-first start already left an unconfirmed session; the forced server refusal is
    // now exercised on the explicit "send pending" action (records stay saved locally, nothing is rebuilt).
    await page.click("#btn-sync-now");
    await page.waitForSelector('#error-banner[data-error-code="FORBIDDEN"]:not([hidden])');
    assert.equal(await page.locator("#error-banner").getAttribute("role"), "alert");
    assert.equal(await page.locator("#success-banner").isHidden(), true);
    { // S1 Etapa E: the announcement is a friendly message (no internal code); the code stays in data-error-code.
      const live = await page.locator("#elo-live-region").textContent();
      assert.ok(live.trim().length > 10 && !live.includes("FORBIDDEN"), `live region must be a friendly message: ${live}`);
    }

    // Recovery of the stale unconfirmed session: real send, then end + dismiss (allowed only once fully confirmed).
    await page.click("#btn-sync-now");
    await page.waitForSelector('#sync-panel[data-sync-status="synced"]');
    await page.click("#btn-session-end");
    await page.waitForSelector('#session-result[data-session-phase="ended"]');
    await page.waitForSelector('#sync-panel[data-sync-status="synced"]');
    await page.click("#btn-dismiss-report");
    await page.waitForSelector("#btn-dismiss-report", { state: "hidden" });

    // --- Step 3 & 4a: Normal report-only session + zero-typing basic report ("unreported") ---
    await assertBasicReportRequiresNoTyping(page);
    await page.click("#btn-session-start");
    await page.waitForSelector('#session-result[data-session-phase="active"]');
    await page.click("#btn-session-end");
    await page.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="end"]');

    await page.click('button[data-choice-group="execution"][data-choice-value="complete"]');
    await page.click('button[data-choice-group="assistance"][data-choice-value="unreported"]');
    await page.click("#btn-submit-report");
    await page.waitForSelector('#report-result[data-report-assistance="unreported"]');

    // --- Step 3 & 4b (Row 6): Single-action symptom stop ("Parar por dor") ---
    await page.click("#btn-session-start");
    await page.waitForSelector('#session-result[data-session-phase="active"]');
    await page.click("#btn-stop-pain");
    await page.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="pain"]');

    await page.click('button[data-choice-group="execution"][data-choice-value="partial"]');
    await page.click('button[data-choice-group="assistance"][data-choice-value="some"]');
    await page.click("#btn-submit-report");
    await page.waitForSelector('#report-result[data-report-assistance="some"]');

    // --- Rows 1, 4, 5, 6, 7 Oracle checks (outside participant browser traffic) ---
    const refOracle = verifyStoredEventsWithRefAndPhaseRules(api, p1.participantId, "pain");
    const pub = await therapistApproveAndPublish(api.apiBase, therapistToken, p1.participantId);
    for (const reqType of ["F02", "F03", "F04", "F08"]) {
      assert.ok(
        pub.verifiedTypes.includes(reqType),
        `Expected therapist oracle to derive & verify ${reqType}, got ${JSON.stringify(pub.verifiedTypes)}`
      );
    }

    // --- Step 5 & 6 (Row 8): Open participant's own published summary & evolution ---
    await page.fill("#summary-id-input", pub.summaryId);
    await page.click("#btn-open-summary");
    await page.waitForSelector(`#summary-view [data-participant-summary="${pub.summaryId}"]`);
    await assertOriginVisibleOnElements(page, "#summary-view [data-participant-summary]", "[Dados sintéticos]", "participant summary");

    await page.fill("#evolution-id-input", pub.evolutionId);
    await page.click("#btn-open-evolution");
    await page.waitForSelector(`#evolution-view [data-participant-evolution="${pub.evolutionId}"]`);
    await assertOriginVisibleOnElements(
      page,
      "#evolution-view [data-participant-evolution-series]",
      "[Dados sintéticos]",
      "participant evolution series"
    );
    await assertOriginVisibleOnElements(
      page,
      "#evolution-view [data-participant-evolution-item]",
      "[Dados sintéticos]",
      "participant evolution item"
    );

    // Verify Row 8: ZERO hashes, ZERO note_refs, ZERO actor IDs, ZERO cmp-v1 forbidden outputs
    await assertParticipantDomClean(page, "pointer pass after Step 6");

    // --- Row 9: Cannot open another participant's summary or evolution (404 accessible denial) ---
    await page.fill("#summary-id-input", other.summaryId);
    await page.click("#btn-open-summary");
    await page.waitForSelector('#error-banner[data-error-code="NOT_FOUND"]:not([hidden])');
    assert.equal(await page.locator("#error-banner").getAttribute("role"), "alert");
    assert.equal(await page.locator("#success-banner").isHidden(), true);

    await page.fill("#evolution-id-input", other.evolutionId);
    await page.click("#btn-open-evolution");
    await page.waitForSelector('#error-banner[data-error-code="NOT_FOUND"]:not([hidden])');
    assert.equal(await page.locator("#error-banner").getAttribute("role"), "alert");
    assert.equal(await page.locator("#success-banner").isHidden(), true);

    // Row 4: getUserMedia must never have been called
    const gumCalls = await page.evaluate(() => window.__eloGetUserMediaCalls || 0);
    assert.equal(gumCalls, 0, `getUserMedia was called ${gumCalls} times`);

    // Assert every participant browser request up to this point is strictly participant-allowed
    const calledRoutes = assertParticipantRequestsValid(browserRequests, contractMatchers);

    // --- Row 9: Participant token cannot perform therapist screen action (403 FORBIDDEN) ---
    const tPage = await context.newPage();
    await tPage.addInitScript((sess) => {
      window.sessionStorage.setItem("elo_v3_therapist_session", JSON.stringify(sess));
    }, participantSession);
    await tPage.goto(`${gateway.origin}/v3/therapist.html`, { waitUntil: "load" });
    await tPage.click("#technical-select > summary");
    await tPage.fill("#active-participant-id", p1.participantId);
    await tPage.click("#btn-select-participant");
    await tPage.waitForSelector('#error-banner[data-error-code="FORBIDDEN"]:not([hidden])');
    assert.equal(await tPage.locator("#error-banner").getAttribute("role"), "alert");
    assert.equal(await tPage.locator("#success-banner").isHidden(), true);

    await context.close();

    return {
      passed: true,
      get_user_media_calls: gumCalls,
      ref_and_phase_oracle: refOracle,
      verified_fact_types: pub.verifiedTypes,
      forced_errors_verified: ["CONSENT_REQUIRED", "FORBIDDEN"],
      authz_checks_verified: [
        "unauthenticated_redirect_to_signin",
        "other_participant_summary_404",
        "other_participant_evolution_404",
        "therapist_screen_action_403_forbidden",
      ],
      called_participant_routes: calledRoutes,
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
    const { therapistToken, p1 } = await setupTherapistSide(api.apiBase, false);

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await attachLoopbackGuardAndLog(context, gateway.origin, browserRequests);
    const page = await context.newPage();
    await installGetUserMediaTrap(page);

    // ZERO pointer events allowed in this pass.
    await page.goto(`${gateway.origin}/v3/participant.html`, { waitUntil: "load" });

    // Step 1: Sign in with invite token via keyboard
    await keyboardFillInput(page, "#invite-token", p1.inviteToken);
    await tabToSelector(page, "#btn-invite-signin");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#signin-result:not([hidden])");

    // Step 2: Load prescription & goals via keyboard
    await tabToSelector(page, "#btn-load-plan");
    await page.keyboard.press("Enter");
    await page.waitForSelector('#prescription-view[data-prescription-loaded="true"]');
    await page.waitForSelector('#goals-list li[data-goal-item="true"]');

    // Step 3 & 4a: Normal report-only session + zero-typing report ("unreported") strictly via keyboard
    await assertBasicReportRequiresNoTyping(page);
    await tabToSelector(page, "#btn-session-start");
    await page.keyboard.press("Enter");
    await page.waitForSelector('#session-result[data-session-phase="active"]');

    await tabToSelector(page, "#btn-session-end");
    await page.keyboard.press("Enter");
    await page.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="end"]');

    await tabToSelector(page, 'button[data-choice-group="execution"][data-choice-value="complete"]');
    await page.keyboard.press("Space");
    await tabToSelector(page, 'button[data-choice-group="assistance"][data-choice-value="unreported"]');
    await page.keyboard.press("Space");
    await tabToSelector(page, "#btn-submit-report");
    await page.keyboard.press("Enter");
    await page.waitForSelector('#report-result[data-report-assistance="unreported"]');

    // Step 3 & 4b (Row 6): Single-action fatigue stop strictly via keyboard
    await tabToSelector(page, "#btn-session-start");
    await page.keyboard.press("Enter");
    await page.waitForSelector('#session-result[data-session-phase="active"]');

    await tabToSelector(page, "#btn-stop-fatigue");
    await page.keyboard.press("Enter");
    await page.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="fatigue"]');

    await tabToSelector(page, 'button[data-choice-group="execution"][data-choice-value="partial"]');
    await page.keyboard.press("Space");
    await tabToSelector(page, 'button[data-choice-group="assistance"][data-choice-value="none"]');
    await page.keyboard.press("Space");
    await tabToSelector(page, "#btn-submit-report");
    await page.keyboard.press("Enter");
    await page.waitForSelector('#report-result[data-report-assistance="none"]');

    // Oracle check + therapist publishes summary & evolution
    const refOracle = verifyStoredEventsWithRefAndPhaseRules(api, p1.participantId, "fatigue");
    const pub = await therapistApproveAndPublish(api.apiBase, therapistToken, p1.participantId);
    for (const reqType of ["F02", "F03", "F04", "F08"]) {
      assert.ok(pub.verifiedTypes.includes(reqType));
    }

    // Step 5 & 6: Open summary & evolution strictly via keyboard
    await keyboardFillInput(page, "#summary-id-input", pub.summaryId);
    await tabToSelector(page, "#btn-open-summary");
    await page.keyboard.press("Enter");
    await page.waitForSelector(`#summary-view [data-participant-summary="${pub.summaryId}"]`);

    await keyboardFillInput(page, "#evolution-id-input", pub.evolutionId);
    await tabToSelector(page, "#btn-open-evolution");
    await page.keyboard.press("Enter");
    await page.waitForSelector(`#evolution-view [data-participant-evolution="${pub.evolutionId}"]`);

    await assertOriginVisibleOnElements(
      page,
      "#evolution-view [data-participant-evolution-series]",
      "[Dados sintéticos]",
      "keyboard-pass participant evolution series"
    );
    await assertParticipantDomClean(page, "keyboard-only pass after Step 6");

    const gumCalls = await page.evaluate(() => window.__eloGetUserMediaCalls || 0);
    assert.equal(gumCalls, 0);

    const calledRoutes = assertParticipantRequestsValid(browserRequests, contractMatchers);
    await context.close();

    return {
      passed: true,
      pointer_events_used: 0,
      get_user_media_calls: gumCalls,
      ref_and_phase_oracle: refOracle,
      verified_fact_types: pub.verifiedTypes,
      called_participant_routes: calledRoutes,
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
        ...pointerPass.called_participant_routes,
        ...keyboardPass.called_participant_routes,
      ])
    ).sort();

    const report = {
      passed: pointerPass.passed && keyboardPass.passed,
      task: "S1-04",
      page: "/v3/participant.html",
      pointer_pass: {
        passed: pointerPass.passed,
        get_user_media_calls: pointerPass.get_user_media_calls,
        verified_fact_types: pointerPass.verified_fact_types,
        forced_errors_verified: pointerPass.forced_errors_verified,
        authz_checks_verified: pointerPass.authz_checks_verified,
      },
      keyboard_pass: {
        passed: keyboardPass.passed,
        pointer_events_used: keyboardPass.pointer_events_used,
        get_user_media_calls: keyboardPass.get_user_media_calls,
        verified_fact_types: keyboardPass.verified_fact_types,
      },
      called_participant_routes: allRoutes,
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
