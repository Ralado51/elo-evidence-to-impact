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
    "OUT_OF_RANGE": 400,
    "ENUM": 400,
    "PATTERN": 400,
    "LENGTH": 400,
    "LITERAL": 400,
    "RULE_VIOLATION": 400,
    "ORIGIN_REF_REQUIRED": 400,
    "ENTITY_HASH_INVALID": 400,
    "UNAUTHENTICATED": 401,
    "INVITE_INVALID": 401,
    "FORBIDDEN": 403,
    "SCOPE_VIOLATION": 403,
    "ROLE_NOT_ALLOWED": 403,
    "REAL_DATA_GATE_CLOSED": 403,
    "CONSENT_REQUIRED": 403,
    "MICROPHONE_CONSENT_REQUIRED": 403,
    "NOT_FOUND": 404,
    "CONFLICT_IMMUTABLE": 409,
    "ENTITY_VERSION_CONFLICT": 409,
    "ENTITY_CHAIN_BROKEN": 409,
    "INTERNAL": 500,
}


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
