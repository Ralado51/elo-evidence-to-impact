# web

Static bilingual interface (pt-BR and English), served by nginx at `/app/`. No framework.

## "At home" tab (between sessions)

- `counter.js`: hand open/close counter, pure logic (no DOM, no camera). `node web/test_counter.js` runs the synthetic tests.
  Known limit: at 700 ms per cycle (1.4 repetitions per second) it undercounts in about 19% of synthetic runs; tested from 800 ms.
- `hand.js`: camera panel. MediaPipe Hand Landmarker runs in the browser; the page draws only a skeleton on a black canvas.
  No `MediaRecorder`, `toDataURL`, `toBlob` or `getImageData`: nothing of the image is stored or sent. Only repetition counts leave the panel.
- The tab sends plan, sensor events, patient reports and draft claims to `POST /api/home/verify` and shows the verdict and reason for each claim.
- Draft claims here are built by rules. The local model's draft comes later; the verifier stays deterministic code.

## Canonical JSON & Hashing (CL06.3)

- `canonical.mjs`: RFC 8785 subset canonical JSON, SHA-256 hashing, `event_id`, `content_hash`, and per-stream `prev_hash` / duplicate-`seq` integrity checks (Node built-in `node:crypto` only).

## Accessibility Base (`web/v3/`)

- `v3/tokens.json` & `v3/tokens.css`: single-source design tokens with WCAG 2.x AA verified foreground/background contrast pairs (`>= 4.5:1` text, `>= 3:1` large text, UI, and focus ring against every background token).
- `v3/base.css`: enlarged `>= 3rem` (48×48 CSS px) targets, visible `:focus-visible` outline (`>= 3px`), `@media (prefers-reduced-motion: reduce)` neutralisation, and zoom-friendly `rem` typography/layout rules.
- `v3/index.html` & `v3/a11y.mjs`: labelled `pt-BR` application shell (skip link, landmarks, native controls, text+icon+colour status variants, single live region) and `announce(message, { politeness })` helper (browser built-ins only).
- Run all Node built-in web tests (canonical + v3 accessibility; signals pass/fail strictly via process exit code):

```bash
node --test web/tests/*.test.mjs
```

### Real-browser accessibility harness (`web/tests/browser/`)

- Serves `web/` over a loopback-only (`127.0.0.1`) Node `http` server, opens each entry listed in `web/tests/browser/pages.json` in headless Chromium via the PO-installed `playwright-core@1.65.1` (resolved by path from `ELO_PLAYWRIGHT_DIR`, defaulting to `~/hackathons/elo-platform/workspace/tools/playwright`), blocks any outbound request outside loopback, verifies rendered accessibility tree, keyboard traversal/skip-link/focus ring, `>= 48×48` CSS px targets, computed contrast, reflow at `320×640` and `640×800@2x`, reduced-motion durations `<= 0.01 ms`, and real-DOM `announce()` live-region isolation, and prints a deterministic JSON report (excluding `timings_ms`).
- Adding a new v3 screen requires only adding an entry to `web/tests/browser/pages.json`.
- Run from the repository root:

```bash
node web/tests/browser/run.mjs
```

Optional overrides: `--pages <path/to/pages.json>`, `--web-root <path/to/web>`, and `ELO_PLAYWRIGHT_DIR=<path/to/playwright>`.

### Therapist journey harness (`web/tests/browser/therapist_journey.mjs`, S1-03)

- Spawns the live Python `/api/v3` server (`uvicorn --factory elo.api:app_factory`) on loopback `127.0.0.1` with synthetic therapist seeds (`ELO_V3_DATA_ORIGIN=synthetic_fixture`), plus a loopback-only gateway serving `web/v3/**` and proxying `/api/v3/*`.
- Runs the full 8-step therapist journey on `web/v3/therapist.html` in headless Chromium in two independent passes — **pointer** and **keyboard-only** (zero pointer events) — using synthetic report-only sessions for `"organizar-a-mesa"`.
- Verifies live API state after every step, strict `/api/v3` contract-only requests (zero `/api/v1` or legacy web files), UI and API review-gate enforcement (`UNREVIEWED_FACT_IN_EVOLUTION`, `CONTENT_HASH_STALE`, `COMPARABILITY_VIOLATION`), visible origin labels and execution modes on every displayed fact/summary/evolution/timeline item, zero forbidden clinical outputs (`cmp-v1`), and role/link authorization denials (unauthenticated redirect to sign-in, participant 403, unlinked therapist 403/404).
- Run from the repository root:

```bash
ELO_PYTHON="${ELO_PYTHON:-python3}" node web/tests/browser/therapist_journey.mjs
```

Optional overrides: `ELO_PYTHON=<path/to/python3>`, `ELO_PLAYWRIGHT_DIR=<path/to/playwright>` (or `PW=<path/to/playwright>`). Exits `0` if and only if every check passes.

### Participant journey harness (`web/tests/browser/participant_journey.mjs`, S1-04)

- Spawns the live Python `/api/v3` server (`uvicorn --factory elo.api:app_factory`, preserving inherited `PYTHONPATH`) on loopback `127.0.0.1` with synthetic data (`ELO_V3_DATA_ORIGIN=synthetic_fixture`), plus a loopback-only gateway serving `web/v3/**` and proxying `/api/v3/*`.
- Runs the report-only `"Organizar a mesa"` participant journey (`web/v3/participant.html`, written from scratch per PO-F29) in headless Chromium in two independent passes — **pointer** and **keyboard-only** (zero pointer events) — verifying invite sign-in, prescription/goal views, report-only session (`getUserMedia` never called, zero `consent.accepted` per D-S1-04-1), zero-typing basic report (`"Não sei / prefiro não dizer"` → `"unreported"`), single-action symptom stops (`pain`/`fatigue`), S0-03 `validate_event` + CL06.3 `elo_ref.py` + S1b-01 phase rules + therapist `facts.verify` oracle (`F02`/`F03`/`F04`/`F08`), simplified participant summary/evolution views with origin labels and zero leaked hashes/actor IDs/forbidden outputs, forced `FORBIDDEN` and `CONSENT_REQUIRED` batch denials, cross-participant `404` and therapist-route `403` denials, and strict participant-only `/api/v3` network isolation.
- Run from the repository root:

```bash
ELO_PYTHON="${ELO_PYTHON:-python3}" node web/tests/browser/participant_journey.mjs
```

Optional overrides: `ELO_PYTHON=<path/to/python3>`, `ELO_PLAYWRIGHT_DIR=<path/to/playwright>` (or `PW=<path/to/playwright>`). Exits `0` if and only if every check passes.

### Integrated end-to-end journey harness (`web/tests/browser/e2e_journey.mjs`, S1-05)

- Drives the complete S1 product loop across both `web/v3/therapist.html` and `web/v3/participant.html` against a live loopback `/api/v3` server on synthetic data (`ELO_V3_DATA_ORIGIN=synthetic_fixture`), in both **pointer** and **keyboard-only** (`pointer_events_used: 0`) passes.
- Covers registration/care link, assessment, goal, `"Organizar a mesa"` report-only prescription, two participant report-only sessions with zero-typing reports, pre-review publication blocks (UI + API), fact approval, summary & two-session `cmp-v1` evolution publication (including R2/R11 assistance transition and unreported-session barrier check), participant simplified views, R4 therapist timeline order/labels, S0-03 `validate_event` + CL06.3 `elo_ref.py` + S1b-01 phase-rule checks, zero camera/microphone calls, and zero `/api/v1`, legacy, or pediatric exposure.
- Run from the repository root:

```bash
ELO_PYTHON="${ELO_PYTHON:-python3}" node web/tests/browser/e2e_journey.mjs
```

Optional overrides: `ELO_PYTHON=<path/to/python3>`, `ELO_PLAYWRIGHT_DIR=<path/to/playwright>` (or `PW=<path/to/playwright>`). Exits `0` if and only if every check passes.

## Run locally

All local execution uses **synthetic data only** (`ELO_V3_DATA_ORIGIN=synthetic_fixture`); never use real patient or pediatric data. Run all commands below from the repository root in WSL.

### 1. Prepare shell environment (WSL)

Ensure Node 24+, the PO-installed `playwright-core` directory, and a Python interpreter with the API dependencies (`fastapi`, `uvicorn`, `jsonschema`) are selected (nothing is installed):

```bash
export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"
export ELO_PLAYWRIGHT_DIR="${ELO_PLAYWRIGHT_DIR:-$HOME/hackathons/elo-platform/workspace/tools/playwright}"
if [ -z "${ELO_PYTHON:-}" ]; then
  for py in "$(command -v python3)" "$PWD/api/.venv/bin/python3" "$PWD/.venv/bin/python3" \
    "$HOME/hackathons/elo-platform/workspace/scratch/"*/venv/bin/python3; do
    if [ -x "$py" ] && "$py" -c "import fastapi, uvicorn, jsonschema" 2>/dev/null; then
      export ELO_PYTHON="$py"
      break
    fi
  done
fi
```

### 2. Start the `/api/v3` API (Terminal 1, loopback only)

```bash
mkdir -p /tmp/elo-v3-local
PYTHONPATH="$PWD/api/src${PYTHONPATH:+:$PYTHONPATH}" \
ELO_DATA_DIR="/tmp/elo-v3-local" \
ELO_V3_DATA_ORIGIN="synthetic_fixture" \
ELO_V3_THERAPIST_SEEDS='[{"therapist_id":"t_localdemo01","username":"terapeuta_demo","password":"senha-sintetica-demo","org_id":"o_localdemo01","display_label":"Terapeuta Sintético Demo"}]' \
"$ELO_PYTHON" -m uvicorn --factory elo.api:app_factory --host 127.0.0.1 --port 8000
```

Verify the API health endpoint:

```bash
curl -fsS http://127.0.0.1:8000/api/v3/health
```

### 3. Serve `web/v3` and proxy `/api/v3/*` (Terminal 2, loopback only)

Serves only `web/v3/**` at `/v3/*` and proxies `/api/v3/*` to `http://127.0.0.1:8000` (legacy root routes and `/api/v1/*` return `404`):

```bash
node -e '
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const v3Dir = path.resolve("web/v3");
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };
http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  if (u.pathname.startsWith("/api/v3/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() !== "host" && k.toLowerCase() !== "content-length" && typeof v === "string") headers[k] = v;
    }
    const up = await fetch(`http://127.0.0.1:8000${u.pathname}${u.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    const out = {};
    up.headers.forEach((v, k) => { if (k.toLowerCase() !== "transfer-encoding") out[k] = v; });
    res.writeHead(up.status, out);
    res.end(Buffer.from(await up.arrayBuffer()));
    return;
  }
  if (u.pathname.startsWith("/v3/")) {
    const fp = path.resolve(v3Dir, u.pathname.slice(4));
    if (fp.startsWith(v3Dir + path.sep) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      res.writeHead(200, { "content-type": mime[path.extname(fp)] || "application/octet-stream" });
      res.end(fs.readFileSync(fp));
      return;
    }
  }
  res.writeHead(404);
  res.end("Not found");
}).listen(8080, "127.0.0.1", () => console.log("web/v3 listening on http://127.0.0.1:8080/v3/therapist.html"));
'
```

Verify the `web/v3` screens respond (and legacy `/index.html` is not served):

```bash
curl -fsS -I http://127.0.0.1:8080/v3/therapist.html
curl -fsS -I http://127.0.0.1:8080/v3/participant.html
```

### 4. Run the browser suites H, J, P, and E (Terminal 3)

Each suite spawns its own isolated loopback API/gateway on ephemeral ports using synthetic data and exits `0` only if every check passes:

```bash
node web/tests/browser/run.mjs
node web/tests/browser/therapist_journey.mjs
node web/tests/browser/participant_journey.mjs
node web/tests/browser/e2e_journey.mjs
```

## Build notes

The Dockerfile fetches `@mediapipe/tasks-vision@1.2.3` and the hand model at build time, so the app serves them itself and the CSP stays `'self'`
(plus `'wasm-unsafe-eval'` for the wasm runtime). The build needs internet access to `registry.npmjs.org` and `storage.googleapis.com`.
Synthetic data only; never use real patient data.
