# S2 — Relatório de implementação (MVP sintético, simulação)

Branch `integration/s2-final` (base a859e4e, S1 aprovado). Dados sintéticos; uso clínico e dados reais proibidos.

## Entregue
1. ARQ-08 Core integrado (3e16d69, merge limpo; contratos congelados intactos).
2. EventOutbox/EventDispatcher estendidos para fluxo de captura (mesmo ledger/verificador; sequência, hashes, recuperação, isolamento preservados; lotes de 100).
3. ActivityRunner mínimo (atividade prescrita, instruções, calibração, contador de ciclos aceitos, progresso de dose, encerramento, autorrelato; sem gamificação).
4. Consentimento/calibração experimental (protocolo `contador-exp-1`, parâmetros de counter.js; sem validade clínica).
5. Contagem, lateralidade e dose prescrita (B3: lateralidade indeterminada não conta).
6. Integração ledger/verificador: sessão simulada aceita ponta a ponta pela API real.
7. Autorrelato (report_only) coexistindo no mesmo armazenamento.
8. Jornada funcional em simulação (UI `#activity-panel`).

## Testes
- Node: 174/174. pytest: 539 ok, 1 skipped, 1 falha pré-existente de ambiente (fixture CL06.1 externa ausente em /root/hackathons/..., não relacionada). sync_catalogs ok.
- Navegador (real API/ledger/verificador): s2_activity 9/9, participant_journey, therapist_journey, e2e_journey, s1_arq04_i18n, s1_integration_final 13/13 — todos passaram.
- Correção durante a regressão dirigida: gateway/guardas das suítes só serviam /v3; os módulos ARQ-08 importados pelo app (activity_runner, simulation_source, capture_events, protocol, motion) foram liberados por allowlist exata (GET); demais caminhos não-v3 seguem proibidos; counter.js não é servido nem importado.

## Câmera física (integrada a partir de 11a4584)
- Pacote `elo-mediapipe-assets.tar.gz` verificado (SHA-256 66774b9c…e5b79; SHA256SUMS e os 4 hashes do manifesto conferem). Biblioteca 0.10.21 (Apache-2.0) e Hand Landmarker float16 v1, em `web/s2/vendor/`, carregados só da mesma origem (sem CDN nem download em tempo de execução).
- Mesmo ActivityRunner/CaptureController/EventOutbox/EventDispatcher, modo `camera`: `source=camera`, `execution_mode=camera`, `data_origin=experimental_capture` + `origin_ref`; nunca `simulation`. Parâmetros `contador-exp-1` e medida de abertura do contador existente (`openness`) reutilizados; núcleo de movimento, lateralidade (indeterminada não conta) e dose inalterados.
- Consentimento: `consent.accepted`/`consent.revoked` em stream próprio (cadeia local em localStorage), enviados pelo mesmo dispatcher; o aceite é gravado no ledger antes de ligar a câmera; a revogação desliga a câmera, encerra a sessão com `interrupt/consent_revoked` e só é enviada depois dos eventos da sessão (o ledger julga consentimento na ingestão).
- Processamento local: nenhum quadro, imagem ou ponto bruto é desenhado, codificado, guardado ou enviado; só valores derivados. Falha de câmera/modelo/permissão cai para autorrelato sem captura. Fim de trilha ou erro do modelo interrompem a sessão (`track_ended`/`model_execution`).
- Testes dirigidos: Node 179/179 (inclui `camera.test.mjs`: hashes dos ativos, origem/`origin_ref`, cadeia de consentimento, sessão de câmera); navegador com câmera falsa do Chromium + modelo local + API/ledger reais: `s2_camera` 5/5 (consentimento antes da câmera, só mesma origem, calibração sem mão falha e nada é contado, nenhuma imagem/ponto armazenado, revogação em ordem, CONSENT_REQUIRED sem aceite); regressões dirigidas `s2_activity` 9/9, `participant_journey`, `e2e_journey`, `s1_integration_final` 13/13. Regressão completa fica com o Gemini.

## Pendências / decisões para o PO
- Validação física da câmera (mão real): NÃO feita nesta sessão (câmera falsa sem mão). A convenção de espelhamento da lateralidade (`SWAP_DETECTOR_LABELS = true`: o detector recebe o vídeo sem espelhar; a prévia é espelhada só por CSS) e a contagem real devem ser conferidas no teste manual (`MANUAL_CAMERA_TEST.md`) com adulto voluntário consentido.
- Licença específica do modelo float16 v1 não acompanha o pacote: confirmar antes de redistribuição definitiva.
- A cadeia de consentimento fica em localStorage do navegador: limpar os dados do site com consentimento já gravado faz o aceite seguinte conflitar com o ledger (HASH_CONFLICT) e a câmera fica indisponível (autorrelato segue). Não há endpoint para ler o topo da cadeia de consentimento.
- B3: o contrato não tem motivo de cycle.rejected para lateralidade indeterminada; só o agregado `lost_events` é preservado.
- Diferenças do contador-exp-1 vs counter.js documentadas no código. Upload no Drive dos bundles DS e do ZIP de 75 capturas bloqueado pelo limite do conector. Sem push/deploy.

## Front-end Elo sobre a baseline 7e9dad4 (S2 câmera + S3 + S4 + ARQ-10)
- Baseline importada de `elo-mvp-final.bundle` (3 partes, SHA-256 das partes e do bundle 290a597d… conferidos; commit 7e9dad4). Branch `integration/front-end`.
- Reaproveitado `web/v3/ds/ds-shell.css` (sidebar do terapeuta, cartões por etapa, prática guiada do participante) e estendido para S3/S4/ARQ-10.
- HTML: `.ds-subsection` (Atendimento remoto externo e Rascunho assistido, este com selo "Experimental"), `.ds-audio-card` (áudio das instruções); sem alterar IDs, JS, APIs ou contratos.
- S3 (ELO_S3_EXPLANATIONS=1): painel "Explicação da evolução publicada" com cartões por série. S4 (?s4=1): rascunho assistido e áudio. ARQ-10: atendimento remoto e linha do tempo.
- Verificação: run.mjs (a11y) igual à baseline (`live_region` falha em therapist e participant também na baseline); jornadas therapist/participant/e2e passam; s2_camera S2C-04 falha igual na baseline (revogação no ledger 1 !== 2), não tocado.
- Capturas: `docs/design-system/screens` (30 por viewport, desktop/tablet/mobile).
- Propostas de comportamento (não feitas): indicadores com valores vivos, contador grande e dose em tempo real, estados vazio/carregando/diálogo de confirmação, navegação de uma etapa por vez.

## Organizar a Mesa — motor c04-hand-1 integrado (baseline 1024ba7)
- Recuperado de `elo-research-lab/experiments/elo-integrated-demo/app` (`movement.mjs`, `camera.mjs`, `style.css`): medida 3D (mediana das 4 pontas / comprimento punho–base do médio), guardas de enquadramento/tamanho/estabilidade, validação de calibração (separação ≥ 0,22; dispersão ≤ 16 %), seleção de dispositivo, pré-visualização local com pontos, mesa com peças. Código em `web/s2/arq08/c04_engine.mjs` (+ teste).
- Ativação opt-in: `participant.html?engine=c04`. Sem o parâmetro, o contador-exp-1 segue como antes. O contador experimental aprovado (`web/s2/contador*`) não foi tocado.
- Integração: `createC04Detector` (mesma forma do detector atual) → `ActivityRunner` (`protocol: c04Protocol`, `minSpan 0.22`, `validateCalibration`) → CaptureController → ledger. `algorithm_version = "c04-hand-1-elo-cycle-1"` (identificação própria da variante integrada; algoritmo de origem `c04-hand-1` preservado em `ORIGIN_ALGORITHM`) fixado na sessão (begin) e herdado por todos os eventos; `origin_ref` inclui o protocolo. Prescrição, dose, lateralidade, consentimento, FIX-CAM-01/02 e contratos intactos. Uma única fonte de contagem (o ledger); o `ReferenceGesture` original existe só para comparação em teste.
- **Incompatibilidade de semântica (para decisão do PO; nada alterado):** o `c04-hand-1` original conta a repetição no FECHAMENTO da mão (aberta armada ≥ 180 ms → fechada); o Elo conta o ciclo aberta → fechada → aberta, na VOLTA à abertura (`cycle.accepted`). Para a mesma sequência terminando com a mão fechada, o original conta N e o Elo N−1 (testado). Também: o original exige 3 amostras/125 ms por zona e 180 ms armado→fechado; o núcleo do Elo não tem essas janelas (limiares 0,72/0,28 e lacuna máxima 240 ms foram adotados via protocolo, as janelas não). Para adotar a definição original seria preciso mudar o contrato de `cycle.accepted`.
- Limitações: (1) mão real não testada (o navegador de teste usa câmera simulada e um substituto roteirizado do MediaPipe; o modelo real é coberto em s2_camera); (2) a recusa de calibração instável não grava `calibration.attempted` no ledger; (3) a lateralidade continua dependendo do rótulo do detector (convenção de espelhamento a confirmar com câmera física); (4) overlay desenha pontos localmente, sem armazenar.
- Testes dirigidos: c04_engine.test (4), arq08 e arq05 unitários (38), s2_mesa (2: contagem/dose/ledger em desktop e mobile; calibração instável recusada), s2_activity, s2_camera, participant_journey, e2e_journey e a11y run.mjs (só `live_region`, já falhava na baseline).

### Decisão do PO (2026-11-27) e backlog
- Mantida a definição de ciclo do Elo (aberta → fechada → aberta); contratos inalterados; sem contagem paralela. A variante integrada recebe a identificação própria `c04-hand-1-elo-cycle-1`, por não reproduzir as regras temporais do original (3 amostras/125 ms por zona; 180 ms armado→fechado). O `ReferenceGesture` fica só em teste.
- Backlog (fora do escopo desta etapa): (B-1) teste manual com mão real e adulto consentido; (B-2) gravar `calibration.attempted` quando a estabilidade da calibração é recusada; (B-3) confirmar convenção de lateralidade/espelhamento em câmera física; (B-4) decidir se as janelas temporais originais entram no núcleo (exige novo protocolo/versionamento); (B-5) `origin_ref` do evento de consentimento usa o protocolo padrão, não o da variante; (B-6) ativação por `?engine=c04` é provisória (definir flag/configuração oficial); (B-7) `live_region` da acessibilidade (preexistente).

### Ajuste visual — landmarks da mão (2026-11-27)
- Os 21 pontos e as 21 conexões da mão são desenhados automaticamente sempre que há uma mão detectada, em ambos os motores (contador-exp-1 e c04), sem botão de ligar/desligar (checkbox removido). Canvas com a resolução do vídeo e o mesmo espelhamento/enquadramento (`object-fit`) do vídeo; linhas amarelas com contorno grafite e pontos brancos com contorno grafite. Limpo quando a mão some (ausente, várias mãos ou quadro insuficiente) e quando a câmera é desligada. Só desenho local: nada é guardado, codificado ou enviado. Algoritmo, calibração, ledger, contratos e mecânica inalterados.

### Defeito — câmera com tela preta (2026-11-27)
- Causa provável: o MediaPipe tentava primeiro o delegate GPU (o protótipo original usa só CPU), que pode travar ou deixar a pré-visualização preta em algumas câmeras/drivers; e o vídeo ficava oculto (`hidden`) durante o `play()`, sem limite de tempo, deixando o estado de carregamento indefinido.
- Correção em `camera_session.mjs`: delegate CPU como no original; vídeo visível antes do `play()`; limites de tempo para carregar o modelo (30 s) e iniciar o vídeo (10 s); em caso de falha a câmera é liberada (trilhas paradas, vídeo oculto e `srcObject` nulo) e o estado cai para o fallback. Canvas dos landmarks inalterado (fica transparente sobre o vídeo e só é mostrado com mão detectada). Algoritmo, calibração, jogo, ledger e Design System inalterados.
