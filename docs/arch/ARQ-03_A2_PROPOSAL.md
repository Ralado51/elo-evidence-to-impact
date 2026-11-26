# ARQ-03 — Proposta normativa A2 (3.2.0) consolidada

**Status: PROPOSTA. Nada aqui está implementado, exceto o item A2-01.** Baseline: commit `2881ced`. Pacotes `CL06_3-r1` (3.0.0) e `CL06_3-A1` (3.1.0) permanecem íntegros e congelados; A2 sairia como pacote novo (`contracts/CL06_3-A2/`, com `VERSIONS.json` e `INTEGRITY_MANIFEST.sha256`, no padrão do A1). A implementação funcional aguarda a liberação do gate pelo PO (D-01 e homologação independente do FIX-03/ARQ-02).

## 0. Premissas e fontes
- **Ratificação das D-02..D-10.** Não localizei no repositório, no Projeto nem nos chats um registro por decisão. Tratei como ratificadas as **recomendações da matriz `ARQ-03_PO_DECISION_MATRIX.md` (`0df7a51`)**, conforme a instrução do PO. Os subpontos que a matriz deixou em aberto estão em §6.2 do plano (P-01..P-08) e **não** foram presumidos.
- **Fontes lidas:** planilha *Elo — Product Backlog* (exportação local de 26/11 17:36: 145 histórias, **599 critérios de aceite**, FIX x Histórias, Componentes V2.2; a planilha foi modificada no Drive às 17:54, depois do export — reexportar antes do gate); *Controle de Defeitos e Backlog S1* (lida no Drive, posição 26/11, revisão e780634); PO_DECISIONS_RATIFIED (PD-01..11), CONTRACT_EVOLUTION_PLAN, BUSINESS_RULES (RN004/005/006/008/009/014/015/022); schemas `goal`, `functional_assessment`, `instrumental_measurement`; `units.json`, `instrument-registry.json`, `limits.v1.json`; `clinical.py`, `entities.py`, `validation.py`.
- **Não existe** no Drive nem no repositório lista de instrumentos, itens, escalas, unidades clínicas ou faixas aprovadas (registro: `EXTENSIBLE_PENDING_VALIDATION_WITH_RAQUEL`; PX-04 pendente). **Nada foi inventado.**
- **Numeração de componentes (a confirmar, P-01).** No backlog (Componentes V2.2): **CMP-05** = Form state e ValidationRegistry (pacote ARQ-01, ainda não implementado no código); **CMP-06** = Catálogos e controles de domínio, que contém *GoalTargetField, InstrumentSelector, MeasurementField, DoseField*; **CMP-13** = Entidades clínicas versionadas (`ClinicalEntitySpec`, regras por domínio). O mandato atribui os quatro campos ao CMP-13; o plano adota a divisão do backlog (campos e catálogos = CMP-06; ponto de encaixe das regras no servidor = CMP-13) e cobre os três.

## 1. Delta contratual consolidado

| ID | Mudança | Decisão | FIX | Natureza | Estado |
|---|---|---|---|---|---|
| A2-01 | `facts.list?include=reviews` → `effective_reviews` por `fact_id` (`decision`, `content_hash`, `event_id`, `note`) | ratificado 26/11 (FIX02-R01) | — | opt-in aditivo | **Implementado** (`e780634`/`2881ced`); só falta publicar no pacote A2 |
| A2-02 | Catálogo `goal-target-rules.v1`: `descriptive_text` ⇒ `value=null`,`unit=null`; `session_count`/`repetitions` ⇒ `value` inteiro 1..100000, `unit=null`; `measure_value` ⇒ `value` número obrigatório, `unit` ∈ `units.json` | D-02, D-03, D-04 (parte mecânica) | FIX-03, FIX-21 | regra semântica de escrita | Proposto |
| A2-03 | `goal.payload.deadline` opcional (data civil real, DT-01), sem regra futuro/passado | D-05a | — (US-018/090) | campo aditivo no schema | Proposto |
| A2-04 | Instrumento derivado do registro: `instrument_id`/`instrument_version`/`status` devem coincidir com `instrument-registry.json` | D-06a | FIX-19, 20, 21 | regra semântica de escrita | Proposto |
| A2-05 | Catálogo `assessment-item-rules.v1`: R1 `value_type` governa o valor; R2 ternário (`not_assessed=true` ⇒ `value=null`; nulo ≠ zero); R3 `unit` só em `integer|number`; R4 `source=therapist_instrumental` com valor numérico exige `unit`; R5 `item_key` único na avaliação. **R6** (unidade ∈ registro e `item_key` ∈ catálogo do instrumento) só quando houver catálogo | D-08 | FIX-21 | regra semântica de escrita | Proposto (R6 dormente) |
| A2-06 | Convenção de erro: reutilizar códigos existentes (`RULE_VIOLATION`, `TYPE`, `OUT_OF_RANGE`, `ENUM`, `PATTERN`) com `details = {rule, path}`; **sem código novo** | D-10 (alt. A) | todos | convenção em `details` | Proposto |
| A2-07 | Dose: **sem mudança de contrato**. Guarda do front derivada de `limits.v1` (≤10 séries, ≤100 repetições, produto ≤100; `sessions_per_week` 1..14 do schema) | D-09 | FIX-21 | nenhuma | Proposto (somente front) |
| — | **Fora do A2** (clínico/adiado): grandezas e métodos de `measure_value` (D-04), catálogo de instrumentos/itens e "validado" (D-06b), medição instrumental unidade×movimento (D-07), novos status de meta (D-05c) | — | — | — | Bloqueado até a terapeuta |

**Identificadores de regra propostos (`details.rule`)** — registro `rules-registry.v1` no pacote A2: `goal.descriptive_no_numeric`, `goal.count_integer`, `goal.count_floor`, `goal.count_no_unit`, `goal.measure_value_required`, `goal.measure_unit_in_registry`, `goal.deadline_civil_date`, `instrument.registry_mismatch`, `item.value_type_mismatch`, `item.not_assessed_requires_null`, `item.unit_not_allowed`, `item.instrumental_requires_unit`, `item.key_duplicate`. Mapeamento de código proposto (a confirmar nos vetores): violação entre campos → `RULE_VIOLATION`; não inteiro → `TYPE`; abaixo do piso → `OUT_OF_RANGE`; unidade fora do registro → `ENUM`.

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
| Cliente 3.x | `session_count`/`repetitions` com `unit`≠null, valor não inteiro ou <1 (D06) | ✖ 400 | **mudança intencional** que corrige D06 |
| Cliente 3.x | `descriptive_text` com valor ou unidade | ✖ 400 | |
| Cliente 3.x | `measure_value` sem valor/unidade ou unidade fora do registro | ✖ 400 | UI oculta o tipo até a validação clínica (D-04) |
| Cliente 3.x | instrumento fora do registro, versão ou status divergentes | ✖ 400 | com o registro atual só existe `custom_unvalidated`/`0`/`unvalidated_custom` |
| Cliente 3.x | item com `value_type`↔valor/unidade inconsistentes, `item_key` duplicado | ✖ 400 | |
| Revisão (nova versão) de meta/avaliação **legada** | payload completo é revalidado | ⚠ | corrigir o dado legado é condição para gravar nova versão (RN004: a versão antiga permanece). Precisa de mensagem clara por campo |
| Reenvio idempotente (A1) de operação aceita **antes** do A2 | `command_dedup` devolve a resposta armazenada | ✔ | sem revalidação (a confirmar em teste) |
| Eventos de ledger (`session.*`, `review.*`, `summary.*`) | sem mudança de schema | ✔ | A2 toca entidades e `facts.list`, não eventos |
| Hash/cadeia de entidades | `compute_entity_hash` sobre o payload | ✔ | `deadline` só entra no hash quando presente; hashes existentes inalterados |

### 2.3 Dados históricos
Nenhum registro é reescrito ou migrado. Metas/avaliações legadas continuam legíveis, listáveis e verificáveis (cadeia e hash). As regras valem para **novas escritas e novas versões**.
