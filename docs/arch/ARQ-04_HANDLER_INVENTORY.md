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

---

## Revisão FIX-01 (baseline `b1e7a51`) — operações assíncronas secundárias e residuais

Lacuna do inventário original: ele contava só o handler "externo" e não as leituras encadeadas **dentro** do `onOk` de uma escrita. O FIX-01 audita todas as cadeias equivalentes (escrita → leitura secundária → renderização). Total revisado: **36 handlers + 6 operações secundárias catalogadas = 42 operações assíncronas**; as 36 originais mantêm seus IDs.

### Operações secundárias (dentro do `onOk`)

| ID | Cadeia | Antes (b1e7a51) | Depois (FIX-01) |
|---|---|---|---|
| TH-11.s | `publishPrescription` → `getCurrentPrescription` | usava `state.participantId` vivo, sem `signal`, sem revalidação: **vazamento confirmado (TH-11, `rxLeakedIntoBeta=true`)** | `readAfterWrite(ticket,"prescription")`: participante de origem, `signal`, revalidação após o `await`; obsoleto → nada exibido + aviso de reconciliação na volta |
| TH-14.s | `publishSummary` → `getSummary` | revalidava só no sucesso; erro tardio e aviso ausentes | mesmo helper; erro/obsolescência tratados, escrita preservada e reconciliada |
| TH-16.s | `publishEvolution` → `getEvolution` | idem | idem |
| TH-12.s | `listFacts` → `getFactEvidence` (por sessão) | já com `op.signal` e `isCurrent` | inalterado (verificado) |
| TH-03.s | `createParticipant` → `refreshParticipantList` em `onOrphan` | disparava lista/aviso após logout | `cmd` não renderiza nem consulta quando o **principal** mudou (logout) |
| TH-07.s | `restoreContext` → `refreshParticipantList` | sem guarda contra seleção manual | `begin("restore")` |

### Residuais (caracterizados antes, protegidos depois)

| ID | Antes (`s1_arq04_residual`, baseline) | Depois |
|---|---|---|
| TH-01 signin | resposta tardia sobrescrevia sessão mais nova e reinstalava sessão após logout (**2 falhas**) | `begin("auth",{level:"principal"})` + `isCurrent` |
| TH-03 criar participante | após logout exibia "registrado" e disparava leitura de lista (**falha**) | guarda de principal em `cmd`; escrita permanece persistida no servidor |
| TH-07 `restoreContext` | caracterizado: sem defeito observável pela UI (a escolha manual já regravava o contexto armazenado) | guarda defensiva `begin("restore")`; teste mantido |
| PA-01 login por convite | sessão instalada após logout (**falha**) | `begin("auth")` + `isCurrent` |
| PN-01 login do painel | resposta da tentativa antiga sobrescrevia a nova (**falha**) | `begin("auth")` + `isCurrent` |

### Logout (FIX-43)

| ID | Antes | Depois |
|---|---|---|
| PA-02 signout (participante) | limpava só parte do estado; metas/prescrição/identificação/publicações ficavam no DOM | `clearParticipantSurfaces()`: prescrição, metas, publicações, resumo, evolução, identificação, resultados de sessão/relato, campos, banners; escritas e leituras tardias descartadas por ticket de principal |
| TH-02 signout (terapeuta) | `setActiveParticipant("")` só limpava com participante ativo | `clearTherapistSurfaces()` independente de participante ativo (fatos, série, timeline, resultados, formulários, convite, banners) |
| PN-05 signout (painel) | apenas ocultava seções | `clearPatientSurfaces()` esvazia o DOM do paciente, recentes, verificação, campos |

### Exclusões ratificadas — mantidas

PA-05..09 (sessão de atividade: single-flight/recuperação de sessão pendente → ARQ-05), PA-12 (local, sem rede), TH-18 (`syncRetention`, baixo risco) e TH-19 (`loadCatalogs`, cache global) **continuam fora do CMP-10**. Observação de transparência: em PA-05/06/07/08 e PA-09 foi acrescentado **somente** um ticket de principal que impede renderização/estado após logout (requisito FIX-43). Não houve mudança de single-flight, de `pendingReport` nem da política de recuperação de sessão pendente.
