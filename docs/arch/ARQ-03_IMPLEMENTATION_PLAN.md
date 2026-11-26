# ARQ-03 — Plano detalhado de implementação (CMP-05, CMP-06, CMP-13)

**Status: PLANO RATIFICADO (`ARQ-03_PO_RATIFICATION_RECORD.md`). Nenhum código, contrato ou teste foi alterado.** Baseline `2881ced`. **Implementação em standby:** condicionada ao parecer independente do Gemini sobre o FIX-37 na revisão `2881ced` e à liberação expressa do PO (D-01). Após a liberação, execução autônoma das oito fases, sem novas aprovações para decisões já estabelecidas. Não inicia ARQ-04, S2 nem altera ARQ-02. Sem push/deploy. Seções 1 e 2 do pedido (delta e matriz de compatibilidade) estão em `ARQ-03_A2_PROPOSAL.md` §1 e §2.

Prioridade: **FIX-03 → FIX-19 → FIX-20 → FIX-21** (FIX-03 é o único defeito confirmado, D06; FIX-19/20/21 são backlog de catálogo/derivação).

## 3. Inventário de arquivos impactados

### 3.1 Contratos (novo pacote; congelados intocados)
| Arquivo | Ação |
|---|---|
| `contracts/CL06_3-A2/` (`VERSIONS.json`, `INTEGRITY_MANIFEST.sha256`, `docs/AMENDMENT_A2_*.md`) | NOVO — padrão do A1; inclui A2-01 já implementado |
| `…/catalogs/goal-target-rules.v1.json`, `assessment-item-rules.v1.json`, `rules-registry.v1.json` | NOVO |
| `…/schemas/entities/goal.schema.json` | NOVO (cópia + `deadline` opcional); r1 e A1 intactos |
| `…/fixtures/a2/*.json` | NOVO — vetores positivos/negativos compartilhados Python e JS |
| `contracts/CL06_3-r1`, `CL06_3-A1` | **sem alteração** (verificado por manifest) |

### 3.2 Servidor (Python)
| Arquivo | Ação | Componente |
|---|---|---|
| `api/src/elo/v3/domain_rules.py` | NOVO — `RuleRegistry` (regra = `rule_id`, entidade, `path`, função pura) + regras A2-02/04/05 | CMP-05 (servidor) |
| `api/src/elo/v3/clinical.py` (`_build_validated_entity`, após `check_entity_civil_dates`, ~l.467) | EDITA — chama o registro; erro ⇒ `V3Error` com `details={rule,path}` | CMP-13 |
| `api/src/elo/v3/validation.py` | EDITA — `load_catalog()` genérico (reaproveita `load_limits_catalog`) | CMP-06 |
| `api/src/elo/v3/errors.py` | EDITA mínimo — helper de `details` (sem código novo) | — |
| `api/src/elo/v3/entities.py` | sem mudança (`check_entity_semantics` de ledger/cadeia permanece; regras A2 ficam **fora** de `validate_entity` para não afetar replay/leitura de legado) | — |
| `api/src/elo/v3/prescriptions.py`, `router.py` | sem mudança (31 operações preservadas; `limits-v1` já aplicado) | — |

### 3.3 Front (JS)
| Arquivo | Ação | Componente |
|---|---|---|
| `web/v3/validation_registry.mjs` | NOVO — registro de regras (mesmos `rule_id`/`path`), mensagens i18n, serialização | CMP-05 (front) |
| `web/v3/domain_fields.mjs` | NOVO — `GoalTargetField`, `InstrumentSelector`, `MeasurementField`, `DoseField` | CMP-06 |
| `web/v3/catalogs/*.json` + `scripts/sync_catalogs.py` | NOVO — cópias geradas dos catálogos A2/`limits.v1`/`units`/`instrument-registry` com `--check` de hash (sem endpoint novo) | CMP-06 |
| `web/v3/therapist.html` | EDITA — meta (l.225–238), avaliação (l.165–184), prescrição (l.282–290); **ids preservados**, padrões passam a ser válidos | CMP-06 |
| `web/v3/therapist_app.mjs` | EDITA — montagem dos corpos (≈l.1093, ≈l.1139), `handleApiError` passa a ler `details.path/rule` e anexar erro ao campo | CMP-05/06 |
| `web/v3/date_field.mjs` | EDITA mínimo — extrair `setFieldError`/reset para helper comum `field_error.mjs` (comportamento ARQ-01 idêntico) | reuso |
| `web/v3/participant_app.mjs` (~l.381) | EDITA — exibição de meta/unidade por serialização única; marcador "legado" | CMP-06 |
| `web/v3/i18n_pt.mjs`, `i18n_en.mjs` | EDITA — chaves de erro por regra e rótulos (paridade PT/EN testada) | — |
| `web/v3/therapist_model.mjs`, `api_client.mjs`, `command_controller.mjs` | **sem mudança** | — |

### 3.4 Testes
| Arquivo | Ação |
|---|---|
| `api/tests/test_v3_a2_domain_rules.py`, `test_v3_a2_vectors.py` | NOVO |
| `web/tests/validation_registry.test.mjs`, `domain_fields.test.mjs`, `catalog_parity.test.mjs` | NOVO |
| `web/tests/browser/s1_arq03_domain.mjs` | NOVO |
| `evidence/arq03_probe.py` | REAPROVEITADO como "antes/depois" |
| `api/tests/test_v3_goals.py` (`repetitions`+`"reps"`), `web/tests/browser/participant_journey.mjs` (`sessions`) | **NÃO substituir** (P-04): `sessions`/`reps` permanecem válidos nos respectivos tipos |
| `test_v3_evolution_timeline.py` (`kgf`/`cycles`), instrumentais, fixtures congeladas e testes históricos | **NÃO alterar** nesta entrega (P-04) |
| Qualquer teste cuja expectativa normativa precise mudar | justificativa e rastreabilidade **individuais** (cópia legada em `evidence/legacy/`); proibido enfraquecer asserções para obter suíte verde |
| **9 suítes de navegador que criam meta/avaliação pelos defaults da UI:** `e2e_journey`, `seed_demo`, `therapist_journey`, `s1_arq01_dates`, `s1_arq02_commands`, `s1_arq02_fix01`, `s1_arq02_fix03`, `s1_arq02_fix03b_concurrency`, `s1_corr_ae` | **não alteradas**: ids e fluxo preservados; os novos padrões da UI são válidos (meta `session_count`/3 com unidade **derivada automaticamente** (`sessions`); instrumento `custom_unvalidated` v0 `unvalidated_custom`, autorizados em P-04). Risco explícito: o instrumento padrão atual `elo_hand_screen` 1.0 **deixa de ser gravável**; a unidade `sessions` da meta continua válida |

## 4. Sequência de implementação

Cada fase: caracterização "antes" primeiro (sondas A01–A12, G10–G14, M02/M03/M05, R02–R09), depois regra, depois UI; commit identificável; gate de regressão completo (JS, Python, 9 suítes de navegador + `s1_arq02_*`); sem push.

| Fase | Entrega | Componentes | FIX | Gate de saída |
|---|---|---|---|---|
| **0 — Pré-condições** | D-01 liberado (parecer do Gemini sobre FIX-37 em `2881ced` + liberação expressa do PO); **reexportar as planilhas oficiais**; documentos normativos e registro de ratificação atualizados (feito) | — | — | liberação expressa do PO |
| **1 — Pacote A2 e catálogos** | `CL06_3-A2` com catálogos, regras, schema `goal`, vetores, manifest; `sync_catalogs.py --check`; testes de paridade de hash | CMP-06 | — | manifest verde; r1/A1 inalterados |
| **2 — ValidationRegistry** | `domain_rules.py` + `validation_registry.mjs` sem regras ativas além de `rules-registry`; encaixe em `clinical.py` com *no-op* provado | CMP-05, CMP-13 | — | suítes atuais 100% verdes (nenhum comportamento muda) |
| **3 — FIX-03 (D06)** | regras A2-02 + `GoalTargetField` (tipo define campos, unidade derivada automaticamente e sem edição livre, erro por campo) + marcador "legado" para combinações incompatíveis | CMP-13, CMP-06 | **FIX-03** | D06 reproduzido "antes" e rejeitado "depois"; `measure_value` oculto na UI; API sem restrição nova para ele |
| **4 — FIX-19/FIX-20** | A2-04 + `InstrumentSelector` (somente registro; sem id/versão/situação editáveis; "personalizado — não validado") | CMP-06 | **FIX-19, FIX-20** | A01–A03 rejeitadas; nenhum instrumento "validado" |
| **5 — FIX-21** | A2-05 R1–R5 + `MeasurementField` (zero × ausente × desconhecido) + unidade/versão derivadas | CMP-06, CMP-13 | **FIX-21** | A04–A12 rejeitadas conforme regra; RN008 provado |
| **6 — DoseField** | guarda de produto derivada de `limits.v1`; nunca ajusta dose | CMP-06 | (US-019/060) | R02–R09 bloqueadas no front **e** no servidor |
| **7 — Prazo e fechamento** | A2-03 `deadline` + exibição (US-090-CA01); relatório `ARQ-03_CORRECTION_REPORT`, rastreabilidade, bundle `elo-arq03.bundle` | CMP-13 | — | regressão total; pacote A2 pronto para ratificação |

Fases 3→5 seguem a prioridade pedida; 6 e 7 não bloqueiam os FIX. Itens de nível C (grandezas, catálogo de instrumentos, medição instrumental) **não entram** em nenhuma fase.

## 5. Critérios de aceite e testes correspondentes

IDs de teste: `PY` = pytest, `JS` = `node --test`, `BR` = navegador. CA = critério da planilha (599).

### FIX-03 (D06) — US-018 CA02/CA03 · RN004, RN008
| # | Critério | Teste |
|---|---|---|
| 3.1 | `session_count` com `unit="kg"` (ou `reps`) e `repetitions` com `sessions` rejeitados (400 `RULE_VIOLATION`, `details.path=$.payload.target.unit`, `rule=goal.count_unit_compatible`); `null` e a unidade canônica aceitos; a UI deriva a unidade sem edição livre | PY-A2-01, BR-A2-01 |
| 3.2 | `session_count`/`repetitions`: fracionário, zero, negativo e ausência de valor rejeitados; 1 e 100000 aceitos; teto técnico, sem aplicar o limite de dose 100 (P-02) | PY-A2-02 |
| 3.3 | `descriptive_text` com valor ou unidade rejeitado; null/null aceito | PY-A2-03 |
| 3.4 | `measure_value`: tipo **oculto na UI** para novas metas; a API **mantém o comportamento atual** (sem nova restrição, D-04); catálogo preparado e testado por paridade | PY-A2-04 (caracterização: comportamento inalterado), BR-A2-02 |
| 3.5 | Meta legada (`kg`) continua listada, com hash/cadeia válidos e marcador "legado"; nova versão exige correção | PY-A2-05, BR-A2-03 |
| 3.6 | Mesmos vetores em Python e JS (`fixtures/a2`) com o mesmo `rule_id`/`path` | JS-A2-01, PY-A2-06 |
| 3.7 | Erro aparece no campo (`aria-invalid`, `aria-describedby`), PT/EN, sem sucesso simultâneo | BR-A2-04 |

### FIX-19 / FIX-20 — US-017 CA01/CA05, US-023, RN005/RN006/RN009
| # | Critério | Teste |
|---|---|---|
| 4.1 | Instrumento inexistente, versão ≠ registro ou status divergente rejeitados (`instrument.registry_mismatch`) | PY-A2-07 |
| 4.2 | `custom_unvalidated` declarado como `validated_with_therapists` rejeitado | PY-A2-08 |
| 4.3 | UI sem campos editáveis de id/versão/situação; mostra "personalizado — não validado" | BR-A2-05 |
| 4.4 | Nenhum instrumento é apresentado como validado; registro inalterado (hash do `instrument-registry.json` no manifest) | JS-A2-02 |
| 4.5 | Avaliações legadas (`elo_hand_screen`) legíveis, marcadas "fora do registro" | PY-A2-09 |

### FIX-21 — US-017 CA02/CA03 · US-018 · US-019 · US-060 · RN008
| # | Critério | Teste |
|---|---|---|
| 5.1 | R1 tipo×valor (`integer` não aceita 1.5; `boolean` não aceita texto; `category` ≤80) | PY-A2-10 |
| 5.2 | R2 ternário: `not_assessed=true` com valor rejeitado; `0` aceito como valor real; nulo nunca vira zero | PY-A2-11, JS-A2-03 |
| 5.3 | R3 unidade em `category|boolean` rejeitada; R4 instrumental numérico sem unidade rejeitado | PY-A2-12 |
| 5.4 | R5 `item_key` duplicado rejeitado | PY-A2-13 |
| 5.5 | `not_assessed`×`assistance` **sem relação adicional** (P-05); estados não avaliado, desconhecido, valor observado e zero distintos e testados | PY-A2-14, JS-A2-03 |
| 5.6 | DoseField: produto >100, 0, fracionário, negativo bloqueados no front e no servidor; dose nunca ajustada | JS-A2-04, BR-A2-06, PY (existentes R02–R09) |

### Transversais
| Critério | Teste |
|---|---|
| `facts.list` sem parâmetro idêntico; A2-01 preservado (ratificação 26/11) | `test_v3_verifier.py:1146`, `test_v3_fix03_effective_reviews.py` |
| 31 operações preservadas; r1/A1 por manifest | `test_v3_reviews_summaries.py` (contagem), PY-A2-15 |
| Cópias de catálogo do front idênticas ao pacote A2 | JS-A2-05 (`catalog_parity`) |
| i18n PT/EN completo para as novas chaves | `i18n.test.mjs` (existente) |
| Regressão ARQ-01/02, D-FIX01-1, S1-03/08, FIX02-R01, concorrência | JS 100+, Python 478+, `s1_arq01_dates`, `s1_arq02_*`, `s1_stab_a/e`, `s1_corr_ae/e01` |
| Sem reescrita de dados legados; sem enfraquecer testes | revisão do diff + cópias em `evidence/legacy/` |

## 6. Decisões ainda pendentes

### 6.1 Clínicas (exigem a terapeuta ocupacional; **bloqueiam apenas o nível C**)
| ID | Pendência | Efeito enquanto aberta |
|---|---|---|
| D-04 | Grandezas, unidades e método de `measure_value` | tipo oculto na UI; servidor aplica só a parte mecânica |
| D-06b / PX-04 | Instrumentos, itens, escalas e unidades por item; critério para "validado" | só `custom_unvalidated`; R6 dormente |
| D-07 | Unidade × movimento, faixas, valores negativos, existência de UI (US-052) | sem regra e sem UI |
| D-05c | Novos status de meta (parcial, pausada…) | vocabulário fechado em 3 valores |
| — | Vocabulário de `category` por item; unidades `kgf`/`cycles` (usadas em fixtures, fora do registro) | valores livres ≤80; testes legados mantidos |
| FIX-23 | Divergência de lateralidade (decisão pendente na planilha) | **fora do ARQ-03** |

### 6.2 Do PO / técnicas — **todas resolvidas** em 26/11/2026 (ver `ARQ-03_PO_RATIFICATION_RECORD.md`)
| ID | Resultado |
|---|---|
| P-01 | Numeração oficial do backlog (CMP-05 / CMP-06 / CMP-13) |
| P-02 | Alternativa C: contagens com `unit` null ou canônica (`sessions`/`reps`), derivada automaticamente; piso 1; teto técnico |
| P-03 | ValidationRegistry + erro por campo compartilhado; **sem** FormController completo; parcela remanescente do CMP-05 registrada para tratamento posterior |
| P-04 | Parcial: testes com `sessions`/`reps`, `kgf`/`cycles`, históricos e fixtures preservados; padrões de avaliação e de meta autorizados; justificativa individual para qualquer mudança normativa |
| P-05 | Sem relação adicional `not_assessed`×`assistance`; R1–R5; R6 condicionado ao catálogo |
| P-06 | Rejeitar instrumento/versão/situação incompatíveis; sem edição livre; sem validação clínica automática |
| P-07 | `deadline` opcional (DateField + validação civil no servidor), sem regra de passado/futuro; A2 **não** declarado retrocompatível; estratégia de versionamento antes de congelar (A2 §2.4–2.5) |
| P-08 | Novas versões de legado cumprem as regras; original preservado; mensagens específicas; sem migração silenciosa |

**Pendências remanescentes (não bloqueiam o plano):** parcela remanescente do CMP-05 (FormController: dirty/touched); política de datas (futuro/passado) para `deadline`; reexportação das planilhas na Fase 0.

## 7. Estratégia de reutilização dos componentes existentes

| Existente | Reuso no ARQ-03 | Mudança |
|---|---|---|
| `check_entity_civil_dates` + hook em `clinical._build_validated_entity` (ARQ-01) | **modelo e ponto de encaixe** do `RuleRegistry` (mesmo formato: issues com `path`, `V3Error` `RULE_VIOLATION`, `details=[paths]`) | estende com `rule` |
| `ClinicalEntitySpec`/`ClinicalEntityService` | cada entidade declara suas regras de domínio | campo novo opcional |
| `load_limits_catalog` + `limits.v1.json` | fonte única da dose (servidor e cópia gerada para o front) | `load_catalog` genérico |
| `units.json`, `instrument-registry.json` | fonte única de unidade/instrumento; **conteúdo intacto** | nenhuma |
| `DateField` (`setFieldError`, listener de `reset`, `aria-invalid/describedby`) | padrão e helper de erro por campo para os quatro campos novos | extração para `field_error.mjs`, testes ARQ-01 preservados |
| `CommandController`/`slotOf`/`COMMAND_FORMS` (ARQ-02) | **sem mudança**; formulários seguem enviados pelos mesmos slots | nenhuma |
| `handleApiError`/`formatApiErrorMessage`/`ui_messages` | roteamento de `details.path` para o campo | estende |
| `canonical.mjs` (`hashCanonical`) | prova de paridade das cópias de catálogo | nenhuma |
| `therapist_model.mjs` (funções puras testáveis) | padrão para `domain_fields.mjs` (lógica pura + DOM fino) | nenhuma |
| `command_dedup` (A1) | reenvio de operação aceita não revalida | nenhuma |
| Sondas `evidence/arq03_probe.py` | base "antes/depois" | reaproveitada |

Sem nova biblioteca. **Um dono por regra:** a regra semântica vive no servidor e no catálogo versionado; o front mantém apenas guardas de UX derivadas do **mesmo** catálogo (cópia gerada, com teste de paridade). O que é novo: `domain_rules.py`, `validation_registry.mjs`, `domain_fields.mjs`, pacote A2 e script de sincronização.
