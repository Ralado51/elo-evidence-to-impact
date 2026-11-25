"""CL06.3 v3 identity, care-link authorization, and versioned entity layer."""

from .auth import AuthService
from .authz import ALLOWED_ROLES, POLICY_MATRIX, AuthzScope, CareLinkView, Decision, Principal, authorize
from .errors import EMITTABLE_ERROR_CODES, V3Error, error_response
from .router import create_v3_router
from .store import V3Store

__all__ = [
    "ALLOWED_ROLES",
    "AuthService",
    "AuthzScope",
    "CareLinkView",
    "Decision",
    "EMITTABLE_ERROR_CODES",
    "POLICY_MATRIX",
    "Principal",
    "V3Error",
    "V3Store",
    "authorize",
    "create_v3_router",
    "error_response",
]
