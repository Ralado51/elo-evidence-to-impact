"""CL06.3 v3 append-only hash-chained event ledger (SQLite).

Implements D-S0-04-1 and D-S0-04-2:
- Append-only SQLite table ``v3_events`` with BEFORE UPDATE / BEFORE DELETE abort triggers.
- Every v3 append invokes S0-03 ``validate_event``, ``consent_state``, ``require_consent``,
  and ``check_session_stream`` without duplicating any CL06.3 reference logic.
- Per-item results: ``{event_id, status: stored|duplicate|rejected, codes: [...]}``.
- Standard library only plus internal ``elo`` modules.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Sequence
from typing import Any

from elo.canonical import canonicalize, check_event_integrity
from elo.v3.authz import Principal
from elo.v3.entities import load_event_catalog
from elo.v3.errors import V3Error, map_validation_code, to_http_error
from elo.v3.session_rules import (
    SESSION_RULE_ERROR_CODES,
    SESSION_RULE_WARNING_CODES,
    evaluate_session_stream,
)
from elo.v3.validation import check_session_stream, consent_state, require_consent, validate_event

LEDGER_SCHEMA = """
CREATE TABLE IF NOT EXISTS v3_events (
    event_id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    type TEXT NOT NULL,
    org_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    prev_hash TEXT,
    data TEXT NOT NULL,
    UNIQUE (stream_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_v3_events_stream_seq ON v3_events (stream_id, seq);
CREATE INDEX IF NOT EXISTS idx_v3_events_participant_type ON v3_events (participant_id, type, seq);
CREATE TRIGGER IF NOT EXISTS v3_events_no_update BEFORE UPDATE ON v3_events
    BEGIN SELECT RAISE(ABORT, 'v3_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS v3_events_no_delete BEFORE DELETE ON v3_events
    BEGIN SELECT RAISE(ABORT, 'v3_events is append-only'); END;
CREATE TABLE IF NOT EXISTS v3_stream_state (
    stream_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    incomplete INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS v3_prescription_streams (
    participant_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    prescription_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (participant_id, exercise_id)
);
"""

_WARNING_INFO_CODES = frozenset({"SEQ_GAP", "DUPLICATE", "CLOCK_REGRESSION"})


class EventLedger:
    """Append-only hash-chained CL06.3 event ledger backed by SQLite."""

    def __init__(
        self,
        db: sqlite3.Connection,
        *,
        real_data_gate_open: bool = False,
        lock: threading.RLock | None = None,
    ) -> None:
        self.db = db
        self.real_data_gate_open = real_data_gate_open
        self._lock = lock if lock is not None else threading.RLock()
        with self._lock:
            self.db.executescript(LEDGER_SCHEMA)

    def get_stream_events(self, stream_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.db.execute(
                "SELECT data FROM v3_events WHERE stream_id = ? ORDER BY seq ASC",
                (stream_id,),
            ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def get_all_events(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.db.execute(
                "SELECT data FROM v3_events ORDER BY stream_id ASC, seq ASC"
            ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def is_stream_incomplete(self, stream_id: str) -> bool:
        with self._lock:
            row = self.db.execute(
                "SELECT incomplete FROM v3_stream_state WHERE stream_id = ?",
                (stream_id,),
            ).fetchone()
        return bool(row and row[0])

    def _stream_schema_version(self, stream_id: str) -> int | None:
        with self._lock:
            row = self.db.execute(
                "SELECT schema_version FROM v3_stream_state WHERE stream_id = ?",
                (stream_id,),
            ).fetchone()
            if row is not None:
                return int(row[0])
            ev_row = self.db.execute(
                "SELECT schema_version FROM v3_events WHERE stream_id = ? LIMIT 1",
                (stream_id,),
            ).fetchone()
        return int(ev_row[0]) if ev_row is not None else None

    def get_consent_events(self, participant_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.db.execute(
                """SELECT data FROM v3_events
                   WHERE participant_id = ? AND type IN ('consent.accepted', 'consent.revoked')
                   ORDER BY seq ASC""",
                (participant_id,),
            ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def get_prescription(
        self,
        prescription_id: str,
        revision: int,
        *,
        org_id: str | None = None,
        participant_id: str | None = None,
    ) -> dict[str, Any] | None:
        with self._lock:
            row = self.db.execute(
                """SELECT data FROM v3_events
                   WHERE stream_id = ? AND seq = ? AND type = 'prescription.published'""",
                (f"prescription:{prescription_id}", revision),
            ).fetchone()
        if row is None:
            return None
        ent = json.loads(row[0])
        if org_id is not None and ent.get("scope", {}).get("org_id") != org_id:
            return None
        if participant_id is not None and ent.get("scope", {}).get("participant_id") != participant_id:
            return None
        return ent

    def list_prescriptions(self, participant_id: str) -> list[dict[str, Any]]:
        """Return all published prescription events for ``participant_id`` ordered by (stream_id, seq)."""
        with self._lock:
            rows = self.db.execute(
                """SELECT data FROM v3_events
                   WHERE participant_id = ? AND type = 'prescription.published'
                   ORDER BY stream_id ASC, seq ASC""",
                (participant_id,),
            ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def get_latest_prescription_for_exercise(
        self,
        participant_id: str,
        exercise_id: str,
    ) -> dict[str, Any] | None:
        """Return the latest published prescription event for ``(participant_id, exercise_id)``."""
        events = [
            ev
            for ev in self.list_prescriptions(participant_id)
            if ev.get("payload", {}).get("exercise_id") == exercise_id
        ]
        if not events:
            return None
        events.sort(key=lambda ev: (ev["seq"], ev["occurred_at"], ev["stream_id"]))
        return events[-1]

    def get_current_prescription(self, participant_id: str) -> dict[str, Any] | None:
        """Return the latest published prescription event for ``participant_id``, or None."""
        events = self.list_prescriptions(participant_id)
        if not events:
            return None
        latest_by_stream: dict[str, dict[str, Any]] = {}
        for ev in events:
            sid = ev["stream_id"]
            if sid not in latest_by_stream or ev["seq"] > latest_by_stream[sid]["seq"]:
                latest_by_stream[sid] = ev
        candidates = list(latest_by_stream.values())
        candidates.sort(key=lambda ev: (ev["occurred_at"], ev["seq"], ev["stream_id"]))
        return candidates[-1]

    def insert_prescription_revision(self, event: dict[str, Any], *, is_new_stream: bool) -> None:
        """Atomically append one server-authored ``prescription.published`` event (D-S1a-04-1).

        Enforces one prescription stream per ``(participant_id, exercise_id)`` via
        ``v3_prescription_streams`` and immutable contiguous revisions via
        ``UNIQUE (stream_id, seq)`` on ``v3_events``. Any concurrent losing writer
        hitting a uniqueness conflict rolls back and receives ``409 CONFLICT_IMMUTABLE``.
        """
        errs = validate_event(event, gate_open=self.real_data_gate_open)
        if errs:
            code = "LIMITS_EXCEEDED" if "LIMITS_EXCEEDED" in errs else errs[0]
            raise to_http_error(code, f"Prescription event validation failed: {', '.join(errs)}", details=errs)

        scope = event["scope"]
        payload = event["payload"]
        stream_id = event["stream_id"]
        seq = int(event["seq"])
        participant_id = scope["participant_id"]
        exercise_id = payload["exercise_id"]
        prescription_id = payload["prescription_id"]
        canonical_json = canonicalize(event)

        with self._lock:
            try:
                if not self.db.in_transaction:
                    self.db.execute("BEGIN IMMEDIATE")
                if is_new_stream:
                    self.db.execute(
                        """INSERT INTO v3_prescription_streams (participant_id, exercise_id, prescription_id)
                           VALUES (?, ?, ?)""",
                        (participant_id, exercise_id, prescription_id),
                    )
                else:
                    self.db.execute(
                        """INSERT OR IGNORE INTO v3_prescription_streams (participant_id, exercise_id, prescription_id)
                           VALUES (?, ?, ?)""",
                        (participant_id, exercise_id, prescription_id),
                    )
                self.db.execute(
                    """INSERT INTO v3_events
                       (event_id, stream_id, seq, schema_version, type, org_id, participant_id, hash, prev_hash, data)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (
                        event["event_id"],
                        stream_id,
                        seq,
                        int(event["schema_version"]),
                        event["type"],
                        scope["org_id"],
                        participant_id,
                        event["hash"],
                        event["prev_hash"],
                        canonical_json,
                    ),
                )
                self.db.execute(
                    """INSERT INTO v3_stream_state (stream_id, schema_version, incomplete)
                       VALUES (?, ?, 0)
                       ON CONFLICT(stream_id) DO NOTHING""",
                    (stream_id, int(event["schema_version"])),
                )
                self.db.commit()
            except sqlite3.IntegrityError as exc:
                self.db.rollback()
                raise V3Error(
                    "CONFLICT_IMMUTABLE",
                    f"Concurrent or conflicting publish for prescription stream {stream_id!r} revision {seq}.",
                ) from exc
            except Exception:
                self.db.rollback()
                raise

    def import_legacy_events(self, events: Sequence[dict[str, Any]]) -> int:
        """Store-level import of read-only CL06.1 (schema_version 2) legacy events."""
        with self._lock:
            count = 0
            try:
                for ev in events:
                    if not isinstance(ev, dict) or ev.get("schema_version") != 2:
                        raise ValueError("import_legacy_events accepts schema_version == 2 events only")
                    errs = check_event_integrity(ev)
                    if errs:
                        raise ValueError(f"Legacy event failed integrity check: {errs}")
                    stream_id = ev["stream_id"]
                    seq = ev["seq"]
                    scope = ev["scope"]
                    canonical_json = canonicalize(ev)
                    self.db.execute(
                        """INSERT INTO v3_events
                           (event_id, stream_id, seq, schema_version, type, org_id, participant_id, hash, prev_hash, data)
                           VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (
                            ev["event_id"],
                            stream_id,
                            seq,
                            2,
                            ev["type"],
                            scope["org_id"],
                            scope["participant_id"],
                            ev["hash"],
                            ev["prev_hash"],
                            canonical_json,
                        ),
                    )
                    self.db.execute(
                        """INSERT INTO v3_stream_state (stream_id, schema_version, incomplete)
                           VALUES (?, 2, 0)
                           ON CONFLICT(stream_id) DO NOTHING""",
                        (stream_id,),
                    )
                    count += 1
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise
            return count

    def append(
        self,
        events: Sequence[dict[str, Any]],
        *,
        principal: Principal | None = None,
        map_http_codes: bool = False,
    ) -> list[dict[str, Any]]:
        """Validate and append events in order, returning per-item results (D-S0-04-1, D-S0-04-2)."""
        with self._lock:
            try:
                return self._append_locked(events, principal=principal, map_http_codes=map_http_codes)
            except Exception:
                self.db.rollback()
                raise

    def _append_locked(
        self,
        events: Sequence[dict[str, Any]],
        *,
        principal: Principal | None = None,
        map_http_codes: bool = False,
    ) -> list[dict[str, Any]]:
        cat = load_event_catalog()
        results: list[dict[str, Any]] = []
        rejected_streams: set[str] = set()

        for ev in events:
            ev_id = ev.get("event_id") if isinstance(ev, dict) and isinstance(ev.get("event_id"), str) else ""
            codes: set[str] = set()

            # 1. Unified S0-03 validation layer (schema + integrity + stateless semantics + real-data gate)
            codes.update(validate_event(ev, gate_open=self.real_data_gate_open))

            is_dict = isinstance(ev, dict)
            ev_type = ev.get("type") if is_dict and isinstance(ev.get("type"), str) else None
            stream_id = ev.get("stream_id") if is_dict and isinstance(ev.get("stream_id"), str) else None
            seq_raw = ev.get("seq") if is_dict else None
            seq = seq_raw if isinstance(seq_raw, int) and not isinstance(seq_raw, bool) else None
            ev_hash = ev.get("hash") if is_dict and isinstance(ev.get("hash"), str) else None
            prev_hash = ev.get("prev_hash") if is_dict else None
            actor = ev.get("actor") if is_dict and isinstance(ev.get("actor"), dict) else None
            scope = ev.get("scope") if is_dict and isinstance(ev.get("scope"), dict) else None
            type_meta = cat["types"].get(ev_type) if ev_type is not None else None

            # 2. Client-authored types only (when called with an API participant principal)
            if principal is not None:
                if type_meta is not None and type_meta["authored"] != "client":
                    codes.add("FORBIDDEN")

                # 3. Actor = principal & scope belongs to principal (D-S0-04-2(a): only check present inputs)
                if actor is not None:
                    if isinstance(actor.get("role"), str) and actor["role"] != "participant":
                        codes.add("SCOPE_VIOLATION")
                    if isinstance(actor.get("id"), str) and actor["id"] != principal.id:
                        codes.add("SCOPE_VIOLATION")
                if scope is not None:
                    if isinstance(scope.get("participant_id"), str) and scope["participant_id"] != principal.id:
                        codes.add("SCOPE_VIOLATION")
                    if isinstance(scope.get("org_id"), str) and scope["org_id"] != principal.org_id:
                        codes.add("SCOPE_VIOLATION")

            # 4. Legacy v2 stream read-only check
            if stream_id is not None and self._stream_schema_version(stream_id) == 2:
                codes.add("LEGACY_STREAM_READ_ONLY")

            # 5. Same-batch rejected stream poison (D-S0-04-2(b)) & store integrity checks
            poisoned = stream_id is not None and stream_id in rejected_streams
            if poisoned:
                codes.add("CHAIN_BROKEN")

            existing_row = None
            if stream_id is not None and seq is not None:
                existing_row = self.db.execute(
                    "SELECT event_id, hash FROM v3_events WHERE stream_id = ? AND seq = ?",
                    (stream_id, seq),
                ).fetchone()
            if existing_row is None and ev_id:
                existing_row = self.db.execute(
                    "SELECT event_id, hash FROM v3_events WHERE event_id = ?",
                    (ev_id,),
                ).fetchone()

            if existing_row is not None:
                if ev_hash is not None and ev_id:
                    existing_id, existing_hash = existing_row
                    if existing_id == ev_id and existing_hash == ev_hash:
                        if not poisoned:
                            codes.add("DUPLICATE")
                    else:
                        codes.add("HASH_CONFLICT")
            elif stream_id is not None and seq is not None and not poisoned:
                if seq > 1:
                    prev_row = self.db.execute(
                        "SELECT hash FROM v3_events WHERE stream_id = ? AND seq = ?",
                        (stream_id, seq - 1),
                    ).fetchone()
                    if prev_row is not None:
                        if is_dict and "prev_hash" in ev and prev_hash != prev_row[0]:
                            codes.add("CHAIN_BROKEN")
                    else:
                        codes.add("SEQ_GAP")
                if ev_hash is not None:
                    next_row = self.db.execute(
                        "SELECT prev_hash FROM v3_events WHERE stream_id = ? AND seq = ?",
                        (stream_id, seq + 1),
                    ).fetchone()
                    if next_row is not None and next_row[0] != ev_hash:
                        codes.add("CHAIN_BROKEN")

            # 6. Consent check via S0-03 require_consent (stored consent stream + earlier stored items in batch)
            if is_dict and scope is not None and isinstance(scope.get("participant_id"), str):
                active_scopes = consent_state(self.get_consent_events(scope["participant_id"]))
                codes.update(require_consent(active_scopes, ev))

            # 7. Prescription presence and session-stream rules (D-S0-04-2(a), S1b-01)
            if type_meta is not None and type_meta["stream"] == "session" and scope is not None:
                rx_id = scope.get("prescription_id")
                rx_rev = scope.get("prescription_revision")
                sc_org = scope.get("org_id")
                sc_pid = scope.get("participant_id")
                rx_event = None
                if (
                    isinstance(rx_id, str)
                    and isinstance(rx_rev, int)
                    and not isinstance(rx_rev, bool)
                    and isinstance(sc_org, str)
                    and isinstance(sc_pid, str)
                ):
                    rx_event = self.get_prescription(
                        rx_id,
                        rx_rev,
                        org_id=sc_org,
                        participant_id=sc_pid,
                    )
                    if rx_event is None:
                        codes.add("PRESCRIPTION_NOT_FOUND")
                    elif stream_id is not None:
                        try:
                            stored_session = self.get_stream_events(stream_id)
                            codes.update(check_session_stream([*stored_session, ev], rx_event["payload"]))
                        except Exception:
                            pass

                # Apply stateful session-phase and stream-ordering rules (S1b-01, PO-F26)
                # Skip on already-stored duplicate/conflict rows; require minimal event structure.
                if (
                    existing_row is None
                    and stream_id is not None
                    and seq is not None
                    and ev_hash is not None
                    and isinstance(ev.get("source"), dict)
                    and isinstance(ev.get("payload"), dict)
                    and isinstance(ev.get("occurred_at"), str)
                ):
                    stored_session = self.get_stream_events(stream_id)
                    rx_payload = rx_event["payload"] if rx_event is not None else None
                    report = evaluate_session_stream([*stored_session, ev], rx_payload)
                    for code in report.per_event_errors.get(seq, ()):
                        if code in SESSION_RULE_ERROR_CODES:
                            codes.add(code)
                    for code in report.per_event_warnings.get(seq, ()):
                        if code in SESSION_RULE_WARNING_CODES:
                            codes.add(code)

            # Map internal ONEOF -> RULE_VIOLATION on HTTP surface per D-S0-03-4
            if map_http_codes and "ONEOF" in codes:
                mapped_code, _, _ = map_validation_code("ONEOF")
                codes.discard("ONEOF")
                codes.add(mapped_code)

            # 8. Status decision (D-S0-04-2(a))
            non_warning = codes - _WARNING_INFO_CODES
            if non_warning:
                status = "rejected"
                if stream_id is not None:
                    rejected_streams.add(stream_id)
            elif codes == {"DUPLICATE"}:
                status = "duplicate"
            else:
                status = "stored"
                assert is_dict and stream_id is not None and seq is not None
                assert scope is not None and ev_type is not None and ev_hash is not None
                canonical_json = canonicalize(ev)
                self.db.execute(
                    """INSERT INTO v3_events
                       (event_id, stream_id, seq, schema_version, type, org_id, participant_id, hash, prev_hash, data)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (
                        ev_id,
                        stream_id,
                        seq,
                        int(ev["schema_version"]),
                        ev_type,
                        scope["org_id"],
                        scope["participant_id"],
                        ev_hash,
                        prev_hash,
                        canonical_json,
                    ),
                )
                incomplete_flag = 1 if "SEQ_GAP" in codes else 0
                self.db.execute(
                    """INSERT INTO v3_stream_state (stream_id, schema_version, incomplete)
                       VALUES (?, ?, ?)
                       ON CONFLICT(stream_id) DO UPDATE SET incomplete = MAX(incomplete, excluded.incomplete)""",
                    (stream_id, int(ev["schema_version"]), incomplete_flag),
                )
                self.db.commit()

            results.append({"event_id": ev_id, "status": status, "codes": sorted(codes)})

        return results
