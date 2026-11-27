# Functional regression report — research/frontend-v3

Base: ARQ-04 candidate `b1e7a51` (unchanged). Branch diff: 4 HTML files (2 `<link>` + `data-ds`), new `web/v3/ds/**`, new scripts, docs. **No `.mjs`, API, contract, existing CSS or test file changed**, so functional behaviour cannot differ by code; the run below confirms it in a real browser with the new CSS.

| Check | Result |
|---|---|
| node unit tests (`web/tests/*.test.mjs`) | 137 / 137 pass (includes the static a11y tests over the HTML/CSS) |
| pytest (`api/tests`) | 524 passed, 1 skipped, 1 failed — the same pre-existing external failure `test_cl06_1_streams_fixtures_exact_parity` as at the ARQ-03 and ARQ-04 baselines |
| Browser suites, isolated one at a time, demo restarted each | **17 / 17 pass**: s1_arq04_context (9 FX37 assertions), s1_arq04_i18n, s1_arq03_fix01, s1_arq03_domain, s1_arq02_fix01, s1_arq02_fix03, s1_arq02_fix03b_concurrency, s1_arq02_commands, s1_arq01_dates, s1_corr_ae, s1_corr_e01, s1_corr_e02e03, s1_stab_a, s1_stab_e, therapist_journey, participant_journey, e2e_journey |
| Contracts | untouched (`git diff demo/claude -- contracts api` is empty) |
| Isolated environment | local demo on :8090/:8010; UAT not touched |

Caveat: the suites assert behaviour and ids, not appearance; visual review is the screenshots plus the human retest, which remains mandatory.
