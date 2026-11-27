# ARQ-05 — Relatório de diagnóstico (CMP-11 Sessão de atividade e segurança / CMP-12 Outbox e recuperação)

**Status: PREPARAÇÃO DOCUMENTAL. Nada implementado; nenhum código, contrato ou teste alterado.** Baseline candidata `2cf4bab` (ARQ-03 + FIX-01; A2 candidato 3.2.0, não congelado). Dados exclusivamente sintéticos. Depende, em parte, de ARQ-04 (ContextStore/ContextGuard), que também está só planejado.

## 0. Fontes e limites
| Fonte | Uso |
|---|---|
| Controle de Defeitos e Backlog S1 (Drive, exportação xlsx de 26/11, 21:53 UTC) | S1-01, S1-02, S1-04, D01, FIX-13..17, histórico |
| Product Backlog (Drive, xlsx) — abas "Componentes V2.2", "Histórias x Componentes", "Critérios de aceite", "FIX x Histórias" | CMP-11/12, 11 histórias de CMP-11/12, critérios US-013/031/033/034/037/038/124 |
| `PROPOSTA_ARQUITETURA_COMPONENTIZACAO_V2_2.md` | CMP-11/12, DT-03, DT-05, DT-06, ordem de entrega |
| Código `2cf4bab`: `participant_app.mjs`, `participant_model.mjs`, `participant_api.mjs`, `command_controller.mjs`, `session_rules.py`, `ledger.py`, `router.py`, `store.py`, `command_dedup.py` | todos os achados abaixo |
| ADs anteriores (`ARCHITECTURE_DECISIONS.md` AD-11, `ARCHITECTURE_IMPACT_ANALYSIS.md`) | dependências ARQ-02 → ARQ-05 |

**Honestidade metodológica.** Os achados são leitura estática do código e das planilhas. S1-01 e S1-02 estão **confirmados pelo UAT** (ceb7391). Os achados marcados *[hipótese a caracterizar]* decorrem só da leitura e viram teste de caracterização na Fase 0 do plano. Não executei novos testes de navegador nesta etapa. O relatório do Gemini/Codex sobre o FIX-01 ainda não foi recebido.

## 1. Situação registrada dos defeitos-alvo
| ID | Resumo | Sev. | Status no controle |
|---|---|---|---|
| FIX-15 / S1-01 | Recarga após interrupção perde o contexto do relato (parada por dor + recarga deixou o envio desabilitado) | Alta | Aberto |
| FIX-14 / S1-02 | Nova sessão substitui o contexto de relato pendente, sem aviso (nova prática após parada por cansaço) | Alta | Aberto |
| FIX-13 / S1-04 | Resumo aberto por código com estado "nada compartilhado" contraditório | Média | Aberto |
| FIX-16 | Integrar painel e jornada clínica (painel ainda exige ID) | A definir | Backlog (melhoria) |
| FIX-17 / D01 | Texto da parada | Baixa | Parcial; EN corrigido, PT corrigido no FIX-01 do ARQ-03 aguardando reteste; **só texto, não é regra de sessão** |
| FIX-37 | Contexto assíncrono | Alta | Parcial → ARQ-04 |

Histórias principais: **CMP-11** US-031, 032, 033, 034, 038, 066, 124, 125; **CMP-12** US-013, 037, 144 (P1). Critérios governantes: US-037-CA01..05 (persistir localmente, restaurar após recarga "conforme política de segurança", estados pendente/sincronizado/conflito, reenvio idempotente, preservar em conflito, **não burlar autorização/consentimento**), US-013-CA01..05, US-033-CA02 (parada imediata, "sem exigir preenchimento adicional"), US-034-CA03/04, US-031-CA05.

## 2. Como a sessão do participante funciona hoje
- Todo o estado de sessão vive em **uma variável em memória**: `state.activeSession = { sessionId, seq, lastHash, lastOccurredAt, phase: "active"|"ended", endAction }`, e `state.pendingReport` (evento do relato). Nada disso é persistido. Só o **token** e o principal ficam em `sessionStorage` (`elo_v3_participant_session`).
- O fluxo é: *iniciar* (lote `session.started` + `session.control(start)`, seq 1–2) → *parar* (`session.control` pain/fatigue/end, seq 3) → *relato* (`report.submitted`, seq 4). Cada evento é encadeado por `prev_hash` e `seq`, e **o hash cobre `occurredAt`**.
- O servidor (`session_rules.advance_phase`) deriva a fase `created → active → ended`; `report.submitted` só é aceito em `ended`/`completed`. Reenviar o **mesmo** evento (mesmo `event_id` e hash) devolve `DUPLICATE` (não é erro); o **mesmo `seq` com hash diferente** é `HASH_CONFLICT` (rejeitado); `seq` seguinte com `prev_hash` errado é `CHAIN_BROKEN`; salto de seq é só `SEQ_GAP` (aviso).
- A idempotência dos eventos de participante é **natural** (por `event_id`/hash do ledger). O `Idempotency-Key` do ARQ-02 (CommandDedupStore) cobre os comandos do **terapeuta**, não `events:batch`.
- O participante **não tem rota de leitura da própria sessão**. As rotas permitidas (`participant_api.mjs`) são: `auth.invite`, `prescriptions.current`, `goals.list`, `events.batch` (POST), `summaries.get`, `evolution.get` e a leitura de publicações em `/api/console/v1/`. Não há como "perguntar ao servidor" em que fase a sessão está.
- Token do participante: TTL de 3600 s (`store.issue_token`); convite é de uso único.

## 3. Achados (CMP-11)

| # | Achado | Evidência | Defeito | Confiança |
|---|---|---|---|---|
| S-01 | **Recarga perde a sessão.** `activeSession` e `pendingReport` só existem em memória; após `F5`, `updateControlsState` vê `phase` nulo: relato desabilitado ("é preciso uma sessão"), início habilitado. Sem `seq`/`lastHash` não é possível sequer encadear um relato válido ao fluxo já gravado. | `participant_app.mjs` l.100–108, 286–306 | FIX-15 / S1-01 | confirmado (UAT) + código |
| S-02 | **Iniciar fica habilitado com sessão encerrada e sem relato.** `btnSessionStart.disabled = isActive`; em `phase === "ended"` o botão está habilitado e o handler de início **sobrescreve** `state.activeSession` e chama `resetReportChoices()` sem aviso. A sessão encerrada fica sem relato para sempre. | l.286–290, l.719–770 | FIX-14 / S1-02 | confirmado (UAT) + código |
| S-03 | **A parada só vira "encerrada" depois da resposta da rede.** `endActiveSession` faz `await postEventsBatch` e só então muda `phase`. Offline ou lento, a tela continua "ativa" e a participante não sabe se a parada valeu. Contraria US-033-CA02 e a regra V2.2 "pausa/parada imediata inclusive offline". | l.570–624 | — (novo) | código; *[hipótese a caracterizar]* offline |
| S-04 | **Repetir a parada após resposta perdida gera `HASH_CONFLICT`.** O evento de parada é **reconstruído a cada clique** com novo `occurredAt` (novo hash) e o mesmo `seq`. Se a primeira tentativa foi gravada e a resposta se perdeu, a segunda é rejeitada (`HASH_CONFLICT`) e o app mostra erro com a sessão já encerrada no servidor. O relato evita isso (`pendingReport` reutiliza o mesmo evento); a parada e o início não. | `endActiveSession` l.589–606; `ledger.py` l.763–770 | — (novo) | código + ledger; *[hipótese a caracterizar]* com resposta perdida |
| S-05 | **Início e parada sem single-flight.** `btn-session-start` e os três botões de parada não usam o `CommandController` nem se desabilitam durante a requisição: duplo clique em "Iniciar" cria **dois `sessionId`** (dois streams), o segundo substituindo o primeiro na memória. | l.719–770, l.774–776 | — (novo; relacionado a S1-03/FIX-02) | código; *[hipótese a caracterizar]* |
| S-06 | **Relato: "resultado desconhecido" não sobrevive à recarga.** `pendingReport` e a intenção do `CommandController` estão em memória. Após falha ambígua e recarga, a participante não consegue reenviar o **mesmo** evento; o ledger aceitaria o replay (DUPLICATE), mas o evento não existe mais. | l.793–870 | FIX-15 | código |
| S-07 | **Sem aviso de pendência.** Não existe estado "relato pendente" visível nem lista de sessões encerradas sem relato. | — | FIX-14/15 | código |
| S-08 | **Pausa/retomada** existem na máquina do servidor (`pause`/`resume`), mas a UI do participante só oferece início e parada. Fora do escopo do CMP-11 desta etapa (sem sensor); registrar para US-034-CA02/US-124. | `session_rules.py` | — | código |
| S-09 | **Sem política de sessão órfã.** Se o estado local for perdido no meio de uma sessão ativa, o stream fica `active` no ledger sem evento terminal; o terapeuta vê sessão incompleta. Não há regra de encerramento por expiração. | `session_rules.py` | — | código (decisão de PO) |

## 4. Achados (CMP-12 e transversais)

| # | Achado | Evidência |
|---|---|---|
| O-01 | **Não existe outbox.** US-037/US-013 (P0) estão sem implementação; "persistir localmente pendentes" = 0. | busca por `indexedDB`/`localStorage` em `web/v3`: só `i18n` e recentes do painel |
| O-02 | **Armazenamento atual é só `sessionStorage`** (token do participante, contexto do terapeuta): por aba, some ao fechar a aba. Recarregar na mesma aba preserva. Fechar a aba e voltar exige novo login; como o **convite é de uso único**, a participante precisa de **novo convite** (dependência ARQ-06). | `participant_app.mjs` l.45–62 |
| O-03 | **Persistência de chaves de idempotência**: o `CommandController` guarda intenção e chave **só em memória**. Recarga após falha ambígua descarta a chave: um reenvio após a recarga usaria **nova chave** e pode **duplicar** o efeito (risco já registrado em `ARCHITECTURE_IMPACT_ANALYSIS`). Persistir a chave **sem** o payload impede o reenvio automático (o payload é dado clínico e não deve ficar no navegador, AD-11). | `command_controller.mjs` |
| O-04 | **Reconciliação de "resultado desconhecido"** hoje é manual: o estado `unknown` exige "Iniciar nova tentativa" e a verificação é "orientada ao usuário (histórico)". Para eventos de participante existe um caminho **determinístico**: reenviar o evento idêntico (DUPLICATE ⇒ já estava gravado). Para comandos do terapeuta não há consulta por chave (nenhuma rota). | AD-11, `ARCHITECTURE_DECISIONS.md` l.34 |
| O-05 | **Sem coordenação entre abas.** Duas abas da participante gerariam duas cadeias para o mesmo prescrito; hoje isso é possível sem conflito local porque nada é compartilhado. | — |
| O-06 | **Logout e dados pendentes.** O logout do participante zera `state.session` e o `sessionStorage`; não há conceito de "pendência que precisa sobreviver ou ser descartada de forma explícita". | l.664–685 |

## 5. Avaliação do armazenamento local (para CMP-12)

Requisitos derivados: (R1) gravar **antes** de enviar (write-ahead); (R2) registros pequenos (eventos já construídos e hasheados; alguns KB); (R3) atomicidade por escopo; (R4) isolamento por principal + participante; (R5) sobreviver à recarga; (R6) opcionalmente sobreviver ao fechamento da aba; (R7) não guardar token, áudio, vídeo nem conteúdo clínico livre; (R8) testável de forma determinística em navegador automatizado.

| Critério | Memória | `sessionStorage` | `localStorage` | IndexedDB |
|---|---|---|---|---|
| Sobrevive à recarga | não | **sim** | sim | sim |
| Sobrevive ao fechar a aba/navegador | não | não | **sim** | **sim** |
| Compartilha entre abas | não | não | sim (evento `storage`) | sim (transações, `BroadcastChannel`) |
| API | trivial | síncrona | síncrona | **assíncrona** |
| Atomicidade multi-registro | n/a | 1 chave = atômica | 1 chave = atômica | **transações** |
| Cota | n/a | ~5 MB | ~5 MB | muito maior |
| Write-ahead antes do `fetch` | n/a | trivial | trivial | exige `await` do `put` antes do envio (viável) |
| Exposição a XSS na mesma origem | n/a | total | total | total (mesma origem) |
| Complexidade/teste | nenhuma | baixa | baixa | **maior** (abertura, versão de esquema, falhas de abertura em modo privado, ordenação assíncrona) |
| Ganho real para o volume previsto (≈ 4 eventos/sessão, 1 sessão pendente por vez) | — | suficiente p/ recarga | suficiente p/ fechamento | **sem ganho mensurável hoje** |

Conclusão técnica: para o volume e os requisitos P0, **IndexedDB não traz benefício que justifique a complexidade**; o limite real é a **política de segurança** (R6/R7), não a tecnologia. Recomendação: definir a interface `OutboxStore` **assíncrona** (assim IndexedDB entra depois sem tocar os consumidores) e implementá-la primeiro sobre **uma chave de armazenamento por escopo**, escolhendo `sessionStorage` (só recarga) ou `localStorage` (também fechamento) conforme a decisão D-ARQ5-02 do PO. IndexedDB fica como evolução quando houver fila longa, múltiplos tipos de registro ou necessidade de Service Worker/Background Sync, nenhum previsto no MVP. Nenhuma das três opções é segura contra XSS; por isso o conteúdo do outbox é mínimo (R7) e a revisão de ameaça é pré-requisito.

## 6. FIX-13 e FIX-16
- **FIX-13 (S1-04)**: o texto "nada compartilhado" é produzido pelo status da lista de publicações (`loadPublications`, rota `/api/console/v1/participants/{id}/publications`), enquanto abrir por código usa outra fonte (`/api/v3/summaries/{id}`, `/api/v3/evolution/{id}`). *[hipótese a caracterizar]*: as duas fontes não são reconciliadas e o status textual não é atualizado quando um resumo é aberto por código; também `loadPublications` engole o erro (`catch {}` → "falha"), o que pode se confundir com "vazio". Causa **não confirmada**; a Fase 0 do plano reproduz S1-04 antes de qualquer correção. Esta é uma melhoria de **leitura/estado**, não de sessão; não depende do outbox.
- **FIX-16 (painel × jornada)**: item de **melhoria** com prioridade "a definir". Depende de ARQ-04 (seletor autorizado único via ContextStore). Recomendação: **não incluir no ARQ-05**; decidir no PO (D-ARQ5-09).

## 7. Dependências
| Dependência | Direção | Observação |
|---|---|---|
| ARQ-02 CommandController / CommandDedupStore | CMP-12 usa | chaves e janela de retenção (1–90 dias, padrão 7; janela do cliente = mín(24 h, retenção − 1 h)) |
| ARQ-04 ContextStore / ContextGuard | CMP-12 usa | escopo `principal+participante+geração` e `onReset("logout")` como gatilho de isolamento; **sem ARQ-04, o isolamento do outbox seria reimplementado** |
| ARQ-06 CMP-09 (logout servidor, expiração, token) | CMP-12 depende | token 1 h e convite único determinam se recuperação após fechar a aba é possível; revogação de vínculo no reenvio |
| `session_rules.py`, `ledger.py`, `events:batch` | reuso integral | **nenhuma alteração de servidor/contrato prevista** no caminho recomendado |
| ARQ-03 | herda | sem acoplamento; `ValidationRegistry` não participa |

## 8. Riscos do próprio ARQ-05
1. **Segurança de dados em repouso**: o relato do participante (execução/assistência) é dado de saúde quando real; hoje é sintético. Armazenar localmente exige política (D-ARQ5-02/04) e revisão de ameaça (XSS, aparelho compartilhado).
2. **Cadeia de hash**: o outbox deve guardar eventos **imutáveis já construídos**; nunca reconstruir (S-04). Perder o estado no meio da cadeia não é recuperável localmente.
3. **Multi-aba**: duas abas gravando a mesma cadeia (O-05).
4. **Reenvio após revogação**: o servidor reavalia autorização/consentimento a cada `events:batch`; o outbox não pode contorná-lo (US-037-CA05).
5. **Segurança da parada**: nenhuma regra de reenvio, bloqueio ou erro de rede pode impedir ou atrasar a parada local (US-033-CA02).
6. **Escopo**: P0 apenas; recuperação de chamada remota (US-144) é P1 e fica fora.

## 9. O que não é problema (preservar)
Hash encadeado e validação do servidor; relato único por sessão (`state.lastReportSlot`, settled); `pendingReport` reutilizado como evento único por intenção (padrão correto a **generalizar** para início/parada); `nextMonotonicIso` (monotonicidade do relógio local); projeções do terapeuta; autorização por vínculo no servidor; contratos congelados.
