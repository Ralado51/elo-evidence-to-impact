# ARQ-03 — Diagnóstico (fase de preparação; nenhuma implementação)

Status: **DIAGNÓSTICO. Implementação NÃO autorizada** até (a) liberação do gate do ARQ-02 pelo PO (homologação independente pendente) e (b) ratificação das regras normativas listadas em §9.

## 1. Integridade e HEAD
- HEAD confirmado: `5331e60176ec0b24acf82a2574bb80ec0e4b59a8` (ARQ-02); anterior `8a9909b71604b85e23d21e768ade2764022f90df`.
- Árvore limpa no início; únicos arquivos novos desta fase: `docs/arch/evidence/arq03_probe.py` e `arq03_probe_results.json` (dados sintéticos) + estes documentos.
- Contratos `CL06_3-r1` (3.0.0) e `CL06_3-A1` (3.1.0) **não tocados**.

## 2. Escopo e fontes lidas
Lidos: PROPOSTA V2.2 (DT-04), PO_DECISIONS_RATIFIED, BUSINESS_RULES, ACCEPTANCE_CRITERIA, DATA_MODEL_V2, CONTRACT_EVOLUTION_PLAN, ACCESSIBILITY_REQUIREMENTS, US-017..021/052/053/060/090, planilha de defeitos (FIX-01..16), schemas `goal`, `functional_assessment`, `instrumental_measurement`, `reassessment`, `encounter`, registries `units.json` e `instrument-registry.json`, `limits.v1.json`, `entities.py`, `therapist.html`, `therapist_app.mjs`, `api_client.mjs`, testes e fixtures.

**Atualização (baseline ffe1e22): a limitação abaixo foi superada — as planilhas completas (FIX-01..36, 599 CA) foram lidas via exportação .xlsx; ver `ARQ-03_PO_DECISION_MATRIX.md` §0.**

**Limitações declaradas originalmente (não presumidas):** as linhas FIX-17..36 da planilha de defeitos e o texto integral dos 599 critérios de aceite não puderam ser lidos (a leitura via conector devolve apenas linhas de amostra). Este diagnóstico **não presume** o conteúdo de FIX-19/20/21 além do que consta nas histórias, regras e no mandato.

## 3. Reprodução de D06 e achados (sonda sintética, HEAD atual)
Evidência: `evidence/arq03_probe_results.json` (43 linhas).

| Área | Aceito (201) indevidamente | Rejeitado hoje |
|---|---|---|
| Metas | `session_count` com `kg` (**D06**); `session_count` 2.5 e 0; `repetitions` com `kg`, 10.5, 5000; `descriptive_text` com valor 5 e unidade `kg`; `measure_value` null/null e com unidade `banana`; valor sem unidade; unidade `deg` em contagem | apenas valor negativo (400 `OUT_OF_RANGE`) |
| Avaliações | 12/12 sondas aceitas: instrumento inventado declarado validado; `custom_unvalidated` declarado `validated_with_therapists` (FIX-20); versão 99; `value_type` incoerente com valor; `not_assessed=true` com valor; item numérico sem unidade ou com `banana`; `item_key` duplicado; fonte `therapist_instrumental` sem unidade | — |
| Medições instrumentais | tudo aceito (45 kg, −9999, unidade `1`, `movement_key` arbitrário); **não existe formulário na UI** | — |
| Prescrições | limites `limits-v1` (10 séries, 100 reps, produto 100) **já aplicados no servidor** | `LIMITS_EXCEEDED`, `OUT_OF_RANGE`, `TYPE` |

Conclusão: o servidor valida apenas **estrutura**; não há semântica entre campos (`entities.check_entity_semantics` só trata confirmação para metas).

## 4. Frontend
- Meta: unidade em texto livre (padrão "sessions"); payload zera valor/unidade quando descritiva ou vazio (`therapist_app.mjs` ~1086–1093). Sem validação cruzada tipo×unidade.
- Avaliação: id/versão do instrumento em texto livre (padrão `elo_hand_screen`/`1.0`, **não registrado**); select de status de validação **livre** (FIX-20); item fixo (categoria, unidade null, `therapist_observed`).
- Prescrição: apenas min/max por campo; **sem guarda do produto séries×reps** (o servidor rejeita).
- Medição instrumental: sem UI.

## 5. Catálogos
- `units.json`: somente `"1"` e `"deg"`.
- `instrument-registry.json`: somente `custom_unvalidated` v0 (`unvalidated_custom`), validação clínica pendente com a terapeuta ocupacional.
- Consequência: **o InstrumentSelector não pode derivar status/versão/unidade a partir de catálogo validado** — não existe fonte. Não será criado catálogo clínico fictício.

## 6. Conflito de retrocompatibilidade
Unidade canônica de contagem aparece como `null` (`test_v3_evolution_timeline`), `"sessions"` (padrão da UI e `participant_journey`) e `"reps"` (`test_v3_goals`). Qualquer regra rígida quebra dados/testes existentes → decisão do PO (D-02).

## 7. Mapeamento
D06, FIX-03, FIX-19, FIX-20, FIX-21 → CMP-06 (GoalTargetField, InstrumentSelector, MeasurementField, DoseField) + CMP-13; US-017/018/019/020/021/052/053/060/090; RN004/005/006/008/009/014/022; PD-04, PD-10. Prazo da meta: lacuna normativa (D-05).

## 8. Regras ratificadas × indefinidas
- Ratificadas: limites de dose (`limits-v1`); desconhecido nunca vira zero (RN008); preservar valor literal; servidor é a autoridade.
- Indefinidas: unidade/valor canônicos por tipo de meta; método/unidade/quantidade de `measure_value`; catálogo de instrumentos/itens e derivação de status; regras unidade×movimento (US-052); consistência `value_type`↔valor↔`not_assessed`; `item_key` duplicado; prazo; vocabulário de status de meta (US-018).

## 9. Decisões pendentes do PO
Ver lista objetiva em `ARQ-03_CONTRACT_DELTA.md` §6 (D-01..D-10).

## 10. Matriz AS-IS/TO-BE
Ver `ARQ-03_COMPONENT_INVENTORY.md` e `ARQ-03_DOMAIN_MATRIX.md`.
