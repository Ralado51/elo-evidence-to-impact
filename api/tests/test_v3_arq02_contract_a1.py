"""ARQ-02: addendum A1 package integrity and delta against frozen CL06_3-r1."""
import hashlib
import json
from pathlib import Path

from elo.v3.errors import A1_ERROR_CODES, ALL_EMITTABLE_ERROR_CODES

ROOT = Path(__file__).resolve().parents[2] / "contracts"
R1, A1 = ROOT / "CL06_3-r1", ROOT / "CL06_3-A1"


def _verify(pkg: Path) -> list[str]:
    bad = []
    for line in (pkg / "INTEGRITY_MANIFEST.sha256").read_text().splitlines():
        if not line.strip():
            continue
        digest, name = line.split(None, 1)
        name = name.strip().lstrip("*")
        if hashlib.sha256((pkg / name).read_bytes()).hexdigest() != digest:
            bad.append(name)
    return bad


def _j(pkg, rel):
    return json.loads((pkg / rel).read_text(encoding="utf-8"))


def test_r1_manifest_still_verifies_and_is_untouched():
    assert _verify(R1) == []
    v = _j(A1, "contracts/VERSIONS.json")
    base = hashlib.sha256((R1 / "INTEGRITY_MANIFEST.sha256").read_bytes()).hexdigest()
    assert v["base_manifest_sha256"] == base


def test_a1_manifest_verifies():
    assert _verify(A1) == []


def test_versions_and_health_shape():
    assert _j(A1, "contracts/VERSIONS.json")["contracts_version"] == "3.1.0"
    assert _j(R1, "contracts/VERSIONS.json")["contracts_version"] == "3.0.0"


def test_a1_differs_from_r1_only_by_declared_delta():
    a, r = _j(A1, "contracts/api/api-contract.v3.json"), _j(R1, "contracts/api/api-contract.v3.json")
    assert [e["id"] for e in a["endpoints"]] == [e["id"] for e in r["endpoints"]]
    for ea, er in zip(a["endpoints"], r["endpoints"]):
        for k in er:
            if k in ("errors", "response", "notes") and (ea["id"] == "health" or k == "errors"):
                continue
            assert ea[k] == er[k], (ea["id"], k)
        if ea["idempotency"] == "keyed":
            assert set(ea["errors"]) - set(er["errors"]) == set(A1_ERROR_CODES)
        elif ea["id"] != "health":
            assert ea["errors"] == er["errors"]
    ca, cr = _j(A1, "contracts/catalogs/error-codes.v3.json"), _j(R1, "contracts/catalogs/error-codes.v3.json")
    assert set(ca["codes"]) - set(cr["codes"]) == set(A1_ERROR_CODES)
    assert all(ca["codes"][c] == cr["codes"][c] for c in cr["codes"])


def test_emittable_codes_in_a1_catalog_and_keyed_ops_marked():
    ca = _j(A1, "contracts/catalogs/error-codes.v3.json")["codes"]
    assert set(ALL_EMITTABLE_ERROR_CODES) <= set(ca)
    for code, status in A1_ERROR_CODES.items():
        assert ca[code]["http"] == status
    api = _j(A1, "contracts/api/api-contract.v3.json")
    classes = api["idempotency"]["classes"]
    by_id = {e["id"]: e for e in api["endpoints"]}
    for op in classes["keyed"]:
        assert by_id[op]["idempotency"] == "keyed"
    assert by_id["events.batch"]["idempotency"] == "natural"
    assert by_id["invites.create"]["idempotency"] == "excluded"
