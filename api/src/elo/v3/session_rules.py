"""Session-phase state machine and stateful session-stream rules for Elo v3.

Written from scratch in Python (PO-F26, D-S1b-01-1) using the CL06.1 session rules
as specification only (no code copied). Operates on a version-neutral projection
so both CL06.3 v3 stored events and CL06.1 v2 specification fixtures evaluate
through identical logic.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

# Ordered lifecycle phases of one practice session.
SESSION_PHASES: tuple[str, ...] = (
    "created",
    "calibrated",
    "active",
    "paused",
    "ended",
    "completed",
)

TERMINAL_PHASES: frozenset[str] = frozenset({"ended", "completed"})
CAPTURE_MODES: frozenset[str] = frozenset({"camera", "simulation"})

_END_ACTIONS: frozenset[str] = frozenset({"end", "pain", "fatigue", "interrupt"})
_MODE_SOURCE_MAP: dict[str, str] = {
    "camera": "camera",
    "simulation": "simulation",
    "report_only": "participant_report",
}

# Pre-event phases in which each non-start, non-control session event is permitted.
# Capture-only event types additionally require a capture session mode (camera/simulation).
ALLOWED_PRE_PHASES: dict[str, frozenset[str]] = {
    "calibration.attempted": frozenset({"created", "calibrated"}),
    "calibration.applied": frozenset({"created", "calibrated"}),
    "calibration.failed": frozenset({"created", "calibrated"}),
    "observation.recorded": frozenset({"active"}),
    "cycle.accepted": frozenset({"active"}),
    "cycle.rejected": frozenset({"active", "paused"}),
    "session.completed": frozenset({"active"}),
    "session.capture_summary": frozenset({"ended", "completed"}),
    "measurement.recorded": frozenset({"ended", "completed"}),  # v3-only capture event (D-S1b-01-3)
    "report.submitted": frozenset({"ended", "completed"}),
}

_CAPTURE_ONLY_TYPES: frozenset[str] = frozenset(
    {
        "calibration.attempted",
        "calibration.applied",
        "calibration.failed",
        "observation.recorded",
        "cycle.accepted",
        "cycle.rejected",
        "session.completed",
        "session.capture_summary",
        "measurement.recorded",
    }
)

# Codes produced by the session-rule engine that belong to the ledger append item check.
SESSION_RULE_ERROR_CODES: frozenset[str] = frozenset(
    {
        "INVALID_TRANSITION",
        "OVER_TARGET",
        "CALIBRATION_MISMATCH",
        "COMPLETION_INCONSISTENT",
        "SOURCE_INCONSISTENT",
        "OUT_OF_ORDER",
        "RULE_VIOLATION",
    }
)

SESSION_RULE_WARNING_CODES: frozenset[str] = frozenset({"CLOCK_REGRESSION"})


@dataclass(frozen=True)
class SessionEventView:
    """Version-neutral projection of a session-stream event (D-S1b-01-1)."""

    event_id: str
    event_type: str
    stream_id: str
    seq: int
    event_hash: str
    prev_hash: str | None
    occurred_at: str
    has_mono: bool
    t_mono_ms: int | float | None
    scope: dict[str, Any]
    data_origin: str
    source_type: str
    algorithm_version: str | None
    payload: dict[str, Any]


@dataclass(frozen=True)
class PrescriptionView:
    """Version-neutral projection of a published prescription revision payload."""

    prescription_id: str
    revision: int
    participant_id: str
    target: int


@dataclass(frozen=True)
class StreamFinding:
    """One diagnostic code emitted for a specific sequence number in a session stream."""

    code: str
    seq: int
    detail: str = ""


@dataclass
class SessionStreamState:
    """Folded stateful summary of one session stream after evaluation."""

    phase: str | None = None
    mode: str | None = None
    replayable: bool = True
    effective_calibration_id: str | None = None
    accepted: int = 0
    candidates: int = 0
    target: int | None = None
    terminal_seq: int | None = None
    effective_report_seq: int | None = None
    capture_summary_seq: int | None = None
    completion_pending: bool = False
    gaps: list[int] = field(default_factory=list)


@dataclass
class SessionStreamReport:
    """Complete result of evaluating a session stream."""

    errors: list[StreamFinding]
    warnings: list[StreamFinding]
    state: SessionStreamState
    per_event_errors: dict[int, list[str]]
    per_event_warnings: dict[int, list[str]]


def project_session_event(raw: SessionEventView | Mapping[str, Any]) -> SessionEventView:
    """Project a CL06.3 v3 or CL06.1 v2 event mapping into ``SessionEventView`` (D-S1b-01-1).

    Field correspondence between v2 and v3:
    - ``type``, ``seq``, ``stream_id``, ``event_id``, ``hash``, ``prev_hash``: identical.
    - ``occurred_at``, ``t_mono_ms``, ``data_origin``, ``scope``: identical.
    - ``source.type`` and optional ``source.algorithm_version``: identical.
    - ``session.started.payload.source_mode``: identical (also mirrored by v3 ``execution_mode``).
    - ``session.control.payload.action``, calibration/cycle/completion payload fields: identical.
    """
    if isinstance(raw, SessionEventView):
        return raw
    src = raw.get("source")
    src_dict = src if isinstance(src, Mapping) else {}
    scope = raw.get("scope")
    scope_dict = dict(scope) if isinstance(scope, Mapping) else {}
    payload = raw.get("payload")
    payload_dict = dict(payload) if isinstance(payload, Mapping) else {}
    raw_mono = raw.get("t_mono_ms")
    has_mono = isinstance(raw_mono, (int, float)) and not isinstance(raw_mono, bool)
    return SessionEventView(
        event_id=str(raw.get("event_id", "")),
        event_type=str(raw.get("type", "")),
        stream_id=str(raw.get("stream_id", "")),
        seq=int(raw["seq"]),
        event_hash=str(raw.get("hash", "")),
        prev_hash=raw.get("prev_hash"),
        occurred_at=str(raw.get("occurred_at", "")),
        has_mono=has_mono,
        t_mono_ms=raw_mono if has_mono else None,
        scope=scope_dict,
        data_origin=str(raw.get("data_origin", "")),
        source_type=str(src_dict.get("type", "")),
        algorithm_version=src_dict.get("algorithm_version")
        if isinstance(src_dict.get("algorithm_version"), str)
        else None,
        payload=payload_dict,
    )


def project_prescription(raw: PrescriptionView | Mapping[str, Any] | None) -> PrescriptionView | None:
    """Project a published prescription payload (v2 or v3) into ``PrescriptionView``."""
    if raw is None or isinstance(raw, PrescriptionView):
        return raw
    target_sets = int(raw["target_sets"])
    target_reps = int(raw["target_repetitions"])
    return PrescriptionView(
        prescription_id=str(raw["prescription_id"]),
        revision=int(raw["revision"]),
        participant_id=str(raw["participant_id"]),
        target=target_sets * target_reps,
    )


def is_terminal_phase(phase: str | None) -> bool:
    """Return True iff ``phase`` is a terminal session phase (``ended`` or ``completed``)."""
    return phase in TERMINAL_PHASES


def advance_phase(
    current_phase: str | None,
    event: SessionEventView | Mapping[str, Any],
    session_mode: str | None,
) -> tuple[str | None, str | None]:
    """Compute ``(next_phase, error_code)`` for one session event.

    Returns ``(next_phase, None)`` when allowed, or ``(None, "INVALID_TRANSITION")``
    when the event is forbidden in ``current_phase`` or under ``session_mode``.
    """
    ev = project_session_event(event)
    ev_type = ev.event_type

    if ev_type == "session.started":
        if current_phase is None:
            return "created", None
        return None, "INVALID_TRANSITION"

    if current_phase is None:
        return None, "INVALID_TRANSITION"

    if ev_type == "session.control":
        action = ev.payload.get("action")
        if action in _END_ACTIONS:
            if is_terminal_phase(current_phase):
                return None, "INVALID_TRANSITION"
            return "ended", None
        if action == "start":
            if session_mode == "report_only" and current_phase == "created":
                return "active", None
            if session_mode in CAPTURE_MODES and current_phase == "calibrated":
                return "active", None
            return None, "INVALID_TRANSITION"
        if action == "pause":
            if current_phase == "active":
                return "paused", None
            return None, "INVALID_TRANSITION"
        if action == "resume":
            if current_phase == "paused":
                return "active", None
            return None, "INVALID_TRANSITION"
        return None, "INVALID_TRANSITION"

    permitted = ALLOWED_PRE_PHASES.get(ev_type)
    if permitted is None or current_phase not in permitted:
        return None, "INVALID_TRANSITION"

    if ev_type in _CAPTURE_ONLY_TYPES and session_mode not in CAPTURE_MODES:
        return None, "INVALID_TRANSITION"

    if ev_type == "calibration.applied":
        return "calibrated", None
    if ev_type == "session.completed":
        return "completed", None
    return current_phase, None


def _check_chain_order(
    views: Sequence[SessionEventView],
) -> tuple[list[StreamFinding], list[StreamFinding], list[int], list[SessionEventView]]:
    """Sort stream events by ``seq`` and verify contiguous sequence and hash links."""
    chain_errors: list[StreamFinding] = []
    chain_warnings: list[StreamFinding] = []
    missing_seqs: list[int] = []
    ordered: list[SessionEventView] = []

    for item in sorted(views, key=lambda v: v.seq):
        if ordered and item.seq == ordered[-1].seq:
            dup_code = "DUPLICATE" if ordered[-1].event_hash == item.event_hash else "HASH_CONFLICT"
            chain_errors.append(StreamFinding(code=dup_code, seq=item.seq))
            continue
        ordered.append(item)

    for idx, cur in enumerate(ordered):
        prev = ordered[idx - 1] if idx > 0 else None
        if prev is not None and cur.stream_id != prev.stream_id:
            chain_errors.append(StreamFinding(code="STREAM_MISMATCH", seq=cur.seq))
        expected_prev = prev.seq if prev is not None else 0
        if cur.seq != expected_prev + 1:
            missing_seqs.extend(range(expected_prev + 1, cur.seq))
            chain_warnings.append(StreamFinding(code="SEQ_GAP", seq=cur.seq))
        elif prev is not None and cur.prev_hash != prev.event_hash:
            chain_errors.append(StreamFinding(code="CHAIN_BROKEN", seq=cur.seq))

    return chain_errors, chain_warnings, missing_seqs, ordered


def evaluate_session_stream(
    events: Sequence[SessionEventView | Mapping[str, Any]],
    prescription: PrescriptionView | Mapping[str, Any] | None,
) -> SessionStreamReport:
    """Evaluate all stateful phase, calibration, target, source, and ordering rules for one session stream."""
    views = [project_session_event(e) for e in events]
    rx = project_prescription(prescription)

    errors, warnings, gaps, ordered = _check_chain_order(views)
    state = SessionStreamState(
        replayable=(len(gaps) == 0),
        target=rx.target if rx is not None else None,
        gaps=gaps,
    )

    per_event_errors: dict[int, list[str]] = {}
    per_event_warnings: dict[int, list[str]] = {}

    def record_error(code: str, seq: int, detail: str = "") -> None:
        errors.append(StreamFinding(code=code, seq=seq, detail=detail))
        bucket = per_event_errors.setdefault(seq, [])
        if code not in bucket:
            bucket.append(code)

    def record_warning(code: str, seq: int, detail: str = "") -> None:
        warnings.append(StreamFinding(code=code, seq=seq, detail=detail))
        bucket = per_event_warnings.setdefault(seq, [])
        if code not in bucket:
            bucket.append(code)

    for f in errors:
        bucket = per_event_errors.setdefault(f.seq, [])
        if f.code not in bucket:
            bucket.append(f.code)
    for f in warnings:
        bucket = per_event_warnings.setdefault(f.seq, [])
        if f.code not in bucket:
            bucket.append(f.code)

    if not ordered:
        return SessionStreamReport(
            errors=errors,
            warnings=warnings,
            state=state,
            per_event_errors=per_event_errors,
            per_event_warnings=per_event_warnings,
        )

    genesis = ordered[0]
    if rx is None:
        record_error("PRESCRIPTION_NOT_FOUND", genesis.seq)
    else:
        g_scope = genesis.scope
        if (
            rx.prescription_id != g_scope.get("prescription_id")
            or rx.revision != g_scope.get("prescription_revision")
            or rx.participant_id != g_scope.get("participant_id")
        ):
            record_error("PRESCRIPTION_NOT_FOUND", genesis.seq, "session scope disagrees with prescription revision")

    first_gap = gaps[0] if gaps else None
    pinned_algorithm: str | None = None
    last_mono: int | float | None = None
    last_occurred: str | None = None
    cycle_counter = 0
    awaiting_completion = False
    calibration_attempts: dict[str, dict[str, Any]] = {}

    for ev in ordered:
        if ev.scope != genesis.scope or ev.data_origin != genesis.data_origin:
            record_error("SOURCE_INCONSISTENT", ev.seq, "scope or data_origin changed inside session")

        if ev.has_mono and ev.t_mono_ms is not None:
            if last_mono is not None and ev.t_mono_ms < last_mono:
                record_error("OUT_OF_ORDER", ev.seq, "monotonic clock regressed")
            last_mono = ev.t_mono_ms

        if last_occurred is not None and ev.occurred_at < last_occurred:
            record_warning("CLOCK_REGRESSION", ev.seq, "civil clock regressed")
        last_occurred = ev.occurred_at

        if ev.algorithm_version:
            if pinned_algorithm is None:
                pinned_algorithm = ev.algorithm_version
            elif ev.algorithm_version != pinned_algorithm:
                record_error("SOURCE_INCONSISTENT", ev.seq, "algorithm_version changed inside session")

        if first_gap is not None and ev.seq > first_gap:
            continue

        if ev.event_type == "session.started":
            mode_val = ev.payload.get("source_mode")
            state.mode = mode_val if isinstance(mode_val, str) else None
        elif ev.event_type != "report.submitted":
            expected_source = _MODE_SOURCE_MAP.get(state.mode or "")
            if ev.source_type != expected_source:
                record_error("SOURCE_INCONSISTENT", ev.seq, "event source disagrees with session.started mode")

        if awaiting_completion and ev.event_type != "session.completed":
            record_error("COMPLETION_INCONSISTENT", ev.seq, "target reached; next event must be session.completed")
        awaiting_completion = False

        next_phase, trans_err = advance_phase(state.phase, ev, state.mode)
        if trans_err is not None:
            record_error(trans_err, ev.seq, f"{ev.event_type} disallowed in phase {state.phase}")
            continue

        if ev.event_type == "calibration.attempted":
            calibration_attempts[ev.event_id] = ev.payload
        elif ev.event_type == "calibration.applied":
            refs = ev.payload.get("attempt_refs")
            if not isinstance(refs, list) or len(refs) != 2:
                record_error("RULE_VIOLATION", ev.seq, "calibration.applied requires two attempt_refs")
            else:
                cited = [calibration_attempts.get(r) for r in refs]
                postures = {c.get("posture") for c in cited if isinstance(c, dict) and c.get("accepted") is True}
                if any(c is None or c.get("accepted") is not True for c in cited) or len(postures) != 2:
                    record_error(
                        "RULE_VIOLATION",
                        ev.seq,
                        "attempt_refs must cite one accepted open and one accepted closed attempt",
                    )
            cal_id = ev.payload.get("calibration_id")
            state.effective_calibration_id = cal_id if isinstance(cal_id, str) else None
        elif ev.event_type in ("observation.recorded", "cycle.accepted", "cycle.rejected"):
            if ev.payload.get("calibration_id") != state.effective_calibration_id:
                record_error("CALIBRATION_MISMATCH", ev.seq)
            if ev.event_type in ("cycle.accepted", "cycle.rejected"):
                cycle_counter += 1
                if ev.payload.get("cycle_index") != cycle_counter:
                    record_error("RULE_VIOLATION", ev.seq, "cycle_index must increase sequentially by 1")
                state.candidates += 1
                if ev.event_type == "cycle.accepted":
                    state.accepted += 1
                    if state.target is not None and state.accepted > state.target:
                        record_error("OVER_TARGET", ev.seq)
                    if state.target is not None and state.accepted == state.target:
                        awaiting_completion = True
        elif ev.event_type == "session.completed":
            if ev.payload.get("accepted") != state.accepted or ev.payload.get("target") != state.target:
                record_error("COMPLETION_INCONSISTENT", ev.seq)
        elif ev.event_type == "session.capture_summary":
            if state.capture_summary_seq is not None:
                record_error("RULE_VIOLATION", ev.seq, "duplicate session.capture_summary in stream")
            state.capture_summary_seq = ev.seq
        elif ev.event_type == "report.submitted":
            state.effective_report_seq = ev.seq

        if not is_terminal_phase(state.phase) and is_terminal_phase(next_phase):
            state.terminal_seq = ev.seq
        state.phase = next_phase

    state.completion_pending = awaiting_completion

    for seq_key in per_event_errors:
        per_event_errors[seq_key].sort()
    for seq_key in per_event_warnings:
        per_event_warnings[seq_key].sort()

    return SessionStreamReport(
        errors=errors,
        warnings=warnings,
        state=state,
        per_event_errors=per_event_errors,
        per_event_warnings=per_event_warnings,
    )
