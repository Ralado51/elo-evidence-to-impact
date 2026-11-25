"""CL06.3 v3 authentication service: bearer token extraction, therapist login, invite redemption."""

from __future__ import annotations

import json
import os

from fastapi import Request

from .authz import ALLOWED_ROLES, Principal
from .entities import new_id
from .errors import V3Error
from .store import V3Store


class AuthService:
    """Server-derived principal authentication over opaque SHA-256 hashed tokens and invites."""

    def __init__(self, store: V3Store) -> None:
        self.store = store
        self._load_env_seeds()

    def _load_env_seeds(self) -> None:
        raw = os.environ.get("ELO_V3_THERAPIST_SEEDS", "").strip()
        if not raw:
            return
        seeds = json.loads(raw)
        if not isinstance(seeds, list):
            raise ValueError("ELO_V3_THERAPIST_SEEDS must be a JSON array")
        for item in seeds:
            self.store.seed_therapist(
                therapist_id=item.get("therapist_id") or new_id("t"),
                username=item["username"],
                password=item["password"],
                org_id=item.get("org_id") or new_id("o"),
                display_label=item.get("display_label", "Synthetic Therapist"),
            )

    def require_principal(self, request: Request) -> Principal:
        """Extract and validate ``Authorization: Bearer <opaque>``.

        - Missing/malformed/unknown/expired/revoked token -> 401 UNAUTHENTICATED.
        - Stored role outside {"participant", "therapist"} -> 403 ROLE_NOT_ALLOWED (PD-08).
        """
        auth_header = request.headers.get("authorization")
        if not auth_header:
            raise V3Error("UNAUTHENTICATED", "Missing Authorization header.")
        parts = auth_header.split(" ")
        if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
            raise V3Error("UNAUTHENTICATED", "Malformed Authorization bearer header.")
        raw_token = parts[1].strip()
        principal = self.store.lookup_token(raw_token)
        if principal is None:
            raise V3Error("UNAUTHENTICATED", "Invalid or expired bearer token.")
        if principal.role not in ALLOWED_ROLES:
            raise V3Error("ROLE_NOT_ALLOWED", f"Role {principal.role!r} is not allowed (PD-08).")
        return principal

    def login_therapist(self, username: str, password: str) -> dict:
        principal = self.store.authenticate_therapist(username, password)
        if principal is None:
            raise V3Error("UNAUTHENTICATED", "Invalid therapist credentials.")
        raw_token, expires_at = self.store.issue_token(principal)
        return {
            "token": raw_token,
            "token_type": "Bearer",
            "expires_at": expires_at,
            "principal": {"role": principal.role, "id": principal.id, "org_id": principal.org_id},
        }

    def redeem_invite(self, raw_invite: str) -> dict:
        principal = self.store.consume_invite(raw_invite)
        if principal is None:
            raise V3Error("INVITE_INVALID", "Invite is unknown, used, expired, or revoked.")
        raw_token, expires_at = self.store.issue_token(principal)
        return {
            "token": raw_token,
            "token_type": "Bearer",
            "expires_at": expires_at,
            "principal": {"role": principal.role, "id": principal.id, "org_id": principal.org_id},
        }
