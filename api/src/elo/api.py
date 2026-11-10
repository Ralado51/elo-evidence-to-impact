"""HTTP API (FastAPI). Every route is a thin layer over the tested core; no rule lives here.

Privacy: text goes through the PrivacyGate before extraction. If the gate blocks it, the answer
lists the KINDS of data found, never the data. The patient list returns pseudonyms only.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from collections import defaultdict, deque
from datetime import date

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .attendance import STATUSES, adherence
from .contract import Assistance, Claim, Environment, Note, Verdict
from .extraction import ExtractionContext, ExtractionError, MODES, extract_note
from .gaps import evidence_map
from .goals import Goal, check_goal, render_check
from .llm import OpenAICompatibleClient
from .packs import load_pack
from .privacy import PrivacyBlocked, PrivacyGate
from .registry_store import PersistentRegistry
from .review import ReviewError, ReviewService
from .summary import build_family_summary

MAX_NOTE_CHARS = 4000
RATE_LIMIT = (120, 60.0)  # requests per window (seconds) per client

SYNTHETIC_NOTICE = {
    "pt-BR": "Ferramenta de demonstração. Use apenas dados sintéticos (fictícios). Não faz diagnóstico nem prescrição.",
    "en": "Demonstration tool. Use synthetic (fictional) data only. It does not diagnose or prescribe.",
}


class CaseIn(BaseModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    label: str = Field(min_length=1, max_length=80)


class PersonIn(BaseModel):
    role: str = Field(pattern="^(patient|caregiver|professional|other)$")
    full_name: str = Field(min_length=2, max_length=120)
    pseudonym: str = Field(min_length=1, max_length=40)
    aliases: list[str] = Field(default_factory=list, max_length=8)


class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_NOTE_CHARS)
    session_date: date
    observed_by: str = Field(default="therapist", min_length=1, max_length=60)
    default_environment: Environment | None = None


class ClaimIn(BaseModel):
    text: str = Field(min_length=1, max_length=400)
    activity: str
    environment: Environment
    assistance: Assistance
    as_of: date | None = None


class ReviewIn(BaseModel):
    actor: str = Field(min_length=1, max_length=60)
    reason: str | None = Field(default=None, max_length=400)


class EditIn(ReviewIn):
    text: str | None = None
    activity: str | None = None
    environment: Environment | None = None
    assistance: Assistance | None = None
    as_of: date | None = None


class GoalIn(BaseModel):
    activity: str
    environment: Environment
    assistance: Assistance
    measure: str = Field(min_length=1, max_length=300)
    baseline: str = Field(default="", max_length=300)
    start_date: date
    review_date: date


class AssessmentIn(BaseModel):
    actor: str = Field(min_length=1, max_length=60)
    gas_rating: int = Field(ge=-2, le=2)
    comment: str = Field(min_length=1, max_length=400)
    as_of: date


class AttendanceIn(BaseModel):
    day: date
    status: str
    actor: str = Field(min_length=1, max_length=60)


def _dump(model) -> dict:
    return model.model_dump(mode="json")


def create_app(data_dir: str | None = None, client=None, mode: str | None = None) -> FastAPI:
    data_dir = data_dir or os.environ.get("ELO_DATA_DIR", ":memory:")
    if data_dir == ":memory:":
        reg_path = svc_path = ":memory:"
    else:
        os.makedirs(data_dir, exist_ok=True)
        reg_path, svc_path = os.path.join(data_dir, "registry.db"), os.path.join(data_dir, "elo.db")
    registry = PersistentRegistry(reg_path)
    svc = ReviewService(svc_path)
    gate = PrivacyGate(registry)
    pack = load_pack()
    llm = client if client is not None else OpenAICompatibleClient.from_env()
    lock = threading.RLock()
    hits: dict[str, deque] = defaultdict(deque)

    app = FastAPI(title="Elo Evidence-to-Impact", docs_url="/api/docs", openapi_url="/api/openapi.json")

    @app.middleware("http")
    async def limit(request: Request, call_next):
        who = request.client.host if request.client else "?"
        now, q = time.monotonic(), hits[who]
        while q and now - q[0] > RATE_LIMIT[1]:
            q.popleft()
        if len(q) >= RATE_LIMIT[0]:
            return JSONResponse({"detail": "too many requests"}, status_code=429)
        q.append(now)
        return await call_next(request)

    @app.exception_handler(ReviewError)
    async def _review_error(_, exc: ReviewError):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    api = APIRouter(prefix="/api")

    def case_or_404(case_id: str) -> dict:
        try:
            return svc.get_case(case_id)
        except ReviewError:
            raise HTTPException(404, "unknown case") from None

    @api.get("/health")
    def health():
        return {"status": "ok"}

    @api.get("/meta")
    def meta():
        return {
            "version": "0.1.0",
            "extraction_mode": mode or os.environ.get("EXTRACTION_MODE", "llm"),
            "model_configured": llm is not None,
            "modes": list(MODES),
            "locales": ["pt-BR", "en"],
            "notice": SYNTHETIC_NOTICE,
            "activities": {k: {"label": a.label} for k, a in pack.activities.items()},
            "assistance_levels": [a.value for a in Assistance],
            "environments": [e.value for e in Environment],
            "attendance_statuses": list(STATUSES),
        }

    # --- cases and people -------------------------------------------------------------
    @api.post("/cases", status_code=201)
    def create_case(body: CaseIn):
        with lock:
            svc.create_case(body.id, body.label)
            return svc.get_case(body.id)

    @api.get("/cases")
    def list_cases():
        return svc.list_cases()

    @api.post("/patients", status_code=201)
    def add_person(body: PersonIn):
        with lock:
            try:
                registry.add(body.role, body.full_name, body.pseudonym, tuple(body.aliases))
            except ValueError as e:
                raise HTTPException(409, str(e)) from None
        return {"pseudonym": body.pseudonym, "role": body.role}

    @api.get("/patients")
    def people():
        return registry.pseudonyms()

    # --- notes -> observations ----------------------------------------------------------
    @api.post("/cases/{case_id}/notes")
    def add_note(case_id: str, body: NoteIn):
        case_or_404(case_id)
        try:
            sanitized = gate.process(body.text)
        except PrivacyBlocked as e:
            kinds = sorted({f.kind for f in e.findings})
            return JSONResponse(
                {"detail": "blocked by the privacy gate", "kinds": kinds,
                 "hint": "Register the person (pseudonym) or remove the data, then send again."},
                status_code=422,
            )
        with lock:
            n = len(svc.notes(case_id)) + 1
            note = Note(id=f"{case_id}-n{n}", session_id=case_id, original_text=body.text, sanitized_text=sanitized.text)
            ctx = ExtractionContext(session_date=body.session_date, observed_by=body.observed_by,
                                    default_environment=body.default_environment)
            try:
                result = extract_note(sanitized, note, ctx, pack, client=llm, mode=mode)
            except ExtractionError as e:
                raise HTTPException(502, f"extraction failed: {e}") from None
            except Exception:  # model unreachable or malformed: say so, keep nothing half-saved
                raise HTTPException(502, "the extraction model did not answer; try again or use mode=rules") from None
            for o in result.observations:
                o.check_against(note)
            svc.save_note(note)
            svc.save_observations(case_id, result.observations)
        return {
            "note_id": note.id,
            "mode_used": result.mode_used,
            "sanitized_text": note.sanitized_text,
            "observations": [_dump(o) for o in result.observations],
            "rejected": [{"reason": r.reason, "quote": r.quote} for r in result.rejected],
            "flags": [{"observation_id": f.observation_id, "kind": f.kind} for f in result.flags],
            "review": [{"kind": r.kind, "quote": r.quote} for r in result.review],
        }

    @api.get("/cases/{case_id}/observations")
    def observations(case_id: str):
        case_or_404(case_id)
        return [_dump(o) for o in sorted(svc.observations(case_id), key=lambda o: (o.observed_on, o.id))]

    # --- claims and review ----------------------------------------------------------------
    def claim_view(claim: Claim, result) -> dict:
        return {"claim": _dump(claim), "verdict": _dump(result)}

    @api.post("/cases/{case_id}/claims", status_code=201)
    def propose(case_id: str, body: ClaimIn):
        case_or_404(case_id)
        if body.activity not in pack.activities:
            raise HTTPException(422, "unknown activity")
        with lock:
            claim = Claim(id=f"c-{uuid.uuid4().hex[:10]}", session_id=case_id, **body.model_dump(), origin="human")
            result = svc.propose(claim, actor="api")
            return claim_view(*svc.get(claim.id))

    @api.post("/cases/{case_id}/claims/from-observations", status_code=201)
    def propose_from_observations(case_id: str):
        """One pending claim per observation, so the reviewer starts from what the notes say."""
        case_or_404(case_id)
        out = []
        with lock:
            have = {c.text for c, _ in svc.claims(case_id)}
            for o in sorted(svc.observations(case_id), key=lambda o: (o.observed_on, o.id)):
                text = o.quote_sanitized or o.quote
                if text in have:
                    continue
                claim = Claim(id=f"c-{uuid.uuid4().hex[:10]}", session_id=case_id, text=text, activity=o.activity,
                              environment=o.environment, assistance=o.assistance, as_of=o.observed_on)
                svc.propose(claim, actor="system")
                out.append(claim_view(*svc.get(claim.id)))
        return out

    @api.get("/cases/{case_id}/claims")
    def claims(case_id: str):
        case_or_404(case_id)
        return [claim_view(c, r) for c, r in svc.claims(case_id)]

    @api.post("/claims/{claim_id}/approve")
    def approve(claim_id: str, body: ReviewIn):
        with lock:
            svc.approve(claim_id, body.actor, body.reason)
            return claim_view(*svc.get(claim_id))

    @api.post("/claims/{claim_id}/reject")
    def reject(claim_id: str, body: ReviewIn):
        with lock:
            svc.reject(claim_id, body.actor, body.reason or "")
            return claim_view(*svc.get(claim_id))

    @api.post("/claims/{claim_id}/edit")
    def edit(claim_id: str, body: EditIn):
        changes = body.model_dump(exclude={"actor", "reason"}, exclude_none=True)
        with lock:
            svc.edit(claim_id, body.actor, body.reason, **changes)
            return claim_view(*svc.get(claim_id))

    @api.get("/claims/{claim_id}/audit")
    def claim_audit(claim_id: str):
        return svc.audit(claim_id)

    # --- goals ----------------------------------------------------------------------------
    @api.post("/cases/{case_id}/goals", status_code=201)
    def add_goal(case_id: str, body: GoalIn):
        case_or_404(case_id)
        if body.activity not in pack.activities:
            raise HTTPException(422, "unknown activity")
        with lock:
            goal = Goal(id=f"g-{uuid.uuid4().hex[:8]}", session_id=case_id, **body.model_dump())
            svc.save_goal(goal)
        return _dump(goal)

    @api.get("/cases/{case_id}/goals")
    def goals(case_id: str):
        case_or_404(case_id)
        return [_dump(g) for g in svc.goals(case_id)]

    def check_view(goal_id: str, as_of: date, locale: str) -> dict:
        try:
            goal = svc.get_goal(goal_id)
        except ReviewError:
            raise HTTPException(404, "unknown goal") from None
        chk = check_goal(goal, svc.observations(goal.session_id), as_of, pack)
        return {"goal": _dump(goal), "check": _dump(chk), "text": render_check(goal, chk, pack, locale)}

    @api.get("/goals/{goal_id}/check")
    def goal_check(goal_id: str, as_of: date | None = None, locale: str = "pt-BR"):
        if locale not in ("pt-BR", "en"):
            raise HTTPException(422, "unsupported locale")
        return check_view(goal_id, as_of or date.today(), locale)

    @api.post("/goals/{goal_id}/assessment", status_code=201)
    def assess(goal_id: str, body: AssessmentIn):
        view = check_view(goal_id, body.as_of, "en")
        with lock:
            svc.record_goal_assessment(goal_id, body.actor, body.gas_rating, body.comment, view["check"]["verdict"])
        return {"recorded": True, "check_verdict": view["check"]["verdict"]}

    # --- gaps, attendance, summary ----------------------------------------------------------
    @api.get("/cases/{case_id}/gaps")
    def gaps(case_id: str, as_of: date | None = None):
        case_or_404(case_id)
        rows = evidence_map(svc.observations(case_id), pack, as_of)
        return [{**r, "label": pack.activities[r["activity"]].label,
                 "last_direct": r["last_direct"].isoformat() if r["last_direct"] else None,
                 "last_report": r["last_report"].isoformat() if r["last_report"] else None} for r in rows]

    @api.post("/cases/{case_id}/attendance", status_code=201)
    def set_attendance(case_id: str, body: AttendanceIn):
        with lock:
            svc.set_attendance(case_id, body.day.isoformat(), body.status, body.actor)
        return {"recorded": True}

    @api.get("/cases/{case_id}/attendance")
    def get_attendance(case_id: str):
        case_or_404(case_id)
        records = svc.attendance(case_id)
        return {"records": records, "adherence": adherence(records)}

    @api.get("/cases/{case_id}/summary")
    def summary(case_id: str, locale: str = "pt-BR"):
        case = case_or_404(case_id)
        if locale not in ("pt-BR", "en"):
            raise HTTPException(422, "unsupported locale")
        s = build_family_summary(svc.approved_claims(case_id), pack, locale, case["label"])
        return {"text": s.render(), "lines": [{"text": l.text, "claim_id": l.claim_id} for l in s.lines], "gaps": s.gaps}

    app.include_router(api)
    app.state.svc, app.state.registry, app.state.pack, app.state.gate = svc, registry, pack, gate
    app.state.llm, app.state.mode = llm, mode
    return app


def app_factory() -> FastAPI:  # uvicorn --factory elo.api:app_factory
    return create_app()
