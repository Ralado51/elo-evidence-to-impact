# S1 — Correção pontual E-01 (retradução de mensagens dinâmicas)

Baseline: 6918df45fde9acd81105d0305dd3acfe39211f31. Sem mudança de contrato/API, sem push/deploy; B/C/D e S2 não iniciadas.

## Causa
Mensagens dinâmicas (banners de sucesso/erro, região viva `#elo-live-region`) eram gravadas como texto já traduzido. Na troca de idioma, os handlers de `elo:lang` ou apagavam o banner (terapeuta, participante, painel) ou o deixavam intocado; a região viva (única saída do "Participante … carregado" no painel) nunca era reescrita. Resultado: o texto ficava no idioma antigo.
O valor "parcial" é o valor-padrão de amostra do campo livre `item_value` da avaliação (texto descritivo digitável, enviado como digitado), sem tradução registrada.

## Correção (`web/v3/i18n.mjs`, sem tocar em operações de negócio)
- `t()` e `label()` registram `texto renderizado → {chave, parâmetros}`.
- `retranslateMessages()` roda em `setLang` e re-renderiza, a partir de chave e parâmetros (parâmetros que são rótulos traduzidos também são re-resolvidos), os destinos `#error-banner-text`, `#success-banner-text`, `#elo-live-region`, `[data-live-msg]` e o bloco técnico do erro. Não há nova requisição nem reanúncio.
- Os handlers de `elo:lang` do terapeuta, participante e painel deixaram de apagar os banners. Valem para todas as páginas e tipos de mensagem que usam `t()`; texto não proveniente do catálogo (mensagem bruta do servidor, valores digitados) fica inalterado.
- "parcial": amostra editável localizada (`th.assessment-item-value.default`: pt "parcial", en "partial"). Valor interno enviado é o digitado; se o usuário editou, não é sobrescrito. Não é dado canônico nem catálogo clínico.

## Evidências
Antes da correção (`s1_corr_e01.mjs`) os defeitos foram reproduzidos: convite copiado permanecia em inglês; erro de participante inexistente não era retraduzido; "Participante … carregado." permanecia em português; "parcial" permanecia em inglês. Depois: todos passam.
- PT→EN e EN→PT, parâmetros preservados (alias no painel), zero requisições `/api/` durante a troca (capturadas no navegador), link do convite e textos digitados preservados, convite usado após alternar idioma e mensagem de entrada retraduzida, contexto limpo (sem localStorage, navegador en-US) abre em pt-BR em terapeuta, participante, painel e contador.
- Regressão: node 70/70; API 399 passed/1 skipped/1 deselected (paridade de fixtures, só passa na máquina do PO); a11y 0 falhas; jornadas terapeuta, participante e e2e; `s1_stab_a`, `s1_stab_e`, `s1_corr_ae`, `s1_corr_e01`. Nenhum teste existente foi alterado.

## Limitações conhecidas
Textos clínicos vindos do servidor continuam em pt-BR (proposta em `S1_CORRECAO_A_E.md` §4). Backlog das etapas B/C/D permanece não corrigido.
