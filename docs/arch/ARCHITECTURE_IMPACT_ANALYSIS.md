# ARCHITECTURE_IMPACT_ANALYSIS

## Defeitos → causa estrutural → componente → pacote
| FIX | Defeito | Causa estrutural | Componente | Pacote |
|---|---|---|---|---|
| FIX-01 | D03 data impossível persistida | validação de data só por regex de sintaxe no schema; 4 parsers divergentes; campo texto livre | CMP-04 | **ARQ-01 (feito)** |
| FIX-22 | datas padrão fixas | defaults estáticos no HTML | CMP-04 | ARQ-01: mantido; PD-01 |
| FIX-02 | duplicação/reenvio | sem ciclo de vida do comando nem idempotência transacional | CMP-07/08 | **ARQ-02 (feito; aguarda validação independente)** |
| FIX-03/19/20/21 | tipo/unidade/instrumento | campos livres sem catálogo | CMP-06/13 | ARQ-03 |
| FIX-04/09/10..13/16/18 | contexto, idioma, erros | handlers e clientes duplicados; sem guarda de resposta tardia | CMP-02/03/10 | ARQ-04 |
| FIX-14/15/17 | stop, relato pendente | sem SessionController/Outbox | CMP-11/12 | ARQ-05 |
| FIX-05..08 | comparabilidade/evolução | política de compatibilidade dispersa | CMP-19 | ARQ-06 |

## Impacto de ARQ-01
- **Contratos/API:** nenhum schema alterado. Respostas de erro mantêm código e formato por superfície; apenas datas antes aceitas indevidamente passam a ser 400.
- **Consumidores:** 5 módulos backend + 4 formulários + `formatIsoDate`. Todos testados.
- **Risco residual:** dados históricos já persistidos com data impossível continuam legíveis e exibidos como armazenados (sem deslocar); não há migração (decisão do PO se desejada).

## Impacto de ARQ-02
- **Contrato:** evolução formal 3.0.0 → 3.1.0 por adendo em pacote separado (`contracts/CL06_3-A1/`, manifest próprio com hash do manifest base). `CL06_3-r1` inalterado (manifest verificado em teste).
- **API:** nenhuma rota nova. Cabeçalhos novos (`Idempotency-Key` opcional; `Idempotency-Replayed`, `Idempotency-Retention-Days` nas respostas) e dois códigos (`IDEMPOTENCY_KEY_INVALID` 400, `IDEMPOTENCY_KEY_REUSED` 409) apenas para operações `keyed`. Clientes sem o cabeçalho mantêm o comportamento anterior.
- **Dados:** uma tabela nova `v3_command_dedup` (só referências). Nenhuma tabela clínica alterada; restrições de unicidade preservadas.
- **Consumidores:** 13 operações `keyed` no servidor; 7 formulários do terapeuta no front; gateway de demonstração (`scripts/gateway.mjs`) passa a repassar `Idempotency-Replayed` e `Idempotency-Retention-Days`. Participante (`events.batch`, idempotência natural) e painel (leitura) não alterados.
- **Defeitos relacionados** (status **não** alterado; homologação é do PO): D04 e S1-03 (registro duplicado em envio repetido), FIX-02 (duplicação/reenvio), FIX-18 (erro e sucesso exibidos juntos — exclusividade garantida e testada em CC-7; a correção estrutural dos demais caminhos de erro segue em ARQ-04).
- **Risco residual:** intenção em memória (recarga a perde); reconciliação automática depende de ARQ-05; `drafts.*` não implementados no servidor.
