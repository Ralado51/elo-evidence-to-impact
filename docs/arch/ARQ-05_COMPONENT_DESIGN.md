# ARQ-05 — Desenho de componentes (CMP-11 SessionController/StopAction, CMP-12 Outbox/Recuperação)

Status: **desenho documental; nada implementado.** Baseline `2cf4bab`. O desenho recomendado **não altera contratos, rotas, códigos de erro, `session_rules.py` nem o ledger**. Alternativas que exigiriam contrato estão marcadas "requer A3/ratificação" na matriz do PO e **não** estão no caminho recomendado. A2 permanece candidato, não congelado.

## 1. Princípios
1. **Parar é local primeiro.** A transição para "encerrada" ocorre no mesmo tick do clique, antes de qualquer rede; a rede só confirma.
2. **Eventos são imutáveis depois de construídos.** Construídos uma vez por intenção (com `seq`, `prev_hash`, `occurredAt`, `hash`) e **persistidos antes do envio** (write-ahead). Nunca reconstruídos em retry (corrige S-04).
3. **Reconciliação por replay determinístico.** Reenviar o evento idêntico devolve `DUPLICATE` ⇒ "já gravado". Não é necessário nenhuma rota nova nem `Idempotency-Key` para eventos do participante.
4. **Nada de dado clínico livre, token, áudio ou vídeo no armazenamento local.** O registro contém só eventos do protocolo (ids, seq, hashes, ações, escolhas de relato) e metadados de estado.
5. **Autoridade do servidor.** Reautorização e consentimento a cada envio (US-037-CA05); conflito nunca é resolvido silenciosamente (US-037-CA04).
6. **Um motor.** O `SessionController` reutiliza `participant_model.mjs` (construtores de evento) e espelha, sem duplicar, as transições do servidor (`advance_phase`); testes de paridade com os mesmos vetores.

## 2. CMP-11 — SessionController (`web/v3/session_controller.mjs`, novo; núcleo puro, sem DOM)

### 2.1 Estados do cliente (mapeados nas fases do servidor)
| Estado local | Fase no servidor | Significado |
|---|---|---|
| `idle` | — | nenhuma sessão em curso nem pendência |
| `active` | `active` | sessão iniciada (os 2 primeiros eventos já construídos/persistidos) |
| `ended_report_pending` | `ended` | parada registrada localmente; **relato ainda não enviado**; carrega `endAction` (`end`/`pain`/`fatigue`) |
| `reporting` | `ended` | relato escolhido, evento construído e persistido; envio em curso/ambíguo |
| `completed` | `ended` + relato | relato confirmado (`stored` ou `duplicate`) |
| `conflict` | divergente | o servidor rejeitou (`HASH_CONFLICT`, `CHAIN_BROKEN`, `INVALID_TRANSITION`); dados preservados, exige tratamento explícito |

Eventos de entrada: `START`, `STOP(action)`, `REPORT_SUBMIT(execution, assistance)`, `SYNCED(eventId)`, `SYNC_REJECTED(code)`, `RECOVER(snapshot)`, `LOGOUT`.

### 2.2 Regras
- **R-S1 StopAction com prioridade.** `STOP` é aceito em `active` sem esperar rede, sem formulário e sem confirmação extra; se há envio em andamento, `STOP` entra na fila na ordem de `seq` (o lote é ordenado por `(stream_id, seq)`, como o servidor exige). Dor/fadiga sem preenchimento adicional (US-033-CA02); ausência de informação nunca vira "sem dor" (CA04).
- **R-S2 Sem auto-resume.** Após `pain`/`fatigue` não há retomada automática; nova sessão só por ação explícita, e apenas se não houver relato pendente (R-S3).
- **R-S3 Relato pendente nunca é sobrescrito (FIX-14).** `START` é recusado em `ended_report_pending`/`reporting`/`conflict`; a UI explica e oferece "responder agora" (e, conforme D-ARQ5-03, "dispensar relato" explícito). Nenhum estado é descartado em silêncio.
- **R-S4 Construção única.** `START` constrói e persiste `session.started` + `session.control(start)`; `STOP` constrói e persiste 1 evento; `REPORT_SUBMIT` constrói e persiste 1 evento. `seq`/`prev_hash` vêm do último evento persistido no escopo, não de variável em memória.
- **R-S5 Single-flight por natureza.** Um segundo `START`/`STOP` com a sessão já no estado alvo é no-op; duplo clique em "Iniciar" cria **uma** sessão (corrige S-05).
- **R-S6 Relato único por sessão** (preservar `lastReportSlot`/settled): enviar de novo após `completed` é no-op.
- **R-S7 Recuperação** (`RECOVER`): lê o snapshot do escopo, valida esquema/versão e a cadeia local (seq contíguo, `prev_hash` encadeado); estado inconsistente ⇒ `conflict` com dados preservados, nunca "limpar e seguir".

### 2.3 Interface
```
createSessionController({ store: OutboxStore, build: participant_model, clock, scope })
  .state()                       // snapshot imutável para a UI
  .start(prescriptionRef) / .stop(action) / .submitReport({execution, assistance})
  .recover()                     // chamado após auth + contexto
  .resolveConflict(choice)       // explícito: "manter e tentar de novo" | "descartar neste aparelho" (D-ARQ5-05)
  .subscribe(fn)
```
A UI (`participant_app.mjs`) vira **projeção**: habilita/desabilita botões a partir de `state()`; não guarda `activeSession`/`pendingReport`.

## 3. CMP-12 — Outbox e recuperação (`web/v3/outbox.mjs`, novo)

### 3.1 Registro por escopo (uma chave de armazenamento por `principalId:participantId`)
```
{ v: 1,
  scope: "<principalId>:<participantId>",
  version: <int>,              // compare-and-set (multi-aba)
  stream: { streamId, sessionId, prescriptionRef:{id,revision}, endAction|null },
  events: [ { event: <objeto completo já construído>, state: "pending"|"synced"|"conflict",
              attempts: n, lastCode: null|"HASH_CONFLICT"|... , builtAt } ],
  dismissedReport: false,
  updatedAt }
```
**Não contém**: token, nome/apelido, texto livre, dados de outros participantes. `event` é o objeto do protocolo (já contém `participant_id`, escolhas de relato). Sem o `Idempotency-Key` (não se aplica a `events:batch`).

### 3.2 Interface assíncrona (permite trocar o motor sem tocar consumidores)
```
OutboxStore = { get(scope), put(scope, record, expectedVersion), delete(scope), listScopes() }
createOutbox({ store, transport, guard })
  .append(scope, event)            // write-ahead: persiste antes de qualquer envio
  .flush(scope, { signal })        // envia o prefixo contíguo de "pending", ordenado por seq
  .status(scope)                   // pending/synced/conflict + contagens p/ a UI (US-037-CA02, US-013-CA05)
  .purge(scope, reason)            // somente por política (§3.5) ou ação explícita
```
Implementações: `WebStorageOutboxStore` (recomendada para a v1; chave única por escopo, atômica) e `IndexedDbOutboxStore` (reservada; mesma interface; adotar só se D-ARQ5-02 escolher).

### 3.3 Algoritmo de envio (`flush`)
1. Pegar o **prefixo contíguo** de eventos `pending` do stream (ordem por `seq`); lote ≤ limite do servidor.
2. `POST events:batch`. Resultados por item: `stored`/`duplicate` ⇒ `synced` (**reconciliação**: `duplicate` significa "já estava gravado", não é erro); `rejected` com `HASH_CONFLICT`/`CHAIN_BROKEN`/`INVALID_TRANSITION`/`STREAM_MISMATCH` ⇒ `conflict` (para; nada é alterado); `rejected` por autorização/consentimento/vínculo revogado ⇒ item **fica** `pending` e a UI sinaliza bloqueio (US-037-CA05).
3. Falha de rede, timeout, 5xx ⇒ permanece `pending`; backoff limitado (ex.: 2 s → 60 s, teto de tentativas por janela; política D-ARQ5-06); `401` ⇒ preserva o outbox e pede nova autenticação.
4. Gatilhos: logo após `append`; evento `online`; após recuperar contexto; botão manual "tentar de novo". Sem Service Worker/Background Sync no MVP.
5. `flush` roda sob `ContextGuard`: o resultado só atualiza a UI se o escopo ainda é o corrente; **a persistência do resultado (`synced`) acontece sempre**, a exibição é que é condicionada.

### 3.4 Reconciliação de "resultado desconhecido"
| Caso | Mecanismo | Resultado |
|---|---|---|
| Evento de participante (início, parada, relato) | replay do **mesmo** evento persistido | `duplicate`/`stored` ⇒ sincronizado; sem consulta e sem rota nova |
| Resposta perdida e recarga | o evento está no outbox | o replay ocorre depois da recarga; resolve S-04 e S-06 |
| Comando do terapeuta com `Idempotency-Key` | `IntentionJournal` (§3.6) guarda **só** `{slot, key, startedAt, escopo}` | após recarga a intenção fica `unknown`; **sem reenvio automático** (não há payload); a UI oferece "verificar no histórico" ou "iniciar nova tentativa" (AD-11 preservado) |

### 3.5 Isolamento, logout e retenção (o que é decisão do PO está na matriz)
- Chave por `principalId:participantId`; leitura/escrita só pelo escopo corrente do `ContextStore` (ARQ-04). Troca de participante/principal **não** apaga: o outro escopo simplesmente é inacessível.
- **Logout com itens `pending`/`conflict`**: nunca descartar em silêncio. Fluxo recomendado: tentar `flush`; se ainda houver pendência, perguntar (enviar depois / manter neste aparelho / descartar), com a consequência clara. A decisão padrão e os prazos de retenção são D-ARQ5-04.
- Itens `synced` são removidos imediatamente após a confirmação (minimização); a sessão encerrada com relato `synced` não deixa resíduo.
- **Validade**: ao recuperar, o outbox é cruzado com a sessão de autenticação atual (mesmo `principalId`); se o principal diferir, o registro é inacessível e não é exposto.

### 3.6 IntentionJournal (persistência de chaves de idempotência — terapeuta)
Pequeno módulo ao lado do `CommandController` (não o substitui): persiste `{ slot, key, startedAt }` por `principalId:participantId` **sem payload e sem conteúdo**. Efeito: após recarga, o controlador **não gera nova chave em silêncio** para uma intenção ambígua — marca `unknown` e exige decisão do usuário (AD-11). A janela de validade respeita o mínimo entre 24 h e a retenção do servidor − 1 h; expirada, a entrada é removida. Não resolve duplicação **após** a janela nem reenvio automático; isso exigiria guardar payload ou uma rota de consulta por chave (alternativas na matriz: D-ARQ5-07).

## 4. Integração
| Com | Como |
|---|---|
| **CommandController** (ARQ-02) | inalterado para o terapeuta; o `IntentionJournal` é injetado opcionalmente; o participante **não** usa chave (ledger natural) mas reutiliza o princípio "um evento por intenção"; o relato migra de `commands.run` para `SessionController.submitReport` mantendo o estado `settled` |
| **ContextStore/ContextGuard** (ARQ-04) | `scope` = `store.current()`; `flush` e `recover` usam `begin("outbox")`/`capture`; `onReset("logout")` aborta `flush` e dispara o fluxo §3.5 |
| **participant_model.mjs** | construtores de evento reutilizados; adicionar apenas funções puras (validação de cadeia local) |
| **Servidor** | nenhuma alteração; `events:batch`, `session_rules`, ledger e autorização usados como estão |
| **a11y/i18n** | estados pendente/sincronizado/conflito por `Msg`, `aria-live` via `StatusRegion` (ARQ-04); ícone + texto, sem cor como único sinal |

## 5. FIX-13 (S1-04)
Tratado fora do outbox: caracterizar na Fase 0; correção provável em `loadPublications`/`openSummaryById` (reconciliar o status textual com a abertura por código; distinguir "vazio" de "falha"). Sem mudança de contrato.

## 6. O que fica de fora
Pausa/retomada com sensor (CMP-14/15, S2); recuperação de chamada remota (US-144, P1); logout servidor/expiração (ARQ-06); sessão órfã no servidor (D-ARQ5-08); sincronização entre dispositivos (exigiria rota de leitura e contrato novo).
