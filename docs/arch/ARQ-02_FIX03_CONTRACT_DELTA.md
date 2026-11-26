# ARQ-02 FIX-03 — Delta normativo proposto (aditivo, opt-in)
Base: `CL06_3-r1` 3.0.0 + `CL06_3-A1` 3.1.0 (congelados; **não editados**). Status: implementado como extensão opcional; **aguarda ratificação do PO** (candidato a addendum A2).

## facts.list — `GET /api/v3/participants/{participant_id}/facts[?include=reviews]`
- Sem `include`: resposta idêntica à atual `{facts, catalog_version}`.
- `include=reviews`: acrescenta `effective_reviews: { <fact_id>: { decision: "approve"|"reject", content_hash: string, event_id: string, note: string|null } }`.
  - Dobra: mesma de `resolve_effective_reviews` (última decisão `approve`/`reject` na ordem de append; `annotate` não altera). Fatos sem decisão efetiva ficam ausentes.
  - O servidor não avalia obsolescência: o cliente compara `content_hash` com o hash do fato atual (inalterado), e a publicação segue validando no servidor.
- Valor de `include` diferente de `reviews` → 400 `RULE_VIOLATION`. Autorização e escopo idênticos a `facts.list` (terapeuta vinculado).
- Sem novo endpoint (a contagem de 31 operações é preservada); sem novo código de erro; sem nova fonte de verdade (projeção do ledger).
