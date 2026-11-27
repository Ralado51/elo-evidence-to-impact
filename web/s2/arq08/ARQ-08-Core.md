# ARQ-08 Core — implementação independente S2

27/11/2026 · branch research/arq08-core · pai 7e93248de04f9003ba7b751ce95639d1ffecebef

## Entrega

- **CMP-14 — camera.mjs.** Porta local de vídeo sem áudio, condicionada ao consentimento explícito. Revogar/parar libera tracks, inclusive se a permissão resolver tardiamente. Indisponibilidade ou recusa devolve estado de alternativa por autorrelato. Adaptador para o Hand Landmarker já usado em web/s2/contador_app.mjs, recebendo a instância local e a função EloCounter.openness existente. A convenção de espelhamento é explícita. O adaptador devolve somente escalares e estado; não grava ou transmite quadros/landmarks.
- **CMP-15 — motion.mjs.** Calibração experimental com amostras escalares por postura, método e versão. Checa os limites de representação do contrato e exige configuração explícita acima do piso contratual. Motor sintético exige protocolo injetado e versionado para qualidade, classificação e intervalo máximo. Perda, quadro insuficiente ou lado indeterminado quebram a sequência de teste, sem produzir zero observado. O ciclo abre–fecha–abre é exercitado com sequência controlada; incompatibilidade de mão gera candidato rejeitado, sem cumprimento. A indicação indeterminada interrompe a montagem de um candidato no protótipo; o tratamento normativo de ciclos com lateralidade nula permanece aberto.
- **CMP-16 — fronteira com atividade.** A sessão congela escopo e revisão da prescrição, respeita a dose original e o teto técnico de 10 séries, 100 repetições e produto 100. Produz candidatos por ciclo, com índice sequencial e estados distintos, sem ligar ActivityRunner, alterar dose ou publicar fatos.
- **evidence.mjs.** Serializa candidatos sintéticos de ciclo no formato v3, com identidade por stream/seq e hash canônico existente. Recebe posição e hash anterior do futuro proprietário do stream. A serialização foi testada isoladamente e não constitui um stream completo aceito pelo ledger. Não emite stream de câmera, eventos de calibração/consentimento, fatos ou publicações.

Não há câmera real, dados pessoais, motor novo instalado, limiar clínico, ângulo terapêutico ou indicação de avaliação clínica validada.

## Testes bloqueantes e rastreabilidade

Rodar na raiz: `node --test web/s2/arq08/core.test.mjs web/tests/s2_contador.test.mjs web/tests/canonical.test.mjs`. **40 passaram**, seis deles novos. Foram usadas permissões e tracks simuladas, landmarks artificiais, valores controlados e vetores do contrato. A comparação de campos de payload com os esquemas não substitui validação do stream de ponta a ponta.

| Critérios oficiais | Cobertura e fronteira |
|---|---|
| US-042-CA01–04 | Consentimento, revogação, stop e fallback na porta simulada. Captura física e UI de autorrelato ficam para a integração. |
| US-043-CA01–04; US-044-CA01–04 | Adaptador do detector exercitado com resultados sintéticos, uma/múltiplas mãos, ausência, inversão explícita, lateralidade divergente e indeterminada. Versão aparece na evidência sintética. Precisão e oclusão reais não avaliadas. |
| US-045-CA02–04; US-046-CA01–04 | Validação de amostras e span, bloqueio sem calibração e perda de sequência quando a observação é insuficiente. Orientação acessível CA01 e protocolo de câmera pendentes. |
| US-047-CA01–04; US-059-CA01–04; US-060-CA01–04 | Ciclo completo único, repetição tardia ignorada, descarte por mão incompatível, dose máxima e revisão fixa. Avanço do jogo e interface da atividade fora do recorte. |
| US-048-CA01–04; US-049-CA01–04 | Entrada adimensional do método existente via adaptação e valor normalizado para classificação interna, sem converter em graus. Sinalização de baixa qualidade ou ausência. Índice publicado, política real de confiança e incerteza pendentes. |
| US-050; US-068-CA01–04 | Candidatos aceito/rejeitado e serialização sintética de ciclo com escopo, origem separada e hash. Consolidação, stream completo, ingestão e aceite do verificador pendentes. |

## Integração futura e decisões bloqueantes

1. Após homologação do S1 e autorização do S2, ratificar motor e versão, convenção anatômica/espelhamento, seleção de mão e critérios técnicos de detecção e perda. Reusar a infraestrutura MediaPipe já presente no preview se aprovada, sem copiar algoritmo proprietário.
2. Ratificar protocolo de calibração e movimento, amostragem, limiares de qualidade e categorias de rejeição. Resolver CL06.3-D1 para lateralidade nula. O piso de esquema e os limites técnicos de dose já existem; exemplos sintéticos não fixam parâmetros operacionais.
3. Definir política de origem/consentimento para câmera real (D-origin) e jornada acessível com alternativa manual. Conectar porta à UI autorizada, parar no fim/revogação e ligar somente ciclos aceitos ao ActivityRunner. Autorrelato continua fonte separada.
4. Conectar o produtor autenticado ao dono da sequência e à ingestão existentes. Exercitar tentativa/aplicação de calibração, start, ciclo, resumo de captura, término e validação de ledger antes de ligar Evidence/Progress. F10 e elegibilidade de índice/ângulo seguem sujeitos ao protocolo e ao PO.

## Fontes consultadas

- [Arquitetura V2.2](https://docs.google.com/document/d/1luqspUGZzPaik-D717Jv0bTwoB93d5I8/edit), CMP-14/15/16 e gate ARQ-08.
- [Product Backlog S2 e critérios de aceite](https://docs.google.com/spreadsheets/d/1FNlEiyL4H-QT0HbwkF_f0NaNxGTv5PeReatON2RONhU/edit).
- CL06_3-r1/A1/A2 na baseline. Para este núcleo: limits.v1, esquemas de ciclo/calibração/capture_summary, session_rules.py, canonical.mjs e OPEN_DECISIONS.md.
- [Síntese competitiva](https://drive.google.com/file/d/1Xusd2BYDDzPnSp2OyMbePADF2vFCxiJt/view) e elo-research-lab local: BEHAVIORAL_SPECIFICATION.md e IMPLEMENTATION_PROPOSAL.md em references/kemtai e references/physitrack, mais mvp/DECISION_LOG.md. Kemtai orienta calibração, repetição e incerteza; Physitrack orienta o vínculo à revisão da prescrição. As propostas e decisões que constam como abertas não foram tratadas como ratificadas.

Escopo Git: somente novos arquivos em web/s2/arq08/. Aplicações compartilhadas, UAT, contratos e integration/s1-final preservados. Nenhum merge, push ou deploy.
