# RELEASE_CRITERIA — two gates, no circular dependency (adjustment 8)

## Gate C — contract release (this package)
Depends on nothing but the contract files. Criteria, all verifiable now:
1. Every schema passes JSON Schema 2020-12 meta-validation.
2. Canonicalization vectors (24) reproduced in Python and JS; 3 must-reject cases rejected; CL06.1 vectors and 21-event ledger reproduced.
3. All valid fixtures pass schema, integrity, semantic and chain checks in both languages.
4. All invalid fixtures fail with the expected code in both languages.
5. The 17 EXECUTABLE_NOW adversarial cases fail with the expected code.
6. Catalog consistency: schemas = event catalog; API roles ⊆ {participant, therapist}; API error codes exist; F10 not summary-eligible; no invented instrument.
7. Traceability: 101/101 P0 accounted for.
8. Manifest sha256 verifies.
9. Pending decisions and limitations are listed; no PENDING case is reported as passed.

## Gate V — verifier approval (NOT met)
Requires a verifier implementation and its tests; depends on Gate C having passed. Criteria: reproduces the oracle; rejects P3-scope, P3b, P5, P5b, P6, P7b, P9, V3-V1..V3 (the 10 verifier cases); PD-01 conditions (a)–(c) satisfied; one normative implementation; PO approval of the trust-core tests.
Gate C never reads Gate V. Gate V reads Gate C. Status of Gate V: NOT STARTED.

## Gate S — service behaviors (NOT met)
V3-S1..S10 (10 service cases) need an API service.
