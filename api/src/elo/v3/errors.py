"""CL06.3 v3 error catalog mapping and error_body response builder."""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse

# Every error code the v3 layer can emit, mapped to its normative HTTP status from
# contracts/CL06_3-r1/contracts/catalogs/error-codes.v3.json.
EMITTABLE_ERROR_CODES: dict[str, int] = {
    "TYPE": 400,
    "UNKNOWN_FIELD": 400,
    "MISSING_FIELD": 400,
    "NULL_NOT_ALLOWED": 400,
    "NON_FINITE": 400,
    "OUT_OF_RANGE": 400,
    "ENUM": 400,
    "PATTERN": 400,
    "LENGTH": 400,
    "LITERAL": 400,
    "INVALID_CHARACTERS": 400,
    "DUPLICATE_ITEM": 400,
    "NOT_SORTED": 400,
    "NON_CANONICAL": 400,
    "UNKNOWN_TYPE": 400,
    "SCHEMA_VERSION_UNSUPPORTED": 400,
    "VERSION_MISMATCH": 400,
    "INVALID_INSTANT": 400,
    "ACTOR_NOT_ALLOWED": 400,
    "SOURCE_NOT_ALLOWED": 400,
    "SCOPE_INVALID": 400,
    "IDENTITY_MISMATCH": 400,
    "STREAM_MISMATCH": 400,
    "RULE_VIOLATION": 400,
    "EVENT_ID_INVALID": 400,
    "HASH_INVALID": 400,
    "GENESIS_INVALID": 400,
    "BATCH_UNORDERED": 400,
    "OUT_OF_ORDER": 400,
    "LIMITS_EXCEEDED": 400,
    "EXECUTION_MODE_MISMATCH": 400,
    "ORIGIN_REF_REQUIRED": 400,
    "ENTITY_HASH_INVALID": 400,
    "GOAL_CONFIRMATION_REQUIRED": 400,
    "COMPARABILITY_VIOLATION": 400,
    "UNAUTHENTICATED": 401,
    "INVITE_INVALID": 401,
    "FORBIDDEN": 403,
    "SCOPE_VIOLATION": 403,
    "ROLE_NOT_ALLOWED": 403,
    "REAL_DATA_GATE_CLOSED": 403,
    "CONSENT_REQUIRED": 403,
    "MICROPHONE_CONSENT_REQUIRED": 403,
    "NOT_FOUND": 404,
    "HASH_CONFLICT": 409,
    "CHAIN_BROKEN": 409,
    "INVALID_TRANSITION": 409,
    "SOURCE_INCONSISTENT": 409,
    "CALIBRATION_MISMATCH": 409,
    "OVER_TARGET": 409,
    "COMPLETION_INCONSISTENT": 409,
    "PRESCRIPTION_NOT_FOUND": 409,
    "CONFLICT_IMMUTABLE": 409,
    "HANDEDNESS_INCOMPATIBLE_ACCEPTED": 409,
    "ENTITY_VERSION_CONFLICT": 409,
    "ENTITY_CHAIN_BROKEN": 409,
    "DRAFT_NOT_CONFIRMED": 409,
    "LEGACY_STREAM_READ_ONLY": 409,
    "CONTENT_HASH_STALE": 409,
    "UNREVIEWED_FACT_IN_EVOLUTION": 409,
    "BATCH_TOO_LARGE": 413,
    "FACT_NOT_APPROVED": 422,
    "FACT_NOT_SUMMARY_ELIGIBLE": 422,
    "INTERNAL": 500,
}

# Warning/informational item codes emitted only inside HTTP 200 events:batch item results.
ITEM_WARNING_CODES: dict[str, int] = {
    "SEQ_GAP": 200,
    "DUPLICATE": 200,
    "CLOCK_REGRESSION": 200,
}

# Verifier-layer result codes emitted only inside HTTP 200 facts.verify responses (error-codes.v3.json).
VERIFIER_RESULT_CODES: dict[str, int] = {
    "REF_MISSING": 200,
    "REF_OUT_OF_SCOPE": 200,
    "REF_WRONG_TYPE": 200,
    "PRECONDITION_FAILED": 200,
    "EVIDENCE_SET_MISMATCH": 200,
    "RECOMPUTE_MISMATCH": 200,
}


def map_validation_code(code: str, details: Any = None) -> tuple[str, int, Any]:
    """Map a validation-layer code onto the cataloged HTTP error surface (D-S0-03-4).

    ``ONEOF`` is emitted by the CL06.3 schema validator (matching REF and INVALID.entities)
    but is absent from ``error-codes.v3.json``; on the HTTP surface it maps to catalog code
    ``RULE_VIOLATION`` (400) with the original ``"ONEOF"`` preserved in ``error.details``.
    Every other code passes through unchanged with its exact catalog HTTP status.
    """
    if code == "ONEOF":
        mapped_details: Any
        if details is None:
            mapped_details = {"validator_code": "ONEOF"}
        elif isinstance(details, dict):
            mapped_details = {"validator_code": "ONEOF", **details}
        else:
            mapped_details = {"validator_code": "ONEOF", "details": details}
        return "RULE_VIOLATION", EMITTABLE_ERROR_CODES["RULE_VIOLATION"], mapped_details
    if code not in EMITTABLE_ERROR_CODES:
        raise ValueError(f"Unregistered v3 error code: {code}")
    return code, EMITTABLE_ERROR_CODES[code], details


def to_http_error(code: str, message: str, details: Any = None) -> V3Error:
    """Build a ``V3Error`` from a validation-layer code using ``map_validation_code`` (D-S0-03-4)."""
    http_code, _, mapped_details = map_validation_code(code, details=details)
    return V3Error(http_code, message, details=mapped_details)


class V3Error(Exception):
    """Structured CL06.3 v3 API error."""

    def __init__(self, code: str, message: str, details: Any = None) -> None:
        if code not in EMITTABLE_ERROR_CODES:
            raise ValueError(f"Unregistered v3 error code: {code}")
        self.code = code
        self.message = message
        self.http_status = EMITTABLE_ERROR_CODES[code]
        self.details = details
        super().__init__(f"{code}: {message}")


def error_response(exc: V3Error) -> JSONResponse:
    """Serialize a V3Error using the normative api-contract.v3.json error_body shape."""
    err_obj: dict[str, Any] = {"code": exc.code, "message": exc.message}
    if exc.details is not None:
        err_obj["details"] = exc.details
    return JSONResponse({"error": err_obj}, status_code=exc.http_status)
