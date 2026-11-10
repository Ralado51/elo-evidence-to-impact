# api

Evidence data contract and the Context-Aware Evidence Verifier. Synthetic data only.

## Run the tests

```bash
cd api
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
pytest
```

## What is here

- `src/elo/contract.py`: `Note`, `Observation` (with source passage, who observed or reported it, note version and offsets), `Claim`, `VerdictResult`. Four verdicts: `supported`, `contradicted`, `insufficient_evidence`, `needs_review`.
- `src/elo/verifier.py`: deterministic verifier, independent of any language model. It compares activity, setting, level of assistance, source of evidence and time, and always explains the verdict in Portuguese and English.
- `src/elo/privacy.py`: Privacy Gate. Local registry, pseudonyms, fail-closed detectors (CPF, RG, phone, e-mail, postal code, address, birth date, handles, titles and relatives followed by a name) and an offset map between original and sanitized text. Only `SanitizedText` issued by the gate should reach a model.
- `tests/`: critical cases, including the clinic-versus-home case, change over time (not a contradiction), reports versus direct observation, and conflicting observations.

## Rules the tests lock in

- Observed in the clinic does not support a claim about home.
- Change between sessions is not a contradiction; only a conflict on the same day and setting is.
- A report alone, or a report that disagrees with a direct observation, goes to human review.
- A valid span proves the passage exists, not that it supports the claim.

## Privacy Gate: what it does and does not do

- Registered names, aliases and name parts are replaced by pseudonyms, ignoring case and accents, whole words only.
- Unregistered identifiers block the text (`PrivacyBlocked`); the error never contains the matched text.
- Offsets: a span in the sanitized text maps back to the original text, and a partial overlap with a pseudonym expands to the whole name.
- **Known limit:** an unregistered name written without a title, relation word or pattern is not detected. This is risk mitigation, not infallible anonymization, and one reason the project uses synthetic data only.

## Review (`review.py`)

Local SQLite persistence plus human review. A claim is approved only if the verifier says
`supported`; otherwise the reviewer edits it (it is re-verified) or rejects it with a reason.
Final states cannot change. Every action goes to an append-only audit log (SQLite triggers
block UPDATE/DELETE). Downstream outputs (family summary) read `approved_claims()` only.

## Family summary (`summary.py`)

Controlled pt/en templates over approved claims only. Lines are built from structured fields
(never the claim's free text); gaps say neutrally where nothing is recorded yet; a fixed note
states it is not a diagnosis or a progress assessment.

## Goals and assisted check (`goals.py`)

A goal states occupation, setting, target level of assistance, measure, baseline and review date.
`check_goal` lines up the evidence (direct vs reported, per setting and date, with the exact
passage), the verifier's verdict, gaps, staleness and the review date. It never rates progress,
computes GAS, predicts or recommends; the therapist records the conclusion and the GAS rating
(`ReviewService.record_goal_assessment`, audited, named reviewer required).
