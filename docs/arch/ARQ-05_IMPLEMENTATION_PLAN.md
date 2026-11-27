# ARQ-05 — Plano de implementação

Status: **plano; implementação bloqueada até liberação do PO.** Baseline `2cf4bab`. Pré-requisitos: (1) homologação do ARQ-03 FIX-01; (2) ARQ-04 liberado e, no mínimo, Fases 1–4 (ContextStore/guarda) concluídas — sem ele o isolamento do outbox seria reimplementado; (3) decisões D-ARQ5-01..05, 10, 11, 13 da matriz.

## Fases
| Fase | Entrega | Saída verificável |
|---|---|---|
| 0 | **Caracterização, sem alterar produto.** Navegador (Playwright): (a) S1-01: parar por dor → `reload` → relato indisponível; (b) S1-02: parar por cansaço → "Iniciar" habilitado → sessão antiga some; (c) S-03: parar com `context.setOffline(true)` → estado continua "ativo"; (d) S-04: `route.fetch()` + `route.abort()` (resposta perdida) → segundo clique em parar → `HASH_CONFLICT`; (e) S-05: duplo clique em Iniciar → 2 `sessionId`; (f) S-06: relato com falha ambígua + reload; (g) FIX-13/S1-04: reproduzir contradição de estado; (h) O-03: intenção do terapeuta ambígua + reload gera nova chave. Falhas esperadas viram evidência "antes" | `arq05_before_*`; cada hipótese do diagnóstico (S-03..S-06, O-03) passa a PASS/FAIL real |
| 1 | `outbox.mjs` + `WebStorageOutboxStore` + testes `node:test` com *fake storage*: write-ahead, `append` ordenado, compare-and-set de versão, `flush` com respostas simuladas (`stored`, `duplicate`, `rejected` por código, rede, 401), isolamento por escopo, ausência de token/PII no registro | JS unit verde; teste "o registro serializado não contém token nem texto livre" |
| 2 | `session_controller.mjs` (núcleo puro) + testes de máquina de estados e **paridade com `advance_phase`** (mesmos vetores); StopAction com prioridade; recusa de `START` com pendência | JS unit verde; vetores compartilhados |
| 3 | Integração em `participant_app.mjs`: UI como projeção de `state()`; parada local-primeiro; início/parada/relato pelo controlador; botões e mensagens PT/EN; estados pendente/sincronizado/conflito com ícone + texto | suítes `participant_journey`, `e2e_journey` sem regressão; novas `s1_arq05_session`, `s1_arq05_recovery` |
| 4 | Recuperação após recarga e após novo login do mesmo principal; logout com pendência (§3.5 do desenho); multi-aba (versão + aviso) | FIX-15/FIX-14 fechados em navegador |
| 5 | `IntentionJournal` + integração opcional no `CommandController` do terapeuta (intenção ambígua vira `unknown` após recarga, nunca nova chave silenciosa) | testes `s1_arq02_*` intactos; novo `s1_arq05_journal` |
| 6 | FIX-13/S1-04 conforme a causa confirmada na Fase 0 (mudança local em `loadPublications`/`openSummaryById`); texto de estado vazio vs falha | `s1_arq05_publications` |
| 7 | Regressão completa isolada, revisão de ameaça (D-ARQ5-13), relatório, rastreabilidade, bundle | critérios abaixo |

Regras de execução: caracterização antes; lotes pequenos; **nenhum teste existente enfraquecido** sem cópia legada (P-04); nenhum contrato alterado; um commit por fase.

## Critérios de aceite
- **AC5-01 (US-033-CA02, S-03)** Parar por dor/fadiga/fim muda a tela para "encerrada" no mesmo clique, **sem rede**, sem campo adicional; offline, o evento fica `pending` e é enviado ao voltar a conexão.
- **AC5-02 (S-04)** Repetir a parada após resposta perdida **não** gera `HASH_CONFLICT`: o evento persistido é reenviado idêntico e o resultado é `duplicate` tratado como sincronizado.
- **AC5-03 (S-05)** Duplo clique em Iniciar cria uma única sessão; duplo clique em parar, um único evento.
- **AC5-04 (FIX-15 / US-037-CA01)** Após `reload`, uma sessão encerrada sem relato volta ao passo do relato com o mesmo `sessionId`, `seq` e `prev_hash`; o relato enviado é aceito pelo servidor; sessão ativa recuperada mostra as paradas disponíveis.
- **AC5-05 (FIX-14 / US-031-CA03)** Com relato pendente, "Iniciar" é recusado com explicação e caminho ("responder agora"/"dispensar" conforme D-ARQ5-03); nada é sobrescrito.
- **AC5-06 (US-037-CA02, US-013-CA05)** Estado pendente/sincronizado/conflito visível, por texto e ícone, anunciado uma vez.
- **AC5-07 (US-037-CA03, US-013-CA03)** Reenvio não duplica registros (contagem de eventos no servidor igual ao esperado após N reenvios).
- **AC5-08 (US-037-CA04)** Conflito preserva os dados locais e exige ação explícita; nunca sobrescrita nem reconstrução da cadeia.
- **AC5-09 (US-037-CA05)** Vínculo revogado/consentimento ausente: o reenvio é bloqueado pelo servidor, o item permanece, a UI sinaliza; o outbox não contorna autorização.
- **AC5-10 (isolamento)** Outbox de A inacessível ao principal B e ao participante B; logout não vaza nem apaga em silêncio (política D-ARQ5-04).
- **AC5-11 (minimização)** O registro armazenado não contém token, apelido, texto livre, áudio ou vídeo; itens sincronizados são removidos.
- **AC5-12 (O-03)** Intenção ambígua do terapeuta não ganha nova chave silenciosa após recarga; vira "resultado desconhecido" com ação explícita.
- **AC5-13 (FIX-13)** Estado do painel de publicações coerente com a abertura por código; "vazio" distinto de "falha".
- **AC5-14** Contratos congelados e manifesto A2 íntegros; nenhum código de erro novo; `session_rules.py` e ledger inalterados; D01/FIX-17 não regridem.
- **AC5-15** Suítes anteriores verdes, cada uma em ambiente isolado.

## Estratégia de regressão
- Python: `pytest api/tests` (referência atual 524 + 1 pulado + 1 falha externa preexistente); **sem novos testes de servidor** no caminho recomendado, mas incluir um teste de integração que reenvie o mesmo evento e verifique `duplicate` e contagem estável.
- JS: `node --test web/tests/*.test.mjs` (113) + testes novos de outbox, controlador e paridade de fases.
- Navegador: suítes atuais isoladas (limite 120 req/60 s); novas suítes citadas. Técnicas determinísticas: `context.setOffline`, `page.route` com `route.fetch()` + `route.abort()` para "resposta perdida", `page.reload`, duas páginas no mesmo contexto para multi-aba, `page.evaluate` para inspecionar o registro armazenado (AC5-11), relógio controlado onde houver backoff.
- Guardas arquiteturais: teste que falha se `participant_app.mjs` voltar a ter `state.activeSession`/`state.pendingReport` fora do controlador, ou se o outbox serializar campos fora da lista permitida.
- Segurança: revisão de ameaça (XSS, aparelho compartilhado, retenção) antes de qualquer dado real; **reteste humano integrado** em dispositivo real (parada, recarga, offline).

## Riscos e mitigação
| Risco | Mitigação |
|---|---|
| Gravação local falha (cota, modo privado) | `append` retorna erro explícito; a parada **ainda** vale na tela e a UI avisa que não ficou salva; nunca bloquear a parada |
| Corrida multi-aba | versão no registro; teste com duas páginas; Web Locks como reforço (D-ARQ5-11) |
| Relógio do aparelho | reaproveitar `nextMonotonicIso`; `occurredAt` já fixo no evento persistido |
| Regressão do fluxo do participante | caracterização + suítes de jornada; troca por lote |
| Dado de saúde no aparelho | minimização, retenção, revisão de ameaça, decisão D-ARQ5-02/04 |

## Fora do escopo
Alteração de contrato/rotas; revogação servidor e expiração (ARQ-06); pausa/retomada com sensor; recuperação de chamada (US-144); FIX-16; S2; push/deploy.
