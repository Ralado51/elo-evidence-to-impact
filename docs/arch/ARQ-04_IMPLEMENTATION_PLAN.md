# ARQ-04 — Plano de implementação

Status: **plano; implementação bloqueada até liberação do PO.** Baseline `2cf4bab`. Pré-requisitos: homologação independente do ARQ-03 FIX-01 (Gemini/Codex) e decisões da matriz (`ARQ-04_PO_DECISION_MATRIX.md`).

## Fases (cada uma termina com suítes isoladas verdes e relatório)

| Fase | Entrega | Saída verificável |
|---|---|---|
| 0 | **Caracterização, sem alterar código de produto.** Testes de navegador que reproduzem hoje: FX37.1 meta/avaliação/prescrição/convite/participante tardios; FX37.2 timeline **e** série tardias; logout com leitura em voo (terapeuta, participante, painel); esgotamento das 3 tentativas; I-01 (unidade não retraduz); troca PT→EN→PT com formulário preenchido; `items[1]` não mapeado. Falhas esperadas são registradas como "antes" | evidências `arq04_before_*`; cada achado do diagnóstico ganha PASS/FAIL real (G-02, G-04, G-09, G-10 hoje só por leitura) |
| 1 | `context_store.mjs` + testes `node:test` (geração, `begin` cancela o anterior, `capture/commit/orphan`, `reset`, `AbortError` silencioso) — **sem ligar a nada** | JS unit verde |
| 2 | `http_transport.mjs` com `signal`; `api_client`/`participant_api` delegam; `rawFetch` do painel migra; listas de capacidade intactas | testes de rota permitida/negada existentes verdes; novo teste "participante não alcança rota de terapeuta" |
| 3 | Terapeuta: migrar canais de leitura (TH-04..07, 12, 15, 17) e depois escritas (TH-03, 08..11, 14, 16); contadores antigos removidos só ao final da fase | FX37 8/8; Fases-0 FX37.1/37.2 viram PASS; suíte `s1_stab_*`, `s1_corr_*` sem regressão |
| 4 | Participante e painel: leituras (PA-01..04, 10, 11; PN-01..05) e logout como fronteira (G-09) | novos testes de logout com leitura em voo |
| 5 | CMP-03: `StatusRegion`, `ResultBanner`, `ErrorMapper`; as 3 cópias de `showError/showSuccess/clearError` viram uma; `items[n]` por expressão | FIX-18/D07 e FIX-37.2: erro tardio nunca aparece; anúncio único (F-06) |
| 6 | CMP-02: I-01, marcador de legado (I-04), testes I-02/I-05 | paridade de chaves de unidade PT/EN; troca de idioma preserva estado |
| 7 | Regressão completa isolada, relatório, rastreabilidade, bundle | critérios de aceite abaixo |

Regra de migração: **um lote por vez**, caracterização antes, e nunca enfraquecer teste existente sem cópia legada rastreável (P-04).

## Critérios de aceite (ARQ-04)
1. **AC4-01** Meta/avaliação/prescrição/convite/participante concluídos após troca de contexto não renderizam no contexto novo; o contexto de origem recebe aviso e recarga (D-ARQ4-02).
2. **AC4-02** Erros tardios de timeline/série/fatos não aparecem em outro contexto; erros do contexto corrente continuam visíveis.
3. **AC4-03** Duas leituras do mesmo canal: prevalece a última solicitada; a anterior é abortada; `AbortError` não gera mensagem.
4. **AC4-04** Logout e novo login são fronteira: nenhuma resposta anterior toca a UI do principal seguinte (terapeuta, participante, painel).
5. **AC4-05** Esgotamento de tentativas na carga de fatos mostra estado "possivelmente desatualizado"; nunca apresenta projeção velha como atual.
6. **AC4-06** Escritas nunca são abortadas; idempotência, single-flight e "settled" do CommandController intactos (suítes `s1_arq02_*`).
7. **AC4-07** Uma só implementação de feedback; sucesso e erro exclusivos; um anúncio por evento.
8. **AC4-08** Unidades e opções dinâmicas retraduzem; paridade PT/EN de chaves verificada por teste.
9. **AC4-09** Registro legado exibido como armazenado, com marcador, sem reescrita (P-08).
10. **AC4-10** Nenhum contrato congelado alterado (`test_frozen_packages_untouched`); manifesto A2 íntegro; sem código de erro novo.
11. **AC4-11** FX37 completo (8/8) e todas as suítes anteriores verdes, cada uma em ambiente isolado.

## Estratégia de regressão
- Python: `pytest api/tests` (referência: 524 + 1 pulado + 1 falha externa preexistente).
- JS: `node --test web/tests/*.test.mjs` (113) + novos testes de store/transporte/feedback.
- Navegador: 20 suítes atuais, cada uma com a demo reiniciada (limite 120 req/60 s); novas suítes `s1_arq04_context`, `s1_arq04_feedback`, `s1_arq04_i18n`. Suítes novas simulam respostas tardias com `page.route` atrasando a resposta (determinístico, sem `sleep` cego).
- Guardas arquiteturais (V2.2 CMP-25): teste que falha se surgir `state.participantId` após `await` em handler migrado, ou `showError(t(`.
- Reteste humano integrado permanece pendente (FIX-37 "Reteste humano integrado").

## Riscos e mitigação
Superfície de 36 handlers (lotes + caracterização); `AbortController` × CommandController (escritas sem signal; teste explícito); rate limit (suítes isoladas); fadiga de mudança nos três apps (migração por canal, feature-flag **não** usada: troca direta com a suíte como porta).

## Fora de escopo
Revogação servidor de token (ARQ-06); SessionController/Outbox (ARQ-05); FormController completo; novas rotas/contratos.
