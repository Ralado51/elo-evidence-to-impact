# S1 final — Preparação da integração (Etapa 1)

Status: **preparação e análise somente**. Nenhuma branch foi integrada. A Etapa 3 está **bloqueada pelo gate do PO** (Etapa 2).

## 1. Entregas importadas e verificadas
| Entrega | Branch | Revisão | Origem | Verificação |
|---|---|---|---|---|
| ARQ-04 FIX-01 | `demo/claude` | `7e93248de04f9003ba7b751ce95639d1ffecebef` | bundle local (SHA-256 `ecf471f1…72c83`) | gerado e verificado nesta sessão |
| Design System v0.1 | `research/frontend-v3` | `8f83b5b` (1 commit sobre `b1e7a51`) | branch já local | ancestralidade confirmada |
| ARQ-05 Core | `research/arq05-core` | `83ccf7dcc2bc34b0e1b1481422cd46249b83171b` | Drive `elo-arq05-core.bundle` | SHA-256 `cd7b29e8eb3528218f709423ef8b8b0c81c36b061f7d6fc1a8df0ed0dbc2519a` **confere** com o `.sha256` publicado; `git bundle verify` ok; head confere |
| ARQ-06 Core | `research/arq06-core` | `fe4ec4f6c359d0c4903925969dabc927a8f4757e` | Drive `elo-arq06-core.bundle` | SHA-256 calculado `10c05d8cef3b9242c566bc0e585e7e22e020b40142fe5401ed6eb6ca478cff16` (**confere** com o hash esperado informado pelo PO: `10c05d8c…78cff16`); `git bundle verify` ok; head confere |

Ancestralidade: as três branches de pesquisa partem de `b1e7a51`, **não** do FIX-01 (`7e93248`); cada uma tem 1 commit próprio. Branches de origem preservadas sem alteração. Worktree `integration/s1-final` criada em `7e93248` (nenhum merge feito).

## 2. Superfície de mudança e conflitos
| Branch | Arquivos | Sobreposição com FIX-01 |
|---|---|---|
| DS | `web/v3/ds/**`, `scripts/ds_*`, 4 HTML (`index`, `painel`, `participant`, `therapist`), docs | nenhuma (FIX-01 não tocou HTML) |
| ARQ-05 Core | 8 arquivos novos em `web/v3/arq05/` (+ README e teste) | nenhuma; módulo isolado, sem ligação com telas |
| ARQ-06 Core | `painel_app.mjs`, `painel_model.mjs`, `i18n_en/pt.mjs`, teste web, teste de API, 2 docs | **`painel_app.mjs` e `i18n_*`** (FIX-01 também alterou) |

Merges de teste em árvore descartável (removida): DS, ARQ-05 e ARQ-06 em sequência → **sem conflito textual**. Na árvore combinada: 155/155 testes Node (inclui o teste do núcleo ARQ-05), 15/15 `test_arq06_comparability`, catálogos em sincronia. No navegador: `s1_arq04_residual` (inclui PN-01) e `e2e_journey` **passam** com o ARQ-06 + DS sobre o FIX-01. Suíte completa de 19 não foi repetida (fica para a Etapa 3).

## 3. Riscos e dependências para a integração
1. **ARQ-06 reescreve a renderização do painel** (`renderAssistance` por série, `pt.assistance`). O `clearPatientSurfaces` do FIX-01 depende dos mesmos ids (`evolution-chart`, `transition-list`, `session-list`…), que continuam existindo; **verificar no logout que as listas por série ficam vazias** (teste a acrescentar).
2. **ARQ-05 é só núcleo**: não está ligado a `participant_app`. A ligação precisa conviver com o que o FIX-01 já fez no participante (`clearParticipantSurfaces`, tickets de principal em iniciar/encerrar/relato, `CommandController` em `pendingReport`). Hoje a recuperação de relato pendente é **em memória**; o núcleo a persiste em `sessionStorage`. O logout do FIX-01 **não** limpa `pendingReport` (política reservada ao ARQ-05): a Etapa 3 deve decidir isso junto com D-ARQ5-03/04.
3. **Isolamento por principal**: o outbox deve ser criado só após autenticar e ser chaveado por organização/participante; o logout (`ctxStore.reset`) não pode apagar a pendência nem deixá-la visível a outro principal.
4. **DS**: o painel e as telas ganham `ds-*` por atributo; a ordem proposta (DS primeiro) mantém o FIX-01 porque não há sobreposição, mas a suíte de navegador deve rodar com o DS ativo (seletores e `data-lang-option`).
5. **Roteiro do Codex**: ainda não disponível nesta sessão; este documento deve ser reconciliado com ele quando chegar. Também **não** localizei relatórios do Gemini/Codex sobre o FIX-01 (necessários para o gate).
6. Relatório `ARQ-06-Core.md` lido na íntegra após atualização: 141/141 Node e 25/25 de backend dirigido na origem; homologação em navegador ficou fora; checkout Windows converteu catálogos para CRLF e quebrou a paridade binária (no ambiente Linux desta integração `sync_catalogs --check` passa).
7. Limites declarados pelos próprios núcleos: ARQ-05 sem multiaba e só em `sessionStorage`; ARQ-06 não integra ARQ-05 e não cobre FIX-09/FIX-37 (login/logout) — o **requisito "autenticação, progresso e evidências" do passo 5 precisa ser definido** com as decisões abaixo.

## 4. Decisões que efetivamente bloqueiam a implementação (recomendações ao PO)
Só as que impedem código; as demais seguem no backlog.
| # | Decisão | Por que bloqueia | Recomendação |
|---|---|---|---|
| 1 | **Gate**: autorização para iniciar a Etapa 3 | exigida pelo prompt, com base nos relatórios do Gemini e do Codex sobre o FIX-01 | autorizar quando ambos aprovarem; relatórios não estão acessíveis a mim |
| 2 | **D-ARQ5-03** nova sessão com relato pendente | define o fluxo do passo 3 | (a) bloquear até relatar ou "dispensar" explícito (local, sem evento) |
| 3 | **D-ARQ5-04** logout/retenção com pendência | define o que o logout faz com o outbox | (a) manter isolado por principal e perguntar; **N = 7 dias** com limpeza automática; revisão de privacidade antes de dados reais |
| 4 | **D-ARQ5-05/06** conflito e reenvio | sem isso o conflito não tem tela | (a) preservar + "tentar de novo" + "descartar neste aparelho"; reenvio manual e no evento `online`, **sem agenda automática** nesta versão |
| 5 | **D-ARQ5-02/10** persistência | núcleo está em `sessionStorage` | manter `sessionStorage` + novo convite após fechar a aba (comportamento atual) |
| 6 | **D-ARQ5-12** textos PT/EN de pendência/conflito/dispensa | tela não pode ser escrita sem texto | eu redijo em linguagem clara e você/terapeuta validam; não bloqueia código se aceitar rascunho |
| 7 | **ARQ06-D01/D03** logout no servidor e pendência após logout | "autenticação" do passo 5 | logout apenas local nesta entrega (sem rota nova, contratos congelados); reautorização obrigatória para qualquer reenvio |
| 8 | **ARQ06-D05** dimensões (10 × 14+4) | "progresso e evidências" | não mapear nesta entrega; usar a partição técnica já implementada, sem regra clínica nova |

Não bloqueiam e ficam no backlog pós-entrega: D-ARQ5-07/08/09/11/13/14, ARQ06-D02/D04/D06/D07/D08/D09/D10, itens de acessibilidade/home do DS e otimizações.

## 5. Plano da Etapa 3 (após autorização)
1. DS sobre `integration/s1-final` → suíte completa de 19 + a11y do DS.
2. ARQ-05 Core: instanciar `StorageAdapter → RecoveryStore → EventOutbox → SessionController/EventDispatcher` após autenticar o participante, ligado a `postEventsBatch`; manter intactos `clearParticipantSurfaces` e tickets do FIX-01.
3. Recuperação de sessão e relato pendente conforme decisões 2–5; teste com recarga real e logout.
4. ARQ-06 Core (painel).
5. Requisitos de autenticação, progresso e evidências conforme decisões 7–8.
6. Homologação integrada: regressão completa + fluxos novos + evidência antes/depois, bundle e SHA.
Restrições mantidas: contratos 3.0.0/3.1.0/3.2.0 congelados, sem regras clínicas, sem push/deploy, dados sintéticos, sem ARQ-08/09/10/S2.

## 6. Revisão após a resposta do PO (sequência candidata)
Sequência candidata: **1) Design System → 2) ARQ-06 Core independente → 3) ARQ-05 Core + ativação da recuperação de sessão → 4) requisitos obrigatórios restantes do S1 → 5) homologação integrada.** Substitui a ordem do plano da seção 5 (ARQ-06 passa a vir antes do ARQ-05). Observação técnica: a mudança é compatível, pois ARQ-05 e ARQ-06 não se sobrepõem em arquivos; ARQ-06 mexe em `painel_app`/`i18n_*` e ARQ-05 só adiciona `web/v3/arq05/`.

Teste obrigatório adicional: **logout com listas de séries carregadas** (painel com ≥2 séries de assistência F04, transições e sessões por série renderizadas) deve esvaziar gráfico, transições, sessões, KPIs, evidências aprovadas, seletor de verificação e linha do tempo, sem repovoamento por resposta tardia, preservando todas as proteções do FIX-01 (`s1_arq04_fix01`, `s1_arq04_residual`, `s1_arq04_context`).

Gate: Etapa 3 **continua bloqueada** até a homologação independente do FIX-01 e a ratificação formal das decisões 2–8 da seção 4. Nenhuma implementação adicional foi iniciada.
