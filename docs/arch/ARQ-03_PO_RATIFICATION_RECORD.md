# ARQ-03 — Registro formal das decisões ratificadas pelo PO

Data da ratificação: **26/11/2026** (ratificação técnica da proposta A2 e do plano). Documentos analisados pelo PO: `ARQ-03_A2_PROPOSAL.md`, `ARQ-03_IMPLEMENTATION_PLAN.md`, commit documental `071a753`, baseline `2881ced`. Este registro transcreve as decisões; onde diverge das recomendações da matriz `ARQ-03_PO_DECISION_MATRIX.md` (`0df7a51`), **vale a decisão do PO**.

## 1. Decisões P-01 a P-08
| ID | Resultado | Decisão (síntese fiel) | Diverge da recomendação? |
|---|---|---|---|
| P-01 | Aprovada | Numeração oficial do backlog: CMP-05 ValidationRegistry; CMP-06 catálogos versionados, GoalTargetField, InstrumentSelector, MeasurementField, DoseField; CMP-13 entidades clínicas versionadas e regras semânticas no servidor | Não |
| P-02 | Aprovada com esclarecimento | **Alternativa C** da D-02. `session_count`: valor inteiro 1..100000, `unit` null ou `sessions`. `repetitions`: valor inteiro 1..100000, `unit` null ou `reps`. `descriptive_text`: `value` e `unit` null. Unidade derivada automaticamente pelo componente, sem edição livre. Rejeitar unidades incompatíveis, zero, negativos, fracionários e ausência de valor nas contagens. Teto técnico, não clínico. `goal.count_no_unit` substituído por identificador adequado à compatibilidade de unidade (`goal.count_unit_compatible`) | **Sim** (matriz recomendava A: `unit` proibida) |
| P-03 | Aprovada | Implementar ValidationRegistry e mecanismo compartilhado de erros por campo. **Não** implementar o FormController completo. Preservar DateField e CommandController. Registrar a parcela remanescente do CMP-05 para tratamento posterior | Não |
| P-04 | Aprovada parcialmente | Não substituir testes válidos com `sessions`/`reps`. Não alterar testes instrumentais com `kgf`/`cycles`. Preservar testes históricos e fixtures congeladas. Autorizados: padrão de avaliação `custom_unvalidated`, versão 0, `unvalidated_custom`; padrão válido de meta de sessões com unidade derivada. Mudança de expectativa normativa exige justificativa e rastreabilidade individuais; proibido enfraquecer asserções | **Sim** (matriz previa substituir testes com `reps`) |
| P-05 | Aprovada | Sem relação adicional `not_assessed`×`assistance`. Implementar R1–R5. Distinguir não avaliado, desconhecido, valor observado e zero. R6 condicionado à aprovação do catálogo | Não |
| P-06 | Aprovada | Rejeitar novas escritas com instrumento, versão ou situação incompatíveis com o registro. Sem edição livre dos metadados técnicos. Preservar históricos. Sem validação clínica automática | Não (alt. A) |
| P-07 | Aprovada com ressalva | `deadline` opcional com DateField e validação civil no servidor; sem regra de passado/futuro; hashes e históricos preservados. Documentar incompatibilidade potencial de clientes com validação estrita de schema. **Não declarar o A2 integralmente retrocompatível.** Registrar mudanças comportamentais de escrita e apresentar estratégia de versionamento/compatibilidade antes de congelar | Parcial (declaração de compatibilidade) |
| P-08 | Aprovada | Novas versões de registros legados cumprem as regras vigentes; versão original preservada; mensagens específicas; sem migração ou normalização silenciosa | Não |

## 2. Decisões complementares
| ID | Decisão |
|---|---|
| D-03 | Aprovada (`descriptive_text` null/null) |
| D-04 | **Ocultar `measure_value` para novas metas na UI.** Preparar o mecanismo de catálogo, **sem** nova restrição de escrita na API sem aprovação específica (diverge da matriz, que previa regra mecânica no servidor) |
| D-05b | Manter os três estados existentes |
| D-05c | Adiada |
| D-06b | Aguardar validação profissional |
| D-07 | Não alterar medição instrumental |
| D-09 | Aprovada integralmente; `limits.v1` preservado; sem ajuste automático da dose |
| D-10 | Reutilizar códigos de erro existentes e acrescentar `details` estruturado sem romper o envelope vigente |
| A2-01 | `effective_reviews`: ratificado e preservado |

## 3. Execução e qualidade (determinações)
Reexportar as planilhas oficiais antes de iniciar a implementação. Atualizar os documentos normativos e manter este registro. Preservar os contratos 3.0.0 e 3.1.0. Reutilizar catálogos e componentes existentes; sem bibliotecas novas sem justificativa. Executar as **oito fases** do plano após a liberação do gate, com caracterização antes e depois, regressão por fase e regressão integrada final. **Isolar as suítes de navegador** para evitar interferência do rate limit. Distinguir falhas **preexistentes**, **ambientais** e **regressões reais**. Não iniciar ARQ-04, ARQ-05 nem S2. Sem push nem deploy.

## 4. D-01 — Gate de implementação
- Ratificação documental: **autorizada** (este registro).
- Implementação funcional: **condicionada ao parecer independente do Gemini sobre o FIX-37 na revisão `2881ced`** e à liberação expressa do PO. Até lá: documentação final e **standby**.
- Após a liberação: execução autônoma do plano ratificado, sem solicitar novas aprovações para decisões já estabelecidas.
- **Entrega final prevista:** `elo-arq03.bundle`, relatório de implementação, rastreabilidade, pacote contratual A2 candidato e evidências de testes.

## 5. Efeito sobre os documentos
`ARQ-03_A2_PROPOSAL.md` (A2-02, A2-06, matriz de compatibilidade, §2.4 mudanças de escrita, §2.5 versionamento) e `ARQ-03_IMPLEMENTATION_PLAN.md` (inventário de testes, fases 0 e 3, critérios 3.1/3.2/3.4/5.5, §6.2) foram atualizados em conformidade. `ARQ-03_PO_DECISION_MATRIX.md` permanece como histórico das recomendações; nos pontos divergentes acima vale este registro.

## 6. Pendências remanescentes
Parcela restante do CMP-05 (FormController: dirty/touched) para tratamento posterior; política de datas passado/futuro para `deadline`; decisões clínicas D-04 (grandezas), D-06b, D-07, D-05c com a terapeuta; reexportação das planilhas na Fase 0.
