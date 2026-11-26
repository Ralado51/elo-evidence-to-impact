# ARCHITECTURE_DECISIONS

## Tomadas (técnicas, reversíveis)
- **AD-01** Data civil é conceito distinto de instante; módulo único `civil_date` no servidor, espelho puro no cliente, vetores compartilhados.
- **AD-02** Campos de data derivados do **schema** (pattern), não de lista manual: novos campos herdam a regra.
- **AD-03** `entities.validate`/`check_entity_semantics` (código portado) **não alterados**; a checagem civil roda depois deles em `clinical.py`.
- **AD-04** Códigos de erro preservados por superfície (prescrição/evolução `RULE_VIOLATION`; revisão `PATTERN`); entidades clínicas passam a `RULE_VIOLATION` para datas inexistentes (antes não eram rejeitadas), com mensagens compatíveis com `RULE_PATTERNS` do front.
- **AD-05** Controle nativo `<input type="date">`; a guarda de UX (`validateDateFields`) cobre `badInput`, vazio obrigatório e intervalo invertido; o servidor continua a autoridade.
- **AD-06** Harness (mudanças declaradas, sem mascarar falhas): `e2e_journey.keyboardFillInput` digita em controles de data na ordem de segmentos do locale; `checks.mjs` trata Tab entre segmentos de um mesmo `input[type=date]` (até 5 repetições consecutivas) como navegação interna, mantendo a detecção de armadilha para todo o resto.

- **AD-07** (ARQ-02, ratificada pelo PO) Idempotência transacional: registro de referências imutáveis (nunca corpos); replay reconstruído pela versão original da entidade; chave opcional no contrato e obrigatória no front para operações `keyed`; só sucessos 2xx são registrados; efeito e registro na mesma transação; `invites.create` fora do registro; retenção padrão 7 dias (1–90) com janela de reenvio automático do cliente ≤ 24 h e abaixo da retenção menos margem; após a janela, estado de resultado desconhecido sem reenvio automático nem chave nova silenciosa. Formalizada no adendo A1 (contracts 3.1.0), pacote separado `contracts/CL06_3-A1/`; o pacote 3.0.0 (`CL06_3-r1`) permanece byte a byte intacto.
- **AD-08** Concorrência: `V3Store.command_scope()` + `_CommandConnection` mantêm o `_tx_lock` existente do ponto de escrita até o fim do comando (reautorização → registro → um único commit). Fecha a corrida revogação de vínculo × execução sem alterar a concorrência otimista (`ENTITY_VERSION_CONFLICT`), cujos testes congelados continuam intactos.
- **AD-09** Compatibilidade com o pacote congelado: códigos A1 em `A1_ERROR_CODES` (separados de `EMITTABLE_ERROR_CODES`); retenção exposta no cabeçalho `Idempotency-Retention-Days` (corpo de `/health` inalterado); nenhuma rota nova; o conjunto de rotas do 3.0.0 é preservado.
- **AD-10** Sem segundo canonicalizador/ledger/verificador: fingerprint usa `elo.canonical.hash_canonical`; o hash do payload nunca é a identidade da intenção.
- **AD-11** Front: `CommandController` (CMP-07) por formulário: single-flight, janela anti-rajada de 500 ms **somente para conteúdo idêntico** após sucesso (Enter+clique, duplo clique), uma chave por intenção, reuso da chave em falhas ambíguas (rede/timeout/5xx), janela = min(24 h, retenção − 1 h) com retenção lida de `Idempotency-Retention-Days` (assume o mínimo de 1 dia até lê-la), estado "resultado desconhecido" com ação explícita "Iniciar nova tentativa". Convites: apenas single-flight, segredo nunca retido. Dependência registrada: reconciliação automática do resultado desconhecido depende do Outbox/SessionController (ARQ-05); até lá, o reenvio automático inseguro está bloqueado.

## Pendentes — requerem ratificação do PO
| ID | Decisão | Por quê |
|---|---|---|
| PD-01 | Limites clínicos de data (futuro, janela, fuso, correção histórica); datas padrão (FIX-22); prazo de meta | regra de negócio/clínica; não inventada |
| PD-02 | ~~Contrato de idempotência~~ **Ratificado pelo PO (Q1–Q6) e implementado** no adendo A1 (contracts 3.1.0) — AD-07..AD-11. Permanece como nova decisão contratual: tornar `Idempotency-Key` obrigatório para clientes em geral | evolução de contrato normativo (ARQ-02) |
| PD-03 | Matriz tipo de meta × unidade × instrumento, lateralidade, séries/repetições | regra clínica (ARQ-03) |
| PD-04 | Política de logout/revogação de sessão | segurança |
| PD-05 | Unificar códigos de erro de data entre superfícies | altera contrato de erro |
| PD-06 | Armazenamento local de relatos pendentes (IndexedDB), retenção | privacidade/segurança |
| PD-07 | Padrão de calendário visual condicionado a testes de acessibilidade | UX/a11y |
| PD-08 | Migrar/sinalizar dados históricos com data impossível já persistidos | dados |

## Limitações registradas
- O seletor do `<input type="date">` segue o locale do **navegador**, não o idioma do app.
- Impedimento de documentação: `ARCHITECTURE_V2.md`, `IMPLEMENTATION_SEQUENCE_V2.md`, PRD, ACCEPTANCE e ADRs de fábrica **não estão no repositório**; as cópias do Drive desses documentos não foram lidas nesta etapa. Nenhuma suposição sobre seu conteúdo foi feita; a fonte usada foi a planilha *Product Backlog* (aba *Componentes V2.2*) e o código.
- Operações `drafts.create|confirm|discard` constam do contrato 3.0.0 mas não existem no servidor; no adendo A1 ficam `deferred` (sem comportamento de idempotência).
- O estado de intenção pendente/desconhecido vive só em memória da página: recarregar a página descarta a intenção (e a chave); a recuperação entre recargas depende do Outbox (ARQ-05).
- Reconciliação (consulta) após resultado desconhecido é orientada ao usuário (histórico do participante); a automática depende de ARQ-05.
