# ARQ-02 — Relatório de correção (fix01) após reprovação no UAT independente

Baseline funcional: `5331e60176ec0b24acf82a2574bb80ec0e4b59a8` (contrato CL06.3-A1 3.1.0). UAT independente: 23 cenários — 14 aprovados, 3 reprovados, 4 parciais, 2 não executados.
**Nenhum defeito é marcado como homologado.** Contratos 3.0.0 e 3.1.0 intactos; nenhum arquivo de `contracts/` ou `api/` foi alterado (correção 100 % frontend).

## 1. Causa-raiz comprovada

### D04 — Enter seguido de clique gera duas metas
Reprodução determinística no navegador (Playwright, dados sintéticos), variando a latência entre Enter e clique:

| Latência Enter→clique | Requisições | Chaves distintas |
|---|---|---|
| 0 / 50 / 150 / 300 / 450 ms | 1 | 1 |
| **600 / 1000 ms** | **2** | **2** |

Causa: o CommandController decidia "mesma gesto" por **tempo** (`BURST_GUARD_MS = 500` + assinatura do conteúdo). Passada a janela, o envio seguinte recebia **nova chave** (`intentions` já fora apagada ao sucesso) e o servidor, corretamente, criou outra meta. Ou seja: duas requisições com chaves diferentes = duas intenções para o sistema. Isso é um debounce disfarçado de identidade. Por que os testes passaram: CC-2 disparava Enter e clique **simultaneamente** (`Promise.all`) — dentro do voo/da janela — e CC-3 usava 900 ms e *esperava* nova chave. Nenhum teste exercitava a sequência humana "Enter, pequena pausa, clique".

### S1-03 — "Relato registrado" e "Não foi possível concluir" juntos
O fluxo do participante (`participant_app.mjs`, submit de `form-report`) **não usava o CommandController** (somente o terapeuta o usava). Dois submits concorrentes passavam pelas guardas antes de qualquer `await`, e ambos enviavam `report.submitted` (medido: 2 eventos POST). O primeiro limpava o estado e mostrava sucesso; o segundo falhava na cadeia (seq/hash) e exibia erro, enquanto a caixa `report-result` mantinha "Relato registrado". Ledger, `event_id` e cadeia de hash estavam íntegros (duplicação de registro não comprovada, confirmada).

### S1-08 (proposto) — Erro de data residual após trocar de participante
`setActiveParticipant` chama `form.reset()` (valor volta ao padrão) mas o estado de validação do DateField (texto, `aria-invalid`, `aria-describedby`) só era limpo em eventos `input`/`change`, que o `reset` não dispara. Causa no componente compartilhado, não no botão.

## 2. Correção estrutural
- **CMP-07 `command_controller.mjs`** (único dono da identidade da intenção): opção `consumeUntilEdit`. Um sucesso *consome* a intenção; novo envio do mesmo formulário sem edição do usuário é a **mesma intenção** (`status: "settled"`, 0 requisição, mesma chave, resultado original) em qualquer latência. Nova intenção só por **edição explícita** (`release(formId)`), nunca por tempo nem por comparação de conteúdo — duas metas legítimas idênticas continuam possíveis (editar → salvar). Falha ambígua preserva a chave mesmo após edição. Edição durante o voo impede o consumo. Fora da janela de deduplicação a intenção consumida deixa de bloquear. Com `consumeUntilEdit` o anti-rajada por tempo não é usado nos comandos com chave (permanece em `singleFlightOnly`/convites).
- **`therapist_app.mjs`**: controlador com `consumeUntilEdit`; slot = `formulário@participante` (a troca de participante nunca reaproveita chave/estado); `input`/`change`/`reset` liberam o slot. `cmd` trata `settled`/`ignored` sem alterar o resultado já exibido (estado único).
- **`participant_app.mjs`**: o relato passa pelo **mesmo** CommandController (sem segundo mecanismo); evento construído uma vez por intenção (reenvio ambíguo reutiliza o mesmo `event_id`/seq/hash — idempotência natural do ledger preservada); estados exclusivos: sucesso, erro, `RESULT_UNCONFIRMED`, `RESULT_UNKNOWN`; 2º envio após sucesso é ignorado em silêncio. Novas chaves i18n `pa.js.cmd_retry`/`cmd_unknown` (PT/EN).
- **`date_field.mjs`**: o campo escuta o `reset` do seu formulário e invalida todo o estado de validação (mensagem, `aria-invalid`, `aria-describedby`). Transversal a todos os consumidores de DateField (7 campos).

## 3. Inventário de consumidores
| Consumidor | D04/idempotência | S1-08 reset |
|---|---|---|
| Terapeuta: participante, avaliação, meta, prescrição, resumo, evolução | CommandController com slot por participante e liberação por edição | — |
| Terapeuta: convite | `singleFlightOnly` (inalterado) | — |
| Participante: relato | agora no CommandController | — |
| Participante: iniciar/encerrar/parar sessão | botões desabilitados por estado; **não** migrados (fora do escopo; ARQ-05) | — |
| DateField: assessment-date, rx-valid-from/to, summary-period-from/to, evolution-period-from/to | — | reset limpa estado (7 campos) |
| Painel (`painel_app`) | sem formulários de comando | — |

## 4. Evidências
- Antes (baseline `5331e60`): `evidence/arq02fix01_before.txt` — 9 falhas (D04 ≥600 ms, Enter repetido, resposta lenta, S1-08 a/b, S1-03 duplo clique com 2 eventos). Depois: `arq02fix01_after.txt` — todos passam.
- Novos: `web/tests/browser/s1_arq02_fix01.mjs` (Enter→clique 0/80/600/1500 ms, clique→Enter 0/700 ms, Enter repetido, resposta lenta, nova intenção idêntica, chaves, S1-08 a/b/c, S1-03 ×3) e `web/tests/command_controller_fix01.test.mjs` (7 testes de unidade).
- Regressão: unidade JS 95/95; browser `s1_arq01_dates`, `s1_stab_a`, `s1_stab_e`, `s1_corr_ae`, `s1_corr_e01` aprovados; `s1_arq02_commands_v2` 9/9; API 470 aprovados.
- Falhas anteriores e alheias à correção (idênticas na baseline): `s1_corr_e02e03` (mensagem de erro inesperado em E03-8) e `test_cl06_1_streams_fixtures_exact_parity` (fixture externa ausente neste ambiente).

## 5. Limitações
Persistência da intenção após recarga permanece para o ARQ-05. A sessão de participante (iniciar/parar) mantém a proteção por estado de botão. O comportamento humano de "Enter + clique" foi reproduzido por automação com atrasos controlados; o UAT independente deve reexecutar os 3 cenários.

## 6. fix02 — D-FIX01-1 ratificada; transição explícita de nova intenção
Decisão do PO: regra ratificada, expectativas legadas CC-2..CC-6 substituídas, **sem exigir edição artificial** para registrar operação idêntica.
- **CommandController (CMP-07):** `startNewIntention(slot)` passa a ser a transição explícita (também limpa a intenção consumida). `release(slot)` permanece para edição genuína.
- **Ação explícita (terapeuta):** após um sucesso, o banner oferece "Registrar outra com os mesmos dados" (`#btn-cmd-another`). Ela inicia nova intenção (nova `Idempotency-Key`); o próximo Salvar cria outro registro sem editar campos. Reenvio sem essa ação anuncia "operação já registrada" e não cria registro.
- **Edição só conta se confiável:** `input`/`change` só liberam a intenção quando `isTrusted`; alterações programáticas, reaplicação de i18n e troca de idioma não geram nova intenção. O listener de `reset` foi removido (a troca de participante já isola o slot `formulário@participante`).
- **Falha ambígua:** retry reutiliza a chave original (FX-I-3). **Relato:** slot `report@sessão`, cada sessão tem sua intenção (FX-S103 ×3 em sessões distintas).
- **Suíte vigente sem contradição:** `web/tests/browser/s1_arq02_commands.mjs` agora usa a ação explícita (9/9); o arquivo anterior foi preservado em `docs/arch/evidence/legacy/s1_arq02_commands.fix00-legacy.mjs` para rastreabilidade; `_v2` removido.
- **Evidências:** `arq02fix02_after.txt` (fix01+fix02 ALL PASS, incl. FX-I-1..3), `arq02fix02_regression.txt`; unidade JS 95/95; API sem alteração (470 aprovados no fix01, nenhum arquivo de `api/` ou `contracts/` tocado).
- **Limitações:** o participante não tem a ação "registrar outra" (relato é único por sessão, por regra de domínio). Persistência após recarga segue no ARQ-05. Homologação independente pendente; nenhum defeito marcado como homologado.
