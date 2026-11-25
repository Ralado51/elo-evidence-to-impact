"""CL06.3 v3 FastAPI router exposing exactly the six S0-02 endpoints under /api/v3.

Endpoints (api-contract.v3.json):
  1. GET  /api/v3/health                          (id: health, roles: anonymous)
  2. POST /api/v3/auth/therapist                  (id: auth.therapist, roles: anonymous)
  3. POST /api/v3/invites                         (id: invites.create, roles: therapist)
  4. POST /api/v3/auth/invite                     (id: auth.invite, roles: anonymous)
  5. POST /api/v3/participants                    (id: participants.create, roles: therapist)
  6. POST /api/v3/care-links/{entity_id}:revoke   (id: care_links.revoke, roles: therapist)
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .auth import AuthService
from .authz import AuthzScope, authorize
from .entities import build_entity, new_id, utc_now_ms
from .errors import V3Error
from .store import V3Store
from .validation import check_real_data_gate, is_real_data_gate_open

_PARTICIPANT_ID_RE = re.compile(r"^p_[A-Za-z0-9-]{8,64}$")
_CARE_LINK_ID_RE = re.compile(r"^cl_[A-Za-z0-9-]{8,64}$")


async def _read_json_object(request: Request, *, allow_empty: bool = False) -> dict[str, Any]:
    raw = await request.body()
    if not raw.strip():
        if allow_empty:
            return {}
        raise V3Error("TYPE", "Request body must be a JSON object.")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise V3Error("TYPE", "Malformed JSON request body.") from exc
    if not isinstance(parsed, dict):
        raise V3Error("TYPE", "Request body must be a JSON object.")
    return parsed


def _reject_live_data_origin_request(body: dict[str, Any], *, real_data_gate_open: bool) -> None:
    """Reject any request attempting to set data_origin='live' while the real-data gate is closed."""
    candidates = [body.get("data_origin")]
    nested = body.get("payload")
    if isinstance(nested, dict):
        candidates.append(nested.get("data_origin"))
    for origin in candidates:
        if isinstance(origin, str) and check_real_data_gate(origin, gate_open=real_data_gate_open):
            raise V3Error("REAL_DATA_GATE_CLOSED", "data_origin 'live' is rejected while real-data gate is closed.")


def _enforce(decision) -> None:
    if not decision.allowed:
        assert decision.code is not None
        raise V3Error(decision.code, decision.reason)


def create_v3_router(
    db_path: str = ":memory:",
    *,
    data_origin: str | None = None,
    real_data_gate_open: bool | None = None,
) -> tuple[APIRouter, V3Store, AuthService]:
    resolved_origin = data_origin if data_origin is not None else os.environ.get("ELO_V3_DATA_ORIGIN", "synthetic_fixture")
    resolved_gate = is_real_data_gate_open() if real_data_gate_open is None else real_data_gate_open

    store = V3Store(db_path, data_origin=resolved_origin, real_data_gate_open=resolved_gate)
    auth = AuthService(store)
    router = APIRouter(prefix="/api/v3")

    # 1. health
    @router.get("/health")
    def health():
        return {
            "status": "ok",
            "versions": {"schema": 3, "catalog": "2", "contracts": "3.0.0"},
        }

    # 2. auth.therapist
    @router.post("/auth/therapist")
    async def auth_therapist(request: Request):
        body = await _read_json_object(request)
        username = body.get("username")
        password = body.get("password")
        if not isinstance(username, str) or not isinstance(password, str) or not username or not password:
            raise V3Error("UNAUTHENTICATED", "Username and password are required.")
        return auth.login_therapist(username, password)

    # 3. invites.create
    @router.post("/invites", status_code=201)
    async def invites_create(request: Request):
        principal = auth.require_principal(request)
        # Role gate first: participants are forbidden from creating invites
        if principal.role != "therapist":
            raise V3Error("FORBIDDEN", "Only therapist may create participant invites.")
        body = await _read_json_object(request)
        participant_id = body.get("participant_id")
        if not isinstance(participant_id, str) or not _PARTICIPANT_ID_RE.fullmatch(participant_id):
            raise V3Error("PATTERN", "participant_id must match ^p_[A-Za-z0-9-]{8,64}$.")

        # Unknown participant id -> 404 NOT_FOUND before linked-scope check (D-S0-02-3)
        if store.get_latest_entity(participant_id, entity_type="participant") is None:
            raise V3Error("NOT_FOUND", "Participant not found.")

        # Therapist must hold an active care_link to participant_id in the same org
        links = store.latest_care_links(participant_id=participant_id)
        decision = authorize(
            principal,
            "care_link",
            "read",
            AuthzScope(participant_id=participant_id, org_id=principal.org_id, is_read_by_id=False),
            links=links,
        )
        _enforce(decision)

        ttl = body.get("ttl_seconds", 3600)
        if isinstance(ttl, bool) or not isinstance(ttl, int) or ttl < 60 or ttl > 86400:
            raise V3Error("OUT_OF_RANGE", "ttl_seconds must be an integer between 60 and 86400.")

        raw_invite, expires_at = store.create_invite(
            participant_id=participant_id,
            org_id=principal.org_id,
            created_by=principal.id,
            ttl_seconds=ttl,
        )
        return JSONResponse(
            {"invite_token": raw_invite, "participant_id": participant_id, "expires_at": expires_at},
            status_code=201,
        )

    # 4. auth.invite
    @router.post("/auth/invite")
    async def auth_invite(request: Request):
        body = await _read_json_object(request)
        raw_invite = body.get("invite_token")
        if raw_invite is None:
            raw_invite = body.get("invite")
        if not isinstance(raw_invite, str) or not raw_invite.strip():
            raise V3Error("INVITE_INVALID", "Invite token is required.")
        return auth.redeem_invite(raw_invite.strip())

    # 5. participants.create
    @router.post("/participants", status_code=201)
    async def participants_create(request: Request):
        principal = auth.require_principal(request)
        decision = authorize(
            principal,
            "participant (entity)",
            "create",
            AuthzScope(org_id=principal.org_id),
        )
        _enforce(decision)

        body = await _read_json_object(request)
        _reject_live_data_origin_request(body, real_data_gate_open=store.real_data_gate_open)

        # Support either flat {"alias", "side"} or {"payload": {"alias", "side"}}; ignore spoofed principal fields
        raw_payload = body.get("payload") if isinstance(body.get("payload"), dict) else body
        payload = {}
        if "alias" in raw_payload:
            payload["alias"] = raw_payload["alias"]
        if "side" in raw_payload:
            payload["side"] = raw_payload["side"]

        requested_pid = body.get("participant_id")
        if requested_pid is not None:
            if not isinstance(requested_pid, str) or not _PARTICIPANT_ID_RE.fullmatch(requested_pid):
                raise V3Error("PATTERN", "participant_id must match ^p_[A-Za-z0-9-]{8,64}$.")
            if store.get_entity_versions(requested_pid):
                raise V3Error("ENTITY_VERSION_CONFLICT", f"Participant {requested_pid} already exists.")
            participant_id = requested_pid
        else:
            participant_id = new_id("p")

        now_ms = utc_now_ms()
        today_iso = datetime.now(timezone.utc).date().isoformat()
        care_link_id = new_id("cl")

        participant_ent = build_entity(
            entity_type="participant",
            entity_id=participant_id,
            version=1,
            prev_hash=None,
            org_id=principal.org_id,
            participant_id=participant_id,
            author_role=principal.role,
            author_id=principal.id,
            data_origin=store.data_origin,
            payload=payload,
            created_at=now_ms,
        )
        care_link_ent = build_entity(
            entity_type="care_link",
            entity_id=care_link_id,
            version=1,
            prev_hash=None,
            org_id=principal.org_id,
            participant_id=participant_id,
            author_role=principal.role,
            author_id=principal.id,
            data_origin=store.data_origin,
            payload={
                "therapist_id": principal.id,
                "status": "active",
                "valid_from": today_iso,
                "valid_to": None,
            },
            created_at=now_ms,
        )
        store.save_entities_atomic([(participant_ent, []), (care_link_ent, [])])
        return JSONResponse(
            participant_ent,
            status_code=201,
            headers={"X-Elo-Care-Link-Id": care_link_id},
        )

    # 6. care_links.revoke
    @router.post("/care-links/{entity_id}:revoke")
    async def care_links_revoke(entity_id: str, request: Request):
        principal = auth.require_principal(request)
        # Role gate first (participant -> 403 FORBIDDEN even before entity lookup)
        role_decision = authorize(principal, "care_link", "create/revoke", AuthzScope())
        _enforce(role_decision)

        body = await _read_json_object(request, allow_empty=True)
        _reject_live_data_origin_request(body, real_data_gate_open=store.real_data_gate_open)

        if not _CARE_LINK_ID_RE.fullmatch(entity_id):
            raise V3Error("NOT_FOUND", "Care link not found.")

        versions = store.get_entity_versions(entity_id)
        if not versions or versions[-1]["entity_type"] != "care_link":
            raise V3Error("NOT_FOUND", "Care link not found.")
        latest = versions[-1]

        party_decision = authorize(
            principal,
            "care_link",
            "create/revoke",
            AuthzScope(
                org_id=latest["org_id"],
                participant_id=latest["participant_id"],
                link_therapist_id=latest["payload"]["therapist_id"],
            ),
        )
        _enforce(party_decision)

        if latest["payload"]["status"] == "revoked":
            raise V3Error("CONFLICT_IMMUTABLE", "Care link is already revoked.")

        v2 = build_entity(
            entity_type="care_link",
            entity_id=latest["entity_id"],
            version=latest["version"] + 1,
            prev_hash=latest["hash"],
            org_id=latest["org_id"],
            participant_id=latest["participant_id"],
            author_role=principal.role,
            author_id=principal.id,
            data_origin=store.data_origin,
            payload={
                "therapist_id": latest["payload"]["therapist_id"],
                "status": "revoked",
                "valid_from": latest["payload"]["valid_from"],
                "valid_to": latest["payload"]["valid_to"],
            },
        )
        store.save_entities_atomic([(v2, versions)])
        return JSONResponse(v2, status_code=200)

    return router, store, auth
