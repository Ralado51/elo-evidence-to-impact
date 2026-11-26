# Proposta: visões de leitura `/api/console/v1` (S1, estabilização)

Status: **implementada nesta entrega, aguardando veto do PO** (decisão do PO em 26/11/2026: "documentar e implementar já").

## Por quê
As telas obrigavam o terapeuta e o participante a digitar identificadores internos (`p_…`, `sum_…`, `evo_…`) porque o contrato CL06.3-r1
não tem rotas de listagem. O contrato é congelado e os testes exigem que o conjunto de rotas `/api/v3` seja exatamente o do contrato.
Por isso as visões novas **não** entram em `/api/v3`: ficam num prefixo próprio, só de leitura.

## O que foi adicionado (somente GET, sem escrita, sem entidade nova)
| Rota | Quem | Retorna |
|---|---|---|
| `GET /api/console/v1/participants?q=` | terapeuta | participantes com vínculo de cuidado ativo **do próprio terapeuta** (alias, lado, vínculo). `q` filtra por apelido (máx. 40). |
| `GET /api/console/v1/participants/{id}/publications` | terapeuta vinculado ou o próprio participante | só os **identificadores** e datas de resumos e evoluções publicados. O conteúdo continua sendo lido pelas rotas do contrato (`summaries.get`, `evolution.get`). |

## Garantias
- Mesma autenticação (bearer) e mesma função `authorize` do contrato. Participante só lista as próprias publicações.
- Vínculo revogado ou expirado some da lista.
- O conjunto de rotas `/api/v3` não mudou (teste `test_contract_route_set_unchanged_by_console`).
- Nenhum contrato, esquema, catálogo ou regra de verificação foi alterado.

## Mudanças em harnesses (declaradas)
Os três harnesses de navegador tinham uma regra "nenhuma requisição fora de `/v3/` e `/api/v3/`". Foi aberta **uma exceção estreita**:
`GET /api/console/v1/participants` e `GET /api/console/v1/participants/{id}/publications`. Qualquer outra rota continua falhando.

## Próximas visões previstas (ainda não implementadas)
Catálogo de instrumentos e itens (Etapa D) e, se necessário, a lista de convites emitidos.
