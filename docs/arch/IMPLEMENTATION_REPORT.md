# IMPLEMENTATION_REPORT

## ARQ-01 — DateField + validação civil de datas
- **Componente:** CMP-04 (+ parte de CMP-03 e CMP-05)
- **Histórias impactadas:** US-017 (principal); consumidores nas jornadas de avaliação, prescrição, resumo e evolução (US-018, US-031, US-038 apenas como vizinhas; não alteradas)
- **CA relacionados:** critérios de validação de data das histórias acima; **status oficiais de homologação não modificados**; critérios não alterados
- **Defeitos tratados:** FIX-01 (D03). FIX-22 mantido (PD-01)
- **Arquivos modificados:** `api/src/elo/v3/{clinical,prescriptions,reviews,evolution,verifier}.py`; `web/v3/{therapist.html,therapist_app.mjs,i18n.mjs,i18n_pt.mjs,i18n_en.mjs,base.css}`; `web/tests/browser/{e2e_journey,checks}.mjs`
- **Arquivos novos:** `api/src/elo/v3/civil_date.py`, `web/v3/{civil_date,date_field}.mjs`, testes (`api/tests/test_v3_civil_date.py`, `web/tests/date_field.test.mjs`, `web/tests/browser/s1_arq01_dates.mjs`, `web/tests/fixtures/civil_date_vectors.json`), `docs/arch/*`
- **Testes e resultado:** ver `TEST_EVIDENCE.md` (todos verdes)
- **Commit:** o commit HEAD desta entrega (SHA informado na mensagem de entrega; um commit não contém o próprio SHA)
- **Limitações/risco residual:** PD-01, PD-05, PD-07, PD-08; picker no locale do navegador; dados históricos inválidos não migrados
- **Sem alteração de contrato/API, schemas, regras clínicas ou escopo.**

## ARQ-02 — CommandController + idempotência transacional
- **Componentes:** CMP-07, CMP-08, CMP-25 (guardas/harness de ARQ-02)
- **Defeitos relacionados:** D04, S1-03, FIX-02, FIX-18 — **status oficiais não alterados; sem marcação de homologado** (ver `ARCHITECTURE_IMPACT_ANALYSIS.md`)
- **Decisões:** PD-02 ratificada (Q1–Q6) → AD-07..AD-11; adendo A1 (contracts 3.1.0) em `contracts/CL06_3-A1/`
- **Arquivos novos:** `api/src/elo/v3/command_dedup.py`, `web/v3/command_controller.mjs`, `contracts/CL06_3-A1/**`, testes (`test_v3_arq02_idempotency.py`, `test_v3_arq02_contract_a1.py`, `command_controller.test.mjs`, `s1_arq02_commands.mjs`), `docs/arch/evidence/arq02_*`
- **Arquivos modificados:** `api/src/elo/v3/{errors,router,store}.py`; `web/v3/{api_client,therapist_app,i18n_pt,i18n_en}.mjs`; `scripts/gateway.mjs`; docs `docs/arch/*`
- **Testes:** ver `TEST_EVIDENCE.md` (antes/depois)
- **Preservados:** `contracts/CL06_3-r1` byte a byte; testes existentes não alterados; PD-01, PD-05, PD-07, PD-08 pendentes; ARQ-03 e S2 não iniciados; sem push/deploy.
