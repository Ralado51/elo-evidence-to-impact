"""Generic versioned clinical-entity service for CL06.3 v3 therapist-authored entities.

Implements D-S1a-01-1: one reusable, entity-type-generic service driven by a single
registration table (``DEFAULT_CLINICAL_REGISTRY``) with zero entity-specific branching.
Server sets ``entity_id``, ``version``, ``prev_hash``, ``org_id``, ``participant_id``,
``created_at``, ``author``, ``data_origin``, and ``hash``. Every version passes
``validate_entity`` and ``validate_entity_chain`` and is stored append-only with a
unique ``(entity_id, version)`` constraint (concurrent losing writer -> 409
``ENTITY_VERSION_CONFLICT``).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from elo.canonical import CanonicalizationError

from .authz import ALLOWED_ROLES, AuthzScope, Principal, authorize
from .entities import (
    ENTITY_PREFIX,
    build_entity,
    load_entity_schema,
    new_id,
    utc_now_ms,
    validate,
)
from .errors import V3Error, to_http_error
from .store import V3Store
from .validation import validate_entity, validate_entity_chain

# Top-level envelope keys owned exclusively by the server (S1a-01 Row 3).
# When sent in the top-level request body they are ignored and never reach the stored entity.
SERVER_OWNED_ENVELOPE_FIELDS: frozenset[str] = frozenset(
    {
        "entity_id",
        "entity_type",
        "version",
        "prev_hash",
        "org_id",
        "participant_id",
        "created_at",
        "author",
        "data_origin",
        "origin_ref",
        "hash",
    }
)


@dataclass(frozen=True)
class ClinicalEntitySpec:
    """Registration descriptor for one versioned clinical entity type."""

    entity_type: str
    id_prefix: str
    create_resource: str
    create_action: str
    revise_resource: str
    revise_action: str
    read_resource: str
    read_action: str
    allow_revise: bool = True


DEFAULT_CLINICAL_REGISTRY: dict[str, ClinicalEntitySpec] = {
    "functional_assessment": ClinicalEntitySpec(
        entity_type="functional_assessment",
        id_prefix=ENTITY_PREFIX["functional_assessment"],
        create_resource="functional_assessment",
        create_action="create/revise",
        revise_resource="functional_assessment",
        revise_action="create/revise",
        read_resource="functional_assessment",
        read_action="read",
        allow_revise=True,
    ),
}


def extract_entity_payload(body: dict[str, Any]) -> dict[str, Any]:
    """Extract the client payload dict from a flat or ``{"payload": ...}`` request body.

    Server-owned envelope fields at the top level are ignored (never reaching the stored
    entity). Any non-envelope unknown top-level field in a wrapped body raises 400
    ``UNKNOWN_FIELD``; any unknown field inside ``payload`` is preserved so schema
    validation rejects it with 400 ``UNKNOWN_FIELD``.
    """
    if "payload" in body:
        raw_payload = body["payload"]
        if raw_payload is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'payload' must not be null.")
        if not isinstance(raw_payload, dict):
            raise V3Error("TYPE", "Field 'payload' must be a JSON object.")
        for key in body:
            if key != "payload" and key not in SERVER_OWNED_ENVELOPE_FIELDS:
                raise V3Error("UNKNOWN_FIELD", f"Unknown request field: {key!r}.")
        return dict(raw_payload)

    return {k: v for k, v in body.items() if k not in SERVER_OWNED_ENVELOPE_FIELDS}


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


class ClinicalEntityService:
    """Entity-type-generic service for versioned therapist-authored clinical entities."""

    def __init__(
        self,
        store: V3Store,
        *,
        registry: Mapping[str, ClinicalEntitySpec] | None = None,
    ) -> None:
        self.store = store
        self._registry: dict[str, ClinicalEntitySpec] = {}
        source = DEFAULT_CLINICAL_REGISTRY if registry is None else registry
        for spec in source.values():
            self.register(spec)

    def register(self, spec: ClinicalEntitySpec) -> None:
        """Register a clinical entity type present in ``ENTITY_PREFIX``."""
        if spec.entity_type not in ENTITY_PREFIX:
            raise ValueError(f"Unknown entity type not in ENTITY_PREFIX: {spec.entity_type!r}")
        if spec.id_prefix != ENTITY_PREFIX[spec.entity_type]:
            raise ValueError(
                f"Prefix mismatch for {spec.entity_type!r}: expected {ENTITY_PREFIX[spec.entity_type]!r}, got {spec.id_prefix!r}"
            )
        self._registry[spec.entity_type] = spec

    def get_spec(self, entity_type: str) -> ClinicalEntitySpec:
        spec = self._registry.get(entity_type)
        if spec is None:
            raise V3Error("UNKNOWN_TYPE", f"Entity type {entity_type!r} is not registered.")
        return spec

    def authorize_create(self, entity_type: str, participant_id: str, principal: Principal | None) -> tuple[ClinicalEntitySpec, dict[str, Any]]:
        """Check auth, role, participant existence, and active care-link scope for create."""
        spec = self.get_spec(entity_type)
        caller = _require_valid_principal(principal)

        # Role gate before existence lookup: participant always receives 403 FORBIDDEN.
        role_decision = authorize(caller, spec.create_resource, spec.create_action, AuthzScope())
        if not role_decision.allowed and role_decision.code == "FORBIDDEN":
            raise V3Error("FORBIDDEN", role_decision.reason)

        participant = self.store.get_latest_entity(participant_id, entity_type="participant")
        if participant is None:
            raise V3Error("NOT_FOUND", "Participant not found.")

        links = self.store.latest_care_links(participant_id=participant_id)
        decision = authorize(
            caller,
            spec.create_resource,
            spec.create_action,
            AuthzScope(
                participant_id=participant_id,
                org_id=participant["org_id"],
                is_read_by_id=False,
            ),
            links=links,
        )
        _enforce_decision(decision)
        return spec, participant

    def authorize_revise(
        self,
        entity_id: str,
        principal: Principal | None,
        *,
        expected_entity_type: str | None = None,
    ) -> tuple[ClinicalEntitySpec, list[dict[str, Any]]]:
        """Check auth, role, entity existence/type, and active care-link scope for revise."""
        caller = _require_valid_principal(principal)

        if expected_entity_type is not None:
            expected_spec = self.get_spec(expected_entity_type)
            role_decision = authorize(caller, expected_spec.revise_resource, expected_spec.revise_action, AuthzScope())
            if not role_decision.allowed and role_decision.code == "FORBIDDEN":
                raise V3Error("FORBIDDEN", role_decision.reason)

        versions = self.store.get_entity_versions(entity_id)
        if not versions:
            raise V3Error("NOT_FOUND", "Entity not found.")

        latest = versions[-1]
        actual_type = latest["entity_type"]
        if expected_entity_type is not None and actual_type != expected_entity_type:
            raise V3Error("NOT_FOUND", "Entity not found.")

        spec = self._registry.get(actual_type)
        if spec is None:
            raise V3Error("NOT_FOUND", "Entity not found.")
        if not spec.allow_revise:
            raise V3Error("RULE_VIOLATION", f"Entity type {actual_type!r} does not support revisions.")

        participant_id = latest.get("participant_id")
        links = self.store.latest_care_links(participant_id=participant_id) if participant_id else ()
        decision = authorize(
            caller,
            spec.revise_resource,
            spec.revise_action,
            AuthzScope(
                participant_id=participant_id,
                org_id=latest["org_id"],
                entity_id=entity_id,
                is_read_by_id=True,
            ),
            links=links,
        )
        _enforce_decision(decision)
        return spec, versions

    def authorize_list(self, entity_type: str, participant_id: str, principal: Principal | None) -> ClinicalEntitySpec:
        """Check auth, role, participant existence, and active care-link scope for list."""
        spec = self.get_spec(entity_type)
        caller = _require_valid_principal(principal)

        # Role gate before existence lookup: participant always receives 403 FORBIDDEN when denied.
        role_decision = authorize(caller, spec.read_resource, spec.read_action, AuthzScope())
        if not role_decision.allowed and role_decision.code == "FORBIDDEN":
            raise V3Error("FORBIDDEN", role_decision.reason)

        participant = self.store.get_latest_entity(participant_id, entity_type="participant")
        if participant is None:
            raise V3Error("NOT_FOUND", "Participant not found.")

        links = self.store.latest_care_links(participant_id=participant_id)
        decision = authorize(
            caller,
            spec.read_resource,
            spec.read_action,
            AuthzScope(
                participant_id=participant_id,
                org_id=participant["org_id"],
                is_read_by_id=False,
            ),
            links=links,
        )
        _enforce_decision(decision)
        return spec

    def _build_validated_entity(
        self,
        *,
        entity_type: str,
        entity_id: str,
        version: int,
        prev_hash: str | None,
        org_id: str,
        participant_id: str,
        principal: Principal,
        payload: Any,
        existing: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if payload is None:
            raise V3Error("NULL_NOT_ALLOWED", "Payload must not be null.")
        if not isinstance(payload, dict):
            raise V3Error("TYPE", "Payload must be a JSON object.")

        created_at = utc_now_ms()
        try:
            ent = build_entity(
                entity_type=entity_type,
                entity_id=entity_id,
                version=version,
                prev_hash=prev_hash,
                org_id=org_id,
                participant_id=participant_id,
                author_role=principal.role,
                author_id=principal.id,
                data_origin=self.store.data_origin,
                payload=payload,
                created_at=created_at,
            )
        except CanonicalizationError as exc:
            # Run schema validation first so schema errors are reported accurately even on non-canonical input.
            placeholder: dict[str, Any] = {
                "entity_id": entity_id,
                "entity_type": entity_type,
                "version": version,
                "prev_hash": prev_hash,
                "org_id": org_id,
                "participant_id": participant_id,
                "created_at": created_at,
                "author": {"role": principal.role, "id": principal.id},
                "data_origin": self.store.data_origin,
                "payload": payload,
                "hash": "0" * 64,
            }
            schema = load_entity_schema(entity_type)
            schema_codes = sorted({code for _, code in validate(schema, placeholder)})
            canon_code = "NON_FINITE" if "non-finite" in str(exc).lower() else "NON_CANONICAL"
            codes = sorted(set(schema_codes) | {canon_code})
            raise to_http_error(codes[0], f"Entity validation failed: {', '.join(codes)}", details=codes) from exc

        ent_errs = validate_entity(ent, gate_open=self.store.real_data_gate_open)
        if ent_errs:
            raise to_http_error(ent_errs[0], f"Entity validation failed: {', '.join(ent_errs)}", details=ent_errs)

        chain_errs = validate_entity_chain([*existing, ent])
        if chain_errs:
            raise to_http_error(chain_errs[0], f"Entity chain check failed: {', '.join(chain_errs)}", details=chain_errs)

        return ent

    def create(
        self,
        entity_type: str,
        participant_id: str,
        payload: Any,
        principal: Principal | None,
    ) -> dict[str, Any]:
        """Create version 1 of a registered clinical entity for ``participant_id``."""
        spec, participant = self.authorize_create(entity_type, participant_id, principal)
        assert principal is not None
        entity_id = new_id(spec.id_prefix)
        ent = self._build_validated_entity(
            entity_type=spec.entity_type,
            entity_id=entity_id,
            version=1,
            prev_hash=None,
            org_id=participant["org_id"],
            participant_id=participant_id,
            principal=principal,
            payload=payload,
            existing=[],
        )
        self.store.insert_entity_version(ent, existing=[])
        return ent

    def revise(
        self,
        entity_id: str,
        payload: Any,
        principal: Principal | None,
        *,
        expected_entity_type: str | None = None,
    ) -> dict[str, Any]:
        """Append version ``v+1`` of an existing clinical entity inside one transaction."""
        spec, versions = self.authorize_revise(
            entity_id,
            principal,
            expected_entity_type=expected_entity_type,
        )
        assert principal is not None
        latest = versions[-1]
        ent_next = self._build_validated_entity(
            entity_type=spec.entity_type,
            entity_id=latest["entity_id"],
            version=latest["version"] + 1,
            prev_hash=latest["hash"],
            org_id=latest["org_id"],
            participant_id=latest["participant_id"],
            principal=principal,
            payload=payload,
            existing=versions,
        )
        self.store.insert_entity_version(ent_next, existing=versions)
        return ent_next

    def list(
        self,
        entity_type: str,
        participant_id: str,
        principal: Principal | None,
    ) -> list[dict[str, Any]]:
        """Return latest version of each ``entity_type`` for ``participant_id`` ordered by (created_at, entity_id)."""
        spec = self.authorize_list(entity_type, participant_id, principal)
        return self.store.list_latest_entities(spec.entity_type, participant_id)
