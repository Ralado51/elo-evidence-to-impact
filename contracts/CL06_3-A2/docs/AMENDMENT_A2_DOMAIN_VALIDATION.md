# Amendment A2 (CANDIDATE) — domain validation (contracts 3.2.0)

Status: **candidate, not frozen**. Not declared fully backward-compatible (P-07). Base: A1 (3.1.0) over r1 (3.0.0), both untouched.
Full normative text: `docs/arch/ARQ-03_A2_PROPOSAL.md`; ratification: `docs/arch/ARQ-03_PO_RATIFICATION_RECORD.md`.

Contents: A2-01 `facts.list?include=reviews` (already live); A2-02 `goal-target-rules.v1`; A2-03 optional `goal.payload.deadline`
(civil date; schema copy here); A2-04 instrument derived from `instrument-registry.json`; A2-05 `assessment-item-rules.v1` (R1–R5, R6 dormant);
A2-06 errors reuse existing codes + `details {rule, path}` (no new codes); A2-07 dose unchanged (front guard from `limits.v1`).

Scope: **write-only**. Reads, replay (command_dedup) and legacy records are not revalidated; new versions of legacy records must satisfy current rules (P-08).
Potential incompatibility: strict-schema clients validating goal with `additionalProperties:false` reject payloads carrying `deadline`.
Vectors: `contracts/fixtures/a2-vectors.json` (shared by Python and JS tests).
