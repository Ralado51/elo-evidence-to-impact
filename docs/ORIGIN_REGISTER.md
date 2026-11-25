# Origin Register

Records provenance, SHA-256 hashes, licenses, and attribution for code and contract artifacts ported or copied into `elo-evidence-to-impact` under PO-F10 and PO-F15.

No code from `elo-functional-intelligence` (historical repository) or from the local laboratory (`experiments/elo-integrated-demo`) is ported in `S0-01` or `S0-02`.

| Target Path | Origin Status | Source Path | Source SHA-256 | License | Attribution | Task / Authorization |
|---|---|---|---|---|---|---|
| `contracts/CL06_3-r1/` | Versioned release copy (tooling-only diff; see `contracts/CL06_3-r1/RELEASE_NOTE.md`) | `contracts/CL06_3` (origin manifest `contracts/CL06_3/INTEGRITY_MANIFEST.sha256`) | `a7f33d5431bd6e5b401f7143e77d39daad371cd92e84fb81f6e83a6ba406d9d1` (origin manifest); SNAP `e584fd5d5beb03332b398e51e4a05859585426a968eb3c677ddd1255c8e80e2d` | Apache-2.0 | Airton Justino O. Junior (Elo CL06.3 contract package) | `S0-01` / PO-F6, PO-F7, PO-F15, D-S0-01-1 |
| `api/src/elo/canonical.py` | Ported from CL06.3 reference library | `contracts/CL06_3/reference/python/elo_ref.py` | `a88f324099523f4cc66f24cf5c9ecdcc5b8f69ec5999418d9a1635955d3439a0` | Apache-2.0 | Airton Justino O. Junior (Elo CL06.3 contract package) | `S0-01` / PO-F10 |
| `web/canonical.mjs` | Ported from CL06.3 reference library | `contracts/CL06_3/reference/js/elo_ref.mjs` | `70d4ad27309e3ffd84e2a606265d0425ab8e9f42bd80809849879bc0f362e5f6` | Apache-2.0 | Airton Justino O. Junior (Elo CL06.3 contract package) | `S0-01` / PO-F10 |
| `api/tests/test_canonical.py` | New file (not ported) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S0-01` |
| `web/tests/canonical.test.mjs` | New file (not ported) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S0-01` |
| `api/src/elo/v3/entities.py` | Ported from CL06.3 reference library (`validate`, `compute_entity_hash`, `check_entity_semantics`, `check_entity_chain`, `_type_ok`, `ENTITY_PREFIX`) | `contracts/CL06_3/reference/python/elo_ref.py` | `a88f324099523f4cc66f24cf5c9ecdcc5b8f69ec5999418d9a1635955d3439a0` | Apache-2.0 | Airton Justino O. Junior (Elo CL06.3 contract package) | `S0-02` / PO-F10 |
| `api/src/elo/v3/__init__.py` | New file (not ported) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S0-02` |
| `api/src/elo/v3/errors.py` | New file (not ported) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S0-02` |
| `api/src/elo/v3/authz.py` | New file (not ported) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S0-02` |
| `api/src/elo/v3/store.py` | New file (not ported) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S0-02` |
| `api/src/elo/v3/auth.py` | New file (not ported) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S0-02` |
| `api/src/elo/v3/router.py` | New file (not ported) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S0-02` |
| `api/tests/test_v3_authz.py` | New file (not ported) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S0-02` |
