# ARQ-02 — Rastreabilidade (ratificação do PD-02 → implementação → teste)

Backend = `api/tests/test_v3_arq02_idempotency.py` (B) e `test_v3_arq02_contract_a1.py` (A1). Front = `web/tests/command_controller.test.mjs` (N) e `web/tests/browser/s1_arq02_commands.mjs` (CC).

| Requisito ratificado | Implementação | Teste |
|---|---|---|
| Q1 replay por referências imutáveis, sem corpo, versão original | `router._rebuild_*`, `command_dedup.record` | B `replay_after_a_later_revision…`, `registry_stores_references_only…`, `replay_performs_no_writes` |
| Q2 chave opcional no contrato, obrigatória no front (`keyed`) | `parse_idempotency_header`; `therapist_app.cmd()` | B `legacy_clients_without_header…`; CC-3 |
| Q3 só sucessos; efeito+registro na mesma transação; resposta perdida recuperável | `store.command_scope`, `_CommandConnection` | B `only_successful…`, `rollback_between_effect_and_idempotency_record…`, `response_lost_after_commit…`, `failure_before_commit…`; CC-4, CC-5 |
| Q4 `invites.create` fora do registro; single-flight no front | `classes.excluded`; `singleFlightOnly` | B `invites_are_excluded…`; N `singleFlightOnly…`; CC-8 |
| Q5 adendo A1, contracts 3.1.0, 3.0.0 intacto | `contracts/CL06_3-A1/` | A1 (5 testes: manifests, delta declarado, códigos, classes) |
| Q6 retenção 7 d (1–90); janela ≤ 24 h; sem reenvio inseguro; estado desconhecido | `resolve_retention_days`; `windowMs`; `RESULT_UNKNOWN` | B `default_retention…`, `retention_at_the_minimum…`, `invalid_retention…`, `expired_rows_swept…`, `config_change…`; N `window…`, `after the window…`; CC-6 |
| Req. 1 autorização atual e corrida revogação × execução | reautorização dentro do lock | B `replay_after_care_link_revocation…`, `replay_by_another_therapist_or_org…`, `revocation_racing_with_commands…` |
| Req. 2 propagação de cabeçalhos no gateway | `scripts/gateway.mjs` | CC-4, CC-9 |
| Req. 3 cabeçalhos inválidos/duplicados/ignorados por categoria | AMENDMENT A1 §Header handling | B `invalid_key…`, `duplicated_header_lines…`, `header_is_ignored…`, `events_batch_natural…` |
| Req. 4 sem segundo canonicalizador/ledger/verificador | `hash_canonical` reutilizado | B `key_identifies_the_intention_not_the_payload_hash` |
| Req. 5 hash do payload ≠ identidade da intenção | chave UUID por intenção | B `different_keys_identical_payload…`, `same_key_different_payload…` |
| Req. 6 sem dados clínicos completos no registro | colunas de referência | B `registry_stores_references_only…` |
| Req. 7 sem dados/tokens/credenciais em logs | `key_ref` | B `logs_never_contain…` |
| Duplo clique; Enter+clique | single-flight + anti-rajada | N `double click…`, `burst guard…`; CC-1, CC-2 |
| Requisições concorrentes, mesma chave / payload diferente / chaves diferentes | `_LostRace`, PK do registro | B `concurrent_*` (3) |
| Isolamento org/usuário/recurso | escopo da chave | B `same_key_is_independent_across…` |
| Unicidade de domínio e idempotência natural do ledger preservadas | sem alteração em `events.batch` | B `domain_uniqueness…`, `events_batch_natural…` |
| Compatibilidade com clientes sem cabeçalho | cabeçalho opcional | B `legacy_clients_without_header…` |
| Regressão ARQ-01 e etapas A/E | — | `s1_arq01_dates`, `s1_stab_a`, `s1_stab_e`, suíte de API (ver `TEST_EVIDENCE.md`) |

Defeitos oficiais relacionados (status **não** alterados): D04, S1-03, FIX-02, FIX-18. Linhas prontas para o controle oficial (a colar pelo PO; não marcam homologação):

| ID | Campo "Implementação" sugerido | Evidência |
|---|---|---|
| D04 / S1-03 | ARQ-02 implementado: single-flight + chave por intenção; duplo clique e Enter+clique geram 1 registro (antes: 2) | `arq02_before_browser.txt` × `arq02_after_browser.txt` (CC-1, CC-2) |
| FIX-02 | ARQ-02 implementado: idempotência transacional A1 (3.1.0), reenvio seguro com a mesma chave | B (45) + CC-4/5/6 |
| FIX-18 | Exclusividade erro×sucesso nos envios com comando; demais caminhos seguem em ARQ-04 | CC-4, CC-7 |
