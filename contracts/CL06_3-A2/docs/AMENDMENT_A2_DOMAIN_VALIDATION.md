# Amendment A2 (FROZEN) — domain validation (contracts 3.2.0)

Status: **frozen by PO on 2026-11-26** (accepted revision `2cf4babe516bc806ff89f87d28ae3f3ac608e730`; formal record `docs/arch/ARQ-03_ACCEPTANCE_RECORD.md`). Compatibility (P-07, accepted): preserved for historical reads and pre-A2 idempotent replay; **not** declared fully backward-compatible for writes. Base: A1 (3.1.0) over r1 (3.0.0), both untouched.
Full normative text: `docs/arch/ARQ-03_A2_PROPOSAL.md`; ratification: `docs/arch/ARQ-03_PO_RATIFICATION_RECORD.md`.

Contents: A2-01 `facts.list?include=reviews` (already live); A2-02 `goal-target-rules.v1`; A2-03 optional `goal.payload.deadline`
(civil date; schema copy here); A2-04 instrument derived from `instrument-registry.json`; A2-05 `assessment-item-rules.v1` (R1–R5, R6 dormant);
A2-06 errors reuse existing codes + `details {rule, path}` (no new codes); A2-07 dose unchanged (front guard from `limits.v1`).

Scope: **write-only**. Reads, replay (command_dedup) and legacy records are not revalidated; new versions of legacy records must satisfy current rules (P-08).
Potential incompatibility: strict-schema clients validating goal with `additionalProperties:false` reject payloads carrying `deadline`.
Vectors: `contracts/fixtures/a2-vectors.json` (shared by Python and JS tests).

Ratified at freeze: `goal.count_ceiling` (reuses `OUT_OF_RANGE`; limit derived from `goal-target-rules.v1`) and vectors V-G14/V-G15. UI-only rules `goal.text_required` and `item.observed_requires_value` are NOT part of this contract.
