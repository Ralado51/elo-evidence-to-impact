# S1 — Correção pós-homologação das Etapas A e E

Dados sintéticos. Sem push, sem deploy, sem mudança de contrato. S2 não iniciado. Etapas B/C/D aguardam nova homologação independente.

## 1. Rastreabilidade defeito → mudança → teste

| Defeito | Mudança | Teste |
|---|---|---|
| D05 / A-1: id inexistente ou não autorizado virava participante ativo | `therapist_app.mjs`: seleção por id valida contra a lista autorizada (`listParticipants`); falha → `NOT_FOUND` e o campo volta ao último contexto válido | `s1_corr_ae` A-1 (negativo), A-2 (positivo); `s1_stab_a` |
| A-2: contexto perdido em seleção inválida | `restoreField()`; `sessionStorage` e resumo não mudam | `s1_corr_ae` A-1 |
| A-3: seleção manual por id na jornada | formulário de id movido para `<details id="technical-select">` (Avançado/suporte); jornada usa lista e pesquisa | `s1_corr_ae` A-3; harness `therapist_journey`/`participant_journey` abrem o bloco avançado (mudança declarada) |
| A-4: isolamento entre participantes | `setActiveParticipant` ao trocar: limpa builders de resultado, reseta os 5 formulários, apaga convite, evidências, linha do tempo e séries | `s1_corr_ae` A-4 (todas as seções, recarga, volta a A sem reaparecer dados) |
| S1-05 / E1: idioma não compartilhado | landing, terapeuta, participante, painel e contador usam `elo_lang`; padrão pt-BR | `s1_corr_ae` E-U1..U4 |
| S1-06 / E2-E5: mensagens operacionais sem tradução | `renderBox`: resultados reconstruídos de builders, retraduzidos na troca; convite, rótulos e nomes acessíveis dinâmicos em catálogo; rótulo de origem derivado de `data_origin` | `s1_corr_ae` E-A1..A6, `s1_stab_e` |
| E6: inglês após autenticação | jornada autenticada completa em EN com varredura de PT (texto, aria-label, placeholder, title, valores-padrão) | `s1_corr_ae` E-A1..A6 |
| E7: conteúdo digitado | valores-padrão só são trocados se não editados (`data-i18n-last`) | `s1_corr_ae` E-A3 |
| E8 / S1-07: contador | `web/s2/contador.*` traduzido (estado inicial incluso); rota oficial `/s2/contador.html`; `/v3/contador.html` → 301 | `s1_corr_ae` E-U4 |
| Revisão | bloco discreto em Informações técnicas com o commit (`build-info.json` do gateway) | `s1_corr_ae` E-U5 |

Correções encontradas durante o teste: textos-padrão de formulário (nota, meta, instruções) sem tradução na carga inicial; guia de atividade do participante não retraduzido; estado inicial do contador não traduzido; rótulo de origem vindo do servidor (PT) na linha do tempo e no resumo.

## 2. Rota oficial do contador
`/s2/contador.html`. A rota antiga `/v3/contador.html` responde 301 para ela (gateway). A rota é da trilha S2 estacionada; nenhuma outra mudança nela.

## 3. Mudanças declaradas em testes/harness
- `therapist_journey.mjs`, `participant_journey.mjs`: abrem `#technical-select` (idempotente) antes de usar o campo de id; a negação do id de outro vínculo ocorre na seleção.
- `checks.mjs` (a11y): `summary` passa a ser enumerado como controle interativo (alvo ≥48px), e conteúdo de `<details>` fechado não conta como focável/renderizado. Nenhuma verificação foi relaxada; `.audit-details > summary` agora tem 3rem.
- `i18n.test.mjs`: também varre `web/s2`.

## 4. Textos clínicos do catálogo de contrato — PROPOSTA SEPARADA (não implementada)
Hoje `text_ptbr` e `limitations_ptbr` vêm do servidor somente em pt-BR e aparecem em inglês marcados `data-clinical-text` (limitação conhecida). Proposta, a decidir pelo PO e sem alterar contratos nesta etapa:
1. Manter os contratos CL06.3-r1 congelados; criar um catálogo de tradução versionado no cliente, indexado por `limitation_id`/`fact_template_id` + hash do texto PT de origem.
2. Se o hash do texto recebido não coincidir com o do catálogo, exibir o texto PT original (nunca tradução desatualizada) com aviso.
3. Tradução revisada por terapeuta ocupacional antes de uso; marcar "tradução de apoio" na UI.
4. Alternativa de longo prazo: campo `text_en` no contrato (exige nova revisão de contrato; fora do escopo).

## 5. Backlog — NÃO corrigido (sem implementação nem evidência)
FIX-01 datas impossíveis (D03); FIX-02 metas duplicadas (D04); FIX-03/21 unidades incompatíveis (D06); FIX-14 nova sessão com relato pendente (S1-02); FIX-15 relato perdido após recarga (S1-01); FIX-02/18 sucesso e erro simultâneos no relato (S1-03); FIX-13/16 estado vazio após consulta de resumo (S1-04); duplo clique no envio do relato; recuperação de atividades após recarga; estados inconsistentes nas consultas de publicação; integridade das séries de evolução. Etapas B/C/D.

## 6. Evidências executadas (sandbox)
Testes node 70/70; API 399 passed, 1 skipped, 1 deselected (`test_cl06_1_streams_fixtures_exact_parity`, passa só na máquina do PO); a11y `run.mjs` 0 falhas nas 5 páginas; jornadas terapeuta, participante e e2e; `s1_stab_a`, `s1_stab_e`, `s1_corr_ae` (pt/en, estado autenticado, mensagens dinâmicas, seleção positiva/negativa, isolamento).

## 7. UAT sugerido
1. Abrir a landing, trocar para EN; terapeuta, participante, painel e contador abrem em EN. Voltar para PT em qualquer página.
2. Em EN: entrar, cadastrar, avaliar, meta, prescrição, convite, relato, revisão, publicar; sem PT fora dos textos clínicos do servidor.
3. Em Avançado, digitar um id inexistente: erro e participante anterior mantido.
4. Trocar de participante e conferir que nenhuma seção mostra dados do anterior.
5. Conferir o commit em Informações técnicas.
