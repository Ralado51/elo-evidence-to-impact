# COMPONENT_INVENTORY (baseline ed50993)

## Backend `api/src/elo/v3/`
| Módulo | Responsabilidade | Observação |
|---|---|---|
| `router.py` | rotas HTTP v3 | |
| `auth.py`, `authz.py` | identidade, papéis, vínculo | CMP-09 |
| `store.py` | persistência | CMP-23 |
| `validation.py`, `entities.py` | validação de schema e semântica (código portado, paridade Py/JS — **não modificar**) | CMP-05/13 |
| `clinical.py` | entidades clínicas versionadas | CMP-13 |
| `prescriptions.py`, `evolution.py`, `reviews.py` | prescrição, evolução, revisão | CMP-13/18/19 |
| `verifier.py`, `ledger.py` | verificador e ledger (núcleo único de confiança) | CMP-17 |
| `session_rules.py` | regras de sessão/segurança | CMP-11 |
| `errors.py` | `V3Error` e códigos | CMP-03 |
| **`civil_date.py`** (novo) | datas civis | CMP-04 |

## Front `web/v3/`
`therapist_*`, `participant_*`, `painel_*` (app/model por superfície); `api_client.mjs` e `participant_api.mjs` (**dois clientes API**); `i18n*.mjs` (CMP-02); `ui_messages.mjs`; `a11y.mjs`; `canonical.mjs`; `tokens.*`, `base.css`. Novos: `civil_date.mjs`, `date_field.mjs`.

## Duplicações / sobreposições encontradas
| # | Duplicação | Tratamento |
|---|---|---|
| D-1 | 4 parsers de data (`reviews`, `evolution`, `verifier`, `prescriptions`) + regex do schema | **Resolvido em ARQ-01** (um dono) |
| D-2 | `showError/showSuccess/clearError/handleApiError` repetidos em therapist (4), participant (4), painel (2) | ARQ-04 |
| D-3 | Dois clientes de API (`api_client` × `participant_api`) | ARQ-04 (CMP-10) |
| D-4 | Códigos de erro de data diferentes por superfície (`RULE_VIOLATION` × `PATTERN`) | preservado por compatibilidade; unificar exige PO (PD-05) |
| D-5 | `counter.js` em `web/s2` e `web/counter.js` | fora de escopo (S2) |
