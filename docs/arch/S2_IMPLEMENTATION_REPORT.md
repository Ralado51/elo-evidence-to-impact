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

## Pendências / decisões para o PO
- Câmera física: bloqueada — pacote `elo-mediapipe-assets.tar.gz` e SHA-256 não recebidos. Sem consentimento em stream próprio nem origem `experimental_capture` no outbox até lá. Nada de captura real é classificado como `simulation`.
- B3: o contrato não tem motivo de cycle.rejected para lateralidade indeterminada; só o agregado `lost_events` é preservado.
- Diferenças do contador-exp-1 vs counter.js (normalização por mediana, sem EMA/minAmp/minCycle) documentadas no código.
- Upload no Drive dos bundles DS e do ZIP de 75 capturas (~18 MB) bloqueado pelo limite do conector.
- Sem push/deploy.
