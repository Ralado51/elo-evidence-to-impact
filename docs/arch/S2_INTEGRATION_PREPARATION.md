# S2 — Preparação da integração do ARQ-08 Core

Base preservada: S1 integrado `a859e4e` (worktree `integration/s2-final`, apenas este documento foi adicionado).
Candidato: `research/arq08-core` = `3e16d6924a25b9f6c75b76fa1fd83b5c0301544a`; bundle SHA-256 `d019bf983c489979b5d2e403287b1ef412a68510199da8c3d45677bb075a384a` (conferido; histórico completo; pai `7e93248` é ancestral de `a859e4e`).
Nada do ARQ-08 foi mergeado em `integration/s2-final`. S2 não está ativo.

## 1. Compatibilidade verificada (merge de teste descartável sobre a859e4e)
- Merge sem conflitos: o ARQ-08 só adiciona 5 arquivos em `web/s2/arq08/`.
- ARQ-08: 40/40 (`core.test.mjs`, `s2_contador`, `canonical`). Node total com ARQ-05 e ARQ-08: 166/166.
- Contratos, API e telas do S1 não são tocados.

| Item | Situação |
|---|---|
| Design System | Compatível: o núcleo não tem UI. Telas novas devem usar `ds/` e as chaves PT/EN. |
| Contador experimental / MediaPipe | Reutilizável: o adaptador recebe o landmarker local e `EloCounter.openness` já existentes; `thresholdsFrom` e `createCounter` existem em `web/s2/counter.js`. Os arquivos do MediaPipe (`vision_bundle.mjs`, wasm, `hand_landmarker.task`) **não estão no repositório** (`web/s2/vendor/` ausente). |
| Ledger e verificador | Regras de sessão de captura existem (`session_rules.py`): calibração (2 tentativas + aplicada), start, ciclos com `calibration_id` efetivo, término, resumo. `camera` exige consentimento ativo (`CONSENT_REQUIRED`); `simulation` e `report_only` não. O ARQ-08 só serializa ciclos, não o stream inteiro. |
| Prescrição, lateralidade, dose | Compatível: o núcleo congela escopo/revisão e respeita o teto 10 séries / 100 reps / produto 100 (`limits-v1`). |
| Autorrelato | Compatível: `report_only` continua modo próprio, escolhido **antes** de iniciar (o modo é fixo no `session.started`). |
| SessionController / EventOutbox / EventDispatcher | **Incompatível hoje** (ver B4): o outbox valida só `report_only` e os 3 tipos do S1; um evento de ciclo faz `read()` falhar com `RECOVERY_RECORD_INVALID` (provado em teste descartável). |
| ActivityRunner | **Não existe** no repositório (ver B5). |

## 2. Decisões que bloqueiam a integração funcional
Recomendação em cada uma; sem elas não inicio a execução.

**B1 — Câmera real no MVP.** O D-origin segue aberto (câmera real = `experimental_capture`, proibida para fatos) e o PO proibiu dados reais. *Recomendação:* integrar o caminho `camera` com consentimento `camera` explícito, processamento local, só escalares no ledger, resultado marcado experimental e sem entrar em fatos/evolução (F10 inelegível); testes e demonstração seguem em `simulation`. Convenção de espelhamento (`swapDetectorLabels`) fixada por teste manual com a mão do PO/Raquel, antes de ativar a câmera.

**B2 — Protocolo experimental (classificação, qualidade, intervalo máximo, amostras).** Não invento parâmetros clínicos. *Recomendação:* adotar como protocolo versionado `contador-exp-1` apenas os valores que já existem em `counter.js` (limiares 30%/70% do intervalo P10–P90, amplitude mínima, perda após 600 ms), declarados experimentais e não clínicos; o mínimo de 8 amostras e span ≥ 0,22 vêm do contrato. O PO confirma ou fornece outros.

**B3 — Lateralidade nula (CL06.3-D1).** O contrato propõe “não incompatível: contar e sinalizar”; o núcleo interrompe o ciclo. *Recomendação:* manter a interrupção (nunca contar) até ratificação explícita; mudar depois é pequeno.

**B4 — Streams de captura no outbox/recuperação.** *Recomendação:* estender o EventOutbox para aceitar streams de captura (tipos `calibration.*`, `cycle.*`, `session.completed`, `session.capture_summary`, modo por stream), mantendo cadeia, hashes, isolamento, bloqueio de nova sessão, dispensa sem perda e regras de reenvio já ratificadas. É alteração em componente do S1 integrado; só entra após o gate S1.

**B5 — “ActivityRunner” e escopo da atividade.** Não há componente a reutilizar. *Recomendação:* o MVP da atividade é o contador de ciclos aceitos contra a dose prescrita (barra de progresso e término ao atingir a dose), reutilizando a UI do contador; sem jogo, sem novas regras.

**B6 — Gates e ativos.** (a) A varredura estática do `e2e_journey` proíbe `counter.js` em `web/v3`. *Recomendação:* autorizar estreitar a regra para permitir somente o caminho exato reutilizado, sem remover a varredura. (b) Os arquivos do MediaPipe precisam ser fornecidos pelo PO (a rede do ambiente não os alcança) com a licença registrada.

## 3. Plano de execução após o gate S1 e as decisões
1. Merge de `research/arq08-core` em `integration/s2-final`; unitários.
2. B4: ampliar o outbox e o dispatcher para capture; testes unitários e de integração contra o ledger real (stream completo aceito pelo verificador, em `simulation`).
3. Produtor: consentimento, calibração, start, ciclos, término e resumo; alternativa por autorrelato escolhida antes do start.
4. Tela do participante (DS, PT/EN, acessibilidade) com o contador e o progresso da dose.
5. Testes: unitários, integração e navegador **somente das suítes dos componentes alterados** (participante, recuperação, consentimento); regressão completa fica com o Gemini. Candidato, relatório e bundle para validação independente.
