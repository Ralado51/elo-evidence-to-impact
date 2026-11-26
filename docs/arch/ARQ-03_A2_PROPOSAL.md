# ARQ-03 — Proposta normativa A2 (3.2.0) consolidada

**Status: PROPOSTA com ratificação técnica do PO (registro formal em `ARQ-03_PO_RATIFICATION_RECORD.md`). Nada aqui está implementado, exceto o item A2-01.** Baseline: commit `2881ced`. Pacotes `CL06_3-r1` (3.0.0) e `CL06_3-A1` (3.1.0) permanecem íntegros e congelados; A2 sairia como pacote novo (`contracts/CL06_3-A2/`, com `VERSIONS.json` e `INTEGRITY_MANIFEST.sha256`, no padrão do A1). A implementação funcional aguarda a liberação do gate pelo PO (D-01 e homologação independente do FIX-03/ARQ-02).

## 0. Premissas e fontes
- **Ratificação.** D-02..D-10 e P-01..P-08 foram ratificados pelo PO em 26/11/2026 (registro formal em `ARQ-03_PO_RATIFICATION_RECORD.md`). Onde a ratificação diverge das recomendações da matriz `0df7a51`, **vale a ratificação** (D-02: alternativa C; D-04: sem nova restrição de escrita; P-04: testes com `sessions`/`reps` preservados).
- **Fontes lidas:** planilha *Elo — Product Backlog* (exportação local de 26/11 17:36: 145 histórias, **599 critérios de aceite**, FIX x Histórias, Componentes V2.2; a planilha foi modificada no Drive às 17:54, depois do export — reexportar antes do gate); *Controle de Defeitos e Backlog S1* (lida no Drive, posição 26/11, revisão e780634); PO_DECISIONS_RATIFIED (PD-01..11), CONTRACT_EVOLUTION_PLAN, BUSINESS_RULES (RN004/005/006/008/009/014/015/022); schemas `goal`, `functional_assessment`, `instrumental_measurement`; `units.json`, `instrument-registry.json`, `limits.v1.json`; `clinical.py`, `entities.py`, `validation.py`.
- **Não existe** no Drive nem no repositório lista de instrumentos, itens, escalas, unidades clínicas ou faixas aprovadas (registro: `EXTENSIBLE_PENDING_VALIDATION_WITH_RAQUEL`; PX-04 pendente). **Nada foi inventado.**
- **Numeração de componentes (P-01, aprovada: numeração oficial do backlog).** **CMP-05** = ValidationRegistry; **CMP-06** = catálogos versionados + GoalTargetField, InstrumentSelector, MeasurementField, DoseField; **CMP-13** = entidades clínicas versionadas e regras semânticas no servidor.

## 1. Delta contratual consolidado

| ID | Mudança | Decisão | FIX | Natureza | Estado |
|---|---|---|---|---|---|
| A2-01 | `facts.list?include=reviews` → `effective_reviews` por `fact_id` (`decision`, `content_hash`, `event_id`, `note`) | ratificado 26/11 (FIX02-R01) | — | opt-in aditivo | **Implementado** (`e780634`/`2881ced`); só falta publicar no pacote A2 |
| A2-02 | Catálogo `goal-target-rules.v1`: `descriptive_text` ⇒ `value=null`,`unit=null`; `session_count` ⇒ `value` inteiro 1..100000, `unit` ∈ {`null`,`sessions`}; `repetitions` ⇒ `value` inteiro 1..100000, `unit` ∈ {`null`,`reps`}. O teto é técnico, não clínico. A unidade é **derivada automaticamente** pelo componente (sem edição livre). `measure_value`: **catálogo preparado, sem nova restrição de escrita na API** (D-04) | D-02 (alt. C), D-03, D-04 | FIX-03, FIX-21 | regra semântica de escrita (somente contagens e descritivo) | Proposto |
| A2-03 | `goal.payload.deadline` opcional (data civil real, DT-01), sem regra futuro/passado | D-05a | — (US-018/090) | campo aditivo no schema | Proposto |
| A2-04 | Instrumento derivado do registro: `instrument_id`/`instrument_version`/`status` devem coincidir com `instrument-registry.json` | D-06a | FIX-19, 20, 21 | regra semântica de escrita | Proposto |
| A2-05 | Catálogo `assessment-item-rules.v1`: R1 `value_type` governa o valor; R2 ternário (`not_assessed=true` ⇒ `value=null`; nulo ≠ zero); R3 `unit` só em `integer|number`; R4 `source=therapist_instrumental` com valor numérico exige `unit`; R5 `item_key` único na avaliação. **R6** (unidade ∈ registro e `item_key` ∈ catálogo do instrumento) só quando houver catálogo | D-08 | FIX-21 | regra semântica de escrita | Proposto (R6 dormente) |
| A2-06 | Convenção de erro: reutilizar códigos existentes (`RULE_VIOLATION`, `TYPE`, `OUT_OF_RANGE`, `ENUM`, `PATTERN`) com `details` **estruturado** (`rule`, `path`) **sem romper o envelope contratual vigente**; sem código novo | D-10 | todos | convenção em `details` | Proposto |
| A2-07 | Dose: **sem mudança de contrato**. Guarda do front derivada de `limits.v1` (≤10 séries, ≤100 repetições, produto ≤100; `sessions_per_week` 1..14 do schema) | D-09 | FIX-21 | nenhuma | Proposto (somente front) |
| — | **Fora do A2**: `measure_value` oculto na UI para novas metas, sem restrição nova na API (D-04); catálogo de instrumentos/itens e "validado" (D-06b, aguarda validação profissional); medição instrumental inalterada (D-07); status de meta: manter os três (D-05b) e adiar novos (D-05c) | — | — | — | Bloqueado/adiado |

**Identificadores de regra propostos (`details.rule`)** — registro `rules-registry.v1` no pacote A2: `goal.descriptive_no_numeric`, `goal.count_integer`, `goal.count_floor`, `goal.count_unit_compatible`, `goal.count_value_required`, `goal.deadline_civil_date`, `instrument.registry_mismatch`, `item.value_type_mismatch`, `item.not_assessed_requires_null`, `item.unit_not_allowed`, `item.instrumental_requires_unit`, `item.key_duplicate`. Mapeamento de código proposto (a confirmar nos vetores): unidade incompatível com o tipo → `RULE_VIOLATION`; fracionário → `TYPE`; zero, negativo ou ausência de valor nas contagens → `OUT_OF_RANGE`/`NULL_NOT_ALLOWED` conforme o validador existente. Distinção de itens (P-05): **não avaliado**, **desconhecido**, **valor observado** e **zero** são estados diferentes e nunca se convertem entre si. `not_assessed`×`assistance`: sem relação adicional.

**Catálogos e registros no pacote A2:** `goal-target-rules.v1.json`, `assessment-item-rules.v1.json`, `rules-registry.v1.json`; `units.json` e `instrument-registry.json` **reaproveitados sem alteração de conteúdo** (nenhuma unidade ou instrumento novo); `limits.v1.json` inalterado. Schema `goal` com `deadline` opcional (propriedade nova; `required` inalterado).

## 2. Matriz de compatibilidade de leitura e escrita

Legenda: ✔ compatível · ⚠ compatível com ressalva · ✖ rejeitado por desenho.

### 2.1 Leitura
| Leitor → fonte | Resposta/dado | Resultado | Observação |
|---|---|---|---|
| Cliente 3.0.0/3.1.0 → servidor A2, `facts.list` **sem** parâmetro | idêntica à atual | ✔ | teste `test_v3_verifier.py:1146` preservado |
| Cliente 3.x → `facts.list?include=reviews` | campo extra `effective_reviews` | ✔ | opt-in; ignorado por quem não pede |
| Cliente A2 → servidor 3.1.0 | `include=reviews` não suportado | ⚠ | servidor 3.1.0 ignora parâmetro de query desconhecido (verificado em `ffe1e22`: `facts_list` só lê `from`/`to`) → cliente A2 deve tratar ausência de `effective_reviews` como "não disponível", nunca como "não revisado" |
| Qualquer cliente → meta/avaliação **legada** (ex.: `session_count`+`kg`, instrumento `elo_hand_screen`) | registro append-only inalterado | ✔ | leitura **não** revalida semântica (validação só na escrita: `clinical._build_validated_entity`); exibido como "legado/fora do registro" |
| Cliente 3.x com validação **estrita** de schema → meta **com** `deadline` | schema 3.0.0 tem `additionalProperties:false` | ⚠ | só afeta clientes que validam resposta contra o schema antigo; o cliente JS atual não valida respostas contra schema (verificado: `api_client.mjs` não usa schema). Servidor omite `deadline` quando ausente → metas sem prazo idênticas (hash inalterado) |
| Participante → meta | projeção do participante | ✔ | rótulo de unidade lido de serialização única (legado tolerado) |

### 2.2 Escrita
| Escritor → servidor A2 | Entrada | Resultado | Observação |
|---|---|---|---|
| Cliente 3.x/A2 | meta válida pelas regras A2-02 | ✔ | |
| Cliente 3.x | `session_count`/`repetitions` com unidade incompatível (ex.: `kg`), valor 0, negativo, fracionário ou ausente (D06) | ✖ 400 | **mudança intencional** que corrige D06; `sessions`/`reps` e `null` continuam aceitos |
| Cliente 3.x | `descriptive_text` com valor ou unidade | ✖ 400 | |
| Cliente 3.x | `measure_value` (qualquer combinação hoje aceita) | ✔ sem mudança | **D-04:** sem nova restrição na API; UI oculta o tipo para novas metas |
| Cliente 3.x | instrumento fora do registro, versão ou status divergentes | ✖ 400 | com o registro atual só existe `custom_unvalidated`/`0`/`unvalidated_custom` |
| Cliente 3.x | item com `value_type`↔valor/unidade inconsistentes, `item_key` duplicado | ✖ 400 | |
| Revisão (nova versão) de meta/avaliação **legada** | payload completo é revalidado | ⚠ | corrigir o dado legado é condição para gravar nova versão (RN004: a versão antiga permanece). Precisa de mensagem clara por campo |
| Reenvio idempotente (A1) de operação aceita **antes** do A2 | `command_dedup` devolve a resposta armazenada | ✔ | sem revalidação (a confirmar em teste) |
| Eventos de ledger (`session.*`, `review.*`, `summary.*`) | sem mudança de schema | ✔ | A2 toca entidades e `facts.list`, não eventos |
| Hash/cadeia de entidades | `compute_entity_hash` sobre o payload | ✔ | `deadline` só entra no hash quando presente; hashes existentes inalterados |

### 2.3 Dados históricos
Nenhum registro é reescrito ou migrado. Metas/avaliações legadas continuam legíveis, listáveis e verificáveis (cadeia e hash). As regras valem para **novas escritas e novas versões**.

### 2.4 Mudanças comportamentais de escrita (declaração explícita)
**O A2 não é declarado integralmente retrocompatível** (P-07). Leitura e dados históricos são preservados; a **escrita** muda em: (1) metas de contagem com unidade incompatível, zero, fracionário ou sem valor; (2) `descriptive_text` com valor/unidade; (3) instrumento/versão/situação fora do registro; (4) itens de avaliação que violam R1–R5; (5) novas versões de registros legados, que passam a satisfazer as regras vigentes (P-08), com mensagem específica por campo e sem migração ou normalização silenciosa; (6) clientes com validação **estrita** de schema que recebam metas com `deadline` (potencial incompatibilidade).

### 2.5 Estratégia de versionamento e compatibilidade (a apresentar ao PO antes de congelar o pacote)
- **Versão:** A2 = **3.2.0** (menor), pacote novo; `schema_version` dos eventos inalterado; r1 3.0.0 e A1 3.1.0 intactos (verificados por manifest).
- **Declaração:** `VERSIONS.json` do A2 registra `read_compatible_with: [3.0.0, 3.1.0]` e `write_behavior_changes: [lista de §2.4]`, **sem** afirmar retrocompatibilidade integral.
- **Guia de migração e changelog** por regra (`rule_id` → mensagem → como corrigir), com vetores positivos/negativos Python e JS idênticos.
- **Adoção:** clientes A2 tratam ausência de `effective_reviews` como "indisponível"; nenhum dado legado é migrado; regras só em escrita.
- **Gate de congelamento:** revisão do PO sobre esta seção + relatório de compatibilidade (vetores, paridade de catálogos, hash do pacote) antes de qualquer congelamento.
