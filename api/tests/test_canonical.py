"""CL06.3 canonical JSON, SHA-256 hashing, ledger integrity, and Python/JS byte-identity tests."""

from __future__ import annotations

import copy
import json
import subprocess
from pathlib import Path

import pytest

from elo.canonical import (
    CanonicalizationError,
    canonical_bytes,
    canonicalize,
    check_event_integrity,
    check_stream_chain,
    compute_event_hash,
    compute_event_id,
    content_hash,
    hash_canonical,
    sha256_hex,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "contracts" / "CL06_3-r1" / "fixtures" / "valid"
VECTORS_DOC = json.loads((FIXTURES / "canonical-vectors.v3.json").read_text(encoding="utf-8"))
VECTORS = VECTORS_DOC["vectors"]
MUST_REJECT = VECTORS_DOC["must_reject"]
LEDGER_EVENTS = json.loads((FIXTURES / "ledger.v3.json").read_text(encoding="utf-8"))["events"]

MUST_REJECT_VALUES = {
    "X01-nan": float("nan"),
    "X02-infinity": float("inf"),
    "X03-lone-surrogate": {"k": "\ud800"},
}


@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["id"])
def test_canonical_vector(vector: dict) -> None:
    got_bytes = canonical_bytes(vector["value"])
    expected_bytes = vector["canonical"].encode("utf-8")
    assert got_bytes == expected_bytes
    assert canonicalize(vector["value"]) == vector["canonical"]
    assert sha256_hex(canonicalize(vector["value"])) == vector["sha256"]
    assert hash_canonical(vector["value"]) == vector["sha256"]


@pytest.mark.parametrize("case", MUST_REJECT, ids=lambda c: c["id"])
def test_canonical_must_reject(case: dict) -> None:
    value = MUST_REJECT_VALUES[case["id"]]
    with pytest.raises(CanonicalizationError):
        canonicalize(value)


def test_additional_must_reject_edge_cases() -> None:
    for bad in (float("-inf"), {"\ud800": 1}, 10**400):
        with pytest.raises(CanonicalizationError):
            canonicalize(bad)


def test_ledger_v3_event_ids_hashes_and_chains() -> None:
    assert len(LEDGER_EVENTS) == 22
    streams: dict[str, list[dict]] = {}
    for event in LEDGER_EVENTS:
        assert compute_event_id(event["stream_id"], event["seq"]) == event["event_id"]
        assert compute_event_hash(event) == event["hash"]
        assert check_event_integrity(event) == []
        streams.setdefault(event["stream_id"], []).append(event)

    for stream_id, events in streams.items():
        assert check_stream_chain(events) == [], stream_id

    evo = next(e for e in LEDGER_EVENTS if e["type"] == "evolution.published")
    assert content_hash(evo["payload"]) == evo["payload"]["content_hash"]


def test_stream_chain_detects_broken_prev_hash() -> None:
    s1 = copy.deepcopy([e for e in LEDGER_EVENTS if e["stream_id"] == "session:s_fixture-0001"])
    target = next(e for e in s1 if e["seq"] == 2)
    target["prev_hash"] = "0" * 64
    target["hash"] = compute_event_hash(target)
    errs = check_stream_chain(s1)
    assert "CHAIN_BROKEN" in errs


def test_stream_chain_detects_duplicate_seq_conflict() -> None:
    s1 = copy.deepcopy([e for e in LEDGER_EVENTS if e["stream_id"] == "session:s_fixture-0001"])
    dup = copy.deepcopy(next(e for e in s1 if e["seq"] == 6))
    dup["payload"]["frames"] = dup["payload"]["frames"] + 1
    dup["hash"] = compute_event_hash(dup)
    s1.append(dup)
    errs = check_stream_chain(s1)
    assert "HASH_CONFLICT" in errs


def test_cross_language_byte_identity_vectors_and_ledger() -> None:
    js_mod = REPO_ROOT / "web" / "canonical.mjs"
    script = (
        "import fs from 'node:fs';"
        "import { pathToFileURL } from 'node:url';"
        "const mod = await import(pathToFileURL(process.argv[1]).href);"
        "const vecs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).vectors;"
        "const evs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).events;"
        "const out = {"
        "  vectors: vecs.map((v) => ({ id: v.id, hex: mod.canonicalBytes(v.value).toString('hex') })),"
        "  events: evs.map((e) => ({ id: e.event_id, hex: mod.canonicalBytes(e).toString('hex') })),"
        "};"
        "process.stdout.write(JSON.stringify(out));"
    )
    proc = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            script,
            str(js_mod),
            str(FIXTURES / "canonical-vectors.v3.json"),
            str(FIXTURES / "ledger.v3.json"),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    js_out = json.loads(proc.stdout)

    assert len(js_out["vectors"]) == len(VECTORS) == 24
    for py_v, js_v in zip(VECTORS, js_out["vectors"], strict=True):
        assert py_v["id"] == js_v["id"]
        assert canonical_bytes(py_v["value"]) == bytes.fromhex(js_v["hex"]), py_v["id"]

    assert len(js_out["events"]) == len(LEDGER_EVENTS) == 22
    for py_e, js_e in zip(LEDGER_EVENTS, js_out["events"], strict=True):
        assert py_e["event_id"] == js_e["id"]
        assert canonical_bytes(py_e) == bytes.fromhex(js_e["hex"]), py_e["event_id"]
