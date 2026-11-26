# COMPONENT_DEPENDENCIES

Regra: dependências apontam para baixo; nenhum ciclo; servidor é autoridade, front só espelha.

```
CMP-04 Data civil ──► (nenhuma)             [folha: stdlib + schema]
CMP-05 ValidationRegistry ─► CMP-04
CMP-13 Entidades clínicas ─► CMP-05, CMP-04, CMP-06
CMP-03 Feedback/erros ─► CMP-02 (i18n), CMP-01 (a11y)
CMP-07 CommandController ─► CMP-03, CMP-10
CMP-08 Idempotência ─► CMP-13, CMP-17
CMP-10 Contexto/API ─► CMP-09, CMP-02
CMP-11 SessionController ─► CMP-10, CMP-12
CMP-12 Outbox ─► CMP-08, CMP-09
CMP-17 Evidence (verificador único) ─► CMP-23
CMP-18/19 ─► CMP-17, CMP-04
```

Ordem de entrega (do mandato): ARQ-01 → 02 → 03 → 04 → 05 → 06 → 07. Dependência dura: ARQ-02 (idempotência) requer decisão de contrato (PD-02) antes de implementar.

ARQ-02 (implementado): `command_controller.mjs` ─► `api_client.mjs` (envia `Idempotency-Key`) ─► gateway ─► `router._command` ─► `CommandDedupStore` ─► `store.command_scope` ─► `elo.canonical.hash_canonical` / `authorize()` existentes.
