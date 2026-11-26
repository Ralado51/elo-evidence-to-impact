# TEST_EVIDENCE — ARQ-01 (baseline ed5099356d38050a51f9b5de1e1c09ca57b2ce4a)

Dados 100% sintéticos. Arquivos brutos em `evidence/`.

## Defeito reproduzido ANTES da correção
| Camada | Resultado antes | Arquivo |
|---|---|---|
| Backend (`test_v3_civil_date.py`) | **16 falhas / 5 passes** — datas impossíveis (2026-02-30, mês 13, dia 00…) aceitas e persistidas | `arq01_before_backend.txt` |
| Navegador (`s1_arq01_dates.mjs`, no baseline) | **9 de 10 falham** (campos de texto livre; nada bloqueia) | `arq01_before_browser.txt` |

## DEPOIS
| Suíte | Resultado | Arquivo |
|---|---|---|
| `test_v3_civil_date.py` | 21 passed | `arq01_after_backend.txt` |
| API completa | **420 passed, 1 skipped, 1 deselected** (`test_cl06_1_streams_fixtures_exact_parity`, deselecionado como em entregas anteriores) | — |
| Node (`node --test web/tests/*.test.mjs`) | **76 pass / 0 fail** (inclui `date_field.test.mjs`, 6) | — |
| Navegador `s1_arq01_dates.mjs` (DF-1..10) | **passed** | `arq01_after_browser.txt` |
| A11y `run.mjs` | exit 0 (alvos ≥48px, foco ≥3px, tab order) | `arq01_a11y.txt` (baseline: `arq01_a11y_baseline.txt`) |
| Jornadas: e2e, therapist, participant, s1_corr_ae, s1_corr_e01, s1_corr_e02e03, s1_stab_a, s1_stab_e | todas exit 0 | `arq01_<nome>.txt` |
| ruff nos arquivos novos/alterados | limpo | — |

## Casos cobertos (mandato: "inexistentes, bissextos, vazios, formato inválido, intervalo invertido")
inexistentes (30/02, 31/04, mês 13, dia 00, 29/02/2026) · bissexto (29/02/2024 aceito e persistido verbatim; troca de idioma exibe 29/02/2024) · vazio obrigatório · formato inválido (`23-11-2026` → `PATTERN`; `\n` final rejeitado) · intervalo invertido (prescrição, care_link) · data final opcional vazia · mesmo dia válido · chamada direta à API (400, nada persiste) · erro retraduzível sem requisição · teclado (Enter não envia).

## Limitações
- Falha da a11y na primeira tentativa foi artefato do harness (Tab entre segmentos do controle de data lido como armadilha); ajustado de forma declarada (AD-06), baseline e demais checks inalterados.
- Não foi re-executado o conjunto dos 599 CA (por mandato); regressão proporcional apenas.
- Picker nativo segue o locale do navegador.
