# ARCHITECTURE_DECISIONS

## Tomadas (técnicas, reversíveis)
- **AD-01** Data civil é conceito distinto de instante; módulo único `civil_date` no servidor, espelho puro no cliente, vetores compartilhados.
- **AD-02** Campos de data derivados do **schema** (pattern), não de lista manual: novos campos herdam a regra.
- **AD-03** `entities.validate`/`check_entity_semantics` (código portado) **não alterados**; a checagem civil roda depois deles em `clinical.py`.
- **AD-04** Códigos de erro preservados por superfície (prescrição/evolução `RULE_VIOLATION`; revisão `PATTERN`); entidades clínicas passam a `RULE_VIOLATION` para datas inexistentes (antes não eram rejeitadas), com mensagens compatíveis com `RULE_PATTERNS` do front.
- **AD-05** Controle nativo `<input type="date">`; a guarda de UX (`validateDateFields`) cobre `badInput`, vazio obrigatório e intervalo invertido; o servidor continua a autoridade.
- **AD-06** Harness (mudanças declaradas, sem mascarar falhas): `e2e_journey.keyboardFillInput` digita em controles de data na ordem de segmentos do locale; `checks.mjs` trata Tab entre segmentos de um mesmo `input[type=date]` (até 5 repetições consecutivas) como navegação interna, mantendo a detecção de armadilha para todo o resto.

## Pendentes — requerem ratificação do PO
| ID | Decisão | Por quê |
|---|---|---|
| PD-01 | Limites clínicos de data (futuro, janela, fuso, correção histórica); datas padrão (FIX-22); prazo de meta | regra de negócio/clínica; não inventada |
| PD-02 | Contrato de idempotência: **proposta do PO recebida em 26/11**; delta normativo exato apresentado em `ARQ-02_CONTRACT_DELTA.md` — aguardando aprovação (Q1–Q6) antes de alterar `contracts/` | evolução de contrato normativo (ARQ-02) |
| PD-03 | Matriz tipo de meta × unidade × instrumento, lateralidade, séries/repetições | regra clínica (ARQ-03) |
| PD-04 | Política de logout/revogação de sessão | segurança |
| PD-05 | Unificar códigos de erro de data entre superfícies | altera contrato de erro |
| PD-06 | Armazenamento local de relatos pendentes (IndexedDB), retenção | privacidade/segurança |
| PD-07 | Padrão de calendário visual condicionado a testes de acessibilidade | UX/a11y |
| PD-08 | Migrar/sinalizar dados históricos com data impossível já persistidos | dados |

## Limitações registradas
- O seletor do `<input type="date">` segue o locale do **navegador**, não o idioma do app.
- Impedimento de documentação: `ARCHITECTURE_V2.md`, `IMPLEMENTATION_SEQUENCE_V2.md`, PRD, ACCEPTANCE e ADRs de fábrica **não estão no repositório**; as cópias do Drive desses documentos não foram lidas nesta etapa. Nenhuma suposição sobre seu conteúdo foi feita; a fonte usada foi a planilha *Product Backlog* (aba *Componentes V2.2*) e o código.
