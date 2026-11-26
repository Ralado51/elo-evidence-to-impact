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
