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

---

# TEST_EVIDENCE — ARQ-02 (baseline `8a9909b71604b85e23d21e768ade2764022f90df`)

Dados 100% sintéticos. Arquivos brutos em `evidence/arq02_*`.

## ANTES da implementação (mesmos testes contra o baseline)
| Camada | Resultado antes | Arquivo |
|---|---|---|
| Backend (`test_v3_arq02_idempotency.py`) | **39 falhas / 6 passes** (os 6 são casos de compatibilidade/ignorados que já valiam) | `arq02_before_backend.txt`, `arq02_before_backend_summary.txt` |
| Navegador (`s1_arq02_commands.mjs`) | **3 de 9 passam**: duplo clique e Enter+clique geram 2 envios/2 registros (D04/S1-03 reproduzidos); sem chave; resposta perdida duplica; sem janela segura; sem cabeçalhos no gateway | `arq02_before_browser.txt` |
| API completa | 420 passed | `arq02_before_api_full.txt` |

## DEPOIS
| Suíte | Resultado | Arquivo |
|---|---|---|
| `test_v3_arq02_idempotency.py` | 45 passed | `arq02_after_backend.txt` |
| `test_v3_arq02_contract_a1.py` (manifests r1 e A1, delta declarado, códigos, classes) | 5 passed | incluído em `arq02_after_api_full.txt` |
| API completa | **470 passed, 1 skipped, 1 deselected** (mesma deseleção das entregas anteriores); testes existentes não modificados | `arq02_after_api_full.txt` |
| Node (`node --test web/tests/*.test.mjs`) | **88 pass / 0 fail** (76 anteriores + 12 `command_controller.test.mjs`) | `arq02_after_node.txt` |
| Navegador `s1_arq02_commands.mjs` (CC-1..9) | **9/9** | `arq02_after_browser.txt` |
| A11y `run.mjs` | exit 0 | `arq02_a11y.txt` |
| Jornadas e2e, therapist, participant, s1_corr_ae, s1_corr_e01, s1_corr_e02e03, s1_stab_a, s1_stab_e, s1_arq01_dates | todas exit 0 | `arq02_<nome>.txt` |
| ruff (arquivos novos) / `api/src/elo/v3` | limpo / mesmo nível do baseline (erros pré-existentes) | — |
| `contracts/CL06_3-r1` | byte a byte intacto (manifest verificado por teste; `git diff` vazio) | — |

## Achados durante a verificação (corrigidos no código, sem alterar testes existentes)
1. Enter+clique chegava após o término do primeiro envio → janela anti-rajada de 500 ms; refinada para só ignorar **conteúdo idêntico** (a jornada E02 cria participantes distintos em sequência rápida).
2. A janela não pode bloquear com relógio retrocedido (`0 ≤ decorrido < janela`); teste dedicado.
3. A consulta de retenção (`/health`) no carregamento violava "zero chamadas de API sem sessão" da jornada do terapeuta → passa a ocorrer só com sessão ativa.

## Limitações
- Estado de intenção em memória (recarga descarta); reconciliação automática depende de ARQ-05.
- Não foi re-executado o conjunto dos 599 CA (por mandato); regressão proporcional.
- Participante/painel não consomem comandos `keyed` (sem alteração).
