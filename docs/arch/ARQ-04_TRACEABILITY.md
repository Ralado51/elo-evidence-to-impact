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
