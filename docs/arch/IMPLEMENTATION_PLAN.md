# IMPLEMENTATION_PLAN

| Pacote | Escopo | Estado | Bloqueio |
|---|---|---|---|
| ARQ-01 | DateField + validação civil no servidor (CMP-04, parte de 03/05) | **Concluído** | — |
| ARQ-02 | CommandController + idempotência transacional (CMP-07/08) | **Implementado; aguarda verificação externa** | — |
| ARQ-03 | Catálogos e campos de domínio (CMP-06/13) | Planejado | PD-03 (matriz tipo/unidade/instrumento) |
| ARQ-04 | i18n/erros/contexto (CMP-02/03/10) | Planejado | preservar E-01/02/03 |
| ARQ-05 | SessionController/Outbox (CMP-11/12) | Planejado | PD-04, PD-06 |
| ARQ-06 | Segurança/evolução/evidência (CMP-09/17/18/19) | Planejado | PD-04 |
| ARQ-07 | Governança de componentes (CMP-01/23/25) | Planejado | — |

Cada pacote: reproduzir defeito antes → corrigir → testes do componente (+/−) → consumidores → regressão proporcional → um commit independente → bundle verificado.
