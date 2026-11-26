"""Read-only convenience views for the Elo UIs (``/api/console/v1``).

NOT part of the CL06.3-r1 clinical contract: it adds no write path, no new entity and no new
verification logic. It only answers "which records exist for me?" so that screens do not make
people type internal identifiers. Authorization reuses the contract's ``authorize`` function and the
same bearer tokens; the contract routes remain the only way to read record contents.
See docs/PROPOSTA_API_CONSOLE.md.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .v3.authz import AuthzScope, authorize
from .v3.errors import V3Error
from .v3.auth import AuthService
from .v3.store import V3Store

_MAX_Q = 40
_MAX_ITEMS = 200


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def create_console_router(store: V3Store, auth: AuthService) -> APIRouter:
    router = APIRouter(prefix="/api/console/v1")

    @router.get("/participants")
    def participants(request: Request):
        """Participants the calling therapist is actively linked to, optionally filtered by alias."""
        principal = auth.require_principal(request)
        if principal.role != "therapist":
            raise V3Error("FORBIDDEN", "Only therapist may list linked participants.")
        q = (request.query_params.get("q") or "").strip()
        if len(q) > _MAX_Q:
            raise V3Error("OUT_OF_RANGE", f"q must have at most {_MAX_Q} characters.")
        today = _today()
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for link in store.latest_care_links():
            if link.therapist_id != principal.id or link.org_id != principal.org_id:
                continue
            if link.status != "active" or link.valid_from > today or (link.valid_to is not None and link.valid_to < today):
                continue
            if link.participant_id in seen:
                continue
            decision = authorize(
                principal,
                "care_link",
                "read",
                AuthzScope(participant_id=link.participant_id, org_id=principal.org_id, is_read_by_id=False),
                links=store.latest_care_links(participant_id=link.participant_id),
            )
            if not decision.allowed:
                continue
            ent = store.get_latest_entity(link.participant_id, entity_type="participant")
            if ent is None:
                continue
            alias = str(ent["payload"].get("alias", ""))
            if q and q.casefold() not in alias.casefold() and q.casefold() not in link.participant_id.casefold():
                continue
            seen.add(link.participant_id)
            out.append(
                {
                    "participant_id": link.participant_id,
                    "alias": alias,
                    "side": ent["payload"].get("side"),
                    "care_link_id": link.entity_id,
                    "created_at": ent["created_at"],
                }
            )
        out.sort(key=lambda r: (r["alias"].casefold(), r["participant_id"]))
        return JSONResponse({"participants": out[:_MAX_ITEMS], "total": len(out)})

    @router.get("/participants/{participant_id}/publications")
    def publications(participant_id: str, request: Request):
        """Identifiers of summaries and evolutions published for a participant (content is read via contract routes)."""
        principal = auth.require_principal(request)
        if principal.role == "participant" and principal.id != participant_id:
            raise V3Error("FORBIDDEN", "Participants may only list their own publications.")
        ent = store.get_latest_entity(participant_id, entity_type="participant")
        if ent is None:
            raise V3Error("NOT_FOUND", "Participant not found.")
        decision = authorize(
            principal,
            "summary",
            "read",
            AuthzScope(participant_id=participant_id, org_id=ent["org_id"], is_read_by_id=False),
            links=store.latest_care_links(participant_id=participant_id),
        )
        if not decision.allowed:
            assert decision.code is not None
            raise V3Error(decision.code, decision.reason)
        led = store.ledger
        with led._lock:
            s_rows = led.db.execute(
                """SELECT s.summary_id, e.data FROM v3_summaries s JOIN v3_events e ON e.event_id = s.event_id
                   WHERE s.participant_id = ? ORDER BY e.rowid ASC""",
                (participant_id,),
            ).fetchall()
            e_rows = led.db.execute(
                """SELECT v.evolution_id, e.data FROM v3_evolutions v JOIN v3_events e ON e.event_id = v.event_id
                   WHERE v.participant_id = ? ORDER BY e.rowid ASC""",
                (participant_id,),
            ).fetchall()

        def _row(kind: str, rid: str, raw: str) -> dict[str, Any]:
            ev = json.loads(raw)
            p = ev.get("payload", {})
            return {
                "kind": kind,
                "id": rid,
                "published_at": ev.get("occurred_at"),
                "period_from": p.get("period_from"),
                "period_to": p.get("period_to"),
            }

        items = [_row("summary", r[0], r[1]) for r in s_rows] + [_row("evolution", r[0], r[1]) for r in e_rows]
        items.sort(key=lambda i: (i["published_at"] or "", i["id"]), reverse=True)
        return JSONResponse({"participant_id": participant_id, "publications": items})

    return router
