# ARQ-03 — Matriz de decisões para ratificação do PO (D-02 a D-10)

> **Superada nos pontos divergentes por `ARQ-03_PO_RATIFICATION_RECORD.md` (26/11/2026):** D-02 (alternativa C), D-04 (sem nova restrição de escrita na API) e P-04 (testes com `sessions`/`reps` preservados). Mantida como histórico das recomendações.

Base: diagnóstico `e7a7300`; baseline funcional atual `ffe1e22` (ARQ-02 fix02). **Somente documentação: nenhum código, contrato ou teste foi alterado.** Gate do ARQ-02 (D-01) permanece pendente; nada aqui autoriza implementação.

## 0. Fontes consultadas e correção de limitação

Desta vez foram lidos **integralmente** (exportação `.xlsx` do Drive): *Elo — Product Backlog* (145 histórias, 599 critérios de aceite, FIX x Histórias, Componentes V2.2) e *Elo — Controle de Defeitos e Backlog S1* (D01–D07, S1-01..07, E-01..03, FIX-01..36). A limitação declarada no `ARQ-03_DIAGNOSTIC.md` §2 (FIX-17..36 e texto dos 599 CA ilegíveis) **fica superada**. Também lidos: PO_DECISIONS_RATIFIED, PO_DECISIONS_REQUIRED v2.1, DATA_MODEL_V2, DATA_MODEL_DETAILED (campos de contrato), CONTRACT_EVOLUTION_PLAN, BUSINESS_RULES (RN001–023), PROPOSTA V2.2 (DT-04, CMP-06/13, ARQ-03), e no repositório: schemas `goal`, `functional_assessment`, `instrumental_measurement`, `prescription.published`, `units.json`, `instrument-registry.json`, `limits.v1.json`, `errors.py`, `entities.py`, formulários e testes.
Resultado da busca por catálogo clínico no Drive: **não existe** lista de instrumentos, itens, escalas, unidades de medida clínica nem faixas de valores aprovadas. O único registro é `instrument-registry.json`, que declara `EXTENSIBLE_PENDING_VALIDATION_WITH_RAQUEL`, e **PX-04** (instrumentos que os terapeutas usam) continua pendente no PO_DECISIONS_REQUIRED. Nada será inventado.

Status das fontes normativas: PO_DECISIONS_RATIFIED (PD-01..11), BUSINESS_RULES e os CA são **ratificados/vigentes**; a PROPOSTA V2.2 (incl. DT-04) é **proposta**, ainda não ratificada.

## 1. Classificação técnica × clínica

| Natureza | Decisões | Quem decide |
|---|---|---|
| **Técnica / de produto** (sem conteúdo clínico) | D-02, D-03, D-05 (prazo e vocabulário existente), D-06a, D-08, D-09, D-10 | PO |
| **Clínica** (conteúdo de domínio) | D-04 (métodos, unidades, grandezas), D-06b (instrumentos, itens, escalas, situação "validado"), D-07 (unidade × movimento, faixas, valores negativos), eventual ampliação do vocabulário de status de meta (D-05c) | PO **com validação da terapeuta ocupacional (Raquel)** |

Regra de ouro adotada: o **mecanismo** (derivar, bloquear, não editar livremente) é técnico e pode ser ratificado já; o **conteúdo** (quais instrumentos/unidades existem) é clínico e fica vazio até validação.

## 2. Matriz objetiva de ratificação

Legenda de prioridade: ★ = FIX-03/19/20/21. Recomendação: **Aprovar**/**Aprovar com ajuste**/**Adiar**.

| ID | Decisão (pergunta ao PO) | Natureza | FIX | Recomendação técnica | Contrato | Dados históricos | Terapeuta? |
|---|---|---|---|---|---|---|---|
| D-02 ★ | Regra de `session_count` e `repetitions` | Técnica | FIX-03, FIX-21 | `value` inteiro **1..100000**; `unit` **proibida** (null): a unidade já está em `kind`. Legado `sessions`/`reps` tolerado na leitura, nunca regravado | Catálogo + regra semântica (A2); schema 3.0.0 intacto | Preservado; marcado "legado" na exibição | Não |
| D-03 ★ | `descriptive_text` exige `value=null` e `unit=null` | Técnica | FIX-03 | Aprovar (DT-04 já descreve) | Regra semântica (A2) | 11 ocorrências nas fixtures, todas null/null | Não |
| D-04 ★ | `measure_value`: métodos, unidades e grandezas aprovados | **Clínica** | FIX-03, FIX-21 | Mecânica agora: `value` obrigatório e `unit` ∈ `units.json`; **bloquear/ocultar** `measure_value` na UI até a terapeuta definir grandezas; sem ampliar registro | Registro de unidades (nova revisão) só com aprovação clínica | Preservado | **Sim** |
| D-05a | Prazo da meta: campo opcional | Técnica | — (US-018/090) | Aprovar `deadline` opcional, data civil (DateField/DT-01), sem regra futuro/passado até política de datas (PD pendente) | **A2 aditivo** (3.2.0) | Metas sem prazo = "sem prazo" | Não |
| D-05b | Vocabulário de status = `active`, `achieved_confirmed`, `discontinued` (já no contrato) | Técnica | — | Confirmar como **fechado**; RN014/US-090-CA03 já atendidos (confirmação já aplicada no servidor) | Nenhum | Nenhum | Opcional |
| D-05c | Acrescentar estados (ex.: parcial, pausada) | Clínica/produto | — | **Adiar**; sem história/CA que exija | A2 se aprovado | — | **Sim** |
| D-06a ★ | Instrumento: versão e situação **derivadas do registro**; rejeitar instrumento/versão/situação fora do registro; UI sem id/versão/situação editáveis | Técnica | FIX-19, FIX-20, FIX-21 | Aprovar. Com o registro atual só existe `custom_unvalidated` v0 / `unvalidated_custom`, exibido explicitamente como "personalizado — não validado" | Regra semântica + códigos (ver D-10) | Registros com outro id/versão ficam legíveis, marcados "fora do registro" | Não |
| D-06b ★ | Quais instrumentos, itens, escalas e unidades por item existem; quando um instrumento passa a `validated_with_therapists` | **Clínica** | FIX-19, FIX-20 | **Adiar** até PX-04; nenhum instrumento pode ser "validado" sem fonte e aprovação profissional | Revisão do registro (A2+) | — | **Sim** |
| D-07 | Medição instrumental: unidade × movimento, faixas, negativos; haverá UI? | **Clínica** | — (US-052) | **Não** implementar regra nem UI no ARQ-03. Risco: teste congelado usa `pinch_force`/`kgf`, fora do registro | Nenhum agora | — | **Sim** |
| D-08 ★ | Consistência dos itens de avaliação (tipo, valor, unidade, não avaliado, chave duplicada) | Técnica | FIX-21 | Aprovar o conjunto R1–R6 (§3.D-08), com representação ternária RN008 | Regras semânticas (A2) | Dados antigos preservados; a regra vale para novas escritas | Não (R1–R5) |
| D-09 | Dose: guarda de produto no front e fontes dos limites | Técnica | — (US-019/060) | Aprovar: guarda derivada de `limits.v1`; `sessions_per_week` 1..14 do contrato; exercício/movimento seguem `const` | Nenhum | Nenhum | Não |
| D-10 | Rota de contrato | Técnica | todos | **Addendum A2 (3.2.0)** aditivo; reutilizar códigos existentes (`RULE_VIOLATION`, `OUT_OF_RANGE`, `TYPE`, `PATTERN`) com `details.rule`; novos códigos só se o PO exigir | A1 3.1.0 e r1 3.0.0 intactos | Leitura de 3.0.0/3.1.0 preservada | Não |

## 3. Detalhamento por decisão

### D-02 — `session_count` e `repetitions` (★ FIX-03, FIX-21; D06)
- **Regra implementada hoje:** `goal.target` valida campo a campo: `kind` enum; `value` número|null 0..100000; `unit` token|null. Sem regra entre campos. Sondas no HEAD: aceitos `session_count` com `kg` (D06), 2.5, 0, null/null, `deg`; `repetitions` com `kg`, 10.5 e 5000. Só negativo é rejeitado (`OUT_OF_RANGE`). UI: unidade em texto livre, padrão "sessions".
- **Fundamentação:** DT-04 (proposta): "`session_count` e `repetitions` exigem inteiro com unidade canônica correspondente… não aceitar kg para contagem"; PROPOSTA V2.2 §2 (matriz tipo→valor→unidade ausente); CMP-05 ("null separado de zero"); RN008; RN004 (preservar versões).
- **Histórias/CA:** US-018 (CA02 critério de alcance; CA03 nova versão sem apagar), US-090 (CA01 critério e status), US-021 não. FIX-03, FIX-21, D06.
- **Alternativas:** (A) `unit` proibida, `value` inteiro ≥1; (B) `unit` obrigatória com token canônico (`sessions`/`reps`); (C) `unit` opcional mas, se presente, igual ao canônico; (D) só guarda no front (rejeitada: viola "servidor é a autoridade").
- **Recomendação:** **A**. O tipo (`kind`) já determina a grandeza; qualquer unidade em contagem só cria o defeito D06. Evita decidir um token novo. Nos testes existentes: `session_count` com `unit` null (2 casos em `test_v3_evolution_timeline.py`), com `"sessions"` (1 caso em `participant_journey.mjs`, padrão da UI) e `repetitions` com `"reps"` (4 casos em `test_v3_goals.py`). Legado `"sessions"`/`"reps"` é lido e exibido como equivalente, **nunca reescrito**. Piso 1 (meta de 0 sessões não tem uso descrito nos CA); teto = o do schema (100000), **sem** aplicar o limite de dose 100, que é de prescrição por sessão, não de meta acumulada. Ponto para o PO: confirmar piso 1.
- **Contrato/dados:** sem mudança de schema; regra em catálogo `goal-target-rules.v1` (A2). Os testes existentes com `repetitions`+`reps` (`test_v3_goals.py`) passariam a ser caso "legado" na escrita → PO decide se esses testes são substituídos (com rastreabilidade, como no fix02) ou se a escrita aceita o alias canônico.
- **Terapeuta:** não necessária (não é conteúdo clínico).

### D-03 — alvo descritivo
- **Hoje:** aceita `value=5`, `unit=kg` (G10). UI já zera ambos (`therapist_app.mjs` ~1086); API não.
- **Fundamentação:** DT-04 ("alvo descritivo exige null nos campos numéricos"); CMP-13.
- **Alternativas:** (A) exigir null/null; (B) ignorar silenciosamente os numéricos (**rejeitada**: converte dado silenciosamente).
- **Recomendação:** A; rejeitar, não normalizar. Impacto: nas fixtures JSON dos contratos, as 11 ocorrências de `descriptive_text` já são null/null; nenhuma viola. Terapeuta: não.

### D-04 — `measure_value` (★ clínica)
- **Hoje:** aceita null/null (G12), unidade inexistente `banana` (G13), `deg` (G14). `units.json` tem só `1` e `deg`; fixtures usam também `cycles` e `kgf`, **fora do registro**. O alvo não tem campo de método.
- **Fundamentação:** DT-04 ("método/unidade de catálogo aprovado… não inventar unidade clínica"); `units.json` ("further units require registry revision"); US-051 (dez dimensões de compatibilidade: segmento, lateralidade, movimento, método, unidade, protocolo…); RN009; US-018-CA02.
- **Alternativas:** (A) só impor a parte mecânica (valor e unidade obrigatórios, unidade ∈ registro); (B) acrescentar ao alvo uma referência de grandeza/método (mudança de contrato, conteúdo clínico); (C) retirar `measure_value` da UI até validação (servidor continua aceitando o enum).
- **Recomendação:** **A + C**: mecânica já, grandezas só com a terapeuta. Antes de impor "unidade ∈ registro" aos alvos, o PO deve saber que `deg` é a única unidade angular registrada e que nenhuma unidade de força existe no registro (o teste `pinch_force`/`kgf` é de medição instrumental, ver D-07).
- **Dados:** preservados. **Terapeuta: sim** (lista de grandezas, unidades, método).

### D-05 — Prazo e vocabulário de status
- **Hoje:** `goal` não tem prazo (confirmado em PROPOSTA §2: "goal.schema.json sem prazo"). Status `active|achieved_confirmed|discontinued`; confirmação profissional já exigida no servidor (`GOAL_CONFIRMATION_REQUIRED`).
- **Fundamentação:** US-018-CA02 ("prazo quando definido"), US-090-CA01 (exibir prazo), DATA_MODEL_V2 §2 ("prazo do paciente/terapeuta, não do projeto"), US-018 pendência "vocabulário de status e obrigatoriedade de prazo", DT-01 (datas civis aplicam-se a prazo de meta), RN014, RN004. CA02 menciona "tarefa" e "critério": hoje `goal_text` + `target` os cobrem.
- **Alternativas (prazo):** (A) opcional (`deadline`, data civil); (B) obrigatório; (C) manter ausente. **Recomendação: A** (CA diz "quando definido"), sem regra futuro/passado (política de datas ainda pendente no PO, PROPOSTA §6), validada como data civil real no servidor. Metas existentes: "sem prazo".
- **Status:** manter os três valores como vocabulário fechado (D-05b); ampliar (D-05c) só com história e validação clínica.
- **Contrato:** campo aditivo → A2. **Terapeuta:** não para prazo; opcional para estados.

### D-06 — Instrumentos e itens (★ FIX-19, FIX-20, FIX-21)
- **Hoje:** registro com 1 entrada (`custom_unvalidated`, v0, `unvalidated_custom`). Schema aceita id/versão por padrão e `status` enum. Sondas: instrumento inexistente declarado validado (A01), `custom_unvalidated` declarado validado (A02, FIX-20), versão 99 (A03). UI: id e versão em texto livre, **select de situação livre**, padrão `elo_hand_screen` v1.0 (não registrado), item único fixo.
- **Fundamentação:** FIX-19/20/21; DT-04 ("deriva versão/situação de catálogo autorizado… estado custom não validado explícito"); CMP-06; RN005, RN006; US-017 pendência ("instrumentos, itens, escalas… a validar com terapeutas"); PX-04 pendente; DATA_MODEL_V2 §7.
- **D-06a (técnica):** derivar versão e situação do registro; rejeitar id/versão fora do registro e situação divergente; UI sem campos técnicos editáveis (FIX-24). Com o registro atual, a seleção resume-se ao instrumento **explicitamente não validado**. **Recomendação: aprovar.** Dados: o padrão `elo_hand_screen` só existe como valor padrão da UI; fixtures e testes usam `custom_unvalidated` (21 ocorrências) → impacto histórico mínimo. Contrato: regras semânticas; tratar via D-10.
- **D-06b (clínica):** conteúdo do catálogo e critério de "validado". **Adiar até PX-04**; não classificar nenhum instrumento como validado sem fonte e aprovação.
- **Alternativas D-06a:** (A) estrita (rejeita fora do registro); (B) aceita fora do registro mas sempre `unvalidated_custom`; (C) status quo. Recomendo A; B é fallback se o PO quiser instrumentos livres antes da validação (nesse caso o status é derivado `unvalidated_custom`, nunca escolhido).
- **Itens de instrumento personalizado:** o registro diz "itens genéricos (item_key/value_type/unit/source)"; o editor de itens é parte de D-08.

### D-07 — Medição instrumental (US-052)
- **Hoje:** `value` −10000..10000, `unit` token livre, `movement_key` livre, `method` const `therapist_instrumental_manual`; **sem UI**. Sondas: 45 `kg` em flexão de punho (M02), −9999 deg (M03), movimento inexistente (M05) aceitos. O teste congelado `test_v3_evolution_timeline.py` registra `pinch_force` em `kgf` (fora do registro).
- **Fundamentação:** US-052 pendência ("instrumentos e unidades aceitos a confirmar com terapeutas"), CA01–CA04; US-051; RN006, RN009; DATA_MODEL_V2 §5 (compatibilidade).
- **Alternativas:** (A) não tocar no ARQ-03; (B) impor unidade ∈ registro (quebraria o teste `kgf` → exige decisão sobre o teste); (C) catálogo movimento×unidade (clínico).
- **Recomendação: A.** Sem UI e sem regra nova até Raquel definir pares válidos, faixas e se valores negativos (ex.: extensão) são válidos. **Terapeuta: sim.**

### D-08 — Consistência dos itens de avaliação (★ FIX-21; técnica)
Proposta de regras (todas verificáveis no servidor, sem conteúdo clínico):
- **R1** `value_type` governa o valor: `integer` → inteiro; `number` → número finito; `category` → texto ≤80; `boolean` → booleano; `null` permitido conforme R2.
- **R2 (ternário RN008):** `not_assessed=true` ⇒ `value=null`; `not_assessed=false` ∧ `value=null` = **desconhecido**; `0` é valor real. Nunca converter nulo em zero.
- **R3** `unit` só em `integer|number`; `category|boolean` ⇒ `unit=null`.
- **R4** item com `source=therapist_instrumental` e valor numérico exige `unit` (US-017-CA02, US-052-CA01).
- **R5** `item_key` único dentro da avaliação.
- **R6** unidade ∈ `units.json` e `item_key` ∈ catálogo do instrumento **quando houver catálogo** (para instrumento personalizado, itens livres com R1–R5).
- **Fundamentação:** US-017-CA02/CA03, US-023-CA02, RN006, RN008, CMP-05. Sondas A04–A12 aceitas hoje.
- **Pendência para o PO:** acoplamento `not_assessed` × `assistance` (`not_assessed` existe nos dois campos; os documentos não definem a relação). **Recomendo não impor** até decisão.
- **Dados:** novas escritas apenas. **Terapeuta:** não para R1–R5; R6 depende de D-06b.

### D-09 — Dose
- **Hoje:** servidor aplica `limits-v1` (R02–R09: 11 séries, 101 reps, produto, 0, fracionário → rejeitados); front só min/max por campo (sem produto); exercício e movimento são `const` (um valor cada); `sessions_per_week` 1..14 vem do schema 3.0.0.
- **Fundamentação:** PD-04, C9, DATA_MODEL_V2 §2, US-019-CA01–CA03 ("inteiros positivos… sem ajustar dose automaticamente"), US-060-CA02/CA03, RN015, DT-04.
- **Recomendação:** **ratificada em essência**; apenas confirmar (a) guarda de produto derivada de `limits.v1` (não digitada no HTML); (b) `1..14` como limite técnico de contrato, não recomendação clínica; (c) nenhum exercício/movimento novo sem validação clínica.
- **Contrato/dados:** nenhum. **Terapeuta:** só se os limites forem alterados (PD-04 exige justificativa e aprovação).

### D-10 — Rota de contrato
- **Hoje:** A1 (3.1.0) congelado; `errors.py` já tem `RULE_VIOLATION`, `OUT_OF_RANGE`, `TYPE`, `PATTERN`, `GOAL_CONFIRMATION_REQUIRED`, `COMPARABILITY_VIOLATION`.
- **Fundamentação:** PD-10; CONTRACT_EVOLUTION_PLAN §1 ("nada congelado é editado em silêncio"); PROPOSTA §1 (patch silencioso proibido; release formal com paridade Python/JS).
- **Alternativas:** (A) addendum A2 (3.2.0) aditivo com catálogos e regras; (B) só código sem contrato (**rejeitada**); (C) A2 + novos códigos de erro.
- **Recomendação: A**, usando os códigos existentes com `details.rule` e caminho do campo; novos códigos apenas se o PO preferir (C). Incluir vetores positivos/negativos Python e JS e relatório de compatibilidade.

## 4. Componentes implementáveis apenas com regras já ratificadas

| Nível | Componente | Depende de | Observação |
|---|---|---|---|
| **A — ratificado hoje** | **DoseField** (guarda de produto/inteiros positivos, rejeitar sem ajustar) | PD-04, C9, US-019, US-060, RN015 | Servidor já aplica; ganho é UX. Implementável após liberar o gate D-01. |
| **B — só ratificação técnica do PO** | **GoalTargetField** para `descriptive_text`, `session_count`, `repetitions`; **InstrumentSelector** (somente registro atual, não validado); consistência R1–R5; prazo opcional | D-02, D-03, D-05a, D-06a, D-08, D-10 | Sem conteúdo clínico novo. |
| **C — exige a terapeuta** | `measure_value` com grandezas; catálogo de instrumentos/itens; medição instrumental com UI | D-04, D-06b, D-07 | Bloquear/ocultar; nunca fabricar catálogo. |

## 5. Prioridade de entrega sugerida (após D-01 e ratificações)
1. **FIX-03** (D06): D-02 + D-03 + parte mecânica de D-04. 2. **FIX-20/19**: D-06a. 3. **FIX-21**: D-02, D-06a, D-08. 4. DoseField (D-09). 5. Prazo (D-05a) com o A2. Itens de nível C permanecem bloqueados.

## 6. Efeitos nos testes existentes (para decisão, sem alteração)
Regras de D-02/D-06a/D-04 podem tornar inválidos dados usados por testes congelados: `repetitions` com unidade `reps` (`test_v3_goals.py`), `session_count` com `sessions` (`participant_journey.mjs`), unidade `kgf`/`cycles` (`test_v3_evolution_timeline.py`, fixtures). Como no fix02, cada caso exigirá ratificação do PO e substituição rastreável (versão anterior preservada), nunca alteração silenciosa.

## 7. Limitações
Não houve entrevista com a terapeuta; nenhum conteúdo clínico foi presumido. A PROPOSTA V2.2 é proposta, não decisão. Dados históricos reais não existem (PD-05: apenas dados sintéticos).
