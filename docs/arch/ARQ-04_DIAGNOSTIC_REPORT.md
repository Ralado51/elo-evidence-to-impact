# ARQ-04 — Relatório de diagnóstico (CMP-10 / CMP-03 / CMP-02)

**Status: PREPARAÇÃO DOCUMENTAL — SUSPENSA em 26/11 19:56 por mandato FIX-01 do ARQ-03 (somente este relatório foi redigido; COMPONENT_DESIGN, IMPLEMENTATION_PLAN, TRACEABILITY, PO_DECISION_MATRIX e o inventário ainda não foram escritos; os levantamentos para eles estão neste relatório e no resumo da sessão). Nenhum código, contrato ou teste foi alterado.** Baseline candidata `ab0d753` (ARQ-03, em homologação por Gemini e Codex). Implementação funcional **bloqueada** até o aceite do ARQ-03 pelo PO. Sem push, sem deploy. ARQ-05 e S2 não iniciados. Dados exclusivamente sintéticos. Contratos congelados 3.0.0 / 3.1.0 e o candidato A2 (3.2.0) **não** são alterados por este documento.

## 0. Fontes consultadas e limites

| Fonte | Versão | Uso |
|---|---|---|
| Elo — Product Backlog (Drive `1FNlEiyL…`) | exportação completa xlsx de 26/11/2026, modificada às 21:53 UTC | 145 histórias, 599 critérios (aba "Critérios de aceite"), "Componentes V2.2", "Histórias x Componentes", "Entregas e evidências" (EV-01..18), "Histórico" |
| Elo — Controle de Defeitos e Backlog S1 (Drive `1rYT7VjX…`) | exportação completa xlsx, mesma data | FIX-09, FIX-18, FIX-37 e FIX-37.1–37.4, D07, FIX03-R01 |
| `PROPOSTA_ARQUITETURA_COMPONENTIZACAO_V2_2.md` | 26/11/2026 17:52 | CMP-02/03/10, DT-02, DT-03, DT-05, DT-06, critério arquitetural transversal |
| Código no baseline `ab0d753` | leitura estática de `web/v3/*.mjs`, `api/src/elo/v3/*.py` | todos os números de linha abaixo |
| Relatórios de homologação do Drive | **parcial** | `ARQ-07_FIX37_VALIDATION_REPORT.md` (Gemini 52d9bbd) **não foi localizado no Drive**; o resultado FX37 (6/8) e a descrição dos quatro achados vêm das linhas FIX-37.x e EV-17 do controle. Não reexecutei a suíte FX37. |

Pendência resolvida: o export em CSV do Drive devolvia só a aba-resumo; o export **xlsx** traz o workbook completo. A comparação com o dump anterior (17:36) mostra 4 entregas novas (EV-15..18), FIX x Histórias 37→38 e Validação R01 30→31; nada que altere o escopo do ARQ-04. Registro: a planilha agora lista os 599 critérios (os 600 do dump contam o cabeçalho).

Honestidade metodológica: os achados abaixo são **leitura estática do código** do baseline. Onde o controle diz "risco a testar" (assessment/prescription em FIX-37.1), eu descrevo a exposição estrutural; a reprodução fica como teste de caracterização na Fase 0 do plano (§ARQ-04_IMPLEMENTATION_PLAN).

## 1. Situação registrada dos defeitos-alvo (controle de 26/11)

| ID | Resumo | Severidade | Tipo | Status no controle |
|---|---|---|---|---|
| FIX-37 / FIX03-R01 | Resposta tardia de Alfa sobrescreve Beta | Alta | Defeito confirmado | Original corrigido em `2881ced` (FX37-LATE-RESPONSE PASS); FIX-37 **Parcial**, 6/8 PASS |
| FIX-37.1 | Resultado de criação de meta tardio aparece no contexto de outro participante | Alta | Confirmado | Backlog (FX37-WRITE-AFTER-SWITCH: `reviews.record` PASS, `goals.create` FAIL) |
| FIX-37.2 | Erro tardio de linha do tempo aparece em outro contexto | Média | Confirmado | Backlog (FX37-STALE-ERROR-LOADING: `facts.list` PASS, `timeline.get` FAIL) |
| FIX-37.3 | ContextGuard centralizado | Alta | Melhoria | Backlog |
| FIX-37.4 | Esgotamento de 3 tentativas na carga de fatos | Média | Risco não reproduzido | Backlog |
| FIX-09 | Isolamento na troca, recarga e logout | Alta | Risco técnico | Parcial: "escrita de meta e erros tardios residuais; logout não coberto" |
| FIX-18 / D07 | Mensagens de validação específicas por campo | Baixa | Defeito confirmado | Parcial: datas, revisão e relato aprovados; erros gerais e feedback contextual parciais |
| E-01..E-03 / FIX-25–36 | i18n estruturado | — | — | Corrigidos no escopo (ed50993); ressalvas FIX-33–36 |

CMP-10 no catálogo V2.2: "Parcial em 2881ced (6/8 FX37); guardas inline. ContextGuard centralizado e residuais no ARQ-04". CMP-03: "Parcial: feedback de data/relato/revisão verificado; demais campos e contexto pendentes". CMP-02: "Proposta — não implementado por esta revisão" (a base ed50993 existe e foi aceita operacionalmente).

## 2. Achados — CMP-10 (contexto)

### 2.1 Mecanismo atual (o que já funciona)
No terapeuta (`therapist_app.mjs`) há três contadores ad hoc em `state` (l.127–129): `ctxSeq` (incrementado em `setActiveParticipant` quando o participante muda, l.372–376), `factsLoadSeq` e `reviewEpoch`. 11 pontos testam `seq !== state.ctxSeq` / `=== state.ctxSeq`. `setActiveParticipant` (l.372–420) limpa estado, caixas de resultado, linha do tempo e **reseta cinco formulários por lista fixa** (`form-assessment`, `form-goal`, `form-prescription`, `form-summary`, `form-evolution`). Revisões (l.628–660), resumo (l.1357–1361), evolução (l.1412–1416), carga de fatos (l.1269–1335), série de evolução (try, l.1372–1374) e linha do tempo (try, l.1427–1429) já descartam respostas **bem-sucedidas** tardias. `CommandController` (ARQ-02) cuida de single-flight, chave de idempotência e `slotOf = form@participante`.

### 2.2 Lacunas confirmadas por leitura do código

| # | Lacuna | Evidência (`ab0d753`) | FIX |
|---|---|---|---|
| G-01 | **Escrita de meta tardia renderiza no contexto errado.** O `onOk` de `goal` não verifica o contexto. | `therapist_app.mjs` `cmd("goal", …, async (res) => { renderBox("goal-result", …) })` (l.1179–): sem `ctxSeq`. `setActiveParticipant` apaga as caixas, mas um `onOk` que chega depois reconstrói a caixa já no novo participante. | 37.1 (confirmado) |
| G-02 | **Mesma exposição estrutural** em avaliação e prescrição. | `cmd("assessment", …)` l.1128 e `cmd("prescription", …)` l.1238: sem guarda. Em prescrição, além disso, a leitura posterior usa o estado **vivo**: `client.getCurrentPrescription(state.participantId)` (l.1240) — pode ler o participante errado. | 37.1 (risco; teste na Fase 0) |
| G-03 | **Criação de participante tardia sequestra o contexto.** O `onOk` chama `setActiveParticipant(ent.entity_id, …)` (l.965) mesmo que o terapeuta já tenha escolhido outro. | `cmd("participant", …)` l.962. | 37.1 |
| G-04 | **Convite tardio.** `btn-create-invite` (l.1037–) lê `state.participantId` **depois** do `await` (l.1055: `box.dataset.inviteFor = state.participantId`), podendo rotular o convite de Alfa como de Beta. O token é segredo de uso único: descartá-lo sem aviso o perde. | l.1037–1085 | 37.1 |
| G-05 | **Erro tardio em linha do tempo e série.** O `catch` não consulta o contexto. | `btn-load-timeline` `catch (err) { handleApiError(err); }` (l.1431); `btn-load-evolution-series` idem (l.1383). Contraste: carga de fatos protege (`if (seq === state.ctxSeq) handleApiError(err)`, l.1332). | 37.2 (confirmado) |
| G-06 | **Estados de carregamento não modelados.** Só há *flags* ad hoc (`inviteBusy`, `selectBusy`, `inflight` do CommandController). Um `finally` tardio pode liberar um botão que pertence a uma operação mais nova. | grep `busy` em `therapist_app.mjs` | 37.2 |
| G-07 | **Nenhum cancelamento.** Não há `AbortController`/`signal` em `web/v3` (grep vazio). Respostas obsoletas são só ignoradas, quando o são; a requisição segue consumindo o limite de 120 req/60 s da API. | `api_client.mjs` `request` (l.83), `participant_api.mjs` `request` (l.99) | 37.3 |
| G-08 | **Sem ordenação de leituras concorrentes.** Duas buscas de participante (`refreshParticipantList(q)`, l.477) ou duas aberturas no painel podem resolver fora de ordem: vence a **última a chegar**, não a **última solicitada**. | `refreshParticipantList` sem guarda; `openPatient` do painel (l.339–376) sem guarda alguma | 37.3 |
| G-09 | **Logout não é fronteira de contexto.** `btnSignout` (l.904) zera sessão e chama `setActiveParticipant("")`, que só incrementa `ctxSeq` se havia participante ativo. Uma `refreshParticipantList` em voo (nível de principal) resolve depois e repinta a lista do terapeuta anterior. No participante, `loadPlan` (l.550–568) captura `pid` mas grava `state.prescription/goals` e renderiza **após** o logout (`btnSignout`, l.664, sem geração). | l.477–495, 550–568, 664–686 | FIX-09 (logout não coberto) |
| G-10 | **Esgotamento silencioso das 3 tentativas.** A carga de fatos repete até 3 vezes se um `reviewEpoch` mudou; ao esgotar, sai do laço e renderiza a **última projeção, possivelmente anterior à revisão**, como se estivesse atual. Cada tentativa refaz a leitura de evidências (um `GET /facts/{id}/evidence` por sessão distinta). O `catch` só testa `ctxSeq`, não `factsLoadSeq`. | l.1269–1335 | 37.4 |
| G-11 | **Três implementações de proteção** (terapeuta com contadores, participante e painel **sem** proteção) e **dois clientes** HTTP com `request` duplicado. | `api_client.mjs`, `participant_api.mjs`; `painel_app.mjs` usa `rawFetch` (l.96) para `entities.versions` e `facts.verify`, fora do cliente tipado (rotas fora do cliente tipado; a cobertura exata da lista de rotas do cliente em relação às operações do servidor **não foi verificada** nesta etapa) | 37.3 |
| G-12 | **Reset de contexto por lista fixa.** Cinco formulários e `PARTICIPANT_RESULT_BOXES` hard-coded; um formulário novo (ARQ-03 acrescentou campos, ARQ-04 pode acrescentar mais) escapa do isolamento se não for lembrado. | l.372–420 | 37.3 |
| G-13 | **Não existe reconciliação de escrita tardia.** Uma escrita já persistida para Alfa, concluída depois da troca, não deixa rastro para Alfa: a UI do terapeuta não sabe que há coisa nova até recarregar manualmente. | consequência de G-01..G-04 | 37.1 |

### 2.3 O que **não** é problema (preservar)
Idempotência e single-flight (`CommandController`, A1), chaves por `form@participante`, autorização por vínculo no servidor, hash chain das entidades, `effective_reviews` (A2-01), isolamento de leituras bem-sucedidas e geração ABA (aprovados em `2881ced`). Escritas **já persistidas nunca devem ser canceladas** — o desenho abaixo só controla o que é *exibido*.

### 2.4 Fora de escopo (não resolver com UI)
Revogação de token no servidor (logout server-side) e política de expiração: lacuna de arquitetura/contrato registrada em V2.2 §2 ("Logout e prazo de meta") e atribuída a **ARQ-06 / CMP-09**. O ARQ-04 define apenas o comportamento do **cliente** no logout.

## 3. Achados — CMP-03 (feedback e erros)

| # | Lacuna | Evidência | Critérios afetados |
|---|---|---|---|
| F-01 | **Funções de feedback duplicadas por página.** `showError/showSuccess/clearError` existem em `therapist_app` (14/16/3 usos), `participant_app` (13/9/2) e `painel_app` (5/0/3), com **assinaturas diferentes** (terapeuta: `showError(code, msg, technical)`; painel: `showError(error)`). `handleApiError` repetido (10 + 9 usos). | `therapist_app.mjs` l.165–190; `painel_app.mjs` l.70–80 | US-121-CA02/CA03, US-126, FIX-18 |
| F-02 | **Um único banner global**, sem dono. Resultado e erro de contextos diferentes podem coexistir: o banner de erro é do participante atual, mas a caixa de resultado (`goal-result`) pode ser de outro (G-01). Sucesso e erro são exclusivos **no banner**, mas não entre banner, caixas de resultado e erros por campo. | `showError` limpa só o banner de sucesso | "estados coerentes" |
| F-03 | **Mapeamento de erro por campo restrito.** `FIELD_FOR_PATH` (`domain_fields.mjs`) é um mapa **estático** com caminhos literais; os itens só resolvem em `items[0]` (o `handleApiError` aplica `FIELD_FOR_PATH[viol.path]` exato; o submit normaliza `items[\d+]`→`items[0]`). Qualquer outro índice cai no banner genérico. Hoje o formulário tem **uma** linha de item, então não há defeito ativo; é um limite de extensibilidade. | `therapist_app.mjs` `handleApiError`; `domain_fields.mjs` | FIX-18, ARQ-03 §4 |
| F-04 | **`details` em dois formatos.** Erros A2 trazem `details {rule, path}` (objeto); erros anteriores trazem `details` como **lista de códigos** (`["PATTERN"]`). `violationFromApiError` só lê o objeto. | `validation_registry.mjs`; `clinical.py` | — |
| F-05 | **Erro tardio** (G-05) é também um defeito de CMP-03: a apresentação de erro não conhece o dono da operação. | G-05 | 37.2 |
| F-06 | **Anúncio duplicado possível.** `announce` é chamado em `showError/showSuccess` **e** em vários pontos de validação de campo (`setFieldError` + `announce`); não há deduplicação do mesmo texto consecutivo. | `therapist_app.mjs` (11 usos de `announce`) | US-121-CA02 |
| F-07 | **Cobertura de reuso real.** `field_error.mjs` (extraído do DateField no ARQ-03) e `ValidationRegistry` já são o núcleo reutilizável; faltam o dono/escopo e o mapeador. | ARQ-03 F2 | — |

## 4. Achados — CMP-02 (internacionalização)

Mecanismos existentes e a preservar (`i18n.mjs`): `Msg`/`tm`, `Ref`/`lref`/`kref`, `bindText` + `retranslateMessages` (re-render sem fetch), `applyI18n` (`data-i18n`), `applyManagedDefaults` + `data-user-edited` (texto digitado nunca é retraduzido), evento `elo:lang` (cinco assinantes: terapeuta l.1506, participante l.138 e l.915, `participant_stage` l.47, painel l.416). `setLang` não faz chamadas de rede.

| # | Achado | Evidência | Gravidade |
|---|---|---|---|
| I-01 | **Regressão introduzida no ARQ-03 (a corrigir):** as opções de unidade do item de avaliação são criadas com texto já traduzido (`o.textContent = label("unit", u.unit)` em `applyUnits`), sem `data-i18n`/`Msg`. Ao trocar o idioma, o rótulo da opção permanece no idioma anterior. | `therapist_app.mjs` `applyUnits` | Média (consistência) |
| I-02 | `t()` (texto já renderizado) é usado 60× no terapeuta, 34× no participante, 21× no painel; a maioria dentro de construtores de caixa (`renderBox`/`boxBuilders`) que **são re-executados** na troca de idioma — correto. O risco é a *mesma chamada* gravada em estado ou passada a `showSuccess/showError/announce`. A varredura estática (`showSuccess(t(`, `showError(…t(`) não encontrou ocorrências; falta um **teste automático** que impeça a regressão. | grep | Baixa (prevenção) |
| I-03 | O painel tem 21 `t()` e 0 `boxBuilders`; re-renderiza por `renderPatientView()` no `elo:lang`. Está coerente, mas é um terceiro padrão. | `painel_app.mjs` l.416 | Baixa |
| I-04 | **Marcador de registros legados (pendente do ARQ-03).** Não existe. Registros gravados antes das regras A2 (ex.: meta `session_count` com `kg`; avaliação com instrumento fora do registro) são exibidos como armazenados — correto — mas sem sinalização. Superfícies que exibem entidades armazenadas: `participant_app.mjs` `renderGoals` (l.376–392) e `painel_app.mjs` (`patient-goal`, l.322); o terapeuta não possui lista de metas/avaliações hoje. | código | Pendência |
| I-05 | Durante a alternância de idioma, o estado de formulários (valor digitado igual ao padrão, seleções, `disabled`/`readonly` derivados de catálogo, checkbox "não avaliado") é preservado porque nada reconstrói os controles; os selects de domínio (instrumento, unidade) reconstroem **apenas** as opções, na inicialização. Falta teste que prove a preservação **depois** de A2. | ARQ-03 | Média (teste) |

## 5. CMP-05 — parcela remanescente (FormController)

`CMP-05` foi autorizado em parte no ARQ-03 (ValidationRegistry + erro por campo); "FormController completo adiado". Estado do código:
- **dirty/touched** já existe, fragmentado em três mecanismos: (a) `CommandController.release(formId)` ligado a `input/change` para iniciar nova intenção (ARQ-02, D-FIX01-1); (b) `data-user-edited` do i18n para valores padrão gerenciados; (c) `form.reset()` em `setActiveParticipant` e o listener de `reset` no `field_error`.
- Um FormController unificaria os três, mas **toca os seis formulários de comando** e a semântica de "nova intenção" aprovada pelo PO — risco alto para ganho moderado.
- Recomendação (ver matriz D-ARQ4-06): **manter em backlog** e incorporar no ARQ-04 apenas o que o CMP-10 exige — um registro de *resetters* de contexto (`store.onReset(fn)`), que remove a lista fixa de formulários (G-12) sem criar um controlador de formulário. Reavaliar o FormController completo no ARQ-07 (acessibilidade) quando houver demanda concreta de dirty/touched.

## 6. Oportunidades de simplificação e redução de duplicação
(medições são contagens de código **atual**; economia futura **não** é afirmada — V2.2 §5 exige coleta antes de declarar)

| Oportunidade | Hoje | Alvo |
|---|---|---|
| Guarda de contexto | 3 contadores + 11 condicionais espalhadas (terapeuta), 0 no participante e no painel | 1 `ContextGuard`; `commit()` substitui cada `if (seq !== …) return` |
| Transporte HTTP | 2 funções `request` duplicadas + `rawFetch` no painel | 1 transporte com `signal`; allowlists por capacidade preservadas |
| Feedback | 3 conjuntos de `showError/showSuccess/clearError` | 1 `StatusRegion` + `ResultBanner` + `ErrorMapper` |
| Mapeamento de erro | `describeApiError` + `handleApiError` ×2 + `violationFromApiError` + `FIELD_FOR_PATH` | 1 `ErrorMapper` |
| Reset de contexto | lista fixa de 5 formulários + `PARTICIPANT_RESULT_BOXES` | registro `onReset` |
| Detecção de legado | inexistente | 1 função pura reutilizando as regras do front (`goalTargetViolations`, `instrumentViolations`, `itemViolations`) |

## 7. Riscos do próprio ARQ-04
1. Tocar **todos** os handlers assíncronos amplia a superfície de regressão (36 handlers; ver inventário). Mitigação: caracterização antes, migração por lotes e suíte FX37 como porta de saída.
2. `AbortController` altera o comportamento de erro: `AbortError` não pode virar mensagem ao usuário nem ser tratado como falha "ambígua" pelo `CommandController` (que reenvia). Escritas **nunca** abortam.
3. Rate limit de 120 req/60 s: suítes de navegador devem continuar isoladas; reduzir requisições obsoletas (cancelamento) é efeito desejado, **não medido**.
4. Interação com ARQ-05 (CMP-11/12, outbox/recuperação): o ContextStore deve expor o escopo `principal+participante+geração` que a outbox futura usará para chavear pendências; o ARQ-04 **não** implementa outbox.
