# ARCHITECTURE_IMPACT_ANALYSIS

## Defeitos → causa estrutural → componente → pacote
| FIX | Defeito | Causa estrutural | Componente | Pacote |
|---|---|---|---|---|
| FIX-01 | D03 data impossível persistida | validação de data só por regex de sintaxe no schema; 4 parsers divergentes; campo texto livre | CMP-04 | **ARQ-01 (feito)** |
| FIX-22 | datas padrão fixas | defaults estáticos no HTML | CMP-04 | ARQ-01: mantido; PD-01 |
| FIX-02 | duplicação/reenvio | sem ciclo de vida do comando nem idempotência transacional | CMP-07/08 | ARQ-02 |
| FIX-03/19/20/21 | tipo/unidade/instrumento | campos livres sem catálogo | CMP-06/13 | ARQ-03 |
| FIX-04/09/10..13/16/18 | contexto, idioma, erros | handlers e clientes duplicados; sem guarda de resposta tardia | CMP-02/03/10 | ARQ-04 |
| FIX-14/15/17 | stop, relato pendente | sem SessionController/Outbox | CMP-11/12 | ARQ-05 |
| FIX-05..08 | comparabilidade/evolução | política de compatibilidade dispersa | CMP-19 | ARQ-06 |

## Impacto de ARQ-01
- **Contratos/API:** nenhum schema alterado. Respostas de erro mantêm código e formato por superfície; apenas datas antes aceitas indevidamente passam a ser 400.
- **Consumidores:** 5 módulos backend + 4 formulários + `formatIsoDate`. Todos testados.
- **Risco residual:** dados históricos já persistidos com data impossível continuam legíveis e exibidos como armazenados (sem deslocar); não há migração (decisão do PO se desejada).
