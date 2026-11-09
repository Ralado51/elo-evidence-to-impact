"""Local persistence (SQLite) and human review with an append-only audit trail.

Rules:
* A claim is born ``pending`` with the verdict the verifier gave it.
* Approve is allowed ONLY when the verdict is ``supported``. Anything else must be edited
  (to what the evidence shows) or rejected, so "not observed" never becomes "achieved".
* Edit changes the claim and re-runs the verifier. If it is now ``supported`` the claim counts
  as approved-with-edits (``edited``); otherwise it stays ``pending``.
* Only ``pending`` claims can be reviewed. Approved/edited/rejected claims are final.
* Every action is logged (actor, time, before, after, verdict). The log cannot be updated
  or deleted (SQLite triggers).
* Downstream outputs read ``approved_claims()`` only.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

from .contract import Claim, Note, Observation, ReviewState, Verdict, VerdictResult
from .verifier import verify

SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (id TEXT, version INTEGER, session_id TEXT, data TEXT, PRIMARY KEY (id, version));
CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, session_id TEXT, state TEXT, data TEXT, verdict TEXT);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, claim_id TEXT NOT NULL, action TEXT NOT NULL,
  actor TEXT NOT NULL, reason TEXT, before TEXT, after TEXT, verdict TEXT);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
"""


class ReviewError(Exception):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class ReviewService:
    def __init__(self, path: str = ":memory:") -> None:
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)

    # --- storage ---------------------------------------------------------------------
    def save_note(self, note: Note) -> None:
        self.db.execute("INSERT INTO notes VALUES (?,?,?,?)", (note.id, note.version, note.session_id, note.model_dump_json()))
        self.db.commit()

    def save_observations(self, session_id: str, observations: list[Observation]) -> None:
        for o in observations:
            self.db.execute("INSERT OR REPLACE INTO observations VALUES (?,?,?)", (o.id, session_id, o.model_dump_json()))
        self.db.commit()

    def observations(self, session_id: str) -> list[Observation]:
        rows = self.db.execute("SELECT data FROM observations WHERE session_id=?", (session_id,)).fetchall()
        return [Observation.model_validate_json(r[0]) for r in rows]

    def _save_claim(self, claim: Claim, result: VerdictResult) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO claims VALUES (?,?,?,?,?)",
            (claim.id, claim.session_id, claim.review_state.value, claim.model_dump_json(), result.model_dump_json()),
        )

    def _log(self, claim_id: str, action: str, actor: str, reason: str | None, before, after, verdict: str) -> None:
        self.db.execute(
            "INSERT INTO audit (at, claim_id, action, actor, reason, before, after, verdict) VALUES (?,?,?,?,?,?,?,?)",
            (_now(), claim_id, action, actor, reason, before, after, verdict),
        )

    def get(self, claim_id: str) -> tuple[Claim, VerdictResult]:
        row = self.db.execute("SELECT data, verdict FROM claims WHERE id=?", (claim_id,)).fetchone()
        if row is None:
            raise ReviewError("unknown claim")
        return Claim.model_validate_json(row[0]), VerdictResult.model_validate_json(row[1])

    def audit(self, claim_id: str | None = None) -> list[dict]:
        q, args = "SELECT seq, at, claim_id, action, actor, reason, before, after, verdict FROM audit", ()
        if claim_id:
            q, args = q + " WHERE claim_id=?", (claim_id,)
        cols = ["seq", "at", "claim_id", "action", "actor", "reason", "before", "after", "verdict"]
        return [dict(zip(cols, r)) for r in self.db.execute(q + " ORDER BY seq", args).fetchall()]

    # --- flow ------------------------------------------------------------------------
    def propose(self, claim: Claim, actor: str = "system") -> VerdictResult:
        result = verify(claim, self.observations(claim.session_id))
        claim = claim.model_copy(update={"review_state": ReviewState.PENDING})
        self._save_claim(claim, result)
        self._log(claim.id, "proposed", actor, None, None, claim.model_dump_json(), result.verdict.value)
        self.db.commit()
        return result

    def _pending(self, claim_id: str, actor: str) -> tuple[Claim, VerdictResult]:
        if not actor or not actor.strip():
            raise ReviewError("a named reviewer is required")
        claim, result = self.get(claim_id)
        if claim.review_state is not ReviewState.PENDING:
            raise ReviewError(f"claim is already {claim.review_state.value} and is final")
        return claim, result

    def approve(self, claim_id: str, actor: str, reason: str | None = None) -> Claim:
        claim, result = self._pending(claim_id, actor)
        if result.verdict is not Verdict.SUPPORTED:
            raise ReviewError(
                f"cannot approve a claim whose verdict is {result.verdict.value}; edit it to match the evidence or reject it"
            )
        new = claim.model_copy(update={"review_state": ReviewState.APPROVED})
        self._save_claim(new, result)
        self._log(claim_id, "approved", actor, reason, claim.model_dump_json(), new.model_dump_json(), result.verdict.value)
        self.db.commit()
        return new

    def reject(self, claim_id: str, actor: str, reason: str) -> Claim:
        claim, result = self._pending(claim_id, actor)
        if not reason or not reason.strip():
            raise ReviewError("a reason is required to reject")
        new = claim.model_copy(update={"review_state": ReviewState.REJECTED})
        self._save_claim(new, result)
        self._log(claim_id, "rejected", actor, reason, claim.model_dump_json(), new.model_dump_json(), result.verdict.value)
        self.db.commit()
        return new

    def edit(self, claim_id: str, actor: str, reason: str | None = None, **changes) -> tuple[Claim, VerdictResult]:
        claim, _ = self._pending(claim_id, actor)
        allowed = {"text", "activity", "environment", "assistance", "as_of"}
        if not set(changes) <= allowed:
            raise ReviewError("only text, activity, environment, assistance and as_of can be edited")
        edited = Claim.model_validate({**claim.model_dump(), **changes, "origin": "human"})
        result = verify(edited, self.observations(claim.session_id))
        state = ReviewState.EDITED if result.verdict is Verdict.SUPPORTED else ReviewState.PENDING
        edited = edited.model_copy(update={"review_state": state})
        self._save_claim(edited, result)
        self._log(claim_id, "edited", actor, reason, claim.model_dump_json(), edited.model_dump_json(), result.verdict.value)
        self.db.commit()
        return edited, result

    def approved_claims(self, session_id: str) -> list[Claim]:
        rows = self.db.execute(
            "SELECT data FROM claims WHERE session_id=? AND state IN ('approved','edited')", (session_id,)
        ).fetchall()
        return [Claim.model_validate_json(r[0]) for r in rows]
