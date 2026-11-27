# ARQ-04 — Rastreabilidade (planejada)

| Origem | Achado | Componente | Fase | Critério | Teste previsto |
|---|---|---|---|---|---|
| FIX-37.1 | G-01..G-04, G-13 | ContextStore `capture/commit/orphan` | 3 | AC4-01 | FX37-WRITE-AFTER-SWITCH (5 escritas) |
| FIX-37.2 | G-05, G-06, F-05 | `begin/fail`; ResultBanner por escopo | 3, 5 | AC4-02 | FX37-STALE-ERROR (timeline, série, fatos) |
| FIX-37.3 | G-07, G-08, G-11, G-12 | store + `http_transport` + `onReset` | 1–4 | AC4-03 | unit + `s1_arq04_context` |
| FIX-37.4 | G-10 | estado `stale` explícito | 3 | AC4-05 | caracterização "3 tentativas" |
| FIX-09 | G-09 | `reset("logout")` | 4 | AC4-04 | logout com leitura em voo ×3 apps |
| FIX-18 / D07 | F-01..F-07 | StatusRegion, ResultBanner, ErrorMapper | 5 | AC4-07 | `s1_arq04_feedback` |
| I-01 (ARQ-03 FIX-01) | unidade não retraduz | CMP-02 | 6 | AC4-08 | paridade de chaves + navegador |
| I-04 (pend. ARQ-03) | legado sem marcador | `legacyFindings` | 6 | AC4-09 | JS + navegador |
| I-05 | estado de formulário na troca de idioma | teste | 6 | AC4-08 | `s1_arq04_i18n` |
| FIX-01 do ARQ-03 | `createDomainRegistry`, select de estado, `goal.text_required` | **preservados**; erros desses campos passam pelo ErrorMapper sem mudar mensagem | 5 | AC4-06/07 | `s1_arq03_fix01` inalterada |
| G-05/36 handlers | inventário | — | 3–4 | AC4-01..04 | `ARQ-04_HANDLER_INVENTORY.md` |
| CMP-05 FormController | adiado | — | — | — | ARQ-07 |

## Revisão FIX-01 (baseline `b1e7a51`, correção consolidada da homologação independente)

| Origem | Achado | Componente / mudança | Critério | Teste (bloqueante) |
|---|---|---|---|---|
| Codex TH-11 / FIX-42 | `prescriptions.publish`: leitura secundária vaza para outro participante (`rxLeakedIntoBeta=true`) | `readAfterWrite(ticket,…)` em `therapist_app`; participante de origem, `signal`, revalidação após `await`, aviso de reconciliação; mesmas garantias em summary/evolution | AC4-01 | `s1_arq04_fix01` FIX42-01/02 |
| Codex PA-02 / FIX-43 | logout não limpava superfícies visíveis nem dados em memória | `clearParticipantSurfaces`, `clearTherapistSurfaces`, `clearPatientSurfaces`; tickets de principal nas escritas do participante | AC4-04 | `s1_arq04_fix01` FIX43 (participante e terapeuta) |
| Codex ARQ04-UAT-01 / FIX-41 | feedback de tentativa anterior sobrevivia a nova tentativa barrada pela validação local | `beginAttempt(kind)` + `RESULT_SURFACES`: ciclo de vida único das superfícies de resultado (avaliação, meta, prescrição, resumo, evolução); registros históricos intactos; no-op (`ignored/settled`) restaura | AC4-07 | `s1_arq04_fix01` FIX41-01/02 |
| I-01 (pendente) | unidade derivada somente-leitura exibia `sessions`/`reps` | `unitLabel`; chaves `enum.unit.sessions/reps`; valor canônico em `data-unit`; sem escrita ao alternar idioma | AC4-08 | `s1_arq04_fix01` I-01; paridade JS |
| FIX-44 | unidade histórica fora do catálogo (`cm`) virava "Não informado" | `unitLabel`: literal para unidade desconhecida, vazio só para ausente; marcador legado; texto via `textContent` | AC4-09 | `s1_arq04_fix01` FIX44 |
| Residuais | TH-01, PA-01, PN-01, TH-03, TH-07 | `begin("auth")`/`begin("restore")`; guarda de principal em `cmd` | AC4-03/04 | `s1_arq04_residual` (6) |
| TEC-03 | FX37-09 vacuoso (`n === -1` passava) | autenticação, status, parse e contagem exata são exigências; chave real `elo_v3_therapist_session` | — | `s1_arq04_context` FX37-09 |
| Inventário | 36 handlers sem operações secundárias | seção "Revisão FIX-01" em `ARQ-04_HANDLER_INVENTORY.md` | — | documental |

Contratos congelados **inalterados** (3.0.0 / 3.1.0 / 3.2.0): nenhum arquivo em `contracts/` ou no catálogo foi tocado. Nenhuma regra clínica nova.
