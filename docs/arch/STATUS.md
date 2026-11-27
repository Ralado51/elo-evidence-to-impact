# STATUS

Branch `demo/claude` · baseline `ed5099356d38050a51f9b5de1e1c09ca57b2ce4a`

| Pacote | Estado | Commit |
|---|---|---|
| Diagnóstico (Fase 1) | Concluído: inventário, matriz, catálogo, dependências, impacto, plano, decisões | (mesmo commit de ARQ-01) |
| ARQ-01 | Concluído e verificado | o commit HEAD desta entrega (SHA informado na mensagem de entrega; um commit não contém o próprio SHA) |
| ARQ-02 | Delta ratificado (Q1–Q6) e **implementado**: adendo A1 (contracts 3.1.0), CMP-08 (servidor), CMP-07 (cliente), CMP-25 (testes). Aguarda verificação externa; defeitos **não** marcados como homologados | o commit HEAD desta entrega (um commit não contém o próprio SHA) |
| ARQ-03..07 | Pendentes (ARQ-03 não iniciado por determinação do PO) | — |

Escalações aguardando o PO: PD-01..PD-08 (`ARCHITECTURE_DECISIONS.md`).


## Atualização 26/11/2026 (noite)
Baseline candidata do ARQ-03: `2cf4bab` (FIX-01: FIX-38/39/40/17); docs de ratificação em `67bc619`. ARQ-03 FIX-01 aguarda validação do Gemini e homologação dirigida do Codex. A2 candidato (3.2.0), **não congelado**; manifesto íntegro. ARQ-04 e ARQ-05: **planejamento documental concluído, implementação bloqueada**. ARQ-06/07, S2: não iniciados. Sem push/deploy.

## Atualização 26/11/2026 (aceite do ARQ-03)
**ARQ-03 ACEITO** na revisão `2cf4bab` (Gemini 4/4 + regressões; Codex 10/10). **A2 3.2.0 CONGELADO** (`ARQ-03_ACCEPTANCE_RECORD.md`). **ARQ-04 LIBERADO**, sujeito às decisões de `ARQ-04_PO_DECISION_MATRIX.md`; ARQ-05, ARQ-06 e S2 não iniciados. Sem push/deploy.
