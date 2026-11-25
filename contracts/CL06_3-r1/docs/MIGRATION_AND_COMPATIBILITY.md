# MIGRATION_AND_COMPATIBILITY — CL06.1 (schema 2) → CL06.3 (schema 3)

CL06.1 is not modified. Nothing is rewritten: migration is by **read mode**.

| Topic | Rule |
|---|---|
| Legacy streams/events (schema_version 2) | Read-only legacy. Writes return `LEGACY_STREAM_READ_ONLY` (service, PENDING). Hash chains stay valid; the 21-event CL06.1 ledger is reproduced by both libraries. |
| Envelope | v3 adds required `execution_mode`, `data_origin` enum with `experimental_capture`, optional `origin_ref`. Legacy events have neither: read as `execution_mode` derived from `source.type` only for display, never written back. |
| Origin (adjustment 5) | Not assumed synthetic. `fixtures/origin-register/legacy-origin-register.json` classifies each known record by evidence with sha256 and `entry_hash`. Result: CL06.1 ledger/probes, camera-fixture export, simulation export, onestep, neurofenix run, E2I benchmark cases → `synthetic_fixture` (self-declared in the record); `real-camera-manual-test` → `experimental_capture` (self-declared; identity and consent unrecorded; forbidden for facts, evolution and clinical use); demo prescription → `unclassified`; tool logs → `tool_log_not_patient_data`. No silent inference: unclassified stays excluded. |
| Consent | v3 consents carry `scopes` [camera, microphone]. Legacy consents get NO inferred scopes. |
| F01 | v1 → v2 semantic change: `handedness_mismatch_cycles` now counts the rejected incompatible cycles and `handedness_unknown_cycles` is new. v1 and v2 facts are not comparable (`fact_definition_version` in the key). Both remain readable. |
| F05 | definition_version 2 (semantic note). Same non-comparability rule. |
| Prescription | `limits_version` required. Legacy prescriptions are validated against limits-v1 on read only; none is rewritten. |
| cycle.rejected | reason += `handedness_incompatible`. Legacy cycles accepted with a different label stay as recorded and are flagged, not reclassified. |
| Aliases | Pattern rewritten without `\p{L}` (Python `re`); stricter than v2. Needs PO confirmation. |
| Intelligence drafts | Modeled as entities, not events (changes C6 of CONTRACT_EVOLUTION_PLAN): they are mutable-by-version proposals, not facts. |
| Roles | caregiver/supervisor never existed in the MVP data; any v2 reference is rejected in v3. |
| Reversal | Because nothing is rewritten, v3 can be abandoned without touching v2 data. |
