# S1 — Correção estrutural de i18n E-02 e E-03

Baseline: c313b509b98eac0bcf9b638519f7a3b8550ad0f3. Sem mudança de contrato/API, sem push/deploy; B/C/D e S2 não iniciadas. Dados sintéticos.

## Causa raiz
Ambos os defeitos vinham da mesma decisão de projeto do E-01: **o texto renderizado decidia se algo era traduzível**.
- **E-02:** `t()`/`label()` registravam `texto → chave`. Ao retraduzir uma mensagem, cada parâmetro cujo texto coincidisse com um texto registrado era trocado pelo rótulo (apelido "Direito" = rótulo `side.right` → "Right"; e o inverso).
- **E-03:** o valor-padrão gerenciado só era trocado se `valor atual == último padrão aplicado` (ou vazio). Digitar "parcial"/"partial" (igual a um padrão) ou apagar o campo era indistinguível de "nunca editado".
(O hack "parcial" do E-01 foi tratado como amostra gerenciada, mas com a mesma inferência por conteúdo.)

## Mecanismo de diferenciação de conteúdo (sem exceções por palavra)
`web/v3/i18n.mjs`:
1. **Chaves de tradução**: `tm(key, params)` cria um `Msg` estruturado `{key, params}` (imutável). O registro texto→chave foi **removido**.
2. **Parâmetros literais** (apelidos, ids, números, texto do usuário): são o padrão; só são inseridos no gabarito, **nunca** consultados como chave ou rótulo.
3. **Parâmetros que são rótulos traduzíveis**: somente por referência explícita: `lref(grupo, valor)` (rótulo de enum de contrato) ou `kref(chave)`; renderizados no idioma atual a cada renderização.
4. **Mensagens ligadas ao componente**: `bindText(nó, msg)` guarda o `Msg` no nó (banners de sucesso/erro, bloco técnico, região viva via `announce`). Na troca de idioma, `retranslateMessages()` renderiza de novo cada nó ligado a partir de chave e parâmetros estruturados; texto simples (`string`) é estático. Erros de API: `describeApiError`/`describeParticipantError` retornam também `msg` (estruturado).
5. **Valores-padrão gerenciados vs. editados**: o campo é gerenciado enquanto `data-user-edited` não existir. A marca é gravada **explicitamente** pelo evento `input` (digitar, colar, apagar, inclusive texto idêntico ao padrão) e removida apenas pelo `reset` do formulário (troca de participante), quando o padrão localizado volta a ser gerenciado. Nenhuma comparação de conteúdo.
6. **Conteúdo clínico persistido** (textos do servidor, `data-clinical-text`): nunca passa por `t()`; permanece como veio.
Também: duas mensagens do participante que estavam hardcoded em PT agora são chaves (`pa.js.need_sum_id`, `pa.js.sum_loaded`).

## Evidências (`web/tests/browser/s1_corr_e02e03.mjs`, novo; executado em servidor limpo)
Antes (baseline c313b50), falhas reproduzidas: E02-1 ("Participant Right registered…" para "Direito"), E02-2, E02-3 (painel "Participant Right loaded."), E03-2 (digitado/idêntico → "partial"), E03-3 (apagado voltava a "partial"), E03-4 (colado), e derivadas E03-6/E03-8.
Depois: todos passam.
- Apelidos: Direito, Right, Esquerdo, Left, Mão, Hand, Ativa, Active, Parcial, Partial, Dados sintéticos, Synthetic data: cadastro e mensagens PT→EN→PT ×3, lista, seleção; painel (live region e página) para Direito, Right, Dados sintéticos, Synthetic data (4 cargas: a API limita rajadas, 429); dados persistidos e ids conferidos.
- Campos: padrão nunca editado (acompanha, PT→EN→PT ×3); editado diferente; editado idêntico ao padrão (parcial/partial); apagado; colado (ctrl+V, inclusive igual ao padrão); textarea da nota; troca de participante (padrão volta a ser gerenciado); recarga (campo não persistido volta ao padrão).
- Zero requisições `/api/` durante trocas de idioma (cobertas também em `s1_corr_e01`, cenários E01-D0..D4 sem regressão).
Nota: o teste aguarda 65 s antes do bloco E-03 por causa do limite de taxa da API.

## Regressão completa
node 70/70; API 399 passed/1 skipped/1 deselected (paridade de fixtures, só na máquina do PO); a11y sem falhas; `s1_corr_e01`, `s1_corr_ae`, `s1_stab_a`, `s1_stab_e`, jornadas terapeuta/participante/e2e passando. Nenhum teste existente foi alterado. Uma regressão própria detectada e corrigida durante o trabalho: o `reset` reaplicava todo o `applyI18n` e sobrescrevia o resumo do participante ativo; agora reaplica apenas os padrões gerenciados.

## Limitações conhecidas
Mensagens montadas fora do catálogo (texto bruto do servidor) ficam estáticas. Textos clínicos continuam em pt-BR (proposta em `S1_CORRECAO_A_E.md` §4). Backlog B/C/D não corrigido.
