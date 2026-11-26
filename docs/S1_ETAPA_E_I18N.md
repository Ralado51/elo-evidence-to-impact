# S1 — Etapa E: internacionalização pt-BR / en (relatório técnico)

Base: `b78421a` (demo/claude). Dados 100% sintéticos. Contratos CL06.3-r1 e API **não alterados**.

## O que mudou
- `web/v3/i18n.mjs` (motor), `i18n_pt.mjs` / `i18n_en.mjs` (catálogos, 529 chaves cada), `ui_messages.mjs` (bloco técnico do erro).
- Seletor Português/English no cabeçalho das 3 telas (terapeuta, participante, painel). Padrão **pt-BR** (independe do idioma do navegador). Preferência salva em `localStorage` (`elo_lang`) e vale para todas as telas.
- Trocar de idioma **não perde dados**: campos digitados, participante ativo, listas, publicações e resultados são redesenhados a partir do estado, sem novas chamadas.
- Valores internos (enums, ids, JSON, códigos de erro) ficam intactos; o texto exibido vem de `label(grupo, valor)`. Valor desconhecido mostra "Não informado", nunca o código.
- Erros: banner com mensagem compreensível + bloco recolhido "Detalhes técnicos" (código/HTTP). O atributo `data-error-code` continua para os testes. `RULE_VIOLATION` vira mensagem específica (data final antes da inicial, data inexistente, dados contraditórios, sessão fora de ordem).
- Códigos entre parênteses removidos (FIX-25). Ids/hashes ficam só em blocos recolhidos "Detalhes de auditoria".
- Terminologia unificada: "fato" → "evidência"; "modo de relato apenas" → "prática por autorrelato"; "Customizado não validado" → "Instrumento personalizado não validado"; "Publicar evolução funcional"; "Consultar evidências" (tabela do PO conferida por teste).
- Datas e números por idioma (`Intl`): 26/11/2026 em pt-BR, 11/26/2026 em en; representação canônica (ISO) no backend e nos envios não muda.

## Rastreabilidade FIX ↔ teste
| FIX | Evidência |
|---|---|
| FIX-25 sem códigos | `web/tests/i18n.test.mjs` (catálogo e HTML sem padrão de código), `s1_stab_e.mjs` E7 (texto visível e `<option>` das 3 telas, pt e en) |
| FIX-26 catálogo central | `i18n.test.mjs` paridade de chaves e placeholders pt/en; todas as chaves usadas no código existem |
| FIX-27 todas as jornadas | `s1_stab_e.mjs` E2/E3/E6/E7; jornadas terapeuta/participante/e2e passam |
| FIX-28 erros | `i18n.test.mjs` (RULE_VIOLATION específico, fallback), `s1_stab_e.mjs` E5 |
| FIX-29 datas/números/unidades | `i18n.test.mjs` (formatIsoDate, formatNumber) |
| FIX-30 persistência | `s1_stab_e.mjs` E1 (padrão), E4 (recarga + outra tela) |
| FIX-31 terminologia | `i18n.test.mjs` tabela do PO; `s1_stab_e.mjs` E8 |
| FIX-32 cobertura | `i18n.test.mjs` + `s1_stab_e.mjs` |

## Regressão (executada)
Node 70/70 · API 399 passed, 1 skipped, 1 deselected (teste que só passa na máquina do PO) · acessibilidade (3 telas + contador) sem falhas · `therapist_journey`, `participant_journey`, `e2e_journey`, `s1_stab_a` (A1-A8), `s1_stab_e` (E1-E8) passam.

## Testes alterados (declarado, nenhum afrouxado para mascarar falha)
1. `therapist_v3.test.mjs`: modo de execução antes exigia o código canônico no texto; agora exige rótulo localizado **sem** o código (é o oposto da regra FIX-25).
2. `therapist_journey.mjs` / `participant_journey.mjs`: o anúncio no leitor de tela antes continha `[CODIGO]`; agora é mensagem amigável, e o código segue em `data-error-code` (verificado).
3. A mensagem técnica `formatApiErrorMessage` (com `[CODIGO]` e `HTTP`) segue existindo para auditoria e continua testada.

## Limitações conhecidas (para o PO decidir)
- Textos clínicos gerados pelo catálogo do contrato (`rendered.text_ptbr`, `limitations_ptbr`) chegam **só em português** da API; em inglês aparecem em português. Corrigir exige campo `text_en` no contrato (mudança de contrato, não feita).
- Textos digitados por pessoas (apelido, meta, observações, orientações) mantêm o idioma original, como pedido.
- Fusos horários (`America/Sao_Paulo`) são nomes IANA e não são traduzidos.
- O painel ainda pede o identificador do participante digitado (Etapa C pendente).

## Novo UAT (Etapa E)
1. `scripts/demo_up.sh` e abrir `http://127.0.0.1:8080/v3/therapist.html`.
2. Conferir que abre em português; clicar **English** e ver tudo em inglês; recarregar e confirmar que continua em inglês; abrir participante e painel (mesmo idioma).
3. Digitar usuário/senha, trocar de idioma antes de entrar: os campos continuam preenchidos.
4. Entrar com senha errada: mensagem sem códigos; abrir "Detalhes técnicos" para ver o código.
5. Cadastrar participante, trocar o idioma no meio: lista, participante ativo e pesquisa preservados.
6. Percorrer avaliação, meta, prescrição, evidências, resumo e evolução em ambos os idiomas; conferir os rótulos da lista do PO.
