"""CL06.3 v3 authorization policy module covering all 27 rows of authorization-matrix.v3.json.

Deny-code rules (D-S0-02-1):
- Missing/invalid principal -> 401 UNAUTHENTICATED
- Role outside {"participant", "therapist"} -> 403 ROLE_NOT_ALLOWED (PD-08)
- Role not allowed for (resource, action) -> 403 FORBIDDEN
- Role allowed but scope not entitled (not own / not linked / not party) -> 403 SCOPE_VIOLATION,
  except reads addressed by an entity id the principal may not see -> 404 NOT_FOUND.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timezone

from .errors import EMITTABLE_ERROR_CODES

ALLOWED_ROLES: frozenset[str] = frozenset({"participant", "therapist"})


@dataclass(frozen=True)
class Principal:
    role: str
    id: str
    org_id: str


@dataclass(frozen=True)
class CareLinkView:
    entity_id: str
    org_id: str
    participant_id: str
    therapist_id: str
    status: str  # "active" | "revoked"
    valid_from: str  # YYYY-MM-DD
    valid_to: str | None = None  # YYYY-MM-DD or None


@dataclass(frozen=True)
class AuthzScope:
    participant_id: str | None = None
    org_id: str | None = None
    entity_id: str | None = None
    author_id: str | None = None
    draft_kind: str | None = None
    link_therapist_id: str | None = None
    actor_id: str | None = None
    client_authored: bool = False
    is_read_by_id: bool = False
    as_of: date | None = None


@dataclass(frozen=True)
class Decision:
    allowed: bool
    code: str | None = None
    http_status: int = 200
    reason: str = ""


def _deny(code: str, reason: str) -> Decision:
    return Decision(allowed=False, code=code, http_status=EMITTABLE_ERROR_CODES[code], reason=reason)


def _allow(reason: str = "allowed") -> Decision:
    return Decision(allowed=True, code=None, http_status=200, reason=reason)


# Normative 27-row mapping matching contracts/CL06_3-r1/contracts/api/authorization-matrix.v3.json.
# Rule tags per role:
#   "allow"                  : permitted for role (care_link create/revoke checks therapist-is-party when link_therapist_id given)
#   "deny"                   : 403 FORBIDDEN
#   "own"                    : principal.id == scope.participant_id (and same org if org_id given)
#   "linked"                 : active care_link (therapist_id, participant_id) in same org within valid_from..valid_to
#   "own_draft_participant"  : draft author/owner AND draft_kind == "session_report_proposal"
#   "own_draft_author"       : draft visible/mutable only to its author (author_id == principal.id, same org)
#   "event_client_own"       : participant own + actor == principal
#   "event_server_therapist" : server-authored only (client_authored=True -> FORBIDDEN) + linked if participant_id given
#   "role_gate"              : PD-08 meta-row ("any resource", "any")
#   "no_profile"             : PD-08 / REM15 ("companion / acompanhante", "any") -> FORBIDDEN
POLICY_MATRIX: dict[tuple[str, str], dict[str, str]] = {
    ("participant (entity)", "create"): {"participant": "deny", "therapist": "allow"},
    ("participant (entity)", "read"): {"participant": "own", "therapist": "linked"},
    ("care_link", "create/revoke"): {"participant": "deny", "therapist": "allow"},
    ("care_link", "read"): {"participant": "own", "therapist": "linked"},
    ("functional_assessment", "create/revise"): {"participant": "deny", "therapist": "linked"},
    ("functional_assessment", "read"): {"participant": "deny", "therapist": "linked"},
    ("goal", "create/revise/confirm"): {"participant": "deny", "therapist": "linked"},
    ("goal", "read"): {"participant": "own", "therapist": "linked"},
    ("encounter", "create"): {"participant": "deny", "therapist": "linked"},
    ("encounter", "read"): {"participant": "deny", "therapist": "linked"},
    ("reassessment", "create/read"): {"participant": "deny", "therapist": "linked"},
    ("instrumental_measurement", "create/read"): {"participant": "deny", "therapist": "linked"},
    ("prescription", "publish"): {"participant": "deny", "therapist": "linked"},
    ("prescription", "read"): {"participant": "own", "therapist": "linked"},
    ("draft", "create/read/confirm/discard"): {
        "participant": "own_draft_participant",
        "therapist": "own_draft_author",
    },
    ("event: session/capture/report/consent", "append"): {
        "participant": "event_client_own",
        "therapist": "deny",
    },
    ("event: prescription/review/summary/evolution/privacy", "append"): {
        "participant": "deny",
        "therapist": "event_server_therapist",
    },
    ("fact", "read/verify/evidence"): {"participant": "deny", "therapist": "linked"},
    ("review", "record"): {"participant": "deny", "therapist": "linked"},
    ("summary", "publish"): {"participant": "deny", "therapist": "linked"},
    ("summary", "read"): {"participant": "own", "therapist": "linked"},
    ("evolution", "series read / publish"): {"participant": "deny", "therapist": "linked"},
    ("evolution", "read published"): {"participant": "own", "therapist": "linked"},
    ("timeline", "read"): {"participant": "deny", "therapist": "linked"},
    ("health", "read"): {"participant": "allow", "therapist": "allow"},
    ("any resource", "any"): {"participant": "role_gate", "therapist": "role_gate"},
    ("companion / acompanhante", "any"): {"participant": "no_profile", "therapist": "no_profile"},
}


def has_active_care_link(
    principal: Principal,
    participant_id: str | None,
    links: Sequence[CareLinkView],
    *,
    as_of: date | None = None,
    scope_org_id: str | None = None,
) -> bool:
    """Return True iff an active care_link entitles ``principal`` (therapist) to ``participant_id`` in same org on ``as_of``."""
    if principal.role != "therapist" or not participant_id:
        return False
    if scope_org_id is not None and scope_org_id != principal.org_id:
        return False
    today = as_of or datetime.now(timezone.utc).date()
    for link in links:
        if (
            link.therapist_id == principal.id
            and link.participant_id == participant_id
            and link.org_id == principal.org_id
            and link.status == "active"
        ):
            start = date.fromisoformat(link.valid_from)
            end = date.fromisoformat(link.valid_to) if link.valid_to is not None else None
            if start <= today and (end is None or today <= end):
                return True
    return False


def _scope_deny(scope: AuthzScope, reason: str) -> Decision:
    if scope.is_read_by_id:
        return _deny("NOT_FOUND", reason)
    return _deny("SCOPE_VIOLATION", reason)


def authorize(
    principal: Principal | None,
    resource: str,
    action: str,
    scope: AuthzScope | None = None,
    links: Sequence[CareLinkView] = (),
) -> Decision:
    """Single policy decision function for all 27 CL06.3 authorization matrix rows."""
    scope = scope or AuthzScope()

    # Row 25: health allows anonymous requests
    if (resource, action) == ("health", "read") and principal is None:
        return _allow("anonymous health read allowed")

    if principal is None:
        return _deny("UNAUTHENTICATED", "authentication required")

    # PD-08 / Row 26: strictly two roles exist
    if principal.role not in ALLOWED_ROLES:
        return _deny("ROLE_NOT_ALLOWED", f"role {principal.role!r} is not allowed (PD-08)")

    entry = POLICY_MATRIX.get((resource, action))
    if entry is None:
        return _deny("FORBIDDEN", f"unmapped resource/action ({resource!r}, {action!r})")

    rule = entry[principal.role]

    if rule == "deny":
        return _deny("FORBIDDEN", f"role {principal.role!r} is denied for ({resource}, {action})")

    if rule == "no_profile":
        return _deny("FORBIDDEN", "companion/acompanhante profile does not exist in v3 (PD-08)")

    if rule == "role_gate":
        return _allow("role is in {participant, therapist}")

    if rule == "allow":
        if (resource, action) == ("care_link", "create/revoke"):
            if scope.org_id is not None and scope.org_id != principal.org_id:
                return _deny("SCOPE_VIOLATION", "care_link belongs to another organization")
            if scope.link_therapist_id is not None and scope.link_therapist_id != principal.id:
                return _deny("SCOPE_VIOLATION", "therapist is not a party to this care_link")
        return _allow("role allowed")

    if rule == "own":
        if scope.org_id is not None and scope.org_id != principal.org_id:
            return _scope_deny(scope, "organization mismatch")
        if scope.participant_id != principal.id:
            return _scope_deny(scope, "participant may access own scope only")
        return _allow("own scope matched")

    if rule == "linked":
        if not has_active_care_link(
            principal,
            scope.participant_id,
            links,
            as_of=scope.as_of,
            scope_org_id=scope.org_id,
        ):
            return _scope_deny(scope, "no active care_link in same org within validity window")
        return _allow("active care_link verified")

    if rule == "own_draft_participant":
        if scope.draft_kind is not None and scope.draft_kind != "session_report_proposal":
            return _deny("FORBIDDEN", "participant drafts are limited to session_report_proposal")
        if scope.org_id is not None and scope.org_id != principal.org_id:
            return _scope_deny(scope, "draft organization mismatch")
        if scope.author_id is not None and scope.author_id != principal.id:
            return _scope_deny(scope, "draft visible only to its author")
        if scope.participant_id is not None and scope.participant_id != principal.id:
            return _scope_deny(scope, "participant may access own drafts only")
        return _allow("participant own session_report_proposal draft")

    if rule == "own_draft_author":
        if scope.org_id is not None and scope.org_id != principal.org_id:
            return _scope_deny(scope, "draft organization mismatch")
        if scope.author_id is not None and scope.author_id != principal.id:
            return _scope_deny(scope, "draft visible only to its author")
        if scope.author_id is None and scope.participant_id is not None:
            if not has_active_care_link(
                principal,
                scope.participant_id,
                links,
                as_of=scope.as_of,
                scope_org_id=scope.org_id,
            ):
                return _scope_deny(scope, "therapist must be linked to participant to draft")
        return _allow("therapist own draft")

    if rule == "event_client_own":
        if scope.org_id is not None and scope.org_id != principal.org_id:
            return _deny("SCOPE_VIOLATION", "event organization mismatch")
        if scope.participant_id != principal.id:
            return _deny("SCOPE_VIOLATION", "participant may append events only to own scope")
        if scope.actor_id is not None and scope.actor_id != principal.id:
            return _deny("SCOPE_VIOLATION", "event actor must equal authenticated principal")
        return _allow("participant own client-authored event")

    if rule == "event_server_therapist":
        if scope.client_authored:
            return _deny("FORBIDDEN", "server-authored event types cannot be appended by clients")
        if scope.participant_id is not None and not has_active_care_link(
            principal,
            scope.participant_id,
            links,
            as_of=scope.as_of,
            scope_org_id=scope.org_id,
        ):
            return _deny("SCOPE_VIOLATION", "therapist not linked to participant for server-authored event")
        return _allow("server-authored event under linked therapist principal")

    return _deny("FORBIDDEN", f"unknown policy rule {rule!r}")
