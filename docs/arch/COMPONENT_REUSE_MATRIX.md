# COMPONENT_REUSE_MATRIX

Base: baseline `ed5099356d38050a51f9b5de1e1c09ca57b2ce4a`. Estratégia = a da planilha *Componentes V2.2* (proposta, a ratificar). Coluna *Situação* = estado após ARQ-01.

| ID | Componente | Estratégia V2.2 | Ativo existente | Pacote | Situação |
|---|---|---|---|---|---|
| CMP-01 | UI primitives / Access | ADAPT | tokens.css/json, base.css, a11y.mjs | ARQ-07 | não iniciado |
| CMP-02 | Internacionalização estruturada | REUSE + ADAPT | i18n.mjs, i18n_pt/en.mjs | ARQ-04 | não iniciado |
| CMP-03 | Feedback e erros de domínio | ADAPT | ui_messages.mjs, errors.py; handlers repetidos | ARQ-01/04 | ARQ-01: parcial (FieldError de data); resto em ARQ-04 |
| CMP-04 | Data civil e intervalos | NEW + ADAPT | therapist.html:147; i18n.mjs:104; schema assessment | ARQ-01 | ARQ-01: IMPLEMENTADO (parcial: ver limites) |
| CMP-05 | Form state e ValidationRegistry | ADAPT | entities.validate, validation.py, ClinicalEntitySpec | ARQ-01 | ARQ-01: parcial (camada de datas civis, servidor); FormController em ARQ-02/03 |
| CMP-06 | Catálogos e controles de domínio | ADAPT + NEW | Catálogo de limites, Goal, instrumentos | ARQ-03 | não iniciado |
| CMP-07 | Ciclo de vida do comando | NEW + ADAPT | Handlers de submit atuais | ARQ-02 | não iniciado |
| CMP-08 | Idempotência transacional | ADAPT + NEW | ledger.py/reviews.py; create clinical.py:482 | ARQ-02 | não iniciado |
| CMP-09 | Identidade, policy, consentimento e privacidade | ADAPT | auth.py, authz.py, store.py, validation.py | ARQ-06 | não iniciado |
| CMP-10 | Contexto e cliente API | ADAPT | api_client.mjs, participant_api.mjs, therapist/painel apps | ARQ-04 | não iniciado |
| CMP-11 | Sessão de atividade e segurança | ADAPT | participant_model/stage/app.mjs, session_rules.py | ARQ-05 | não iniciado |
| CMP-12 | Outbox e recuperação | ADAPT + NEW | Lote idempotente ledger; outbox local a validar | ARQ-05 | não iniciado |
| CMP-13 | Entidades clínicas versionadas | REUSE + ADAPT | clinical.py, entities.py, prescriptions.py | ARQ-03 | não iniciado |
| CMP-14 | Captura e adaptadores de dispositivo | ADAPT | web/s2, web/hand.js (comparar) | ARQ-08 | não iniciado |
| CMP-15 | Motion core | ADAPT | web/s2/counter.js e web/counter.js (comparar) | ARQ-08 | não iniciado |
| CMP-16 | Play runtime e conteúdo | ADAPT | Organizar a mesa / protótipos | ARQ-08 | não iniciado |
| CMP-17 | Núcleo Evidence | REUSE + ADAPT | ledger.py, verifier.py, validation.py, canonical.mjs | ARQ-06 | não iniciado |
| CMP-18 | Revisão e publicação | REUSE + ADAPT | reviews.py, verifier.py, UI de revisão | ARQ-06 | não iniciado |
| CMP-19 | Progress / comparabilidade | ADAPT | evolution.py, painel_model.mjs e timeline | ARQ-06/09 | não iniciado |
| CMP-20 | Intelligence drafts | ADAPT (planejado) | Interfaces previstas; ativos legados não normativos | ARQ-09 | não iniciado |
| CMP-21 | Áudio e instruções acessíveis | NEW + ADAPT | HTML audio/Web Speech candidatos | ARQ-09 | não iniciado |
| CMP-22 | Remote e agenda | ADAPT + NEW | Encounter, Clinical e Progress | ARQ-10 | não iniciado |
| CMP-23 | Persistência/migração/auditoria | REUSE + ADAPT | store.py, ledger.py, contratos, vetores | ARQ-07 | não iniciado |
| CMP-24 | Exportação e notificações | NEW + ADAPT | Templates/serviços candidatos | ARQ-10 | não iniciado |
| CMP-25 | Test harness / guardas de arquitetura | ADAPT | pytest, node:test, harness browser, fixtures | Transversal | não iniciado |

Nenhum componente classificado REBUILD: evolução incremental é segura em todos os casos analisados. Os ativos de CMP-14..16 (`web/s2`, `web/hand.js`, `web/counter.js`) pertencem a S2+ e não foram inspecionados a fundo (fora de escopo).
