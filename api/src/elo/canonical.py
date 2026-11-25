"""CL06.3 canonical JSON (RFC 8785 subset), hashing, and envelope/stream integrity (Python).

Origin-Source: contracts/CL06_3/reference/python/elo_ref.py
Origin-SHA256: a88f324099523f4cc66f24cf5c9ecdcc5b8f69ec5999418d9a1635955d3439a0
Origin-License: Apache-2.0
Origin-Attribution: Airton Justino O. Junior (Elo CL06.3 contract package; ported per PO-F10)

Standard library only. Contract-level canonicalization, SHA-256 hashing, deterministic
event_id / event hash / content_hash, and per-stream prev_hash / duplicate-seq integrity checks.
"""

from __future__ import annotations

import hashlib
import math
from typing import Any


class CanonicalizationError(Exception):
    """Raised when a value cannot be serialized to CL06.3 canonical JSON."""


def _es_number(x: int | float) -> str:
    """ECMAScript Number::toString for finite IEEE-754 doubles (RFC 8785 sec 3.2.2.3)."""
    if isinstance(x, bool):
        raise CanonicalizationError("bool is not a number")
    if isinstance(x, int):
        if abs(x) <= 2**53:
            return str(x)
        try:
            x = float(x)  # JSON numbers are IEEE-754 doubles (RFC 8785): same as JS parser
        except OverflowError as exc:
            raise CanonicalizationError("non-finite number") from exc
    if not math.isfinite(x):
        raise CanonicalizationError("non-finite number")
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    r = repr(abs(x))  # shortest round-trip digits
    mant, _, exp = r.partition("e")
    ip, _, fp = mant.partition(".")
    if fp == "0":
        fp = ""
    digits = (ip + fp).lstrip("0")
    e10 = int(exp or 0)
    lead_zeros_removed = len(ip + fp) - len((ip + fp).lstrip("0"))
    n = len(ip) - lead_zeros_removed + e10  # ES "n"
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    if k <= n <= 21:
        s = digits + "0" * (n - k)
    elif 0 < n <= 21:
        s = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        es = ("+" if e >= 0 else "-") + str(abs(e))
        s = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + es
    return sign + s


def _es_string(s: str) -> str:
    out = ['"']
    for ch in s:
        o = ord(ch)
        if 0xD800 <= o <= 0xDFFF:
            raise CanonicalizationError("lone surrogate")
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif o < 0x20:
            out.append("\\u%04x" % o)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonicalize(v: Any) -> str:
    """Return the CL06.3 / RFC 8785 canonical JSON string for ``v``."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return _es_number(v)
    if isinstance(v, str):
        return _es_string(v)
    if isinstance(v, list):
        return "[" + ",".join(canonicalize(i) for i in v) + "]"
    if isinstance(v, dict):
        encoded_keys = []
        for k in v.keys():
            if not isinstance(k, str):
                raise CanonicalizationError("dict key must be str")
            ser_k = _es_string(k)  # rejects lone surrogates before UTF-16 encoding
            encoded_keys.append((k.encode("utf-16-be"), ser_k, k))
        encoded_keys.sort(key=lambda item: item[0])  # UTF-16 code-unit order
        return "{" + ",".join(ser_k + ":" + canonicalize(v[k]) for _, ser_k, k in encoded_keys) + "}"
    raise CanonicalizationError("unsupported type " + type(v).__name__)


def canonical_bytes(v: Any) -> bytes:
    """Return the UTF-8 encoded canonical JSON bytes for ``v``."""
    return canonicalize(v).encode("utf-8")


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def hash_canonical(v: Any) -> str:
    return sha256_hex(canonicalize(v))


def content_hash(v: Any) -> str:
    """Compute SHA-256 of canonical JSON, excluding a top-level ``content_hash`` key if present."""
    if isinstance(v, dict):
        return hash_canonical({k: val for k, val in v.items() if k != "content_hash"})
    return hash_canonical(v)


def compute_event_id(stream_id: str, seq: int) -> str:
    return hash_canonical({"seq": seq, "stream_id": stream_id})


def compute_event_hash(event: dict[str, Any]) -> str:
    return hash_canonical({k: v for k, v in event.items() if k != "hash"})


def check_event_integrity(event: dict[str, Any]) -> list[str]:
    """Validate event_id, hash, and genesis prev_hash invariant for one event."""
    errs: list[str] = []
    if event["event_id"] != compute_event_id(event["stream_id"], event["seq"]):
        errs.append("EVENT_ID_INVALID")
    if event["hash"] != compute_event_hash(event):
        errs.append("HASH_INVALID")
    if (event["seq"] == 1) != (event["prev_hash"] is None):
        errs.append("GENESIS_INVALID")
    return errs


def check_stream_chain(events: list[dict[str, Any]]) -> list[str]:
    """Validate per-stream integrity, duplicate seq conflicts (HASH_CONFLICT), and prev_hash links (CHAIN_BROKEN)."""
    errs: list[str] = []
    by_seq: dict[int, dict[str, Any]] = {}
    for e in events:
        errs += check_event_integrity(e)
        if e["seq"] in by_seq and by_seq[e["seq"]]["hash"] != e["hash"]:
            errs.append("HASH_CONFLICT")
        by_seq.setdefault(e["seq"], e)
    for s, e in by_seq.items():
        if s > 1 and (s - 1) in by_seq and e["prev_hash"] != by_seq[s - 1]["hash"]:
            errs.append("CHAIN_BROKEN")
    return errs
