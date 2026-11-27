# ARQ-06 Core — Relatório de implementação

27/11/2026 · Branch `research/arq06-core` · Baseline `b1e7a51f2c58b2d5228780ea7cb8c5a3ae863c62`

## Entrega

Foi exercitado o recorte S1 do CMP-19 no painel do terapeuta. A projeção usa as séries de assistência F04 já aprovadas e separadas pelo servidor. Apresenta a razão contratual de separação e usa as mudanças adjacentes autorizadas pelo servidor, evitando resumir `some → full → some` como estabilidade. Ausência de mudança confirmada não gera conexão entre pontos.

Rótulos de execução F03 usam a chave de escopo, sessão, prescrição e revisão. Cada fato auxiliar precisa corresponder ao ID e ao hash do conteúdo na projeção aprovada. Ausência, múltiplos resultados ambíguos ou conteúdo divergente são exibidos como indisponíveis. A visão de evidências aprovadas e o seletor de verificação só usam conteúdo com hash confirmado. Os indicadores de primeiro/último nível são omitidos quando há mais de uma série.

O backend já aplicava `cmp-v1`; testes bloqueantes verificam as 14 chaves individualmente, incluindo as quatro dimensões contextuais como conjunto distinto. A implementação segue a partição feita pelo catálogo congelado e não infere correspondência com as dez dimensões de produto. Os textos PT/EN alterados restringem-se à apresentação da evolução.

## Verificação

- `node --test web/tests/*.test.mjs` · 141/141 em cópia de teste com os finais LF originais dos catálogos. O checkout Windows aplicou CRLF aos catálogos e gerou uma falha de paridade binária; o repositório e os contratos congelados não foram editados para corrigir o ambiente.
- `cd api; python -m pytest tests/test_arq06_comparability.py tests/test_v3_evolution_timeline.py` · 25/25 no conjunto dirigido, incluindo as 15 novas verificações. O ensaio usou `python-docx` já disponível nas dependências do desktop.
- `node --check web/v3/painel_app.mjs` e `git diff --check` · sem erros.
- Homologação visual/funcional em navegador e ensaio no UAT ficaram fora desta entrega.

## Dependências bloqueantes

| Dependência | Consequência |
|---|---|
| Homologação ARQ-04 | Condiciona a integração final e o reteste da troca de contexto assíncrona/FIX-09. A leitura do painel mantém a guarda de contexto existente antes de publicar o resultado na interface. |
| Ratificação PO de logout, expiração e revogação | Condiciona CMP-09 e eventual aditivo. Nenhuma rota ou política de sessão proposta foi aplicada. |
| Ratificação de retenção, sessão órfã, conflito e reconciliação | Condiciona a futura integração do ARQ-05. A referência 83ccf7d foi preservada. |
| Correspondência entre 14 chaves e dez dimensões e recorte ARQ-06/09 | Exige respaldo documental e decisão do PO. Critérios de reavaliação, remoto e todas as projeções clínicas continuam no backlog. |
| Política histórica de publicação e revogação | A regra vigente de hash/revisão permanece. O fluxo de escrita e o tratamento das publicações históricas não foram alterados. |

Sem merge, push, deploy ou alteração de UAT. Todos os dados de teste são sintéticos.

[Rastreabilidade da entrega](ARQ-06-Core-Traceability.md)
