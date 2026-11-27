# ARQ-04 — Inventário de handlers assíncronos (CMP-10 / CMP-03)

Baseline de leitura: código do `2cf4bab` (ARQ-03 + FIX-01; sem mudança em `therapist_app`/`participant_app`/`painel_app` além do FIX-01 em avaliação/meta). Leitura estática; as colunas "Guarda atual" refletem o código, não testes novos. Classes: **R** leitura, **W** escrita (nunca abortar), **A** autenticação/principal.

| ID | Handler (arquivo:linha) | Cl. | Fronteira de contexto | Guarda atual | Lacuna | Tratamento-alvo |
|---|---|---|---|---|---|---|
| TH-01 | signin (`therapist_app` l.920) | A | principal | — | resposta tardia após logout/novo login | `ctx.principal` por geração; descartar |
| TH-02 | signout (l.904) | A | principal | `setActiveParticipant("")` | não invalida leituras em voo (G-09) | `store.reset("logout")` incrementa geração e cancela leituras |
| TH-03 | criar participante (l.953) | W | principal | CommandController | `onOk` chama `setActiveParticipant` mesmo se outro foi escolhido (G-03) | `commit()` condicionado; se obsoleto, só registrar "criado" sem trocar contexto |
| TH-04 | selecionar participante (l.996) | R | participante | `selectBusy` | ordem de chegada ≠ ordem de pedido (G-08) | `store.begin("select")` + `AbortController` |
| TH-05 | busca (l.1029) → `refreshParticipantList` | R | principal | — | idem G-08 | `begin("list")` por consulta |
| TH-06 | `refreshParticipantList` (l.477) | R | principal | — | repinta lista após logout | `begin` por principal |
| TH-07 | `restoreContext` (l.497) | R | participante | parcial | corrida com seleção manual | `begin("restore")` |
| TH-08 | convite (l.1037) | W (segredo único) | participante | `inviteBusy` | lê `state.participantId` depois do `await` (G-04); token descartado é perdido | capturar `ctx` antes; se obsoleto, **exibir o token no contexto de origem** (reconciliação, §D-ARQ4-02) |
| TH-09 | avaliação (l.1091) | W | participante | CommandController; `onOk` sem guarda | G-02 | `cmd` recebe `ctx`; `onOk` via `guard.commit` |
| TH-10 | meta (l.1156) | W | participante | idem | G-01 (confirmado) | idem |
| TH-11 | prescrição (l.1208) | W + R | participante | idem | G-02; `getCurrentPrescription(state.participantId)` usa estado vivo | usar `ctx.participantId` capturado |
| TH-12 | carga de fatos (l.1272) | R | participante | `ctxSeq`+`factsLoadSeq`+`reviewEpoch` | G-10 (esgotamento silencioso das 3 tentativas) | estado `stale` explícito na UI; sem repetição cega |
| TH-13 | ação de revisão (l.628) | W | participante | `reviewEpoch` | — (aprovado em 2881ced) | só migrar ao contrato novo |
| TH-14 | resumo (l.1340) | W | participante | CommandController | `onOk` sem guarda | `guard.commit` |
| TH-15 | série de evolução (l.1372) | R | participante | sucesso guardado; `catch` não | G-05 | `catch` via guarda |
| TH-16 | evolução (l.1391) | W | participante | idem TH-14 | idem | idem |
| TH-17 | timeline (l.1427) | R | participante | sucesso guardado; `catch` não | G-05 / FIX-37.2 (confirmado) | `catch` via guarda |
| TH-18 | `syncRetention` (l.145) | R | sessão | — | baixo risco | manter |
| TH-19 | `loadCatalogs` (l.1507) | R | global | — | cache global; sem contexto | fora do store |
| PA-01 | login por convite (`participant_app` l.688) | A | principal | — | sem guarda | `begin("auth")` |
| PA-02 | signout (l.664) | A | principal | — | `loadPlan`/`loadPublications` em voo repintam (G-09) | `reset("logout")` |
| PA-03 | `loadPublications` (l.244) | R | principal | — | idem | `begin` |
| PA-04 | `loadPlan` (l.550) | R | principal | captura `pid` | grava estado/DOM sem checar | `commit` |
| PA-05 | iniciar sessão (l.719) | W | sessão | — (sem single-flight) | duplo clique cria duas sessões; **fora do CMP-10 → ARQ-05** | encaminhado ao CMP-11 |
| PA-06 | encerrar (l.774) | W | sessão | — | idem | ARQ-05 |
| PA-07 | parar por dor (l.775) | W | sessão | — | idem | ARQ-05 |
| PA-08 | parar por cansaço (l.776) | W | sessão | — | idem | ARQ-05 |
| PA-09 | relato (l.793) | W | sessão | CommandController | recarga perde `pendingReport` | ARQ-05 |
| PA-10 | abrir resumo (l.626/879) | R | principal | — | sem guarda | `begin` |
| PA-11 | abrir evolução (l.644/884) | R | principal | — | sem guarda | `begin` |
| PA-12 | botões de escolha (l.780) | local | — | — | sem rede | — |
| PN-01 | login do painel (`painel_app` l.379) | A | principal | — | sem guarda | `begin("auth")` |
| PN-02 | `openPatient` (l.339) | R | participante | **nenhuma** | G-08 | `begin("open")`; `rawFetch` migra ao transporte comum |
| PN-03 | recentes (l.134) | R | participante | — | herda PN-02 | idem |
| PN-04 | `runVerify` (l.281) | W | participante | — | resposta tardia | `commit` |
| PN-05 | signout (l.405) | A | principal | — | G-09 | `reset("logout")` |

Resumo: 36 handlers (TH 19, PA 12, PN 5); 14 escritas (TH-03/08/09/10/11/13/14/16, PA-05..09, PN-04). Das 8 escritas do terapeuta, só TH-13 tem guarda de contexto; as outras 7 não têm, e o painel inteiro não tem. As 5 escritas de sessão de atividade (PA-05..PA-09) pertencem ao ARQ-05 (CMP-11), não ao CMP-10.
