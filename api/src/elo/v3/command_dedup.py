"""CMP-08 CommandDedupStore — transactional command idempotency (PD-02, A1 / contracts 3.1.0).

Single owner of: ``Idempotency-Key`` syntax, the request fingerprint, the dedup registry and its retention.
It reuses what already exists and adds nothing parallel: the fingerprint uses ``elo.canonical`` (no second
canonicalizer), the registry lives in the same SQLite store and transaction as the effect (``V3Store.command_tx``),
authorization is the existing ``authorize()`` engine, and no ledger/verifier is touched.

What is stored is a *reference* to an immutable result (entity id + version, event id, ...) — never the request
body, never the response body, never clinical content or secrets (Q1, req. 6). Only successful commands are
recorded (Q3). The key is the identity of the intention; the fingerprint only detects key misuse (req. 5).
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sqlite3
import time
from collections.abc import Mapping
from typing import Any

from elo.canonical import hash_canonical

from .errors import V3Error

HEADER = "Idempotency-Key"
REPLAYED_HEADER = "Idempotency-Replayed"
RETENTION_HEADER = "Idempotency-Retention-Days"
RETENTION_ENV = "ELO_V3_IDEMPOTENCY_RETENTION_DAYS"
DEFAULT_RETENTION_DAYS = 7
MIN_RETENTION_DAYS, MAX_RETENTION_DAYS = 1, 90
_DAY_MS = 86_400_000
_UUID4_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

log = logging.getLogger("elo.v3.command")


def _now_ms() -> int:  # module-level so tests can inject a clock
    return int(time.time() * 1000)


def resolve_retention_days(env: Mapping[str, str] | None = None) -> int:
    """Effective retention in days; invalid configuration fails at startup (never silently clamped)."""
    raw = (os.environ if env is None else env).get(RETENTION_ENV)
    if raw is None:
        return DEFAULT_RETENTION_DAYS
    if not re.fullmatch(r"[0-9]+", raw.strip() or "x"):
        raise ValueError(f"{RETENTION_ENV} must be an integer between {MIN_RETENTION_DAYS} and {MAX_RETENTION_DAYS}.")
    days = int(raw)
    if not MIN_RETENTION_DAYS <= days <= MAX_RETENTION_DAYS:
        raise ValueError(f"{RETENTION_ENV} must be between {MIN_RETENTION_DAYS} and {MAX_RETENTION_DAYS} days.")
    return days


def parse_idempotency_header(header_values: list[str]) -> str | None:
    """``None`` when absent; the canonical UUID v4 when valid; ``IDEMPOTENCY_KEY_INVALID`` otherwise.

    Several header lines, comma lists, blanks, upper-case or non-v4 values are all invalid.
    """
    if not header_values:
        return None
    if len(header_values) != 1 or not _UUID4_RE.fullmatch(header_values[0]):
        raise V3Error("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key must be a single canonical lower-case UUID v4.")
    return header_values[0]


def fingerprint(operation_id: str, resource_key: str, body: Any) -> str:
    """sha256 over the canonical form of {v, op, resource, body}. Detects misuse only; never an identity."""
    return hash_canonical({"v": 1, "op": operation_id, "resource": resource_key, "body": body})


def key_ref(key: str) -> str:
    """Short, non-reversible reference for diagnostics (the key itself is never logged)."""
    return hashlib.sha256(key.encode()).hexdigest()[:8]


class CommandDedupStore:
    def __init__(self, db: Any, *, lock: Any, retention_days: int = DEFAULT_RETENTION_DAYS) -> None:
        self.db = db
        self._lock = lock  # the store's transaction lock: a read must never observe another thread's open tx
        self.retention_days = retention_days

    @staticmethod
    def scope(principal: Any, operation_id: str, resource_key: str) -> tuple[str, str, str, str]:
        return (principal.org_id, principal.id, operation_id, resource_key)

    def sweep(self, now: int | None = None) -> None:
        """Delete expired registry rows. Touches ONLY ``v3_command_dedup`` (clinical retention is untouched)."""
        self.db.execute("DELETE FROM v3_command_dedup WHERE expires_at <= ?", (now if now is not None else _now_ms(),))

    def lookup(self, scope: tuple[str, str, str, str], key: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.db.execute(
                "SELECT fingerprint, status_code, result_ref, expires_at FROM v3_command_dedup "
                "WHERE org_id = ? AND principal_id = ? AND operation_id = ? AND resource_key = ? AND idem_key = ?",
                (*scope, key),
            ).fetchone()
        if row is None or row[3] <= _now_ms():  # expired == unknown
            return None
        return {"fingerprint": row[0], "status": row[1], "ref": json.loads(row[2])}

    def record(self, scope: tuple[str, str, str, str], key: str, fp: str, status: int, ref: Mapping[str, Any]) -> None:
        """Insert in the caller's (command) transaction. ``expires_at`` is fixed here, at creation."""
        now = _now_ms()
        self.sweep(now)
        try:
            self.db.execute(
                "INSERT INTO v3_command_dedup (org_id, principal_id, operation_id, resource_key, idem_key, fingerprint, "
                "status_code, result_ref, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (*scope, key, fp, status, json.dumps(dict(ref), separators=(",", ":"), sort_keys=True), now, now + self.retention_days * _DAY_MS),
            )
        except sqlite3.IntegrityError as exc:  # lost a race on the unique index: caller rolls back and re-reads
            raise V3Error("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was concurrently used for a different request.") from exc
