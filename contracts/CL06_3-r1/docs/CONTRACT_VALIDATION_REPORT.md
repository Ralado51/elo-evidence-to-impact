# CONTRACT_VALIDATION_REPORT — CL06.3

**Status: CONTRACTS_READY_WITH_CONDITIONS.** Gate C (contract release) is met. Gate V (verifier approval) is NOT met and NOT claimed: no verifier exists. The conditions are the open decisions in `OPEN_DECISIONS.md` and the pending implementation work below.

## 1. Approved contract tests (run now, Python AND JavaScript, same fixtures)
| Area | Result |
|---|---|
| Canonicalization: 24 hand-written vectors (expected strings written before any implementation ran) + sha256; 3 must-reject (NaN, Infinity, lone surrogate) | pass, both |
| CL06.1 vectors (5) and 21-event ledger (hashes, ids, chains) reproduced independently | pass, both |
| 19 event schemas + 9 entity schemas + 18 fact/proposal schemas load, cover the catalog, pass JSON Schema 2020-12 meta-validation (python-jsonschema) | pass |
| 22 valid ledger events: schema, integrity, semantics; stream chains; session-stream rule; evolution content_hash | pass, both |
| 13 valid entity fixtures + 2 version chains | pass, both |
| Limits boundary (5 cases) | pass, both |
| 33 invalid events, 4 integrity, 2 stream, 3 stream-rule, 18 entity, 2 entity-chain cases fail with the expected code | pass, both |
| 17 EXECUTABLE_NOW adversarial cases (P1, P1b, P2, P2b, P3, P4, P7, P8, P10, V3-A1..A8) | pass, both |
| Catalog consistency: roles only participant/therapist, API error codes exist in the catalog, 36 endpoints, 27 authorization rows, F10 not summary-eligible, F07 absent, no invented instrument, origin register hashes | pass, both |
| Mini-validator agrees with python-jsonschema on accepted documents | pass (Python only; cross-check) |
Totals: Python 37 tests, JavaScript 18 tests, 0 failures (`reports/test-results.json`).

## 2. Tests depending on a future implementation (PENDING, never counted as passed)
- **Verifier (10):** P3-scope, P7b, P3b, P5, P5b, P6, P9, V3-V1, V3-V2, V3-V3. P5 and P6 are regression cases for the Python-verifier divergence documented in VERIFIER_COMPARISON §3.
- **Service (10):** V3-S1..S10 (publication gate, stale content hash, comparability enforcement, no-transition rule, microphone consent, draft confirmation, role rejection, scope, real-data gate, legacy read-only).
- `fixtures/expected/facts.oracle.v3.json` is hand-written, shape/id/hash only, never checked by a verifier.

## 3. Existing failures
None in this package. CL06.1 was not modified or re-run; its known open item (5 verifier-layer A05 probes TODO) is unchanged and shows up here as the PENDING verifier cases.

## 4. Failures found and fixed during this work (transparency)
Python rejected integers >2^53 where JS converted to double (now aligned); `NULL_NOT_ALLOWED` was missing from both validators; Python `re` lacks `\p{L}` (alias pattern rewritten); a duplicate-seq stream reported a spurious CHAIN_BROKEN (libraries now keep the first event per seq); the `hash_pattern` invalid fixture was being re-hashed and therefore valid (fixed); two fixture expectations were mislabeled (limits layer, entity chain gap). All fixed in the builders and re-run.

## 5. Pending decisions
See `OPEN_DECISIONS.md`: CL06.3-D1, ADR-014..017 approval, instrument fields (Raquel), transcript retention/legal basis, modality values, F10 eligibility, alias pattern, origin of the real camera record, provisional PRD IDs.

## 6. Known limitations
- The reference libraries implement a JSON-Schema subset and stateless/stream-level rules. They are not a verifier, not a service, and not production code.
- Schema checks duplicate some limits (max sets/reps) that the semantic layer also checks; the product limit (<=100) and `limits_version` are semantic only.
- Integrity is not authenticity (RN020): hashes detect accidental or unilateral edits, they do not prove who wrote an event.
- The origin register classifies by documented evidence; "self-declared" entries were not independently verified. The real camera record's identity and consent are unrecorded.
- Traceability: 82 of 101 P0 requirements have a contract element; 19 are interface/behavior requirements with none. 13 of the 82 are only partially testable now.
- PRD IDs are the PRD's provisional consolidated IDs; the check against historical IDs requested by the PRD was not possible from the package.
- No performance, accessibility, security or clinical claim is made or validated.
- PD-04 implementation depends on CL06.3-D1 (null handedness).

## 7. Restrictions respected
CL06.1 untouched; original repositories untouched; no product feature, commit, deploy, paid service, real clinical data or hosting/model/framework choice. The only `pip`/`npm` actions: none.
