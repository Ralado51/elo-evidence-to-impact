# ARQ-03 — Rastreabilidade (decisão → implementação → teste)
| Item | Implementação | Teste |
|---|---|---|
| P-01 numeração CMP-05/06/13 | `domain_rules.py`, `validation_registry.mjs`, `domain_fields.mjs`, catálogos | — |
| P-02 alt. C (`goal.count_*`) | `goal_target_rules`; `goal-target-rules.v1.json` | PY `test_goal_vectors`, `test_goal_http_*`; JS-A2-01/02/03; BR-A2-01..05 |
| P-03 registry + erro por campo | `RuleRegistry`, `field_error.mjs` (DateField/CommandController preservados) | `test_v3_a2_registry_noop`, `validation_registry.test`, `s1_arq01_dates` |
| P-04 testes | ajuste único rastreado | `evidence/legacy_tests/README.md` |
| P-05 R1–R5 (R6 dormente) | `assessment_item_rules`; `buildItem/itemViolations` | `test_item_vectors`, `test_assessment_http_items`, `test_zero_unknown_*`; JS-A2-06/07; BR-A2-08/09 |
| P-06 instrumento derivado | `instrument_registry_rule`; InstrumentSelector | `test_instrument_vectors`, `test_assessment_http_instrument_registry`; JS-A2-04; BR-A2-06/07 |
| P-07 `deadline` | schema A2, `goal_deadline_rule` | `test_deadline_vectors`, `test_goal_http_deadline_*`; BR-A2-11 |
| P-08 legado | hook só em escrita | `test_legacy_goal_stays_readable_and_new_version_must_satisfy_rules` |
| D-04 UI oculta `measure_value` | `therapist.html` | BR-A2-01; `test_goal_http_accepts_valid_and_preserves_measure_value` |
| D-09 dose | `doseViolations` (limits.v1) | JS-A2-08; BR-A2-10 |
| D-10 erros | `rules-registry.v1` (`new_error_codes: []`) | `test_rules_registry_adds_no_error_codes` |
| A2-01 `effective_reviews` | preservado | `test_v3_fix03_effective_reviews`, `s1_arq02_fix03*` |
| Contratos congelados | não editados | `test_frozen_packages_untouched` |
| Paridade de catálogos | `sync_catalogs.py` | `test_web_catalogs_in_sync`, JS-A2-05 |
