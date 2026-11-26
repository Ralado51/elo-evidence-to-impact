# Handoff: demo layer (branch `demo/claude`)

Base: `development/elo-v2` (S0, S1a, S1b, S1 accepted by the factory; tip `6b3a90f`). Rules that still hold:
no push, `main` and `development/elo-v2` untouched, synthetic data only (`ELO_V3_DATA_ORIGIN=synthetic_fixture`),
the `/api/v3` contract is not changed by this branch.

## What this branch adds
- `web/v3/painel.html`, `painel.css`, `painel_app.mjs`, `painel_model.mjs`: therapist dashboard. Case summary and KPIs,
  evolution chart of reported assistance (from the approved comparable F04 series), approved sessions, timeline, and the
  "how Elo prevents exaggeration" panel that calls the real `POST /api/v3/facts/verify` with a faithful and a tampered claim
  (tampered claim returns `RECOMPUTE_MISMATCH`).
- `web/tests/browser/seed_demo.mjs`: builds a full synthetic case through the real pages (5 sessions, assistance full -> none,
  15 approved facts, summary and evolution published). Prints the participant id.
- `web/tests/browser/pages.json`: the dashboard is registered in the real-browser accessibility harness.

## Run it (WSL, repo root)
```bash
export ELO_PLAYWRIGHT_DIR="$HOME/hackathons/elo-platform/workspace/tools/playwright"
mkdir -p /tmp/elo-v3-local
PYTHONPATH="$PWD/api/src" ELO_DATA_DIR=/tmp/elo-v3-local ELO_V3_DATA_ORIGIN=synthetic_fixture \
ELO_V3_THERAPIST_SEEDS='[{"therapist_id":"t_localdemo01","username":"terapeuta_demo","password":"senha-sintetica-demo","org_id":"o_localdemo01","display_label":"Terapeuta Sintético Demo"}]' \
python3 -m uvicorn --factory elo.api:app_factory --host 127.0.0.1 --port 8000 &
# gateway: see "Run locally" in web/README.md (serves web/v3 at /v3 and proxies /api/v3)
node web/tests/browser/seed_demo.mjs --origin http://127.0.0.1:8080     # prints participant_id
# open http://127.0.0.1:8080/v3/painel.html?participant=<participant_id>   (login: terapeuta_demo)
```

## Checks (all green on this branch)
- `node --test web/tests/*.test.mjs` (59), `node web/test_counter.js`, `node web/tests/browser/run.mjs` (4 pages).
- API: `pytest` in `api/` = 394 passed, 1 skipped. `test_cl06_1_streams_fixtures_exact_parity` needs the CL06.1 fixtures
  from the PO's knowledge folder, so it only passes on the PO machine.

## Next steps, in order
1. Participant screen polish (`participant.html`): guided, larger, friendlier report-only session. Keep the data-* hooks the
   e2e harness uses (`web/tests/browser/e2e_journey.mjs`), or update the harness in the same commit.
2. S2-01 hand counter with camera (license decision A accepted: Apache-2.0 with attribution; NOTICE entry needed).
3. Landing and video script (`landing/`, `docs/roteiro-video.md`) aligned with the dashboard story: "AI drafts, code verifies".
4. Run `e2e_journey.mjs`, `therapist_journey.mjs`, `participant_journey.mjs` before any handoff back.

## S2-01 hand counter (done, synthetic only)
- Page `web/v3/contador.html` (+ `contador_app.mjs`, `contador_model.mjs`, `contador.css`). `web/v3/counter.js` is a copy of `web/counter.js` (a test enforces parity).
- Demo button runs a synthetic signal without camera; verified in Chrome (5 reps in 16 s, period 3 s).
- Camera mode needs `web/v3/vendor/{vision_bundle.mjs,wasm/,hand_landmarker.task}` (see `web/Dockerfile` for the pinned download). NOT tested with a real camera here: PO must test it.
- Results stay on screen; nothing is sent to the API (no contract for camera data yet).
