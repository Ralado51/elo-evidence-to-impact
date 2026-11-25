"""Server-authored review recording, publication gate, and immutable summaries (CL06.3 v3, S1b-03).

Implements D-S1b-03-1:
- ``reviews.record`` (POST /api/v3/reviews):
  Request = ``review.recorded`` payload minus server fields (``fact_id``, ``content_hash``,
  ``decision``, ``note``; optional ``participant_id``). Verifies the fact via S1b-02
  ``derive_facts`` / ``verify_fact``; checks ``content_hash`` against the fact's current
  content hash (mismatch -> 409 ``CONTENT_HASH_STALE``; unknown/unverifiable -> 404
  ``NOT_FOUND``); stores one server-authored ``review.recorded`` event on stream
  ``review:<therapist_id>.<participant_id>``; returns 201 ``{event_id, review}``.
- Effective review of a fact = latest ``review.recorded`` for that ``fact_id`` with a
  status-changing decision (``approve`` or ``reject``), ordered by server append order;
  ``annotate`` never changes effective status.
- ``summaries.publish`` (POST /api/v3/summaries):
  Request = ``{participant_id, fact_ids, summary_id?}`` (optional ``period_from``,
  ``period_to``, ``note_refs``). Enforces publication gate on every requested ``fact_id``:
    * never reviewed / only annotated -> 422 ``FACT_NOT_APPROVED``
    * effective review is ``reject`` -> 422 ``FACT_NOT_APPROVED``
    * effective ``approve`` whose ``content_hash`` != current hash, or whose ``fact_id``
      no longer derives from the ledger -> 409 ``CONTENT_HASH_STALE``
    * ``fact_id`` never seen in any review and not derivable -> 404 ``NOT_FOUND``
    * non-summary-eligible fact (``F09``/``F10``) -> 422 ``FACT_NOT_SUMMARY_ELIGIBLE``
  Any failure publishes nothing. Stores one immutable ``summary.published`` event;
  same ``summary_id`` with identical content -> 200 idempotent; different content ->
  409 ``CONFLICT_IMMUTABLE``. Returns ``{summary_id, event_id}``.
- ``summaries.get`` (GET /api/v3/summaries/{summary_id}):
  * Linked therapist -> full ``summary.published`` event.
  * Participant (own) -> simplified view containing only ``summary_id``, ``published_at``,
    and ``rendered_facts`` (each ``{text_ptbr, limitations_ptbr}``).
  * Other / unlinked / revoked / other org -> 404 ``NOT_FOUND`` (D-S0-02-1).
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import date
from typing import Any

from elo.canonical import compute_event_hash, compute_event_id, hash_canonical

from .authz import ALLOWED_ROLES, AuthzScope, Principal, authorize
from .entities import new_id, utc_now_ms
from .errors import V3Error
from .store import V3Store
from .verifier import derive_facts, verify_fact

_PARTICIPANT_ID_RE = re.compile(r"^p_[A-Za-z0-9-]{8,64}$")
_SUMMARY_ID_RE = re.compile(r"^sum_[A-Za-z0-9-]{8,64}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")

_VALID_DECISIONS: frozenset[str] = frozenset({"approve", "reject", "annotate"})
_STATUS_CHANGING_DECISIONS: frozenset[str] = frozenset({"approve", "reject"})

# Server-owned event envelope fields (ignored if client passes them on reviews.record / summaries.publish).
_SERVER_OWNED_ENVELOPE_FIELDS: frozenset[str] = frozenset(
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

_REVIEW_ALLOWED_FIELDS: frozenset[str] = frozenset({"fact_id", "content_hash", "decision", "note", "participant_id"})
_SUMMARY_ALLOWED_FIELDS: frozenset[str] = frozenset(
    {"participant_id", "fact_ids", "summary_id", "period_from", "period_to", "note_refs"}
)


def _require_valid_principal(principal: Principal | None) -> Principal:
    if principal is None:
        raise V3Error("UNAUTHENTICATED", "Authentication required.")
    if principal.role not in ALLOWED_ROLES:
        raise V3Error("ROLE_NOT_ALLOWED", f"Role {principal.role!r} is not allowed (PD-08).")
    return principal


def _enforce_decision(decision: Any) -> None:
    if not decision.allowed:
        assert decision.code is not None
        raise V3Error(decision.code, decision.reason)


def _proposal_from_fact(fact: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "type": fact["type"],
        "catalog_version": fact["catalog_version"],
        "params": fact["params"],
        "evidence_refs": fact["evidence_refs"],
        "scope": fact["scope"],
        "data_origin": fact["data_origin"],
    }


def _is_valid_date_str(value: str) -> bool:
    if not _DATE_RE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def resolve_effective_reviews(
    review_events: Sequence[Mapping[str, Any]],
) -> tuple[set[str], dict[str, Mapping[str, Any]]]:
    """Fold ``review.recorded`` events in server append order (D-S1b-03-1(2)).

    Returns ``(seen_fact_ids, effective_by_fact_id)`` where ``effective_by_fact_id[fid]``
    is the latest ``review.recorded`` event for ``fid`` whose decision is ``approve`` or
    ``reject``; ``annotate`` never alters effective status.
    """
    seen: set[str] = set()
    effective: dict[str, Mapping[str, Any]] = {}
    for ev in review_events:
        if ev.get("type") != "review.recorded":
            continue
        payload = ev.get("payload")
        if not isinstance(payload, Mapping):
            continue
        fid = payload.get("fact_id")
        decision = payload.get("decision")
        if not isinstance(fid, str):
            continue
        seen.add(fid)
        if decision in _STATUS_CHANGING_DECISIONS:
            effective[fid] = ev
    return seen, effective


def _extract_review_payload(body: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    """Extract client review fields from flat body or ``{"payload": ...}``, ignoring server envelope fields."""
    participant_id: str | None = None
    if "participant_id" in body:
        pid_raw = body["participant_id"]
        if pid_raw is not None:
            if not isinstance(pid_raw, str):
                raise V3Error("TYPE", "Field 'participant_id' must be a string.")
            participant_id = pid_raw

    if "payload" in body:
        raw_payload = body["payload"]
        if raw_payload is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'payload' must not be null.")
        if not isinstance(raw_payload, dict):
            raise V3Error("TYPE", "Field 'payload' must be a JSON object.")
        for key in body:
            if key not in ("payload", "participant_id") and key not in _SERVER_OWNED_ENVELOPE_FIELDS:
                raise V3Error("UNKNOWN_FIELD", f"Unknown request field: {key!r}.")
        source = dict(raw_payload)
    else:
        source = {k: v for k, v in body.items() if k not in _SERVER_OWNED_ENVELOPE_FIELDS}

    for key in source:
        if key not in _REVIEW_ALLOWED_FIELDS:
            raise V3Error("UNKNOWN_FIELD", f"Unknown review field: {key!r}.")
    if "participant_id" in source and participant_id is None:
        pid_raw = source["participant_id"]
        if pid_raw is not None:
            if not isinstance(pid_raw, str):
                raise V3Error("TYPE", "Field 'participant_id' must be a string.")
            participant_id = pid_raw
    source.pop("participant_id", None)
    return source, participant_id


def _project_summary_for_participant(
    event: Mapping[str, Any],
    rendered_items: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Simplified participant summary view per D-S1b-03-1(1) & ACCEPTANCE Row 7.

    Contains ONLY ``summary_id``, ``published_at``, and ``rendered_facts`` (each with
    ``text_ptbr`` and ``limitations_ptbr`` — no internal ids, hashes, therapist actor,
    or clinical review note refs).
    """
    return {
        "summary_id": event["payload"]["summary_id"],
        "published_at": event["occurred_at"],
        "rendered_facts": [
            {
                "text_ptbr": str(item["text_ptbr"]),
                "limitations_ptbr": list(item.get("limitations_ptbr", [])),
            }
            for item in rendered_items
        ],
    }


class ReviewSummaryService:
    """Server-authored review recording, publication gate, and immutable summary service."""

    def __init__(self, store: V3Store) -> None:
        self.store = store

    def authorize_review_role(self, principal: Principal | None) -> Principal:
        caller = _require_valid_principal(principal)
        decision = authorize(caller, "review", "record", AuthzScope())
        if not decision.allowed and decision.code in ("FORBIDDEN", "ROLE_NOT_ALLOWED", "UNAUTHENTICATED"):
            raise V3Error(decision.code, decision.reason)
        return caller

    def authorize_summary_publish_role(self, principal: Principal | None) -> Principal:
        caller = _require_valid_principal(principal)
        decision = authorize(caller, "summary", "publish", AuthzScope())
        if not decision.allowed and decision.code in ("FORBIDDEN", "ROLE_NOT_ALLOWED", "UNAUTHENTICATED"):
            raise V3Error(decision.code, decision.reason)
        return caller

    def _resolve_participant_org(self, participant_id: str) -> str | None:
        p_ent = self.store.get_latest_entity(participant_id, entity_type="participant")
        if p_ent is not None:
            return str(p_ent["org_id"])
        evs = self.store.get_participant_events(participant_id)
        if evs:
            org = evs[0].get("scope", {}).get("org_id")
            return str(org) if isinstance(org, str) else None
        return None

    def _authorize_participant_action(
        self,
        caller: Principal,
        resource: str,
        action: str,
        participant_id: str,
        org_id: str | None,
    ) -> None:
        links = self.store.latest_care_links(participant_id=participant_id)
        decision = authorize(
            caller,
            resource,
            action,
            AuthzScope(participant_id=participant_id, org_id=org_id, is_read_by_id=False),
            links=links,
        )
        _enforce_decision(decision)

    def record_review(self, body: dict[str, Any], principal: Principal | None) -> dict[str, Any]:
        """Validate and store a server-authored ``review.recorded`` event (D-S1b-03-1(1))."""
        caller = self.authorize_review_role(principal)
        fields, req_pid = _extract_review_payload(body)

        # Validate required client fields
        if "fact_id" not in fields:
            raise V3Error("MISSING_FIELD", "Missing required field 'fact_id'.")
        fact_id = fields["fact_id"]
        if fact_id is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'fact_id' must not be null.")
        if not isinstance(fact_id, str):
            raise V3Error("TYPE", "Field 'fact_id' must be a string.")

        if "content_hash" not in fields:
            raise V3Error("MISSING_FIELD", "Missing required field 'content_hash'.")
        content_hash = fields["content_hash"]
        if content_hash is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'content_hash' must not be null.")
        if not isinstance(content_hash, str):
            raise V3Error("TYPE", "Field 'content_hash' must be a string.")

        if "decision" not in fields:
            raise V3Error("MISSING_FIELD", "Missing required field 'decision'.")
        decision_val = fields["decision"]
        if decision_val is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'decision' must not be null.")
        if not isinstance(decision_val, str):
            raise V3Error("TYPE", "Field 'decision' must be a string.")
        if decision_val not in _VALID_DECISIONS:
            raise V3Error("ENUM", f"Invalid review decision: {decision_val!r}.")

        note = fields.get("note", None)
        if note is not None:
            if not isinstance(note, str):
                raise V3Error("TYPE", "Field 'note' must be a string or null.")
            if len(note) < 1 or len(note) > 1000:
                raise V3Error("LENGTH", "Field 'note' length must be between 1 and 1000.")

        # Resolve participant & currently verified fact via S1b-02 verifier
        matched_fact: dict[str, Any] | None = None
        current_hash: str | None = None
        target_pid: str | None = None
        target_org: str | None = None

        if req_pid is not None:
            if not _PARTICIPANT_ID_RE.fullmatch(req_pid):
                raise V3Error("PATTERN", "Field 'participant_id' must match ^p_[A-Za-z0-9-]{8,64}$.")
            org_id = self._resolve_participant_org(req_pid)
            if org_id is None:
                raise V3Error("NOT_FOUND", "Participant not found.")
            self._authorize_participant_action(caller, "review", "record", req_pid, org_id)

            p_events = self.store.get_participant_events(req_pid)
            facts, hashes = derive_facts(p_events, participant_id=req_pid)
            for fact in facts:
                if fact["fact_id"] == fact_id:
                    recheck = verify_fact(_proposal_from_fact(fact), p_events)
                    if recheck["valid"] and recheck["content_hash"] is not None:
                        matched_fact = recheck["fact"]
                        current_hash = str(recheck["content_hash"])
                    break
            target_pid = req_pid
            target_org = org_id
        else:
            all_events = self.store.get_all_events()
            facts, hashes = derive_facts(all_events)
            for fact in facts:
                if fact["fact_id"] == fact_id:
                    target_pid = str(fact["scope"]["participant_id"])
                    target_org = str(fact["scope"]["org_id"])
                    # Authorize BEFORE disclosing hash match/mismatch
                    self._authorize_participant_action(caller, "review", "record", target_pid, target_org)
                    p_events = self.store.get_participant_events(target_pid)
                    recheck = verify_fact(_proposal_from_fact(fact), p_events)
                    if recheck["valid"] and recheck["content_hash"] is not None:
                        matched_fact = recheck["fact"]
                        current_hash = str(recheck["content_hash"])
                    break
            if matched_fact is None:
                # If fact_id appeared in an earlier review, enforce scope before returning 404
                for rev in reversed(self.store.get_all_reviews()):
                    if rev.get("payload", {}).get("fact_id") == fact_id:
                        rev_pid = str(rev["scope"]["participant_id"])
                        rev_org = str(rev["scope"]["org_id"])
                        self._authorize_participant_action(caller, "review", "record", rev_pid, rev_org)
                        break

        if matched_fact is None or current_hash is None or target_pid is None or target_org is None:
            raise V3Error("NOT_FOUND", "Fact not found or no longer verifiable.")

        if content_hash != current_hash:
            raise V3Error(
                "CONTENT_HASH_STALE",
                "Supplied content_hash does not match the fact's current content_hash.",
            )

        stream_id = f"review:{caller.id}.{target_pid}"
        now_ms = utc_now_ms()

        def _build_review(seq: int, prev_hash: str | None) -> dict[str, Any]:
            ev_wo_hash: dict[str, Any] = {
                "event_id": compute_event_id(stream_id, seq),
                "schema_version": 3,
                "type": "review.recorded",
                "stream_id": stream_id,
                "seq": seq,
                "prev_hash": prev_hash,
                "occurred_at": now_ms,
                "actor": {"role": "therapist", "id": caller.id},
                "scope": {"org_id": target_org, "participant_id": target_pid},
                "source": {"type": "therapist"},
                "execution_mode": "not_applicable",
                "data_origin": self.store.data_origin,
                "payload": {
                    "fact_id": fact_id,
                    "content_hash": current_hash,
                    "decision": decision_val,
                    "note": note,
                },
            }
            return {**ev_wo_hash, "hash": compute_event_hash(ev_wo_hash)}

        stored_event = self.store.append_review_event(stream_id, _build_review)
        return {
            "event_id": stored_event["event_id"],
            "review": stored_event,
        }

    def publish_summary(self, body: dict[str, Any], principal: Principal | None) -> tuple[dict[str, Any], int]:
        """Enforce publication gate and publish an immutable ``summary.published`` event (D-S1b-03-1)."""
        caller = self.authorize_summary_publish_role(principal)

        clean_body = {k: v for k, v in body.items() if k not in _SERVER_OWNED_ENVELOPE_FIELDS}
        for key in clean_body:
            if key not in _SUMMARY_ALLOWED_FIELDS:
                raise V3Error("UNKNOWN_FIELD", f"Unknown summary publish field: {key!r}.")

        if "participant_id" not in clean_body:
            raise V3Error("MISSING_FIELD", "Missing required field 'participant_id'.")
        participant_id = clean_body["participant_id"]
        if participant_id is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'participant_id' must not be null.")
        if not isinstance(participant_id, str):
            raise V3Error("TYPE", "Field 'participant_id' must be a string.")
        if not _PARTICIPANT_ID_RE.fullmatch(participant_id):
            raise V3Error("PATTERN", "Field 'participant_id' must match ^p_[A-Za-z0-9-]{8,64}$.")

        org_id = self._resolve_participant_org(participant_id)
        if org_id is None:
            raise V3Error("NOT_FOUND", "Participant not found.")
        self._authorize_participant_action(caller, "summary", "publish", participant_id, org_id)

        if "fact_ids" not in clean_body:
            raise V3Error("MISSING_FIELD", "Missing required field 'fact_ids'.")
        fact_ids = clean_body["fact_ids"]
        if fact_ids is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'fact_ids' must not be null.")
        if not isinstance(fact_ids, list):
            raise V3Error("TYPE", "Field 'fact_ids' must be an array.")
        if len(fact_ids) < 1 or len(fact_ids) > 500:
            raise V3Error("LENGTH", "Field 'fact_ids' must contain between 1 and 500 items.")
        for fid in fact_ids:
            if fid is None:
                raise V3Error("NULL_NOT_ALLOWED", "Items in 'fact_ids' must not be null.")
            if not isinstance(fid, str):
                raise V3Error("TYPE", "Items in 'fact_ids' must be strings.")
        if len(set(fact_ids)) != len(fact_ids):
            raise V3Error("DUPLICATE_ITEM", "Field 'fact_ids' must not contain duplicate items.")

        req_summary_id = clean_body.get("summary_id")
        if req_summary_id is not None:
            if not isinstance(req_summary_id, str):
                raise V3Error("TYPE", "Field 'summary_id' must be a string.")
            if not _SUMMARY_ID_RE.fullmatch(req_summary_id):
                raise V3Error("PATTERN", "Field 'summary_id' must match ^sum_[A-Za-z0-9-]{8,64}$.")
            summary_id = req_summary_id
        else:
            summary_id = new_id("sum")

        req_period_from = clean_body.get("period_from")
        if req_period_from is not None:
            if not isinstance(req_period_from, str):
                raise V3Error("TYPE", "Field 'period_from' must be a string.")
            if not _is_valid_date_str(req_period_from):
                raise V3Error("PATTERN", "Field 'period_from' must be a valid YYYY-MM-DD date.")

        req_period_to = clean_body.get("period_to")
        if req_period_to is not None:
            if not isinstance(req_period_to, str):
                raise V3Error("TYPE", "Field 'period_to' must be a string.")
            if not _is_valid_date_str(req_period_to):
                raise V3Error("PATTERN", "Field 'period_to' must be a valid YYYY-MM-DD date.")

        raw_note_refs = clean_body.get("note_refs", [])
        if raw_note_refs is None:
            raise V3Error("NULL_NOT_ALLOWED", "Field 'note_refs' must not be null.")
        if not isinstance(raw_note_refs, list):
            raise V3Error("TYPE", "Field 'note_refs' must be an array.")
        if len(raw_note_refs) > 500:
            raise V3Error("LENGTH", "Field 'note_refs' exceeds maximum length of 500.")
        for nref in raw_note_refs:
            if not isinstance(nref, str):
                raise V3Error("TYPE", "Items in 'note_refs' must be strings.")
            if not _SHA256_RE.fullmatch(nref):
                raise V3Error("PATTERN", "Items in 'note_refs' must be 64-char hex sha256 strings.")
        if len(set(raw_note_refs)) != len(raw_note_refs):
            raise V3Error("DUPLICATE_ITEM", "Field 'note_refs' must not contain duplicates.")
        note_refs = sorted(raw_note_refs)

        # Derive and verify current facts for participant via S1b-02 verifier
        p_events = self.store.get_participant_events(participant_id)
        current_facts, current_hashes = derive_facts(p_events, participant_id=participant_id)
        facts_by_id = {f["fact_id"]: f for f in current_facts}

        # Fold reviews in exact server append order (D-S1b-03-1(2))
        review_events = self.store.get_participant_reviews(participant_id)
        seen_fact_ids, effective_reviews = resolve_effective_reviews(review_events)

        # Publication gate check across ALL requested fact_ids before writing anything (D-S1b-03-1(3))
        verified_selected: list[tuple[dict[str, Any], str]] = []
        for fid in fact_ids:
            cur_fact = facts_by_id.get(fid)
            eff = effective_reviews.get(fid)

            if cur_fact is None:
                if eff is not None and eff["payload"]["decision"] == "approve":
                    raise V3Error(
                        "CONTENT_HASH_STALE",
                        f"Approved fact {fid!r} no longer derives from the current ledger.",
                    )
                if eff is not None and eff["payload"]["decision"] == "reject":
                    raise V3Error(
                        "FACT_NOT_APPROVED",
                        f"Fact {fid!r} has an effective reject decision.",
                    )
                if fid in seen_fact_ids:
                    raise V3Error(
                        "FACT_NOT_APPROVED",
                        f"Fact {fid!r} has no approving review.",
                    )
                raise V3Error("NOT_FOUND", f"Fact {fid!r} not found.")

            # Re-verify current fact through single normative verify_fact
            recheck = verify_fact(_proposal_from_fact(cur_fact), p_events)
            if not recheck["valid"] or recheck["fact"] is None or recheck["content_hash"] is None:
                if eff is not None and eff["payload"]["decision"] == "approve":
                    raise V3Error(
                        "CONTENT_HASH_STALE",
                        f"Approved fact {fid!r} no longer verifies against the current ledger.",
                    )
                raise V3Error("NOT_FOUND", f"Fact {fid!r} no longer verifies.")

            cur_hash = str(recheck["content_hash"])
            cur_verified_fact = recheck["fact"]

            if eff is None:
                raise V3Error("FACT_NOT_APPROVED", f"Fact {fid!r} has not been approved.")
            if eff["payload"]["decision"] != "approve":
                raise V3Error("FACT_NOT_APPROVED", f"Fact {fid!r} has effective decision {eff['payload']['decision']!r}.")
            if eff["payload"]["content_hash"] != cur_hash:
                raise V3Error(
                    "CONTENT_HASH_STALE",
                    f"Approving review for fact {fid!r} cites a stale content_hash.",
                )
            if not cur_verified_fact["flags"].get("summary_eligible", False):
                raise V3Error(
                    "FACT_NOT_SUMMARY_ELIGIBLE",
                    f"Fact {fid!r} of type {cur_verified_fact['type']!r} is not eligible for summaries.",
                )

            verified_selected.append((cur_verified_fact, cur_hash))

        # Canonical item ordering by fact_id so set-equivalent republish has identical content_hash
        verified_selected.sort(key=lambda pair: pair[0]["fact_id"])

        items = [
            {"fact_id": fact["fact_id"], "content_hash": chash}
            for fact, chash in verified_selected
        ]
        rendered_items = [
            {
                "fact_id": fact["fact_id"],
                "type": fact["type"],
                "text_ptbr": fact["rendered"]["text_ptbr"],
                "limitations_ptbr": list(fact["rendered"]["limitations_ptbr"]),
            }
            for fact, _ in verified_selected
        ]

        dates = [str(fact["params"]["session_date_local"]) for fact, _ in verified_selected]
        period_from = req_period_from if req_period_from is not None else min(dates)
        period_to = req_period_to if req_period_to is not None else max(dates)
        if period_to < period_from:
            raise V3Error("RULE_VIOLATION", "period_to must not be earlier than period_from.")

        payload_wo_hash: dict[str, Any] = {
            "summary_id": summary_id,
            "period_from": period_from,
            "period_to": period_to,
            "items": items,
            "note_refs": note_refs,
        }
        summary_content_hash = hash_canonical(payload_wo_hash)
        payload = {**payload_wo_hash, "content_hash": summary_content_hash}

        stream_id = f"review:{caller.id}.{participant_id}"
        now_ms = utc_now_ms()

        def _build_summary(seq: int, prev_hash: str | None) -> dict[str, Any]:
            ev_wo_hash: dict[str, Any] = {
                "event_id": compute_event_id(stream_id, seq),
                "schema_version": 3,
                "type": "summary.published",
                "stream_id": stream_id,
                "seq": seq,
                "prev_hash": prev_hash,
                "occurred_at": now_ms,
                "actor": {"role": "therapist", "id": caller.id},
                "scope": {"org_id": org_id, "participant_id": participant_id},
                "source": {"type": "therapist"},
                "execution_mode": "not_applicable",
                "data_origin": self.store.data_origin,
                "payload": payload,
            }
            return {**ev_wo_hash, "hash": compute_event_hash(ev_wo_hash)}

        stored_event, created = self.store.publish_summary_event(
            stream_id=stream_id,
            summary_id=summary_id,
            org_id=org_id,
            participant_id=participant_id,
            content_hash=summary_content_hash,
            rendered_items=rendered_items,
            build_event_fn=_build_summary,
        )
        return (
            {
                "summary_id": summary_id,
                "event_id": stored_event["event_id"],
            },
            201 if created else 200,
        )

    def get_summary(self, summary_id: str, principal: Principal | None) -> dict[str, Any]:
        """Return full ``summary.published`` event (linked therapist) or simplified view (own participant)."""
        caller = _require_valid_principal(principal)
        if not _SUMMARY_ID_RE.fullmatch(summary_id):
            raise V3Error("NOT_FOUND", "Summary not found.")

        record = self.store.get_summary_record(summary_id)
        if record is None:
            raise V3Error("NOT_FOUND", "Summary not found.")

        event, rendered_items = record
        participant_id = str(event["scope"]["participant_id"])
        org_id = str(event["scope"]["org_id"])

        links = self.store.latest_care_links(participant_id=participant_id)
        decision = authorize(
            caller,
            "summary",
            "read",
            AuthzScope(participant_id=participant_id, org_id=org_id, is_read_by_id=True),
            links=links,
        )
        _enforce_decision(decision)

        if caller.role == "therapist":
            return event

        # Participant simplified view (D-S1b-03-1(1) & Row 7)
        if rendered_items is None:
            p_events = self.store.get_participant_events(participant_id)
            facts, _ = derive_facts(p_events, participant_id=participant_id)
            by_id = {f["fact_id"]: f for f in facts}
            rendered_items = [
                {
                    "text_ptbr": by_id[it["fact_id"]]["rendered"]["text_ptbr"],
                    "limitations_ptbr": list(by_id[it["fact_id"]]["rendered"]["limitations_ptbr"]),
                }
                for it in event["payload"]["items"]
                if it["fact_id"] in by_id
            ]
        return _project_summary_for_participant(event, rendered_items)
