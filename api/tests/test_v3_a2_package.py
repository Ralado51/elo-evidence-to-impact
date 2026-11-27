"""A2 frozen package: integrity, frozen-package preservation, catalog parity, vector well-formedness."""
import hashlib, json, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]


def _verify(pkg: pathlib.Path):
    bad = []
    for line in (pkg / "INTEGRITY_MANIFEST.sha256").read_text().splitlines():
        digest, rel = line.split("  ", 1)
        if hashlib.sha256((pkg / rel).read_bytes()).hexdigest() != digest:
            bad.append(rel)
    return bad


def test_frozen_packages_untouched():
    assert _verify(ROOT / "contracts/CL06_3-r1") == []
    assert _verify(ROOT / "contracts/CL06_3-A1") == []
    assert _verify(ROOT / "contracts/CL06_3-A2") == []  # frozen on 2026-11-26 (accepted revision 2cf4bab)


def test_a2_manifest_integrity_and_versions():
    pkg = ROOT / "contracts/CL06_3-A2"
    assert _verify(pkg) == []
    v = json.loads((pkg / "contracts/VERSIONS.json").read_text())
    assert v["contracts_version"] == "3.2.0" and v["base_package"] == "contracts/CL06_3-A1"
    assert "FROZEN" in v["status"] and "NOT declared fully backward-compatible" in v["status"]
    assert v["base_manifest_sha256"] == hashlib.sha256((ROOT / "contracts/CL06_3-A1/INTEGRITY_MANIFEST.sha256").read_bytes()).hexdigest()


def test_rules_registry_adds_no_error_codes():
    from elo.v3.errors import EMITTABLE_ERROR_CODES
    reg = json.loads((ROOT / "contracts/CL06_3-A2/contracts/catalogs/rules-registry.v1.json").read_text())
    assert reg["new_error_codes"] == []
    assert {r["code"] for r in reg["rules"]} <= set(EMITTABLE_ERROR_CODES)


def test_vectors_reference_registered_rules():
    base = ROOT / "contracts/CL06_3-A2/contracts"
    ids = {r["id"] for r in json.loads((base / "catalogs/rules-registry.v1.json").read_text())["rules"]}
    vec = json.loads((base / "fixtures/a2-vectors.json").read_text())
    for group in vec.values():
        for v in group:
            assert v["ok"] or v["rule"] in ids


def test_web_catalogs_in_sync():
    r = subprocess.run([sys.executable, str(ROOT / "scripts/sync_catalogs.py"), "--check"], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout
