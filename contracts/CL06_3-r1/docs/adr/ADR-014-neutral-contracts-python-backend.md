# ADR-014 — Language-independent contracts; Python/FastAPI preferred backend

**Status:** PROPOSED (needs PO approval, PX-03). Supersedes ADR-002 and ADR-006. Implements PD-01.

## Context
CL06.1 contracts and verifier are JavaScript ESM. The PO prefers Python/FastAPI for the backend and JavaScript for the frontend, and decided that contracts must not depend on a language. Two verifier implementations (JS and Python) diverged in the past: the Python E2I verifier accepted the P5 and P6 cases that CL06.1 rejects (VERIFIER_COMPARISON §3).

## Decision
1. The normative contract is the set of JSON Schemas, catalogs, canonicalization rules and hash vectors under `contracts/` and `fixtures/`. No implementation is normative.
2. Backend: Python/FastAPI preferred. Frontend: JavaScript. No frontend framework, hosting, definitive database or AI provider is chosen here.
3. There is exactly ONE normative verifier implementation (to be chosen after Gate C and after the feasibility check below). Other implementations only run conformance tests.
4. The preference becomes a commitment only when all three PD-01 conditions hold: (a) canonicalization and hash vectors reproduced in both languages (done for contracts: Python and JS reference libraries pass the same vectors and reproduce the 21 CL06.1 ledger hashes); (b) feasibility of adapting existing code (not assessed here); (c) approval of the trust-core tests by the PO.
5. P5 and P6 become mandatory regression cases for any verifier (fixtures `P5`, `P5b`, `P6`, status PENDING_IMPLEMENTATION).

## Alternatives considered
- Keep JS for everything (ADR-002/006): lowest migration cost, contradicts the PO preference.
- Two parallel verifiers: rejected, it already produced P5/P6 divergence.
- Generate code from schemas: possible later; not required for Gate C.

## Consequences
- Reference libraries here are contract-level only (schema validation, canonicalization, hashes, stateless semantic rules). They are NOT a verifier.
- Python regex lacks `\p{L}`; alias patterns were rewritten with explicit ranges (stricter than v2; see MIGRATION).
- Integers beyond 2^53 are converted to double in both languages (RFC 8785 behavior).

## Evidence
`tests/python`, `tests/js`, `fixtures/valid/canonical-vectors.v3.json` (24 vectors + 3 must-reject), `legacy_cl06_1_reference/`.
