# COMPONENT_CATALOG

Catálogo vivo dos componentes **implementados**. Os 25 componentes propostos estão em `COMPONENT_REUSE_MATRIX.md`.

## CMP-04 — Data civil e intervalos (ARQ-01)

**Responsabilidade:** única dona da regra "o que é uma data civil válida" e de "intervalo invertido". Data civil = dia de calendário `YYYY-MM-DD` (sem hora/fuso). Instantes (`created_at`, `occurred_at`) são outro conceito e nunca passam por este módulo.

| Camada | Arquivo | Interface pública |
|---|---|---|
| Servidor (autoridade) | `api/src/elo/v3/civil_date.py` | `parse_civil_date`, `is_civil_date`, `is_range_inverted`, `civil_date_paths(schema)`, `check_entity_civil_dates(schema, entity)`, `CivilDateIssue` |
| Cliente (espelho de UX) | `web/v3/civil_date.mjs` | `parseCivilDate`, `isCivilDate`, `isLeapYear`, `civilDateKey`, `isRangeInverted` |
| Controle | `web/v3/date_field.mjs` + `<input type="date">` | `dateFieldProblem`, `setFieldError`, `validateDateFields` |

**Regras:** ASCII canônico `YYYY-MM-DD`; dia real do calendário gregoriano (bissextos); round-trip exato; nunca normaliza ("2026-02-30" nunca vira 03/02); `\n` final rejeitado. Campos de data são **derivados do schema** (pattern), então novos campos entram sem editar o módulo.
**Paridade Python/JS:** vetores compartilhados em `web/tests/fixtures/civil_date_vectors.json`.
**Não faz:** limites de negócio (futuro, janela, fuso, correção histórica) — decisão do PO (ver `ARCHITECTURE_DECISIONS.md`, PD-01).
**Consumidores:** `clinical.py` (entidades), `prescriptions.py`, `reviews.py`, `evolution.py`, `verifier.py`; front: 4 formulários de `therapist_app.mjs`, `i18n.formatIsoDate`.
**Testes:** `api/tests/test_v3_civil_date.py` (21), `web/tests/date_field.test.mjs` (6), `web/tests/browser/s1_arq01_dates.mjs` (10).

## CMP-03 (parcial) — FieldError
`setFieldError` em `date_field.mjs`: `<p id="{id}-error" class="field-error">`, `aria-invalid`, `aria-describedby`, mensagem `Msg` retraduzível, foco + anúncio assertivo no primeiro erro. **Ainda local às datas**; generalização em ARQ-04.

## CMP-08 — Idempotência transacional (ARQ-02, servidor)

**Responsabilidade:** garantir que a mesma intenção (chave UUID v4) produza um único efeito e que repetições devolvam o resultado original, sem guardar corpos clínicos.
| Arquivo | Interface pública |
|---|---|
| `api/src/elo/v3/command_dedup.py` | `CommandDedupStore.{scope,lookup,record,sweep}`, `parse_idempotency_header`, `fingerprint`, `resolve_retention_days`, `key_ref` |
| `api/src/elo/v3/store.py` | tabela `v3_command_dedup`, `V3Store.command_scope()`, `_CommandConnection` |
| `api/src/elo/v3/router.py` | pipeline `_command` (auth → cabeçalho → autorização → corpo → lookup → execução → reautorização/registro → commit único) |
**Regras:** escopo `(org, principal, operação, recurso, chave)`; só 2xx; referências imutáveis (entidade id+versão, evento, ids); replay reautoriza; chave expirada = intenção nova; retenção 7 dias (1–90), `expires_at` fixo na criação; logs só com `key_ref`.
**Não faz:** `invites.create`, `auth.*`, `facts.verify`, `events.batch` (idempotência natural do ledger).
**Testes:** `api/tests/test_v3_arq02_idempotency.py` (45), `api/tests/test_v3_arq02_contract_a1.py` (5).

## CMP-07 — CommandController (ARQ-02, cliente)

**Responsabilidade:** ciclo de vida de um comando de formulário: single-flight, anti-rajada (conteúdo idêntico), chave por intenção, reuso em falha ambígua, janela segura, estado "desconhecido".
**Interface:** `createCommandController({now,uuid,retentionDays,marginMs,burstMs})` → `run(formId, send, {signature})`, `singleFlightOnly`, `startNewIntention`, `stateOf`, `setRetentionDays`, `windowMs`.
**Integração:** `therapist_app.mjs` (`cmd()` em 7 formulários + convite), `api_client.mjs` (`idempotencyKey`, `health()`), mensagens `th.js.cmd_*` (pt/en).
**Não faz:** persistir payloads ou chaves; reenviar após a janela; reconciliação automática (ARQ-05).
**Testes:** `web/tests/command_controller.test.mjs` (12), `web/tests/browser/s1_arq02_commands.mjs` (CC-1..9).
