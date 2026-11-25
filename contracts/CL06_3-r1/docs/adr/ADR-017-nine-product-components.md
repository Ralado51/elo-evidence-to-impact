# ADR-017 — Nine product components over shared engines; two roles

**Status:** PROPOSED (PX-03). Supersedes ADR-013. Implements PD-07, PD-08, PD-09, PD-11.

## Decision
1. Product components: Clinical, Between Sessions, Motion, Play, Evidence, Progress, Intelligence, Accessibility, Remote Continuity. Internal engines stay internal; the user-facing surface stays simple. Positioning (PD-11, not reopened): Elo Functional Intelligence is a plataforma de inteligência funcional para terapia ocupacional, com MVP delimitado.
2. Roles: only `participant` and `therapist`. `caregiver` and `supervisor` are rejected (`ROLE_NOT_ALLOWED`; enum validation also fails them).
3. Modality is an attribute of the declared `encounter` (`in_person`, `remote_external`; values to confirm). `remote_integrated` (video in the product) is P1 and rejected by the schema.
4. MVP population is adult hand/wrist; a pediatric contextual verifier is reserved (PD-09) and has no contract here.
5. Instruments: no functional-assessment instrument is invented. `functional_assessment` has generic items; the registry contains only `custom_unvalidated`. Specific fields wait for validation with Raquel (PX-04).

## Consequences
Components are a product grouping; contracts do not depend on them. Traceability maps the 101 P0 requirements to contract elements (`docs/TRACEABILITY_P0.md`).

## Evidence
`authorization-matrix.v3.json`, `encounter.schema.json`, `instrument-registry.json`, fixtures `old_role_caregiver`, `encounter_remote_integrated_p1`.
