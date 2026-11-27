# ARQ-04 — Implementation report (CMP-10, CMP-03, CMP-02)

Baseline accepted: `2654a5b` (ARQ-03 closed, A2 3.2.0 frozen). Data: synthetic only. No push, no deploy, no frozen contract touched.

## What was delivered
| Phase | Result |
|---|---|
| 1 | `context_store.mjs` — ContextStore/ContextGuard (reads: last requested wins, abort previous; writes: ticket captured before the await, never aborted; orphan notices per participant; `reset("logout")` is a boundary). 10 unit tests. |
| 2 | `http_transport.mjs` — single transport; `signal` on reads only. |
| 3–4 | Therapist, participant and painel migrated (`begin`/`capture`, switch at sign-in, reset at sign-out). Painel `rawFetch` takes a signal. Participant session events untouched (ARQ-05). |
| 5 | `feedback.mjs` — one implementation replaces three copies: exclusive states, announce dedup, owner scope (participant-owned feedback is cleared on switch; global feedback survives it), ErrorMapper for `details` object or list. |
| 6 | I-01: unit options relabelled on language switch (value unchanged). `legacyFindings` (pure, display-only) + "Legacy record" badge on participant goals and painel goal line; record shown exactly as stored. |
| 7 | Full isolated regression (see `evidence/arq04_regression.json`). |

## Cancelled request vs. processed write (requested check)
- Structural rule in `performRequest`: a `signal` is honoured **only for GET**. A signal handed to a write is ignored (HT-06).
- `ABORTED` is produced **only when our own signal aborted**. Before this change a write that failed with an `AbortError`-named network error would have been labelled ABORTED; it is now `NETWORK_ERROR` (unknown outcome), never "cancelled" (HT-07). Found and fixed during this check.
- A late write that completes after a context switch is not rendered; it becomes a reconciliation notice for the participant it belongs to, shown with a timeline reload when the therapist returns (FX37-01, FX37-09 confirms the record exists exactly once on the server).
- Defect found and fixed: the notice was overwritten by the reload's own success banner; the notice is now shown after the reload.

## FIX-37 — characterization converted to blocking assertions
`web/tests/browser/s1_arq04_context.mjs` (exit code ≠ 0 on any failure): FX37-01 goals.create late; 02 assessments.create late; 03 invites.create late; 04 timeline error late; 05 evolution-series error late; 06 facts.list late response; 07 facts.list late error; 08 logout with list in flight; 09 late write persisted once. `s1_arq04_i18n.mjs`: I-01 relabel, no raw keys (I-02), selection survives language switch. The Phase-0 characterization stays as the "before" record.

**Limitation to state plainly:** the original Gemini report (`ARQ-07_FIX37_VALIDATION_REPORT.md`, 8 scenarios) is not in the Drive or the repository; only the tracking sheet names part of the scenarios (late response, goals.create, reviews.record, facts.list, timeline.get). The suite covers every scenario the sheet and diagnostics describe. `reviews.record` is not separately asserted here. **Gemini should confirm one-to-one coverage of its eight scenarios** or supply the report.

## Test fixture defect (not a product defect)
The first version of the suite was flaky because `mk()` could return the previous participant's id (Alfa === Beta). Fixed: waits for a new id and asserts the fixtures differ. 3 consecutive green runs afterwards. The Phase-0 characterization suite still has that race.

## Not covered / carried over
- Legacy badge: unit-tested (`legacyFindings`) but no browser assertion on a seeded legacy goal; human integrated retest remains mandatory.
- FIX-37.4 (3-attempt exhaustion on facts load): risk not reproduced; no dedicated test.
- ErrorMapper is only unit-tested; per-item (`items[n]`) mapping deferred. FormController remains in the backlog (ARQ-07).
- I-01 covers the assessment unit select; the read-only goal unit field still shows the raw catalog value.

## Regression
pytest 524 passed / 1 skipped / 1 failed (pre-existing external `test_cl06_1_streams_fixtures_exact_parity`, same as baseline); node 137/137; catalogs in sync; 17 browser suites pass.
