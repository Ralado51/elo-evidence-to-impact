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
- `tests/`: critical cases, including the clinic-versus-home case, change over time (not a contradiction), reports versus direct observation, and conflicting observations.

## Rules the tests lock in

- Observed in the clinic does not support a claim about home.
- Change between sessions is not a contradiction; only a conflict on the same day and setting is.
- A report alone, or a report that disagrees with a direct observation, goes to human review.
- A valid span proves the passage exists, not that it supports the claim.
