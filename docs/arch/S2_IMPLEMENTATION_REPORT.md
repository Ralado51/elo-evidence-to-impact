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
