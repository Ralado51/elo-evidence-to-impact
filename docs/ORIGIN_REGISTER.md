# Origin Register

Records provenance, SHA-256 hashes, licenses, and attribution for code and contract artifacts ported or copied into `elo-evidence-to-impact` under PO-F10 and PO-F15.

No code from `elo-functional-intelligence` (historical repository) or from the local laboratory (`experiments/elo-integrated-demo`) is ported in `S0-01`, `S0-02`, `S0-03`, or `S0-04`.

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
| `api/src/elo/v3/validation.py` | Ported from CL06.3 reference library (`check_event_semantics`, `check_session_stream`, `STREAM_OF`, `START_SOURCE`) | `contracts/CL06_3/reference/python/elo_ref.py` | `a88f324099523f4cc66f24cf5c9ecdcc5b8f69ec5999418d9a1635955d3439a0` | Apache-2.0 | Airton Justino O. Junior (Elo CL06.3 contract package) | `S0-03` / PO-F10 |
| `api/tests/test_v3_validation.py` | New file (not ported) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S0-03` |
| `api/src/elo/v3/ledger.py` | New file (not ported; append-only trigger pattern adapted from `api/src/elo/review.py`) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S0-04` |
| `api/tests/test_v3_ledger.py` | New file (not ported) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S0-04` |
| `api/src/elo/v3/session_rules.py` | phase rules specified by CL06.1, new code (no code copied; CL06.1 read as specification only) | CL06.1 specification objects (`session-states.mjs`, `events.mjs`, `errors.mjs`, `streams.json` in read-only knowledge store) | `session-states.mjs`: `52376bace2fd829a4fd48a1fa5ff85d9ae83dda5e229e52749908088c75b04b9`; `events.mjs`: `7759c9952c73dd1067543993f123f4af4139c23d084553de950c8693817a8fc8`; `errors.mjs`: `1b812c75760f01b893429633d7b3636f442c34d48a0f824459ea29fbd3497b66`; `streams.json`: `9ae0e0518ce23c89dc2304ea96a6bc27835379d618a7315f9d1a4d2e4deede51` | Apache-2.0 | Airton Justino O. Junior | `S1b-01` / PO-F26, D-S1b-01-1 |
| `api/tests/test_v3_session_rules.py` | New file (not ported; exercises CL06.1 `streams.json` specification fixtures read-only) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S1b-01` / PO-F26 |
| `api/src/elo/v3/verifier.py` | New file written from scratch (selectors & `session_date_local` specified by CL06.1, no code copied) | CL06.3 `fact-catalog.v2.json` & `limitations.v2.json`; CL06.1 specification objects (`session-states.mjs`, `catalog.mjs`, `fact.mjs`, `limitations.mjs`, `api.mjs` in read-only knowledge store) | `session-states.mjs`: `52376bace2fd829a4fd48a1fa5ff85d9ae83dda5e229e52749908088c75b04b9`; `catalog.mjs`: `8a260b79d53d8efa32f4396b51ee136349d83fe0dabcb33c086d28bf448f2053`; `fact.mjs`: `83560a5daf02a87bab7dccfe99c3883429f0dae6177c0bbb90b146f84d3c339a`; `limitations.mjs`: `b5807233415b8838f20d54eb56d55f7a130ce4119eda09e2a60955ed718be895`; `api.mjs`: `d2465e8cb38e1c756328948935da7eb44771b268c5fbbd55c4b2e60f54366fe7` | Apache-2.0 | Airton Justino O. Junior | `S1b-02` / PO-F27, D-S1b-02-1 |
| `api/tests/test_v3_verifier.py` | New file (not ported) | n/a | n/a | Apache-2.0 | Airton Justino O. Junior | `S1b-02` / PO-F27 |
