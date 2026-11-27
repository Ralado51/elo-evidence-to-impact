# S1 — Relatório consolidado da integração final

Branch: `integration/s1-final` (sem push, sem deploy). Dados exclusivamente sintéticos.
Base: ARQ-04 FIX-01 `7e93248`; Design System `8f83b5b`; ARQ-06 Core `fe4ec4f`; ARQ-05 Core `83ccf7d`.

## 1. Registro do aceite do ARQ-04 (com ressalvas)
Aceite **restrito ao MVP sintético**, por autorização formal do PO. Base: implementação 7e93248; validação técnica independente do Gemini aprovada; homologação funcional do Codex **parcial**, sem novos defeitos; cenários não reproduzidos pelo Codex cobertos pela validação do Gemini; contratos 3.0.0, 3.1.0 e 3.2.0 preservados.
**Ressalvas:** isto NÃO é homologação funcional integral nem clínica. Uso com dados reais está proibido até a resolução de privacidade, segurança e validação clínica.

## 2. Decisões ratificadas e onde estão implementadas
| Decisão do PO | Implementação / prova |
|---|---|
| Recuperação local em sessionStorage | `arq05/storage_adapter.mjs`; INT-04 |
| Bloquear nova sessão com relato pendente | `participant_app` (SESSION_BLOCKED); INT-03, INT-11 |
| Dispensa explícita sem perda silenciosa | `SessionController.start({dismissReport})`; `dismiss.test.mjs`; INT-08 |
| Isolamento por organização e principal | chave `elo:arq05:v1:[org,participante]`; INT-10 |
| Retenção ≤ 7 dias (limitada à aba) | `arq05/retention.mjs`; RT-01 (unitário). Expirado com pendência é mantido e sinalizado; expirado e confirmado pode ser substituído |
| Aviso de perda ao fechar a aba | `#sync-loss-warning`; INT-09 (PT/EN) |
| Reautorização antes de enviar eventos recuperados | `needsReauth` + clique em “Enviar pendências”; INT-10 |
| Preservar ids, sequências e hashes | INT-06, INT-10, INT-11 |
| Reenvio manual ou automático limitado | 1 tentativa automática após 3 s + botão manual; INT-06 |
| Suspender reenvio em conflito, sem reconstruir a cadeia | INT-11 (HASH_CONFLICT real no ledger) |
| Sinalizar sessões órfãs | `#sync-notice[data-notice-kind~=orphan]`; INT-05 |
| Novo convite após fechar a aba | política vigente mantida (token em sessionStorage) |
| Logout somente local | `ctxStore.reset("logout")`; revogação no servidor segue pendente |
| 14 chaves técnicas do catálogo congelado | `sync_catalogs.py --check`: em sincronia |
| PT/EN | novas chaves `pa.js.sync_*` em `i18n_pt/en`; INT-09 |

## 3. Etapas e commits (`integration/s1-final`)
1. f078b00 — Design System V3 (8f83b5b).
2. b4dd3a5 — ARQ-06 Core (fe4ec4f).
3. 4b27dc3 — ARQ-05 Core (83ccf7d).
4. 73280ef — Core ARQ-05: dispensa segura e retenção.
5. 1efca65 — ARQ-05 ligado à jornada do participante (local-first).
6. 5246177 — suíte integrada obrigatória e evidências.

## 4. Resultados
- Node: 160/160. API: 539 passed, 1 skipped, 1 falha **pré-existente e externa** (`test_cl06_1_streams_fixtures_exact_parity`, igual à linha de base). Catálogos em sincronia. Nenhum arquivo de API ou contrato alterado.
- Regressão de navegador: **19/19 suítes** (evidências `docs/arch/evidence/integration_after_*.txt`).
- Suíte integrada nova `s1_integration_final.mjs`: **13/13** (`s1_integration_final_run1.txt`).

| Cenário obrigatório | Teste |
|---|---|
| Logout com séries carregadas (painel) | INT-12, INT-13 (inclui resposta tardia) |
| Recarga real | INT-04, INT-05 |
| Transmissão com ledger real | INT-01, INT-02 |
| Resposta perdida | INT-06 (servidor armazena, resposta descartada, reenvio vira `duplicate`) |
| Duplicação | INT-07 |
| Conflito | INT-11 (conflito real produzido no ledger) |
| Isolamento entre participantes | INT-10 |

## 5. Mudanças de comportamento (para revisão do PO)
- Iniciar/parar/relatar agora gravam **primeiro no aparelho** e transmitem depois. Um erro do servidor aparece no banner, mas os registros ficam guardados.
- `participant_journey.mjs` foi adaptado: o antigo teste “segundo start com erro forçado” passou a forçar o erro no botão “Enviar pendências” e a recuperar a sessão (enviar, concluir, dispensar). A intenção (CONSENT_REQUIRED e FORBIDDEN visíveis e acessíveis) é mantida.

## 6. Limites e ressalvas conhecidos
- Verificação de critérios do Product Backlog feita **por componente e história relacionadas** (ARQ-05: US-031/034/037/038; contexto/logout: US-003; evidências no painel). Não houve homologação critério a critério dos 599 CAs.
- Sem coordenação entre abas (comparação de revisão só na mesma área de armazenamento).
- Rejeições do servidor que não são conflito (ex.: validação) deixam o item pendente e visível; não há descarte automático.
- Logout não revoga o token no servidor.
- Retenção de 7 dias só tem teste unitário (o relógio do navegador não foi manipulado).

## 7. Backlog pós-entrega (não implementado)
1. Revogação de sessão no servidor (US-003).
2. Coordenação multiaba (lock/BroadcastChannel).
3. Descarte explícito e confirmado de pendências rejeitadas definitivamente.
4. Teste de navegador para a retenção de 7 dias com relógio controlado.
5. Reduzir o tempo da suíte integrada (limite de 120 req/60 s força pausas).
6. Homologação clínica e revisão de ameaças antes de qualquer dado real.
7. Pausa/retomada de sessão (D-ARQ5-14).
