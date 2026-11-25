"""CL06.3 v3 identity, care-link authorization, validation, consent, and versioned entity layer."""

from .auth import AuthService
from .authz import ALLOWED_ROLES, POLICY_MATRIX, AuthzScope, CareLinkView, Decision, Principal, authorize
from .errors import EMITTABLE_ERROR_CODES, V3Error, error_response, map_validation_code, to_http_error
from .ledger import EventLedger
from .router import create_v3_router
from .store import V3Store
from .validation import (
    REAL_DATA_GATE_ENV,
    check_event_semantics,
    check_real_data_gate,
    check_session_stream,
    consent_state,
    is_real_data_gate_open,
    require_consent,
    validate_entity,
    validate_entity_chain,
    validate_event,
)

__all__ = [
    "ALLOWED_ROLES",
    "AuthService",
    "AuthzScope",
    "CareLinkView",
    "Decision",
    "EMITTABLE_ERROR_CODES",
    "EventLedger",
    "POLICY_MATRIX",
    "Principal",
    "REAL_DATA_GATE_ENV",
    "V3Error",
    "V3Store",
    "authorize",
    "check_event_semantics",
    "check_real_data_gate",
    "check_session_stream",
    "consent_state",
    "create_v3_router",
    "error_response",
    "is_real_data_gate_open",
    "map_validation_code",
    "require_consent",
    "to_http_error",
    "validate_entity",
    "validate_entity_chain",
    "validate_event",
]
