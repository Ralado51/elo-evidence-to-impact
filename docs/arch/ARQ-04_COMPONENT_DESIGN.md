# ARQ-04 — Desenho de componentes (CMP-10, CMP-03, CMP-02)

Status: **desenho documental; nada implementado.** Baseline candidata `2cf4bab`. Contratos congelados e A2 (candidato, não congelado) não são alterados por este desenho; nenhum item abaixo exige código novo de erro, rota ou propriedade de contrato.

Princípios herdados (V2.2 §1/DT-05/DT-06): monólito modular, módulos ES sem biblioteca; o servidor é a autoridade; a UI só controla o que é **exibido**; escrita já persistida nunca é cancelada; um proprietário por regra.

## 1. CMP-10 — ContextStore + ContextGuard (`web/v3/context_store.mjs`, novo)

**Escopo de contexto** = `{ principalId, role, participantId|null, generation }`. A geração é um inteiro monotônico por loja; **muda** quando (a) o participante ativo muda, (b) há logout/novo login, (c) recarga restaura contexto.

```
createContextStore({ onReset? }) -> {
  current(): Scope                      // snapshot imutável
  switchTo({principalId, participantId}) // incrementa generation se algo mudou; chama resetters
  reset(reason)                         // "logout" | "switch" | "reload"; sempre incrementa
  onReset(fn): unsubscribe              // substitui a lista fixa de formulários (G-12)
  begin(channel, { signal? }) -> Op     // leitura: cancela a op anterior do mesmo canal
  capture() -> Ticket                   // escrita: captura o escopo na intenção
}
Op     = { signal, isCurrent(), commit(fn), fail(fn), done() }
Ticket = { scope, isCurrent(), commit(fn), orphan(fn) }
```

Regras:
1. **Leituras** (`begin`): um `AbortController` por canal (`select`, `list`, `facts`, `timeline`, `series`, `plan`...); chamar `begin` de novo no mesmo canal aborta a anterior ⇒ vence a **última solicitada**, não a última a chegar (G-08). `commit(fn)` só executa `fn` se `isCurrent()`; `fail(fn)` idem — resolve G-05/F-05. `AbortError` é silencioso (nunca vira mensagem nem "falha ambígua").
2. **Escritas** (`capture`): nunca recebem `signal`. O ticket é capturado **antes do `await`**; `commit(fn)` executa a renderização só se o escopo ainda é o corrente. Se não é, chama `orphan(fn)`: reconciliação (§3), nunca descarte silencioso.
3. `reset` aborta todas as leituras, invalida todos os tickets e dispara os resetters registrados. Logout é fronteira de contexto (G-09).
4. Nenhum acesso a `state.participantId` **após** `await`; leituras posteriores usam `scope.participantId` capturado (corrige TH-11 e TH-08).
5. A API é independente de DOM: testável com `node:test`.

**Substituição por etapas**: os contadores `ctxSeq`/`factsLoadSeq`/`reviewEpoch` migram para o store sem mudar o comportamento já aprovado em `2881ced` (suíte FX37 como porta). `reviewEpoch` permanece como mecanismo de domínio (revisão invalida projeção) — **não** é contexto.

**Transporte (G-07/G-11)**: `api_client.mjs` e `participant_api.mjs` passam a aceitar `signal`; o `request` duplicado é extraído para `http_transport.mjs` preservando as **listas de capacidade separadas** (participante só vê suas 6 rotas). `painel_app.rawFetch` migra para o transporte comum. Escritas não passam `signal`.

**CMP-10 + estado "obsoleto" (G-10)**: a carga de fatos para de repetir 3× silenciosamente. Após N tentativas a UI mostra o estado explícito *"os dados podem estar desatualizados — recarregar"* e **não** apresenta a projeção como atual (mensagem estruturada `Msg`, sem código de contrato novo).

## 2. CMP-03 — Feedback e erros (`web/v3/feedback.mjs`, novo)

| Peça | Responsabilidade | Reuso |
|---|---|---|
| `StatusRegion` | anúncio `aria-live` único; deduplica texto idêntico consecutivo (F-06) | `a11y.mjs` `announce` |
| `ResultBanner` | um dono por escopo (`scope.generation` + canal): sucesso, erro e progresso mutuamente exclusivos; limpa ao `reset` (F-02) | `showError/showSuccess/clearError` (3 cópias → 1) |
| `FieldError` | já existe (`field_error.mjs`, ARQ-03); sem alteração | — |
| `ErrorMapper` | `ApiError → { target: field|banner, msg, focus }`; aceita `details` objeto `{rule,path}` e lista de códigos (F-04); resolve paths indexados `items[n]` por **expressão**, não por mapa estático (F-03) | `violationFromApiError`, `FIELD_FOR_PATH`, `describeApiError` |

Regras: erro de contexto obsoleto **nunca** chega ao `ResultBanner` (o guard o filtra antes); sucesso só após commit confirmado; `Msg` estruturada (nunca texto pré-renderizado) para retraduzir em `elo:lang`; detalhe técnico sanitizado permanece como hoje (`ui_messages.mjs`). Sem novo código de erro; o catálogo normativo não muda.

Limitação `items[0]`: o mapeador passa a derivar o índice do path e a procurar o controle por convenção `[data-path]`. Como o formulário atual tem **uma** linha de item, a mudança é preparatória e não altera comportamento hoje (teste de caracterização garante).

## 3. Reconciliação de escrita tardia (FIX-37.1 / G-13)

Escrita já persistida para o participante A concluída depois de ir para B:
- **Não** renderizar em B. **Não** cancelar.
- `orphan()` registra no store um aviso **associado a A** (`pendingNotice[A] = {kind, entityId, at}`), exibido quando o terapeuta voltar a A ("Uma meta foi gravada enquanto você estava em outro paciente — atualizando") e dispara recarga das leituras de A. Convite (segredo único): o token é guardado **só em memória, só no escopo de A**, e exibido uma vez ao voltar; ao `reset("logout")` é destruído (política D-ARQ4-02).
- O aviso é efêmero (memória), nunca persistido, sem conteúdo clínico (só tipo e id).

## 4. CMP-02 — i18n (manutenção, sem redesenho)

Preservar `Msg/Ref/bindText/applyManagedDefaults/userEdited`. Itens do ARQ-04:
1. **I-01 (confirmado pelo PO em 26/11)**: opções dinâmicas de unidade com `data-i18n="th.opt.assessment-item-unit.<unit>"` (ou `Ref`) e `applyI18n(select)` ao criá-las, como já é feito para instrumentos; chaves PT/EN novas para `deg`, `1` (adimensional) e as unidades futuras do catálogo; teste de paridade que **falha** se uma unidade do catálogo não tem chave nas duas línguas.
2. **Marcador de legado (I-04)**: função pura `legacyFindings(entity, catalogs)` reutilizando `goalTargetViolations`, `instrumentViolations` e `itemViolations`; só exibição (ex.: selo "registro anterior às regras vigentes") em `participant_app.renderGoals` e no painel; **nunca** reescreve nem filtra o registro. Texto por `Msg`. Aplica-se só a leitura (P-08 mantido).
3. **I-05**: teste de caracterização "troca PT→EN→PT preserva valor digitado, estado do select de situação do valor, `disabled`/`readonly` de domínio e mensagens de erro de campo retraduzidas".
4. **I-02**: varredura estática automatizada (teste) que proíbe `showSuccess(t(` / `showError(… t(` / `announce(t(` em código novo; sem tradução por conteúdo.

## 5. FormController (CMP-05, parcela remanescente)

Recomendação mantida: **backlog**. Incorporar só `store.onReset` (remove a lista fixa de formulários, G-12). Reavaliar no ARQ-07.

## 6. Mapa de dependências

`ContextStore` ← usado por `FeedbackScope`/`ResultBanner` e por todos os handlers; `http_transport` ← `api_client`, `participant_api`, `painel`; `CommandController` (inalterado) recebe `Ticket` do store; **ARQ-05** (SessionController/Outbox) consumirá `store.current()` como chave de escopo e `onReset("logout")` como gatilho de isolamento.

## 7. O que este desenho não faz
Não revoga token no servidor (ARQ-06/CMP-09); não implementa outbox; não altera CommandController, DateField, ValidationRegistry nem contratos; não adiciona biblioteca.
