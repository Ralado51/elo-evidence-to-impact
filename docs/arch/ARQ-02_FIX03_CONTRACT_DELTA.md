# ARQ-02 FIX-03 — Delta normativo proposto (aditivo, opt-in)
Base: `CL06_3-r1` 3.0.0 + `CL06_3-A1` 3.1.0 (congelados; **não editados**). Status: **RATIFICADO pelo PO em 2026-11-26** como extensão opcional candidata ao addendum A2 (3.2.0); incorporado a `ARQ-03_CONTRACT_DELTA.md` (item 6). Pacotes congelados 3.0.0 e 3.1.0 não modificados.

## facts.list — `GET /api/v3/participants/{participant_id}/facts[?include=reviews]`
- Sem `include`: resposta idêntica à atual `{facts, catalog_version}`.
- `include=reviews`: acrescenta `effective_reviews: { <fact_id>: { decision: "approve"|"reject", content_hash: string, event_id: string, note: string|null } }`.
  - Dobra: mesma de `resolve_effective_reviews` (última decisão `approve`/`reject` na ordem de append; `annotate` não altera). Fatos sem decisão efetiva ficam ausentes.
  - O servidor não avalia obsolescência: o cliente compara `content_hash` com o hash do fato atual (inalterado), e a publicação segue validando no servidor.
- Valor de `include` diferente de `reviews` → 400 `RULE_VIOLATION`. Autorização e escopo idênticos a `facts.list` (terapeuta vinculado).
- Sem novo endpoint (a contagem de 31 operações é preservada); sem novo código de erro; sem nova fonte de verdade (projeção do ledger).

## Condições da ratificação (todas atendidas/verificadas)
Resposta original sem o parâmetro; contratos 3.0.0/3.1.0 intactos; 31 operações; autorização por participante; ledger como fonte; regra compartilhada de resolução efetiva (`resolve_effective_reviews`); validação definitiva de elegibilidade no servidor (publicação segue recusando `FACT_NOT_APPROVED` independentemente da projeção); histórico integral (teste `test_full_decision_history_preserved...`).
