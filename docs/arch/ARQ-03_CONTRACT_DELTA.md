# ARQ-03 — Contract Delta (PROPOSTA; nada aplicado)

Pacotes `CL06_3-r1` (3.0.0) e `CL06_3-A1` (3.1.0) permanecem **íntegros e congelados**. Qualquer mudança sai como addendum separado (A2, 3.2.0), somente após aprovação do PO. A implementação normativa fica **bloqueada** até lá.

## 1. Mudanças propostas (condicionais)
1. Regras semânticas de meta (kind×value×unit) como catálogo versionado `goal-target-rules.v1` + validação servidor em `check_entity_semantics`.
2. Novos códigos de erro (A2): `GOAL_UNIT_INCOMPATIBLE`, `GOAL_VALUE_INVALID_FOR_KIND`, `GOAL_VALUE_NOT_ALLOWED`, `INSTRUMENT_UNKNOWN`, `INSTRUMENT_ITEM_UNKNOWN`, `VALIDATION_STATUS_NOT_DECLARABLE`, `ITEM_VALUE_TYPE_MISMATCH`, `ITEM_KEY_DUPLICATE`.
3. Ampliação de `units.json` (somente unidades aprovadas pelo PO/terapeuta).
4. Catálogo de instrumentos/itens com fonte e aprovação profissional (hoje inexistente).
5. Campo opcional `deadline` em `goal` (prazo) — se ratificado (D-05).
6. **[RATIFICADO PELO PO em 2026-11-26 — origem ARQ-02 FIX-03]** `facts.list` aceita o parâmetro opcional `include=reviews`, que acrescenta `effective_reviews` (por `fact_id`: `decision`, `content_hash`, `event_id`, `note`). Detalhes em `ARQ-02_FIX03_CONTRACT_DELTA.md`. Já implementado como extensão opcional; entra no A2 (3.2.0) sem alterar os pacotes congelados. Invariantes: resposta sem o parâmetro idêntica à de 3.0.0/3.1.0; 31 operações preservadas (sem endpoint novo); autorização por participante igual à de `facts.list`; ledger como fonte de verdade; regra de resolução efetiva compartilhada com a publicação; elegibilidade definitiva validada pelo servidor; histórico integral das decisões preservado. Vetores de teste (Python e JS) do item a produzir junto com os demais do A2.

## 2. Impacto em dados históricos
Registros append-only já gravados com combinações hoje aceitas (ex.: `session_count` com `kg`) **não são reescritos**. Regras novas aplicam-se a escritas novas; leitura histórica tolerante, com marcação de "legado" na exibição.

## 3. Compatibilidade
Aditiva: campos novos opcionais; códigos novos só em escritas rejeitadas; clientes 3.0.0/3.1.0 continuam lendo. Estratégia de adoção (rejeitar vs. aceitar com aviso) depende de D-02.

## 4. Vetores (Python e JS) — a produzir após aprovação
- Positivos: `session_count` 5 unit null; `repetitions` 10 unit null; `descriptive_text` null/null; `measure_value` 45 `deg`.
- Negativos: `session_count` 5 `kg`; `session_count` 2.5; `repetitions` 5000; `descriptive_text` com valor; `measure_value` null; unidade `banana`; instrumento desconhecido; status declarado ≠ catálogo; `item_key` duplicado.
(Valores sujeitos às decisões abaixo.)

## 5. Testes de caracterização já possíveis
A sonda `evidence/arq03_probe.py` reproduz D06 e as demais combinações; servirá de base "antes/depois".

## 6. Decisões pendentes do PO
> Aprofundamento (regra atual, fundamentação, CA, alternativas, recomendação, impacto, validação clínica): `ARQ-03_PO_DECISION_MATRIX.md`.

- **D-01** Liberar o gate do ARQ-02 (homologação independente).
- **D-02** Unidade/valor canônicos de `session_count` e `repetitions` (null vs "sessions"/"reps"; inteiro ≥1 ou ≥0; zero) e tratamento de dados/testes existentes.
- **D-03** `descriptive_text` deve ser null/null imposto no servidor?
- **D-04** `measure_value`: métodos, unidades, grandezas aprovados; representação de ausente/desconhecido.
- **D-05** Prazo da meta (campo opcional, liberação de contrato, projeções) e vocabulário de status (US-018).
- **D-06** Fonte do catálogo de instrumentos/itens e validação pela terapeuta ocupacional; status derivado; destino de `elo_hand_screen` e dados existentes.
- **D-07** Regras unidade×movimento da medição instrumental (US-052) e se haverá UI.
- **D-08** Consistência `value_type`↔valor/unidade/`not_assessed`; `item_key` duplicado.
- **D-09** DoseField: apenas guarda de produto no front? Limites de `sessions_per_week` e catálogos de exercício/movimento.
- **D-10** Rota de contrato (addendum A2 / 3.2.0) e códigos de erro propostos.
