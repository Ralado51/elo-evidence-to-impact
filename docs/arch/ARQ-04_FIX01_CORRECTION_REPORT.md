# ARQ-04 FIX-01 — Relatório de correção consolidada da homologação independente

Baseline: `b1e7a51f2c58b2d5228780ea7cb8c5a3ae863c62` (branch `demo/claude`). Escopo: somente a branch funcional. `research/frontend-v3` (Design System, `8f83b5b`) **não** foi integrada. Sem push, sem deploy. Dados sintéticos.

## 0. Transparência sobre as fontes
Os relatórios do Gemini e do Codex (`ARQ-07_ARQ04_VALIDATION_REPORT.md`, evidências JSON) **não estavam acessíveis** nesta sessão (buscados no Drive, no repositório e nos uploads). O trabalho partiu do prompt FIX-01 (que descreve cada defeito) e **cada defeito foi reproduzido por mim na baseline** antes de qualquer correção. Consequência: a suíte independente do Gemini e os cenários exatos do Codex **não foram reexecutados**; foram substituídos por reproduções equivalentes (abaixo). Se os arquivos forem anexados, rodar a suíte do Gemini e os cenários do Codex é o primeiro passo recomendado.

## 1. Resultado
| Item | Defeito | Reproduzido na baseline | Depois |
|---|---|---|---|
| FIX-42 | `prescriptions.publish` vaza leitura secundária para outro participante | sim: `rxLeakedIntoBeta=true` | corrigido; leitura presa ao participante de origem |
| FIX-43 | logout não limpa superfícies/dados (PA-02, terapeuta, painel) | sim: participante com `goals=1, rx=265 chars, signin=57 chars` visíveis logo após o logout; terapeuta com `signin-result` residual | corrigido nos 3 apps |
| FIX-41 | feedback da tentativa anterior sobrevive (UAT-01) | sim (avaliação e meta) | corrigido; ciclo central em `feedback.mjs` |
| I-01 | unidade derivada exibia `sessions`/`reps` | sim (campo exibia o código `sessions`/`reps`) | traduzida; canônico em `data-unit` |
| FIX-44 | unidade fora do catálogo (`cm`) virava "Não informado" | sim: exibia `Target: 12 Not provided` | literal + marcador legado; `textContent` |
| Residuais | TH-01, TH-03, PA-01, PN-01 (5 falhas); TH-07 sem defeito observável | sim | protegidos |
| TEC-03 | FX37-09 vacuoso (`n === -1`) | sim (chave de sessão errada fazia o teste passar vazio) | exige auth, HTTP 200, JSON e exatamente 1 registro |

Evidência antes/depois: `docs/arch/evidence/arq04_fix01_before.txt` (1/8 verdes: FIX42-02 é teste de guarda e já passava), `arq04_residual_before.txt` (1/6 verdes), `arq04_fix01_regression.json` e `fix01_after_*.txt` (todas verdes).

## 2. O que mudou
- **FIX-42** (`therapist_app`): helper `readAfterWrite(ticket, kind, read)`. A leitura pós-escrita usa o participante capturado no ticket (não o estado vivo), recebe `signal`, é revalidada após o `await`; se o contexto mudou, nada é exibido e a escrita (já processada) vira aviso de reconciliação entregue quando o terapeuta volta ao participante de origem. Aplicado às três cadeias escrita→leitura: prescrição, resumo, evolução. Auditoria: as demais leituras encadeadas (fatos→evidência) já tinham `signal`+`isCurrent`.
- **FIX-43**: `clearParticipantSurfaces` (prescrição, metas, publicações, resumo, evolução, identificação, resultados de sessão/relato, campos, banners), `clearTherapistSurfaces`, `clearPatientSurfaces`. Escritas do participante (iniciar/encerrar/relato) ganharam ticket de **principal**: após logout nada é renderizado nem restaurado; o resultado desconhecido permanece no `CommandController` (política de sessão pendente do ARQ-05 **não alterada**). Em `cmd`, logout durante uma escrita não renderiza, não consulta lista e não cria aviso entre principais.
- **FIX-41**: `feedback.mjs` agora detém o ciclo de vida das superfícies de resultado (`registerSurface`, `beginAttempt`, `restoreAttempt`). Toda tentativa de envio começa substituindo o feedback e os resultados anteriores, mesmo se barrada pela validação local; só uma tentativa sem efeito (intenção já salva/em voo) devolve o anterior. Registros históricos não são tocados.
- **I-01/FIX-44**: `unitLabel()` (i18n): unidade conhecida → traduzida; desconhecida → literal; ausente → vazio. Chaves `enum.unit.sessions/reps` (PT/EN). O campo somente-leitura do terapeuta mostra o texto traduzido e guarda o valor canônico em `data-unit`; alternar idioma não escreve nada e preserva o digitado.
- **Residuais**: `begin("auth")` em TH-01/PA-01/PN-01 (resposta tardia ou superada nunca instala sessão); `begin("restore")` em TH-07; guarda de principal em TH-03.
- **TEC-03**: FX37-09 reescrito; auditoria das suítes encontrou mais dois padrões fracos, corrigidos: `(!status || true)` no helper `hold` e o FIX-40 do ARQ-03 (clique de idioma engolido por `.catch` + asserção `txt.length > 0`, agora exige "Descreva a meta funcional.").

## 3. Regressão (versão final do código)
- Navegador: **19/19 suítes verdes**, uma por vez: s1_arq04_context (9 asserções FX37, incluindo os 8 cenários originais + FX37-09), s1_arq04_i18n, s1_arq04_fix01 (8), s1_arq04_residual (6), s1_arq03_fix01/domain, s1_arq02_fix01/fix03/fix03b/commands, s1_arq01_dates, s1_corr_ae/e01/e02e03, s1_stab_a/e, therapist/participant/e2e journey.
- Node: 143/143 (novos: UL-01..04, FB-05/06). Pytest: 524 passed, 1 skipped, 1 falha **pré-existente e externa** (`test_cl06_1_streams_fixtures_exact_parity`, igual à baseline). `sync_catalogs --check`: em sincronia.
- Contratos 3.0.0/3.1.0/3.2.0 e catálogos: nenhum arquivo alterado. Nenhuma regra clínica nova.
- Ajustes de testes existentes (justificados): leituras do campo `goal-target-unit` migraram de `value` para `data-unit` (o texto visível agora é traduzido); nenhuma asserção foi enfraquecida.

## 4. Limitações e riscos remanescentes
1. Relatórios e suíte do Gemini / cenários do Codex não reexecutados (seção 0).
2. FIX-44 usa o registro histórico emulado na leitura (a API rejeita `cm` na escrita); o caminho de renderização é o real.
3. TH-07 não tinha defeito observável; a guarda é defensiva.
4. Convites e logins consumidos por uma resposta tardia descartada não são recuperáveis (convite é de uso único): é a consequência esperada de não instalar sessão após logout.
5. Pendente fora deste escopo: upload ao Drive do `elo-frontend-v3.bundle` e do ZIP das 75 capturas (limite do conector); aguarda sua escolha.
