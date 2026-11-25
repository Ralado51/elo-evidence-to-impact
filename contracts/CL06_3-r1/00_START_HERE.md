# CL06.3 — Contract package · Elo Functional Intelligence

**Status: CONTRACTS_READY_WITH_CONDITIONS.** Contracts are ready for PO review. Verifier approval (Gate V) is not claimed: no verifier is implemented. Product implementation waits for PO approval.

## What is in here
| Path | Content |
|---|---|
| `contracts/schemas/` | 19 event, 9 entity, 18 fact/proposal JSON Schemas (2020-12) + progress series |
| `contracts/catalogs/` | event catalog v3, fact catalog v2, comparability rules v1, limits v1, limitations L01–L19, enums, error codes (73) |
| `contracts/api/` | API v3 (36 endpoints), authorization matrix (27 rows; participant/therapist only) |
| `contracts/registries/` | instrument registry (only `custom_unvalidated`; waits for Raquel), units |
| `fixtures/` | canonical/hash vectors, valid ledger and entities, invalid cases, adversarial cases (17 executable now, 20 pending), origin register |
| `reference/python`, `reference/js` | two independent contract-level reference libraries (not a verifier) |
| `tests/python`, `tests/js`, `run_all.sh` | contract tests in both languages |
| `docs/` | DATA_MODEL_DETAILED, ADR-014..017, MIGRATION_AND_COMPATIBILITY, TRACEABILITY_P0 (.md/.csv), RELEASE_CRITERIA, OPEN_DECISIONS, CONTRACT_VALIDATION_REPORT |
| `INTEGRITY_MANIFEST.sha256` | sha256 of every file |
| `legacy_cl06_1_reference/` | read-only copies of CL06.1 vectors/ledger used for cross-reproduction |
| `tools/` | builders that regenerate contracts, fixtures, traceability and docs deterministically |

## Validate (needs Python 3.10+ and Node 18+; no installs; `jsonschema` is optional for the cross-check)
```
./run_all.sh                     # Python + JS tests, writes reports/test-results.json
sha256sum -c INTEGRITY_MANIFEST.sha256
```
Regenerate (optional): `python3 tools/build_contracts.py && python3 tools/build_fixtures.py && python3 tools/build_traceability.py && python3 tools/build_docs.py` (the builders read CL06.1 schemas read-only from `CL06_1_DIR` and the PRD from `PRD_DIR`; outputs are already included).

## Read first
1. `docs/CONTRACT_VALIDATION_REPORT.md` — what passed, what is pending, known limits.
2. `docs/OPEN_DECISIONS.md` — what needs the PO (CL06.3-D1 and others).
3. `docs/adr/ADR-014..017` — proposed, awaiting approval.

## Reminders
Verifier and service cases are PENDING and never counted as passed. Synthetic data only. CL06.1 and the original repositories are untouched. Nothing was committed, pushed or deployed.
