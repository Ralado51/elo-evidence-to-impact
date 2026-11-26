#!/usr/bin/env python3
"""Copy the A2 catalogs/registries consumed by the browser into web/v3/catalogs (single source: contracts/).

Usage: sync_catalogs.py [--check]. --check fails (exit 1) when the generated copies drift from the contracts.
Standard library only. Writes web/v3/catalogs/MANIFEST.json (sha256 of each copied file).
"""
import hashlib, json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
A2 = ROOT / "contracts/CL06_3-A2/contracts"
R1 = ROOT / "contracts/CL06_3-r1/contracts"
OUT = ROOT / "web/v3/catalogs"
SOURCES = {
    "goal-target-rules.v1.json": A2 / "catalogs/goal-target-rules.v1.json",
    "assessment-item-rules.v1.json": A2 / "catalogs/assessment-item-rules.v1.json",
    "rules-registry.v1.json": A2 / "catalogs/rules-registry.v1.json",
    "units.json": A2 / "registries/units.json",
    "instrument-registry.json": A2 / "registries/instrument-registry.json",
    "limits.v1.json": R1 / "catalogs/limits.v1.json",
}

def main(check: bool) -> int:
    manifest, bad = {}, []
    for name, src in SOURCES.items():
        data = src.read_bytes()
        manifest[name] = hashlib.sha256(data).hexdigest()
        dst = OUT / name
        if check:
            if not dst.exists() or dst.read_bytes() != data:
                bad.append(name)
        else:
            OUT.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
    mtxt = json.dumps(manifest, indent=1, sort_keys=True) + "\n"
    mf = OUT / "MANIFEST.json"
    if check:
        if not mf.exists() or mf.read_text() != mtxt:
            bad.append("MANIFEST.json")
        if bad:
            print("DRIFT:", ", ".join(bad)); return 1
        print("catalogs in sync"); return 0
    mf.write_text(mtxt); print("synced", len(manifest)); return 0

if __name__ == "__main__":
    sys.exit(main("--check" in sys.argv))
