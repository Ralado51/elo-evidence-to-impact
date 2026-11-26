"""CL06.3 v3 FastAPI router exposing the S0-02, S0-04, S1a-01..04, S1b-02, S1b-03, and S1-01 endpoints under /api/v3.

Endpoints (api-contract.v3.json):
  1.  GET  /api/v3/health                                          (id: health, roles: anonymous)
  2.  POST /api/v3/auth/therapist                                  (id: auth.therapist, roles: anonymous)
  3.  POST /api/v3/invites                                         (id: invites.create, roles: therapist)
  4.  POST /api/v3/auth/invite                                     (id: auth.invite, roles: anonymous)
  5.  POST /api/v3/participants                                    (id: participants.create, roles: therapist)
  6.  POST /api/v3/care-links/{entity_id}:revoke                   (id: care_links.revoke, roles: therapist)
  7.  POST /api/v3/events:batch                                    (id: events.batch, roles: participant)
  8.  GET  /api/v3/entities/{entity_id}/versions                   (id: entities.versions, roles: therapist)
  9.  POST /api/v3/participants/{participant_id}/assessments       (id: assessments.create, roles: therapist)
  10. POST /api/v3/assessments/{entity_id}/versions                (id: assessments.revise, roles: therapist)
  11. GET  /api/v3/participants/{participant_id}/assessments       (id: assessments.list, roles: therapist)
  12. POST /api/v3/participants/{participant_id}/goals             (id: goals.create, roles: therapist)
  13. POST /api/v3/goals/{entity_id}/versions                      (id: goals.revise, roles: therapist)
  14. GET  /api/v3/participants/{participant_id}/goals             (id: goals.list, roles: therapist, participant)
  15. POST /api/v3/participants/{participant_id}/encounters        (id: encounters.create, roles: therapist)
  16. GET  /api/v3/participants/{participant_id}/encounters        (id: encounters.list, roles: therapist)
  17. POST /api/v3/participants/{participant_id}/reassessments     (id: reassessments.create, roles: therapist)
  18. POST /api/v3/participants/{participant_id}/instrumental-measurements (id: instrumental.create, roles: therapist)
  19. POST /api/v3/prescriptions                                   (id: prescriptions.publish, roles: therapist)
  20. GET  /api/v3/participants/{participant_id}/prescription/current (id: prescriptions.current, roles: participant, therapist)
  21. GET  /api/v3/participants/{participant_id}/prescriptions     (id: prescriptions.history, roles: therapist)
  22. GET  /api/v3/participants/{participant_id}/facts             (id: facts.list, roles: therapist)
  23. GET  /api/v3/facts/{fact_id}/evidence                        (id: facts.evidence, roles: therapist)
  24. POST /api/v3/facts/verify                                    (id: facts.verify, roles: therapist)
  25. POST /api/v3/reviews                                         (id: reviews.record, roles: therapist)
  26. POST /api/v3/summaries                                       (id: summaries.publish, roles: therapist)
  27. GET  /api/v3/summaries/{summary_id}                          (id: summaries.get, roles: participant, therapist)
  28. GET  /api/v3/participants/{participant_id}/evolution/series  (id: evolution.series, roles: therapist)
  29. POST /api/v3/evolution                                       (id: evolution.publish, roles: therapist)
  30. GET  /api/v3/evolution/{evolution_id}                        (id: evolution.get, roles: participant, therapist)
  31. GET  /api/v3/participants/{participant_id}/timeline          (id: timeline.get, roles: therapist)
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .auth import AuthService
from .authz import AuthzScope, authorize
from .clinical import ClinicalEntityService, extract_entity_payload
from .command_dedup import (
    HEADER as IDEM_HEADER,
)
from .command_dedup import (
    REPLAYED_HEADER,
    RETENTION_HEADER,
    fingerprint,
    key_ref,
    parse_idempotency_header,
)
from .command_dedup import log as cmd_log
from .entities import build_entity, new_id, utc_now_ms
from .errors import V3Error
from .evolution import EvolutionTimelineService
from .prescriptions import PrescriptionService
from .reviews import ReviewSummaryService
from .store import V3Store
from .validation import check_real_data_gate, is_real_data_gate_open
from .verifier import FactsService

_PARTICIPANT_ID_RE = re.compile(r"^p_[A-Za-z0-9-]{8,64}$")
_CARE_LINK_ID_RE = re.compile(r"^cl_[A-Za-z0-9-]{8,64}$")
BATCH_MAX_EVENTS = 500
BODY_MAX_BYTES = 2097152  # 2 MiB (api-contract.v3.json limits.body_max_bytes)


def _reject_non_finite(token: str) -> Any:
    raise V3Error("NON_FINITE", f"Non-finite JSON constant not allowed: {token!r}.")


async def _read_json_object(request: Request, *, allow_empty: bool = False) -> dict[str, Any]:
    return _parse_json_object(await request.body(), allow_empty=allow_empty)


def _parse_json_object(raw: bytes, *, allow_empty: bool = False) -> dict[str, Any]:
    if len(raw) > BODY_MAX_BYTES:
        raise V3Error("BATCH_TOO_LARGE", f"Request body exceeds {BODY_MAX_BYTES} bytes.")
    if not raw.strip():
        if allow_empty:
            return {}
        raise V3Error("TYPE", "Request body must be a JSON object.")
    try:
        parsed = json.loads(raw.decode("utf-8"), parse_constant=_reject_non_finite)
    except V3Error:
        raise
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


@dataclass
class _Cmd:
    """Per-request command state for the synchronous command section (no ``await`` while the tx lock is held)."""

    raw: bytes
    allow_empty: bool = False
    _body: dict[str, Any] | None = field(default=None, repr=False)

    def body(self) -> dict[str, Any]:
        if self._body is None:
            self._body = _parse_json_object(self.raw, allow_empty=self.allow_empty)
        return self._body


@dataclass
class _Outcome:
    status: int
    body: Any
    ref: dict[str, Any]  # immutable references only (ids/versions/hashes) - never clinical content
    headers: dict[str, str] = field(default_factory=dict)


def _body_str(cmd: _Cmd, name: str) -> str:
    """String field of the body, also looking inside the draft/payload wrappers some operations accept."""
    body = cmd.body()
    for holder in (body, body.get("draft"), body.get("payload")):
        if isinstance(holder, dict) and isinstance(holder.get(name), str):
            return holder[name]
    return ""


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
    clinical = ClinicalEntityService(store)
    prescriptions = PrescriptionService(store)
    facts = FactsService(store)
    reviews = ReviewSummaryService(store)
    evolution = EvolutionTimelineService(store)
    router = APIRouter(prefix="/api/v3")

    # ---- ARQ-02 / CMP-07 server pipeline: authorize -> (replay | execute) -> record, in ONE transaction ------
    def _authorize_participant_ref(pr, resource: str, action: str, participant_id: str, *, by_id: bool = False) -> None:
        """Re-evaluate participant-scoped access with the existing ``authorize`` engine (replay path)."""
        participant = store.get_latest_entity(participant_id, entity_type="participant")
        if participant is None:
            raise V3Error("NOT_FOUND", "Participant not found.")
        links = store.latest_care_links(participant_id=participant_id)
        _enforce(authorize(pr, resource, action, AuthzScope(participant_id=participant_id, org_id=participant["org_id"], is_read_by_id=by_id), links=links, ))

    def _rebuild_entity(ref: dict[str, Any]) -> tuple[Any, dict[str, str]]:
        for ent in store.get_entity_versions(ref["id"]):
            if ent["version"] == ref["v"]:  # the ORIGINAL immutable version, never the latest
                return ent, {}
        raise V3Error("INTERNAL", "Referenced entity version is missing.")

    def _rebuild_participant(ref: dict[str, Any]) -> tuple[Any, dict[str, str]]:
        ent, _ = _rebuild_entity({"id": ref["p"], "v": 1})
        return ent, {"X-Elo-Care-Link-Id": ref["cl"]}

    def _rebuild_event_review(ref: dict[str, Any]) -> tuple[Any, dict[str, str]]:
        ev = store.get_event_by_id(ref["e"])
        if ev is None:
            raise V3Error("INTERNAL", "Referenced event is missing.")
        return {"event_id": ref["e"], "review": ev}, {}

    def _rebuild_ids(ref: dict[str, Any]) -> tuple[Any, dict[str, str]]:
        return ref["b"], {}

    class _LostRace(Exception):
        """Another command committed the same Idempotency-Key first; our staged effect was rolled back."""

        def __init__(self, hit: dict[str, Any]) -> None:
            self.hit = hit

    async def _command(
        request: Request,
        operation_id: str,
        *,
        resource_key: str | Callable[[_Cmd], str],
        authorize_fn: Callable[[Any, _Cmd], Any],
        execute_fn: Callable[[Any, _Cmd, Any], _Outcome],
        rebuild_fn: Callable[[dict[str, Any]], tuple[Any, dict[str, str]]],
        replay_authorize: Callable[[Any, dict[str, Any]], None] | None = None,
        allow_empty: bool = False,
    ) -> JSONResponse:
        principal = auth.require_principal(request)
        key = parse_idempotency_header(request.headers.getlist(IDEM_HEADER))  # 400 only on keyed operations
        cmd = _Cmd(await request.body(), allow_empty=allow_empty)
        info = {RETENTION_HEADER: str(store.dedup.retention_days)} if key else {}
        # No await below: the synchronous section never yields the event loop while it may hold the tx lock.
        ctx = authorize_fn(principal, cmd)  # the existing authorization chain, evaluated on current state
        scope = fp = None
        if key is not None:
            rk = resource_key(cmd) if callable(resource_key) else resource_key
            scope = store.dedup.scope(principal, operation_id, rk)
            fp = fingerprint(operation_id, rk, cmd.body())

        def replay(hit: dict[str, Any]) -> JSONResponse:
            if hit["fingerprint"] != fp:
                cmd_log.info("command op=%s outcome=key_reused key=%s", operation_id, key_ref(key))
                raise V3Error("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request.")
            if replay_authorize is not None:
                replay_authorize(principal, hit["ref"])  # access is re-evaluated; nothing is disclosed if lost
            body, hdrs = rebuild_fn(hit["ref"])
            cmd_log.info("command op=%s outcome=replayed key=%s", operation_id, key_ref(key))
            return JSONResponse(body, status_code=hit["status"], headers={**hdrs, **info, REPLAYED_HEADER: "true"})

        if key is not None:
            hit = store.dedup.lookup(scope, key)
            if hit is not None:
                return replay(hit)
        try:
            with store.command_scope() as sc:
                out = execute_fn(principal, cmd, ctx)
                if sc.held:  # an effect is staged in the open transaction (lock kept): finish inside it
                    authorize_fn(principal, cmd)  # re-check against the current state, race-free
                    if replay_authorize is not None:
                        replay_authorize(principal, out.ref)
                    if key is not None:
                        late = store.dedup.lookup(scope, key)
                        if late is not None:
                            raise _LostRace(late)  # rolls the staged effect back
                        store.dedup.record(scope, key, fp, out.status, out.ref)
                resp = JSONResponse(out.body, status_code=out.status, headers={**out.headers, **info})
        except _LostRace as lost:
            return replay(lost.hit)
        if key is not None:
            cmd_log.info("command op=%s outcome=created key=%s", operation_id, key_ref(key))
        return resp

    async def _clinical_create(request: Request, op_id: str, entity_type: str, participant_id: str) -> JSONResponse:
        def exec_(pr, cmd, _ctx):
            ent = clinical.create(entity_type, participant_id, extract_entity_payload(cmd.body()), pr)
            return _Outcome(201, ent, {"k": "e", "id": ent["entity_id"], "v": ent["version"]})

        return await _command(
            request, op_id, resource_key=participant_id,
            authorize_fn=lambda pr, cmd: clinical.authorize_create(entity_type, participant_id, pr),
            execute_fn=exec_, rebuild_fn=_rebuild_entity,
        )

    async def _clinical_revise(request: Request, op_id: str, entity_type: str, entity_id: str) -> JSONResponse:
        def exec_(pr, cmd, _ctx):
            ent = clinical.revise(entity_id, extract_entity_payload(cmd.body()), pr, expected_entity_type=entity_type)
            return _Outcome(201, ent, {"k": "e", "id": ent["entity_id"], "v": ent["version"]})

        return await _command(
            request, op_id, resource_key=entity_id,
            authorize_fn=lambda pr, cmd: clinical.authorize_revise(entity_id, pr, expected_entity_type=entity_type),
            execute_fn=exec_, rebuild_fn=_rebuild_entity,
        )

    # 1. health
    @router.get("/health")
    def health():
        # body is frozen by the 3.0.0 contract/tests; A1 exposes the effective retention as a header only.
        return JSONResponse(
            {"status": "ok", "versions": {"schema": 3, "catalog": "2", "contracts": "3.0.0"}},
            headers={RETENTION_HEADER: str(store.dedup.retention_days)},
        )

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
        def authorize_(principal, cmd):
            _enforce(authorize(principal, "participant (entity)", "create", AuthzScope(org_id=principal.org_id)))
            _reject_live_data_origin_request(cmd.body(), real_data_gate_open=store.real_data_gate_open)

        def exec_(principal, cmd, _ctx):
            body = cmd.body()
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
                entity_type="participant", entity_id=participant_id, version=1, prev_hash=None,
                org_id=principal.org_id, participant_id=participant_id, author_role=principal.role,
                author_id=principal.id, data_origin=store.data_origin, payload=payload, created_at=now_ms,
            )
            care_link_ent = build_entity(
                entity_type="care_link", entity_id=care_link_id, version=1, prev_hash=None,
                org_id=principal.org_id, participant_id=participant_id, author_role=principal.role,
                author_id=principal.id, data_origin=store.data_origin,
                payload={"therapist_id": principal.id, "status": "active", "valid_from": today_iso, "valid_to": None},
                created_at=now_ms,
            )
            store.save_entities_atomic([(participant_ent, []), (care_link_ent, [])])
            return _Outcome(201, participant_ent, {"k": "pc", "p": participant_id, "cl": care_link_id}, {"X-Elo-Care-Link-Id": care_link_id})

        return await _command(
            request, "participants.create", resource_key="", authorize_fn=authorize_, execute_fn=exec_,
            rebuild_fn=_rebuild_participant,
            # the replay discloses the participant: the caller must still be allowed to read it
            replay_authorize=lambda pr, ref: _authorize_participant_ref(pr, "participant (entity)", "read", ref["p"], by_id=True),
        )

    # 6. care_links.revoke
    @router.post("/care-links/{entity_id}:revoke")
    async def care_links_revoke(entity_id: str, request: Request):
        def authorize_(principal, cmd):
            # Role gate first (participant -> 403 FORBIDDEN even before entity lookup)
            _enforce(authorize(principal, "care_link", "create/revoke", AuthzScope()))
            _reject_live_data_origin_request(cmd.body(), real_data_gate_open=store.real_data_gate_open)
            if not _CARE_LINK_ID_RE.fullmatch(entity_id):
                raise V3Error("NOT_FOUND", "Care link not found.")
            versions = store.get_entity_versions(entity_id)
            if not versions or versions[-1]["entity_type"] != "care_link":
                raise V3Error("NOT_FOUND", "Care link not found.")
            latest = versions[-1]
            _enforce(authorize(
                principal, "care_link", "create/revoke",
                AuthzScope(org_id=latest["org_id"], participant_id=latest["participant_id"], link_therapist_id=latest["payload"]["therapist_id"]),
            ))
            return versions, latest

        def exec_(principal, cmd, ctx):
            versions, latest = ctx
            if latest["payload"]["status"] == "revoked":
                raise V3Error("CONFLICT_IMMUTABLE", "Care link is already revoked.")
            v2 = build_entity(
                entity_type="care_link", entity_id=latest["entity_id"], version=latest["version"] + 1,
                prev_hash=latest["hash"], org_id=latest["org_id"], participant_id=latest["participant_id"],
                author_role=principal.role, author_id=principal.id, data_origin=store.data_origin,
                payload={"therapist_id": latest["payload"]["therapist_id"], "status": "revoked",
                         "valid_from": latest["payload"]["valid_from"], "valid_to": latest["payload"]["valid_to"]},
            )
            store.save_entities_atomic([(v2, versions)])
            return _Outcome(200, v2, {"k": "e", "id": v2["entity_id"], "v": v2["version"]})

        return await _command(
            request, "care_links.revoke", resource_key=entity_id, authorize_fn=authorize_, execute_fn=exec_,
            rebuild_fn=_rebuild_entity, allow_empty=True,
        )

    # 7. events.batch (S0-04, D-S0-04-1, D-S0-04-2)
    @router.post("/events:batch")
    async def events_batch(request: Request):
        principal = auth.require_principal(request)
        if principal.role != "participant":
            raise V3Error("FORBIDDEN", "Only participant may append client-authored event batches.")

        raw = await request.body()
        if len(raw) > BODY_MAX_BYTES:
            raise V3Error("BATCH_TOO_LARGE", f"Request body exceeds {BODY_MAX_BYTES} bytes.")
        if not raw.strip():
            raise V3Error("TYPE", "Request body must be a JSON object.")
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise V3Error("TYPE", "Malformed JSON request body.") from exc
        if not isinstance(body, dict):
            raise V3Error("TYPE", "Request body must be a JSON object.")
        if "events" not in body:
            raise V3Error("MISSING_FIELD", "Missing required field 'events'.")
        events = body["events"]
        if not isinstance(events, list):
            raise V3Error("TYPE", "Field 'events' must be an array.")
        if len(events) == 0:
            raise V3Error("LENGTH", "Batch must contain at least 1 event.")
        if len(events) > BATCH_MAX_EVENTS:
            raise V3Error("BATCH_TOO_LARGE", f"Batch exceeds maximum of {BATCH_MAX_EVENTS} events.")

        # Batch-level ordering check: sorted by (stream_id, seq) ascending
        prev_key: tuple[str, int] | None = None
        for ev in events:
            if isinstance(ev, dict):
                sid = ev.get("stream_id")
                seq = ev.get("seq")
                if isinstance(sid, str) and isinstance(seq, int) and not isinstance(seq, bool):
                    key = (sid, seq)
                    if prev_key is not None and key < prev_key:
                        raise V3Error("BATCH_UNORDERED", "Batch is not sorted by (stream_id, seq) ascending.")
                    prev_key = key

        results = store.append(events, principal=principal, map_http_codes=True)
        return JSONResponse({"results": results}, status_code=200)

    # 8. entities.versions (S0-04)
    @router.get("/entities/{entity_id}/versions")
    def entities_versions(entity_id: str, request: Request):
        principal = auth.require_principal(request)
        if principal.role != "therapist":
            raise V3Error("FORBIDDEN", "Only therapist may read entity version trails.")

        versions = store.get_entity_versions(entity_id)
        if not versions:
            raise V3Error("NOT_FOUND", "Entity not found.")

        latest = versions[-1]
        participant_id = latest.get("participant_id")
        if participant_id is not None:
            links = store.latest_care_links(participant_id=participant_id)
            decision = authorize(
                principal,
                "participant (entity)",
                "read",
                AuthzScope(participant_id=participant_id, org_id=latest["org_id"], is_read_by_id=True),
                links=links,
            )
            _enforce(decision)
        else:
            if latest["entity_id"] != principal.id or latest["org_id"] != principal.org_id:
                raise V3Error("NOT_FOUND", "Entity not found.")

        return JSONResponse(versions, status_code=200)

    # 9. assessments.create (S1a-01)
    @router.post("/participants/{participant_id}/assessments", status_code=201)
    async def assessments_create(participant_id: str, request: Request):
        return await _clinical_create(request, "assessments.create", "functional_assessment", participant_id)

    # 10. assessments.revise (S1a-01, D-S1a-01-1)
    @router.post("/assessments/{entity_id}/versions", status_code=201)
    async def assessments_revise(entity_id: str, request: Request):
        return await _clinical_revise(request, "assessments.revise", "functional_assessment", entity_id)

    # 11. assessments.list (S1a-01)
    @router.get("/participants/{participant_id}/assessments")
    def assessments_list(participant_id: str, request: Request):
        principal = auth.require_principal(request)
        items = clinical.list("functional_assessment", participant_id, principal)
        return JSONResponse(items, status_code=200)

    # 12. goals.create (S1a-02, D-S1a-02-1)
    @router.post("/participants/{participant_id}/goals", status_code=201)
    async def goals_create(participant_id: str, request: Request):
        return await _clinical_create(request, "goals.create", "goal", participant_id)

    # 13. goals.revise (S1a-02, D-S1a-01-1/-2, D-S1a-02-1)
    @router.post("/goals/{entity_id}/versions", status_code=201)
    async def goals_revise(entity_id: str, request: Request):
        return await _clinical_revise(request, "goals.revise", "goal", entity_id)

    # 14. goals.list (S1a-02, D-S1a-02-1)
    @router.get("/participants/{participant_id}/goals")
    def goals_list(participant_id: str, request: Request):
        principal = auth.require_principal(request)
        items = clinical.list("goal", participant_id, principal)
        return JSONResponse(items, status_code=200)

    # 15. encounters.create (S1a-03, D-S1a-03-1)
    @router.post("/participants/{participant_id}/encounters", status_code=201)
    async def encounters_create(participant_id: str, request: Request):
        return await _clinical_create(request, "encounters.create", "encounter", participant_id)

    # 16. encounters.list (S1a-03)
    @router.get("/participants/{participant_id}/encounters")
    def encounters_list(participant_id: str, request: Request):
        principal = auth.require_principal(request)
        items = clinical.list("encounter", participant_id, principal)
        return JSONResponse(items, status_code=200)

    # 17. reassessments.create (S1a-03, D-S1a-03-1)
    @router.post("/participants/{participant_id}/reassessments", status_code=201)
    async def reassessments_create(participant_id: str, request: Request):
        return await _clinical_create(request, "reassessments.create", "reassessment", participant_id)

    # 18. instrumental.create (S1a-03)
    @router.post("/participants/{participant_id}/instrumental-measurements", status_code=201)
    async def instrumental_create(participant_id: str, request: Request):
        return await _clinical_create(request, "instrumental.create", "instrumental_measurement", participant_id)

    # 19. prescriptions.publish (S1a-04, D-S1a-04-1)
    @router.post("/prescriptions", status_code=201)
    async def prescriptions_publish(request: Request):
        def exec_(pr, cmd, _ctx):
            result = prescriptions.publish(cmd.body(), pr)
            ev = store.get_event_by_id(result["event_id"])
            return _Outcome(201, result, {"k": "b", "b": result, "p": ev["scope"]["participant_id"]})

        return await _command(
            request, "prescriptions.publish", resource_key=lambda c: _body_str(c, "participant_id"),
            authorize_fn=lambda pr, cmd: prescriptions.authorize_publish_role(pr), execute_fn=exec_,
            rebuild_fn=_rebuild_ids,
            replay_authorize=lambda pr, ref: _authorize_participant_ref(pr, "prescription", "publish", ref["p"]),
        )

    # 20. prescriptions.current (S1a-04)
    @router.get("/participants/{participant_id}/prescription/current")
    def prescriptions_current(participant_id: str, request: Request):
        principal = auth.require_principal(request)
        latest = prescriptions.current(participant_id, principal)
        return JSONResponse(latest, status_code=200)

    # 21. prescriptions.history (S1a-04)
    @router.get("/participants/{participant_id}/prescriptions")
    def prescriptions_history(participant_id: str, request: Request):
        principal = auth.require_principal(request)
        items = prescriptions.history(participant_id, principal)
        return JSONResponse(items, status_code=200)

    # 22. facts.list (S1b-02, D-S1b-02-1)
    @router.get("/participants/{participant_id}/facts")
    def facts_list(participant_id: str, request: Request):
        principal = auth.require_principal(request)
        date_from = request.query_params.get("from")
        date_to = request.query_params.get("to")
        include = request.query_params.get("include")
        if include is not None and include != "reviews":
            raise V3Error("RULE_VIOLATION", "Query parameter 'include' only supports the value 'reviews'.")
        result = facts.list_facts(
            participant_id,
            principal,
            date_from=date_from,
            date_to=date_to,
        )
        if include == "reviews":
            # Opt-in additive projection (ARQ-02 FIX-03): default response is unchanged (A1 3.1.0).
            result = {
                **result,
                "effective_reviews": reviews.effective_review_projection(
                    participant_id, [f["fact_id"] for f in result["facts"]]
                ),
            }
        return JSONResponse(result, status_code=200)

    # 23. facts.evidence (S1b-02, D-S1b-02-1)
    @router.get("/facts/{fact_id}/evidence")
    def facts_evidence(fact_id: str, request: Request):
        principal = auth.require_principal(request)
        result = facts.get_evidence(fact_id, principal)
        return JSONResponse(result, status_code=200)

    # 24. facts.verify (S1b-02, D-S1b-02-1 — never persists)
    @router.post("/facts/verify")
    async def facts_verify(request: Request):
        principal = auth.require_principal(request)
        body = await _read_json_object(request)
        result = facts.verify_proposal(body, principal)
        return JSONResponse(result, status_code=200)

    # 25. reviews.record (S1b-03, D-S1b-03-1)
    @router.post("/reviews", status_code=201)
    async def reviews_record(request: Request):
        def exec_(pr, cmd, _ctx):
            result = reviews.record_review(cmd.body(), pr)
            ev = result["review"]
            return _Outcome(201, result, {"k": "rv", "e": result["event_id"], "p": ev["scope"]["participant_id"]})

        return await _command(
            request, "reviews.record", resource_key=lambda c: _body_str(c, "fact_id"),
            authorize_fn=lambda pr, cmd: reviews.authorize_review_role(pr), execute_fn=exec_,
            rebuild_fn=_rebuild_event_review,
            replay_authorize=lambda pr, ref: _authorize_participant_ref(pr, "review", "record", ref["p"]),
        )

    # 26. summaries.publish (S1b-03, D-S1b-03-1)
    @router.post("/summaries", status_code=201)
    async def summaries_publish(request: Request):
        def exec_(pr, cmd, _ctx):
            result, status_code = reviews.publish_summary(cmd.body(), pr)
            ev = store.get_event_by_id(result["event_id"])
            return _Outcome(status_code, result, {"k": "b", "b": result, "p": ev["scope"]["participant_id"]})

        return await _command(
            request, "summaries.publish", resource_key=lambda c: _body_str(c, "participant_id"),
            authorize_fn=lambda pr, cmd: reviews.authorize_summary_publish_role(pr), execute_fn=exec_,
            rebuild_fn=_rebuild_ids,
            replay_authorize=lambda pr, ref: _authorize_participant_ref(pr, "summary", "publish", ref["p"]),
        )

    # 27. summaries.get (S1b-03, D-S1b-03-1)
    @router.get("/summaries/{summary_id}")
    def summaries_get(summary_id: str, request: Request):
        principal = auth.require_principal(request)
        result = reviews.get_summary(summary_id, principal)
        return JSONResponse(result, status_code=200)

    # 28. evolution.series (S1-01, D-S1-01-2, R5, R9, R13)
    @router.get("/participants/{participant_id}/evolution/series")
    def evolution_series(participant_id: str, request: Request):
        principal = auth.require_principal(request)
        date_from = request.query_params.get("from")
        date_to = request.query_params.get("to")
        result = evolution.list_series(
            participant_id,
            principal,
            date_from=date_from,
            date_to=date_to,
        )
        return JSONResponse(result, status_code=200)

    # 29. evolution.publish (S1-01, D-S1-01-3, R6, R7, R10, R12, R14)
    @router.post("/evolution", status_code=201)
    async def evolution_publish(request: Request):
        def exec_(pr, cmd, _ctx):
            result, status_code = evolution.publish_evolution(cmd.body(), pr)
            ev = store.get_event_by_id(result["event_id"])
            return _Outcome(status_code, result, {"k": "b", "b": result, "p": ev["scope"]["participant_id"]})

        return await _command(
            request, "evolution.publish", resource_key=lambda c: _body_str(c, "participant_id"),
            authorize_fn=lambda pr, cmd: evolution.authorize_publish_role(pr), execute_fn=exec_,
            rebuild_fn=_rebuild_ids,
            replay_authorize=lambda pr, ref: _authorize_participant_ref(pr, "evolution", "series read / publish", ref["p"]),
        )

    # 30. evolution.get (S1-01, D-S1-01-5, R7, R8, R9, R13)
    @router.get("/evolution/{evolution_id}")
    def evolution_get(evolution_id: str, request: Request):
        principal = auth.require_principal(request)
        result = evolution.get_evolution(evolution_id, principal)
        return JSONResponse(result, status_code=200)

    # 31. timeline.get (S1-01, D-S1-01-6, R3, R4)
    @router.get("/participants/{participant_id}/timeline")
    def timeline_get(participant_id: str, request: Request):
        principal = auth.require_principal(request)
        result = evolution.get_timeline(participant_id, principal)
        return JSONResponse(result, status_code=200)

    return router, store, auth
