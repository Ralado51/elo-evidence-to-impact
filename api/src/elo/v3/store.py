"""SQLite persistence for CL06.3 v3 credentials, hashed tokens/invites, and versioned entities."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

from .authz import CareLinkView, Principal
from .entities import (
    build_entity,
    utc_now_ms,
)
from .errors import to_http_error
from .ledger import EventLedger
from .validation import check_real_data_gate, validate_entity, validate_entity_chain

V3_SCHEMA = """
CREATE TABLE IF NOT EXISTS v3_therapist_credentials (
    therapist_id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    org_id TEXT NOT NULL,
    display_label TEXT NOT NULL,
    kdf TEXT NOT NULL,
    salt_hex TEXT NOT NULL,
    hash_hex TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_tokens (
    token_hash TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_invites (
    invite_hash TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_entities (
    entity_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    version INTEGER NOT NULL,
    org_id TEXT NOT NULL,
    participant_id TEXT,
    hash TEXT NOT NULL,
    prev_hash TEXT,
    data TEXT NOT NULL,
    PRIMARY KEY (entity_id, version)
);
CREATE INDEX IF NOT EXISTS idx_v3_entities_type_participant ON v3_entities (entity_type, participant_id, version);
CREATE TRIGGER IF NOT EXISTS v3_entities_no_update BEFORE UPDATE ON v3_entities
    BEGIN SELECT RAISE(ABORT, 'v3_entities is append-only'); END;
CREATE TRIGGER IF NOT EXISTS v3_entities_no_delete BEFORE DELETE ON v3_entities
    BEGIN SELECT RAISE(ABORT, 'v3_entities is append-only'); END;
"""

SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32


def sha256_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def hash_password_scrypt(password: str) -> tuple[str, str, str]:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_DKLEN)
    return f"scrypt:{SCRYPT_N}:{SCRYPT_R}:{SCRYPT_P}", salt.hex(), dk.hex()


def verify_password_scrypt(password: str, kdf: str, salt_hex: str, hash_hex: str) -> bool:
    parts = kdf.split(":")
    if len(parts) != 4 or parts[0] != "scrypt":
        return False
    n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
    dk = hashlib.scrypt(
        password.encode("utf-8"),
        salt=bytes.fromhex(salt_hex),
        n=n,
        r=r,
        p=p,
        dklen=len(bytes.fromhex(hash_hex)),
    )
    return hmac.compare_digest(dk.hex(), hash_hex)


class V3Store:
    """SQLite store for v3 auth artifacts and CL06.3 versioned entities."""

    def __init__(
        self,
        path: str = ":memory:",
        *,
        data_origin: str = "synthetic_fixture",
        real_data_gate_open: bool = False,
    ) -> None:
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(V3_SCHEMA)
        self.data_origin = data_origin
        self.real_data_gate_open = real_data_gate_open
        self.ledger = EventLedger(self.db, real_data_gate_open=real_data_gate_open)

    # --- CL06.3 append-only event ledger delegation ---
    def append(
        self,
        events,
        *,
        principal: Principal | None = None,
        map_http_codes: bool = False,
    ) -> list[dict[str, Any]]:
        return self.ledger.append(events, principal=principal, map_http_codes=map_http_codes)

    def import_legacy_events(self, events) -> int:
        return self.ledger.import_legacy_events(events)

    def get_stream_events(self, stream_id: str) -> list[dict[str, Any]]:
        return self.ledger.get_stream_events(stream_id)

    def get_all_events(self) -> list[dict[str, Any]]:
        return self.ledger.get_all_events()

    def is_stream_incomplete(self, stream_id: str) -> bool:
        return self.ledger.is_stream_incomplete(stream_id)

    # --- credentials (synthetic seeds only; stdlib scrypt with per-credential salt) ---
    def seed_therapist(
        self,
        *,
        therapist_id: str,
        username: str,
        password: str,
        org_id: str,
        display_label: str = "Synthetic Therapist",
    ) -> dict[str, Any]:
        kdf, salt_hex, hash_hex = hash_password_scrypt(password)
        now = utc_now_ms()
        self.db.execute(
            """INSERT OR REPLACE INTO v3_therapist_credentials
               (therapist_id, username, org_id, display_label, kdf, salt_hex, hash_hex, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (therapist_id, username, org_id, display_label, kdf, salt_hex, hash_hex, now),
        )
        # Also ensure therapist entity v1 exists when data_origin is permitted
        existing = self.get_entity_versions(therapist_id)
        if not existing:
            ent = build_entity(
                entity_type="therapist",
                entity_id=therapist_id,
                version=1,
                prev_hash=None,
                org_id=org_id,
                author_role="therapist",
                author_id=therapist_id,
                data_origin="synthetic_fixture" if check_real_data_gate(self.data_origin, gate_open=self.real_data_gate_open) else self.data_origin,
                payload={"display_label": display_label},
                created_at=now,
            )
            self._validate_and_insert_entity(ent, existing=[])
        self.db.commit()
        return {"therapist_id": therapist_id, "username": username, "org_id": org_id}

    def authenticate_therapist(self, username: str, password: str) -> Principal | None:
        row = self.db.execute(
            "SELECT therapist_id, org_id, kdf, salt_hex, hash_hex FROM v3_therapist_credentials WHERE username=?",
            (username,),
        ).fetchone()
        if row is None:
            return None
        therapist_id, org_id, kdf, salt_hex, hash_hex = row
        if not verify_password_scrypt(password, kdf, salt_hex, hash_hex):
            return None
        return Principal(role="therapist", id=therapist_id, org_id=org_id)

    # --- opaque bearer tokens (>= 128 bits, stored only as sha256) ---
    def issue_token(self, principal: Principal, ttl_seconds: int = 3600) -> tuple[str, str]:
        raw_token = secrets.token_urlsafe(32)  # 256 bits entropy
        token_hash = sha256_token(raw_token)
        now = datetime.now(timezone.utc)
        created_at = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
        exp = now + timedelta(seconds=ttl_seconds)
        expires_at = exp.strftime("%Y-%m-%dT%H:%M:%S.") + f"{exp.microsecond // 1000:03d}Z"
        self.db.execute(
            """INSERT INTO v3_tokens (token_hash, role, principal_id, org_id, expires_at, revoked, created_at)
               VALUES (?,?,?,?,?,0,?)""",
            (token_hash, principal.role, principal.id, principal.org_id, expires_at, created_at),
        )
        self.db.commit()
        return raw_token, expires_at

    def lookup_token(self, raw_token: str) -> Principal | None:
        if not raw_token:
            return None
        token_hash = sha256_token(raw_token)
        row = self.db.execute(
            "SELECT role, principal_id, org_id, expires_at, revoked FROM v3_tokens WHERE token_hash=?",
            (token_hash,),
        ).fetchone()
        if row is None:
            return None
        role, principal_id, org_id, expires_at, revoked = row
        if revoked:
            return None
        if expires_at <= utc_now_ms():
            return None
        return Principal(role=role, id=principal_id, org_id=org_id)

    # --- single-use expiring invites (stored only as sha256) ---
    def create_invite(self, *, participant_id: str, org_id: str, created_by: str, ttl_seconds: int = 3600) -> tuple[str, str]:
        raw_invite = secrets.token_urlsafe(32)  # 256 bits entropy
        invite_hash = sha256_token(raw_invite)
        now = datetime.now(timezone.utc)
        created_at = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
        exp = now + timedelta(seconds=ttl_seconds)
        expires_at = exp.strftime("%Y-%m-%dT%H:%M:%S.") + f"{exp.microsecond // 1000:03d}Z"
        self.db.execute(
            """INSERT INTO v3_invites (invite_hash, participant_id, org_id, created_by, expires_at, used_at, revoked, created_at)
               VALUES (?,?,?,?,?,NULL,0,?)""",
            (invite_hash, participant_id, org_id, created_by, expires_at, created_at),
        )
        self.db.commit()
        return raw_invite, expires_at

    def consume_invite(self, raw_invite: str) -> Principal | None:
        if not raw_invite:
            return None
        invite_hash = sha256_token(raw_invite)
        now = utc_now_ms()
        cur = self.db.execute(
            """UPDATE v3_invites
               SET used_at = ?
               WHERE invite_hash = ? AND used_at IS NULL AND revoked = 0 AND expires_at > ?""",
            (now, invite_hash, now),
        )
        if cur.rowcount != 1:
            self.db.rollback()
            return None
        row = self.db.execute(
            "SELECT participant_id, org_id FROM v3_invites WHERE invite_hash=?",
            (invite_hash,),
        ).fetchone()
        self.db.commit()
        if row is None:
            return None
        return Principal(role="participant", id=row[0], org_id=row[1])

    def revoke_invite_by_hash(self, invite_hash: str) -> None:
        self.db.execute("UPDATE v3_invites SET revoked = 1 WHERE invite_hash = ?", (invite_hash,))
        self.db.commit()

    # --- CL06.3 versioned entities ---
    def _validate_and_insert_entity(self, ent: dict[str, Any], *, existing: list[dict[str, Any]]) -> None:
        ent_errs = validate_entity(ent, gate_open=self.real_data_gate_open)
        if ent_errs:
            raise to_http_error(ent_errs[0], f"Entity validation failed: {', '.join(ent_errs)}", details=ent_errs)

        chain_errs = validate_entity_chain([*existing, ent])
        if chain_errs:
            raise to_http_error(chain_errs[0], f"Entity chain check failed: {', '.join(chain_errs)}", details=chain_errs)

        self.db.execute(
            """INSERT INTO v3_entities (entity_id, entity_type, version, org_id, participant_id, hash, prev_hash, data)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                ent["entity_id"],
                ent["entity_type"],
                ent["version"],
                ent["org_id"],
                ent.get("participant_id"),
                ent["hash"],
                ent["prev_hash"],
                json.dumps(ent, ensure_ascii=False),
            ),
        )

    def save_entities_atomic(self, items: list[tuple[dict[str, Any], list[dict[str, Any]]]]) -> None:
        try:
            for ent, existing in items:
                self._validate_and_insert_entity(ent, existing=existing)
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def get_entity_versions(self, entity_id: str) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT data FROM v3_entities WHERE entity_id=? ORDER BY version ASC",
            (entity_id,),
        ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def get_latest_entity(self, entity_id: str, entity_type: str | None = None) -> dict[str, Any] | None:
        if entity_type is not None:
            row = self.db.execute(
                "SELECT data FROM v3_entities WHERE entity_id=? AND entity_type=? ORDER BY version DESC LIMIT 1",
                (entity_id, entity_type),
            ).fetchone()
        else:
            row = self.db.execute(
                "SELECT data FROM v3_entities WHERE entity_id=? ORDER BY version DESC LIMIT 1",
                (entity_id,),
            ).fetchone()
        return json.loads(row[0]) if row else None

    def latest_care_links(self, participant_id: str | None = None) -> list[CareLinkView]:
        """Return the latest version of every care_link (optionally filtered by participant_id)."""
        if participant_id is not None:
            rows = self.db.execute(
                """SELECT e.data FROM v3_entities e
                   INNER JOIN (
                       SELECT entity_id, MAX(version) AS max_v
                       FROM v3_entities
                       WHERE entity_type = 'care_link' AND participant_id = ?
                       GROUP BY entity_id
                   ) latest ON e.entity_id = latest.entity_id AND e.version = latest.max_v""",
                (participant_id,),
            ).fetchall()
        else:
            rows = self.db.execute(
                """SELECT e.data FROM v3_entities e
                   INNER JOIN (
                       SELECT entity_id, MAX(version) AS max_v
                       FROM v3_entities
                       WHERE entity_type = 'care_link'
                       GROUP BY entity_id
                   ) latest ON e.entity_id = latest.entity_id AND e.version = latest.max_v"""
            ).fetchall()
        views: list[CareLinkView] = []
        for (raw,) in rows:
            ent = json.loads(raw)
            p = ent["payload"]
            views.append(
                CareLinkView(
                    entity_id=ent["entity_id"],
                    org_id=ent["org_id"],
                    participant_id=ent["participant_id"],
                    therapist_id=p["therapist_id"],
                    status=p["status"],
                    valid_from=p["valid_from"],
                    valid_to=p["valid_to"],
                )
            )
        return views

    def care_links_for_participant(self, participant_id: str) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT data FROM v3_entities WHERE entity_type='care_link' AND participant_id=? ORDER BY entity_id, version",
            (participant_id,),
        ).fetchall()
        return [json.loads(r[0]) for r in rows]
