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

## Build notes

The Dockerfile fetches `@mediapipe/tasks-vision@1.2.3` and the hand model at build time, so the app serves them itself and the CSP stays `'self'`
(plus `'wasm-unsafe-eval'` for the wasm runtime). The build needs internet access to `registry.npmjs.org` and `storage.googleapis.com`.
Synthetic data only; never use real patient data.
