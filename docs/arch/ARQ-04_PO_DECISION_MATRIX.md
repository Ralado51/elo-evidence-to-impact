# ARQ-04 — Matriz de decisões do PO

Recomendação em **negrito**. Nenhuma decisão foi tomada pelo agente; sem decisão, a fase correspondente não começa.

| ID | Decisão | Opções | Recomendação e razão |
|---|---|---|---|
| D-ARQ4-01 | Escopo da liberação | (a) ARQ-04 inteiro; (b) só Fases 0–4 (CMP-10) e depois CMP-03/02 | **(b)**: o risco bloqueante é FIX-37 (dados reais); feedback e i18n não bloqueiam |
| D-ARQ4-02 | Escrita concluída após troca de contexto | (a) aviso no contexto de origem + recarga, convite exibido uma vez na origem; (b) só recarga, token de convite descartado com aviso; (c) toast global | **(a)**; o token de convite é segredo de uso único, descartá-lo obriga a emitir outro |
| D-ARQ4-03 | Estado "dados possivelmente desatualizados" (G-10) | (a) mensagem + botão recarregar; (b) repetição indefinida | **(a)**: não esconde incerteza |
| D-ARQ4-04 | Transporte único com `signal` (muda 2 clientes + painel) | (a) extrair agora; (b) manter e só passar `signal` | **(a)** se (b) do D-ARQ4-01 não for escolhido; senão (b) mínimo |
| D-ARQ4-05 | Mapeador por expressão para `items[n]` | (a) agora (preparatório); (b) quando houver 2ª linha de item | **(b)**: hoje há uma linha; custo sem benefício imediato |
| D-ARQ4-06 | FormController completo | (a) ARQ-04; (b) backlog/ARQ-07 | **(b)** |
| D-ARQ4-07 | Marcador de registro legado: texto e superfícies | (a) selo discreto em participante e painel; (b) só painel; (c) nenhum | **(a)**, texto a validar com a terapeuta (clínico) |
| D-ARQ4-08 | I-01 | confirmado em 26/11: planejar no CMP-02 | já decidido |
| D-ARQ4-09 | Reteste humano integrado antes de dados reais | obrigatório / opcional | **obrigatório** (controle de defeitos já exige) |
| D-ARQ4-10 | Revogação servidor de token no logout | ARQ-06 | **manter no ARQ-06**; ARQ-04 só trata o cliente |

## Ratificação do PO (26/11/2026, após o aceite do ARQ-03)
| ID | Decisão ratificada |
|---|---|
| D-ARQ4-01 | **Tudo, em ordem** (CMP-10 primeiro; porta de saída FX37 8/8 antes de seguir para CMP-03 e CMP-02) |
| D-ARQ4-02 | **Aviso no paciente de origem + recarga**; token de convite exibido uma vez na origem (memória, destruído no logout) |
| D-ARQ4-03 | **"Possivelmente desatualizado" + recarregar** após esgotar tentativas |
| D-ARQ4-07 | **Selo de registro legado em participante e painel**; texto a validar com a terapeuta |
| D-ARQ4-04 | Transporte HTTP único com `signal`, listas de capacidade separadas |
| D-ARQ4-05 | Mapeador por expressão para `items[n]` **adiado** |
| D-ARQ4-06 | FormController completo **em backlog** (ARQ-07) |
| D-ARQ4-08 | I-01 incluído (já decidido) |
| D-ARQ4-09 | Reteste humano integrado **obrigatório** antes de dados reais |
| D-ARQ4-10 | Revogação servidor de token **no ARQ-06** |
