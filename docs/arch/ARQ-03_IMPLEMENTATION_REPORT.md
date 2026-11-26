# ARQ-03 — Relatório de implementação (catálogos e validação de domínio)

Baseline: `7308757`. Gate D-01 liberado pelo PO (26/11/2026). Dados exclusivamente sintéticos. Sem push, sem deploy. ARQ-04, ARQ-05 e S2 **não** iniciados.
Contratos congelados 3.0.0 (`CL06_3-r1`) e 3.1.0 (`CL06_3-A1`) **intactos** (manifestos verificados por teste). Pacote A2 (3.2.0) é **candidato, não congelado** e **não é declarado totalmente retrocompatível** (P-07).

## 1. Fases executadas
| Fase | Entrega | Commit |
|---|---|---|
| F0 | Baseline verde (Python 478 + 1 falha externa preexistente; JS 100); sondas "antes" | a42f37a |
| F1 | `contracts/CL06_3-A2` (catálogos, schema `goal`+`deadline`, vetores, manifesto), `scripts/sync_catalogs.py`, paridade | 79031d1 |
| F2 | ValidationRegistry (servidor `domain_rules.py`, front `validation_registry.mjs`), `field_error.mjs` extraído do DateField; hook de escrita sem regras = no-op provado | 80cfff6 |
| F3 | FIX-03: regras `goal.*` (alt. C), GoalTargetField (unidade derivada, `measure_value` oculto na UI) | f53cd5b |
| F4 | FIX-19/20: `instrument.registry_mismatch`, InstrumentSelector | e093b69 |
| F5 | FIX-21: R1–R5, MeasurementField (zero/desconhecido/não avaliado distintos) | 21b203c |
| F6 | DoseField: guarda do front derivada de `limits.v1` | f7397e7 |
| F7 | `goal.deadline` opcional (A2-03); regressão integrada; relatório; bundle | 075f3c2, c508456 |

## 2. Comportamento resultante (sondas antes → depois: `evidence/arq03_before.txt`, `arq03_after.txt`)
Escritas novas agora recusadas, com **códigos existentes** e `error.details = {rule, path}` (sem novo código): unidade incompatível em metas de contagem (`ENUM`), valor fracionário (`TYPE`), zero/negativo (`OUT_OF_RANGE`), contagem sem valor e descritiva com valor (`RULE_VIOLATION`), instrumento/versão/situação fora do registro (`RULE_VIOLATION`), itens com tipo/unidade/não-avaliado/chave duplicada incoerentes. Inalterados: `measure_value` na API (D-04), medição instrumental (D-07), limites de dose (D-09), leituras, replay idempotente e registros legados (nunca revalidados).

## 3. Testes e regressões
- Python: **521 passam**, 1 falha preexistente/ambiental (`test_cl06_1_streams_fixtures_exact_parity`, fixture externa ausente; idêntica ao baseline). Novos: `test_v3_a2_package.py`, `test_v3_a2_registry_noop.py`, `test_v3_a2_domain_rules.py` (vetores compartilhados + HTTP).
- JS: **111 passam** (baseline 100). Novos: `validation_registry`, `domain_fields`, `catalog_parity`.
- Navegador (15 suítes, cada uma isolada com demo reiniciada, por causa do limite de 120 req/60 s): todas verdes — evidências `arq03_regression_browser_1..4.txt`. Nova: `s1_arq03_domain.mjs` (BR-A2-01..11). `s1_corr_e02e03`, que tinha falha preexistente E03-8, passou nesta execução (provável instabilidade/ambiental; não atribuída ao ARQ-03).
- Teste legado ajustado (P-04, individualmente justificado): `test_timeline_get_entities_events_order_and_exclusions` — dado de montagem `instrument_version "0.1"` → `"0"` (não está no registro). Asserções inalteradas; cópia original preservada em `evidence/legacy_tests/` com registro.

## 4. Desvios e itens não implementados (honestidade)
- Marcador visual "legado" no app do participante: **não implementado** (sem impacto em dados; registrado para ARQ-04).
- `FormController` completo (dirty/touched): **não** feito (P-03); resto do CMP-05 registrado.
- Política de prazo passado/futuro do `deadline`: não aplicada (P-07).
- Mapeamento erro-de-servidor→campo cobre item único (`items[0]`) e campos de meta/instrumento/prazo.
- Planilhas oficiais: o export do Drive devolve só a aba-resumo; mantido o dump completo local de 26/11 17:36 (a planilha foi alterada às 17:54) — **reexport completo pendente de conferência pelo PO**.
- D-04: `measure_value` continua aceito pela API; só a UI deixou de oferecê-lo para novas metas.

## 5. Decisões clínicas ainda pendentes (não inventadas)
D-04 (restrição de escrita de `measure_value`), D-06b (validação profissional de instrumentos/unidades), D-07 (medição instrumental), D-05c, catálogo clínico para R6 (PX-04), política de datas do prazo.

## 6. Compatibilidade (A2 §2.4–2.5)
Leitura: nenhuma mudança (default de `facts.list` inalterado; 31 operações preservadas). Escrita: mudanças comportamentais registradas acima. Cliente com schema estrito de `goal` (`additionalProperties:false`) rejeita payloads com `deadline`. Nova versão de registro legado deve cumprir as regras atuais; versão original preservada; sem migração silenciosa (P-08).
