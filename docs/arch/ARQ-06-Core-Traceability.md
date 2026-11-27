# ARQ-06 Core — Rastreabilidade da implementação

## Escopo executado

| Referência | Critério exercitado | Evidência |
|---|---|---|
| FIX-05 / DEF-11 · CMP-19 | US-089-CA01–03 e US-086-CA01 no recorte de autorrelato aprovado. Preservar a variação intermediária e ausência de comparação autorizada. | `web/tests/arq06_progress.test.mjs` FIX-05 e regressão `test_assistance_transitions_and_unreported_barrier_r2_r11`. |
| FIX-06 / DEF-12 · CMP-19 | US-051-CA02/03 e US-087-CA01/02 no recorte de partição técnica e visualização F04. | Teste web FIX-06, 14 mutações individuais da chave e paridade catálogo/esquema em `api/tests/test_arq06_comparability.py`. |
| FIX-07 / DEF-13 · CMP-19 | US-036-CA01/05 e US-091-CA02/03 no recorte da associação execução/assistência ao mesmo escopo, sessão e versão. | Teste web FIX-07/08 com ordem divergente, ausência, versão de prescrição distinta e conteúdo obsoleto. |
| FIX-08 / DEF-14 · CMP-17/18/19 | US-022-CA03 e US-036-CA04 no recorte de projeção de evidência efetivamente aprovada. | Negativos de hash/aprovação no teste web e regressão do gate, imutabilidade e autorização em `api/tests/test_v3_evolution_timeline.py`. Nenhuma mudança no gate de escrita. |
| FIX-09 / FIX-37 · CMP-09/10 | US-003-CA01–04 e US-005-CA01–04 exigem integração e política ratificada. | Pendente no recorte ARQ-06. Nenhum aceite inferido dos testes de CMP-19. |
| ARQ-05 / FIX-14/15 · CMP-11/12 | US-013, US-031, US-034, US-037 e US-038. | Dependências futuras. Nenhum componente ARQ-05 integrado nesta entrega. |

Os vínculos indicam critérios parcial ou diretamente exercitados pelos testes. O aceite de histórias completas e a homologação S1 dependem de UAT e decisão do PO.

[Planejamento ARQ-06 e controle de defeitos](https://drive.google.com/drive/folders/1lFudhHxLgX6ukBYQHFaDK47SmibvBSd0)
