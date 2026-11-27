# ARQ-05 — Rastreabilidade (planejada)

| Origem | Achado | Componente | Fase | Critério | Teste previsto |
|---|---|---|---|---|---|
| FIX-15 / S1-01 | S-01, S-06, O-02 | Outbox + SessionController `RECOVER` | 1–4 | AC5-04 | `s1_arq05_recovery` (reload após parada por dor) |
| FIX-14 / S1-02 | S-02, S-07 | SessionController R-S3 | 2–3 | AC5-05 | `s1_arq05_session` (Iniciar com relato pendente) |
| US-033 CA02/CA04 | S-03 | StopAction local-primeiro | 2–3 | AC5-01 | offline + parada |
| (novo) | S-04 | evento imutável + replay | 1–3 | AC5-02 | resposta perdida + 2º clique |
| (novo) / FIX-02 | S-05 | single-flight de SessionController | 2–3 | AC5-03 | duplo clique |
| US-037 CA01..CA05, US-013 CA01..CA05 | O-01 | Outbox | 1, 3, 4 | AC5-04, 06..09 | unit + navegador |
| ARQ-02 AD-11 | O-03, O-04 | IntentionJournal; reconciliação por replay | 5 | AC5-12 | `s1_arq05_journal` |
| FIX-13 / S1-04 | §6 | `loadPublications`/`openSummaryById` | 6 | AC5-13 | `s1_arq05_publications` |
| FIX-16 | §6 | fora do ARQ-05 | — | — | D-ARQ5-09 |
| FIX-17 / D01 | texto | **sem mudança** (regressão preservada) | — | AC5-14 | `s1_arq03_fix01` |
| FIX-37 / ARQ-04 | isolamento | ContextStore/ContextGuard | pré-req. | AC5-10 | `s1_arq04_context` |
| US-031 CA03/CA05, US-034 CA03/CA04, US-124 CA04 | — | SessionController | 2–3 | AC5-01, 03 | unit de máquina de estados |
| US-066, US-144 | — | **fora** (S2 / P1) | — | — | — |
