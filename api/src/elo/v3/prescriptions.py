"""Server-authored prescription publishing and read service (CL06.3 v3, S1a-04).

Implements D-S1a-04-1:
- One prescription stream per ``(participant_id, exercise_id)``: first publish assigns
  ``prescription_id`` (``rx_``), ``revision=1``, ``supersedes_revision=None``; each
  subsequent publish appends ``revision=n+1``, ``supersedes_revision=n`` on
  ``prescription:<prescription_id>`` with ``seq == revision``.
- Published revisions are immutable (RN003); concurrent losing writers receive 409
  ``CONFLICT_IMMUTABLE``.
- Server sets ``prescription_id``, ``revision``, ``supersedes_revision``, ``created_by``,
  ``created_at``, ``limits_version`` (from ``limits.v1.json``), and all event envelope
  fields; client values for those fields are ignored.
"""

from __future__ import annotations

import re
from typing import Any

from elo.canonical import CanonicalizationError, compute_event_hash, compute_event_id

from .authz import ALLOWED_ROLES, AuthzScope, Principal, authorize
from .entities import new_id, utc_now_ms, validate
from .civil_date import parse_civil_date
from .errors import V3Error, to_http_error
from .store import V3Store
from .validation import load_event_schema, load_limits_catalog, validate_event

_PARTICIPANT_ID_RE = re.compile(r"^p_[A-Za-z0-9-]{8,64}$")

# Server-owned event envelope keys (ignored if supplied at top level of publish request).
SERVER_OWNED_EVENT_ENVELOPE_FIELDS: frozenset[str] = frozenset(
    {
        "event_id",
        "schema_version",
        "type",
        "stream_id",
        "seq",
        "prev_hash",
        "occurred_at",
        "t_mono_ms",
        "actor",
        "scope",
        "source",
        "execution_mode",
        "data_origin",
        "origin_ref",
        "hash",
    }
)

# Server-owned prescription payload keys (D-S1a-04-1 / S1a-04 Row 4: client values ignored).
SERVER_OWNED_PRESCRIPTION_PAYLOAD_FIELDS: frozenset[str] = frozenset(
    {
        "prescription_id",
        "revision",
        "supersedes_revision",
        "created_by",
        "created_at",
        "limits_version",
    }
)


def extract_prescription_draft(body: dict[str, Any]) -> dict[str, Any]:
    """Extract the client prescription draft from ``{"draft": ...}``, ``{"payload": ...}``, or flat body.

    Strips server-owned envelope and server-owned prescription payload fields so client
    values for those keys never reach the stored event. Unknown non-envelope top-level
    keys in wrapped bodies raise 400 ``UNKNOWN_FIELD``; unknown keys inside the draft
    are preserved so schema validation rejects them with 400 ``UNKNOWN_FIELD``.
    """
    wrapper_key: str | None = None
    if "draft" in body:
        wrapper_key = "draft"
    elif "payload" in body:
        wrapper_key = "payload"

    if wrapper_key is not None:
        raw_draft = body[wrapper_key]
        if raw_draft is None:
            raise V3Error("NULL_NOT_ALLOWED", f"Field {wrapper_key!r} must not be null.")
        if not isinstance(raw_draft, dict):
            raise V3Error("TYPE", f"Field {wrapper_key!r} must be a JSON object.")
        for key in body:
            if (
                key != wrapper_key
                and key != "participant_id"
                and key not in SERVER_OWNED_EVENT_ENVELOPE_FIELDS
                and key not in SERVER_OWNED_PRESCRIPTION_PAYLOAD_FIELDS
            ):
                raise V3Error("UNKNOWN_FIELD", f"Unknown request field: {key!r}.")
        draft = {k: v for k, v in raw_draft.items() if k not in SERVER_OWNED_PRESCRIPTION_PAYLOAD_FIELDS}
        if "participant_id" in body:
            top_pid = body["participant_id"]
            if "participant_id" not in draft:
                draft["participant_id"] = top_pid
            elif draft["participant_id"] != top_pid:
                raise V3Error("RULE_VIOLATION", "Top-level participant_id differs from draft.participant_id.")
        return draft

    return {
        k: v
        for k, v in body.items()
        if k not in SERVER_OWNED_EVENT_ENVELOPE_FIELDS
        and k not in SERVER_OWNED_PRESCRIPTION_PAYLOAD_FIELDS
    }


def _require_valid_principal(principal: Principal | None) -> Principal:
    if principal is None:
        raise V3Error("UNAUTHENTICATED", "Authentication required.")
    if principal.role not in ALLOWED_ROLES:
        raise V3Error("ROLE_NOT_ALLOWED", f"Role {principal.role!r} is not allowed (PD-08).")
    return principal


def _enforce_decision(decision) -> None:
    if not decision.allowed:
        assert decision.code is not None
        raise V3Error(decision.code, decision.reason)


def _check_prescription_dates(payload: dict[str, Any]) -> None:
    """Enforce calendar validity and ``valid_to >= valid_from`` (S1a-04 Row 6) with the shared civil-date rule."""
    valid_from_raw = payload.get("valid_from")
    valid_to_raw = payload.get("valid_to")
    d_from = parse_civil_date(valid_from_raw)
    if d_from is None:
        raise V3Error("RULE_VIOLATION", f"valid_from {valid_from_raw!r} is not a valid calendar date.")
    if valid_to_raw is not None:
        d_to = parse_civil_date(valid_to_raw)
        if d_to is None:
            raise V3Error("RULE_VIOLATION", f"valid_to {valid_to_raw!r} is not a valid calendar date.")
        if d_to < d_from:
            raise V3Error("RULE_VIOLATION", "valid_to must not be earlier than valid_from.")


class PrescriptionService:
    """Server-authored prescription publication and read service backed by ``V3Store``."""

    def __init__(self, store: V3Store) -> None:
        self.store = store

    def authorize_publish_role(self, principal: Principal | None) -> Principal:
        """Role gate before body parsing / participant lookup (participant -> 403 FORBIDDEN)."""
        caller = _require_valid_principal(principal)
        role_decision = authorize(caller, "prescription", "publish", AuthzScope())
        if not role_decision.allowed and role_decision.code == "FORBIDDEN":
            raise V3Error("FORBIDDEN", role_decision.reason)
        return caller

    def publish(self, body: dict[str, Any], principal: Principal | None) -> dict[str, Any]:
        """Validate and append a server-authored ``prescription.published`` event."""
        caller = self.authorize_publish_role(principal)
        draft = extract_prescription_draft(body)

        if "participant_id" not in draft:
            raise V3Error("MISSING_FIELD", "Missing required field 'participant_id'.")
        participant_id = draft["participant_id"]
        if participant_id is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'participant_id' must not be null.")
        if not isinstance(participant_id, str):
            raise V3Error("TYPE", "Field 'participant_id' must be a string.")
        if not _PARTICIPANT_ID_RE.fullmatch(participant_id):
            raise V3Error("PATTERN", "Field 'participant_id' must match ^p_[A-Za-z0-9-]{8,64}$.")

        participant = self.store.get_latest_entity(participant_id, entity_type="participant")
        if participant is None:
            raise V3Error("NOT_FOUND", "Participant not found.")

        links = self.store.latest_care_links(participant_id=participant_id)
        decision = authorize(
            caller,
            "prescription",
            "publish",
            AuthzScope(
                participant_id=participant_id,
                org_id=participant["org_id"],
                is_read_by_id=False,
            ),
            links=links,
        )
        _enforce_decision(decision)

        exercise_id = draft.get("exercise_id")
        prev_ev = (
            self.store.get_latest_prescription_for_exercise(participant_id, exercise_id)
            if isinstance(exercise_id, str)
            else None
        )
        if prev_ev is not None:
            prescription_id = prev_ev["payload"]["prescription_id"]
            revision = int(prev_ev["payload"]["revision"]) + 1
            supersedes_revision: int | None = int(prev_ev["payload"]["revision"])
            prev_hash: str | None = prev_ev["hash"]
            is_new_stream = False
        else:
            prescription_id = new_id("rx")
            revision = 1
            supersedes_revision = None
            prev_hash = None
            is_new_stream = True

        limits = load_limits_catalog()
        now_ms = utc_now_ms()
        stream_id = f"prescription:{prescription_id}"
        event_id = compute_event_id(stream_id, revision)

        payload: dict[str, Any] = {
            **draft,
            "prescription_id": prescription_id,
            "revision": revision,
            "supersedes_revision": supersedes_revision,
            "created_by": caller.id,
            "created_at": now_ms,
            "limits_version": limits["limits_version"],
        }

        scope_exercise_id = exercise_id if isinstance(exercise_id, str) else "organizar-a-mesa"
        ev_without_hash: dict[str, Any] = {
            "event_id": event_id,
            "schema_version": 3,
            "type": "prescription.published",
            "stream_id": stream_id,
            "seq": revision,
            "prev_hash": prev_hash,
            "occurred_at": now_ms,
            "actor": {"role": "therapist", "id": caller.id},
            "scope": {
                "org_id": participant["org_id"],
                "participant_id": participant_id,
                "prescription_id": prescription_id,
                "prescription_revision": revision,
                "exercise_id": scope_exercise_id,
            },
            "source": {"type": "therapist"},
            "execution_mode": "not_applicable",
            "data_origin": self.store.data_origin,
            "payload": payload,
        }

        try:
            ev_hash = compute_event_hash(ev_without_hash)
        except CanonicalizationError as exc:
            placeholder = {**ev_without_hash, "hash": "0" * 64}
            schema = load_event_schema("prescription.published")
            schema_codes = sorted({code for _, code in validate(schema, placeholder)}) if schema else []
            canon_code = "NON_FINITE" if "non-finite" in str(exc).lower() else "NON_CANONICAL"
            codes = sorted(set(schema_codes) | {canon_code})
            raise to_http_error(codes[0], f"Prescription validation failed: {', '.join(codes)}", details=codes) from exc

        ev = {**ev_without_hash, "hash": ev_hash}
        ev_errs = validate_event(ev, gate_open=self.store.real_data_gate_open)
        if ev_errs:
            # Prioritize LIMITS_EXCEEDED when sets/reps exceed technical limits (also triggers schema OUT_OF_RANGE).
            primary = "LIMITS_EXCEEDED" if "LIMITS_EXCEEDED" in ev_errs else ev_errs[0]
            raise to_http_error(primary, f"Prescription validation failed: {', '.join(ev_errs)}", details=ev_errs)

        _check_prescription_dates(payload)

        self.store.insert_prescription_revision(ev, is_new_stream=is_new_stream)
        return {
            "prescription_id": prescription_id,
            "revision": revision,
            "event_id": event_id,
        }

    def current(self, participant_id: str, principal: Principal | None) -> dict[str, Any]:
        """Return the latest published prescription event for ``participant_id`` (404 if none)."""
        caller = _require_valid_principal(principal)
        if caller.role == "participant" and participant_id != caller.id:
            self_decision = authorize(
                caller,
                "prescription",
                "read",
                AuthzScope(participant_id=participant_id, is_read_by_id=False),
            )
            _enforce_decision(self_decision)

        participant = self.store.get_latest_entity(participant_id, entity_type="participant")
        if participant is None:
            raise V3Error("NOT_FOUND", "Participant not found.")

        links = self.store.latest_care_links(participant_id=participant_id)
        decision = authorize(
            caller,
            "prescription",
            "read",
            AuthzScope(
                participant_id=participant_id,
                org_id=participant["org_id"],
                is_read_by_id=False,
            ),
            links=links,
        )
        _enforce_decision(decision)

        latest = self.store.get_current_prescription(participant_id)
        if latest is None:
            raise V3Error("NOT_FOUND", "No prescription published for participant.")
        return latest

    def history(self, participant_id: str, principal: Principal | None) -> list[dict[str, Any]]:
        """Return all published prescription events for ``participant_id`` in revision order (therapist only)."""
        caller = _require_valid_principal(principal)
        if caller.role != "therapist":
            raise V3Error("FORBIDDEN", "Only therapist may read prescription history.")

        participant = self.store.get_latest_entity(participant_id, entity_type="participant")
        if participant is None:
            raise V3Error("NOT_FOUND", "Participant not found.")

        links = self.store.latest_care_links(participant_id=participant_id)
        decision = authorize(
            caller,
            "prescription",
            "read",
            AuthzScope(
                participant_id=participant_id,
                org_id=participant["org_id"],
                is_read_by_id=False,
            ),
            links=links,
        )
        _enforce_decision(decision)

        return self.store.list_prescriptions(participant_id)
