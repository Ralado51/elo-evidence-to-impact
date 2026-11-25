"""Elo CL06.3 reference library (Python). Contract-level only: canonical JSON, hashing,
JSON-Schema-subset validation, envelope/stream integrity. NO fact verifier lives here.
Spec: canonicalization/CANONICALIZATION_SPEC.md (RFC 8785 subset)."""
import hashlib, json, math, re

class CanonicalizationError(Exception):
    pass

def _es_number(x):
    """ECMAScript Number::toString for finite doubles (RFC 8785 sec 3.2.2.3)."""
    if isinstance(x, bool):
        raise CanonicalizationError("bool is not a number")
    if isinstance(x, int):
        if abs(x) <= 2**53:
            return str(x)
        x = float(x)                       # JSON numbers are IEEE-754 doubles (RFC 8785): same as a JS parser
    if not math.isfinite(x):
        raise CanonicalizationError("non-finite number")
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    r = repr(abs(x))                      # shortest round-trip digits
    mant, _, exp = r.partition("e")
    ip, _, fp = mant.partition(".")
    if fp == "0": fp = ""
    digits = (ip + fp).lstrip("0")
    e10 = int(exp or 0)
    # position of decimal point relative to start of `digits`
    lead_zeros_removed = len((ip + fp)) - len((ip + fp).lstrip("0"))
    n = len(ip) - lead_zeros_removed + e10    # ES "n"
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

def _es_string(s):
    out = ['"']
    for ch in s:
        o = ord(ch)
        if 0xD800 <= o <= 0xDFFF:
            raise CanonicalizationError("lone surrogate")
        if ch == '"': out.append('\\"')
        elif ch == "\\": out.append("\\\\")
        elif ch == "\b": out.append("\\b")
        elif ch == "\f": out.append("\\f")
        elif ch == "\n": out.append("\\n")
        elif ch == "\r": out.append("\\r")
        elif ch == "\t": out.append("\\t")
        elif o < 0x20: out.append("\\u%04x" % o)
        else: out.append(ch)
    out.append('"')
    return "".join(out)

def canonicalize(v):
    if v is None: return "null"
    if v is True: return "true"
    if v is False: return "false"
    if isinstance(v, (int, float)): return _es_number(v)
    if isinstance(v, str): return _es_string(v)
    if isinstance(v, list): return "[" + ",".join(canonicalize(i) for i in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=lambda k: k.encode("utf-16-be"))   # UTF-16 code-unit order
        return "{" + ",".join(_es_string(k) + ":" + canonicalize(v[k]) for k in keys) + "}"
    raise CanonicalizationError("unsupported type " + type(v).__name__)

def sha256_hex(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def hash_canonical(v): return sha256_hex(canonicalize(v))
def compute_event_id(stream_id, seq): return hash_canonical({"seq": seq, "stream_id": stream_id})
def compute_event_hash(event):
    return hash_canonical({k: v for k, v in event.items() if k != "hash"})

# ---------------- JSON Schema subset validator ----------------
# Supported keywords: type (string|list), const, enum, pattern, minimum, maximum, minLength,
# maxLength, properties, required, additionalProperties(false), items, minItems, maxItems,
# uniqueItems, oneOf, $ref (local "#/$defs/..." only).
def _type_ok(t, v):
    if t == "null": return v is None
    if t == "boolean": return isinstance(v, bool)
    if t == "integer": return isinstance(v, int) and not isinstance(v, bool)
    if t == "number": return isinstance(v, (int, float)) and not isinstance(v, bool)
    if t == "string": return isinstance(v, str)
    if t == "array": return isinstance(v, list)
    if t == "object": return isinstance(v, dict)
    return False

def validate(schema, value, root=None, path="$"):
    root = root or schema
    errs = []
    if "$ref" in schema:
        ref = schema["$ref"]
        assert ref.startswith("#/$defs/"), ref
        return validate(root["$defs"][ref[8:]], value, root, path)
    if "oneOf" in schema:
        ok = [validate(s, value, root, path) for s in schema["oneOf"]]
        if sum(1 for e in ok if not e) != 1:
            errs.append((path, "ONEOF"))
        return errs
    if "const" in schema and (value != schema["const"] or type(value) != type(schema["const"])):
        return [(path, "LITERAL")]
    if "type" in schema:
        ts = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_type_ok(t, value) for t in ts):
            return [(path, "NULL_NOT_ALLOWED" if value is None else "TYPE")]
    if "enum" in schema and value not in schema["enum"]:
        errs.append((path, "ENUM"))
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errs.append((path, "PATTERN"))
        if "minLength" in schema and len(value) < schema["minLength"]: errs.append((path, "LENGTH"))
        if "maxLength" in schema and len(value) > schema["maxLength"]: errs.append((path, "LENGTH"))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]: errs.append((path, "OUT_OF_RANGE"))
        if "maximum" in schema and value > schema["maximum"]: errs.append((path, "OUT_OF_RANGE"))
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]: errs.append((path, "LENGTH"))
        if "maxItems" in schema and len(value) > schema["maxItems"]: errs.append((path, "LENGTH"))
        if schema.get("uniqueItems") and len({canonicalize(i) for i in value}) != len(value):
            errs.append((path, "DUPLICATE_ITEM"))
        if schema.get("x-sorted") and any(value[i] >= value[i + 1] for i in range(len(value) - 1)):
            errs.append((path, "NOT_SORTED"))
        if "items" in schema:
            for i, it in enumerate(value):
                errs += validate(schema["items"], it, root, f"{path}[{i}]")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for r in schema.get("required", []):
            if r not in value: errs.append((f"{path}.{r}", "MISSING_FIELD"))
        for k, v in value.items():
            if k in props: errs += validate(props[k], v, root, f"{path}.{k}")
            elif schema.get("additionalProperties") is False: errs.append((f"{path}.{k}", "UNKNOWN_FIELD"))
    return errs

# ---------------- envelope / stream integrity (not a verifier) ----------------
def check_event_integrity(e):
    errs = []
    if e["event_id"] != compute_event_id(e["stream_id"], e["seq"]): errs.append("EVENT_ID_INVALID")
    if e["hash"] != compute_event_hash(e): errs.append("HASH_INVALID")
    if (e["seq"] == 1) != (e["prev_hash"] is None): errs.append("GENESIS_INVALID")
    return errs

def check_stream_chain(events):
    """events of ONE stream. Returns list of error codes. Gaps are reported as SEQ_GAP warnings by callers."""
    errs = []
    by_seq = {}
    for e in events:
        errs += check_event_integrity(e)
        if e["seq"] in by_seq and by_seq[e["seq"]]["hash"] != e["hash"]: errs.append("HASH_CONFLICT")
        by_seq.setdefault(e["seq"], e)
    for s, e in by_seq.items():
        if s > 1 and (s - 1) in by_seq and e["prev_hash"] != by_seq[s - 1]["hash"]: errs.append("CHAIN_BROKEN")
    return errs

# ---------------- CL06.3 semantic rules (contract layer; NOT the fact verifier) ----------------
STREAM_OF = {"session": lambda e: "session:" + e["scope"].get("session_id", ""), "prescription": lambda e: "prescription:" + e["scope"].get("prescription_id", ""),
             "consent": lambda e: "consent:" + e["scope"]["participant_id"], "review": lambda e: "review:%s.%s" % (e["actor"]["id"], e["scope"]["participant_id"]),
             "privacy": lambda e: "privacy:" + e["scope"]["participant_id"]}
START_SOURCE = {"camera": "camera", "simulation": "simulation", "report_only": "participant_report"}

def check_event_semantics(e, cat, limits, real_data_gate_open=False):
    """Stateless cross-field rules for one v3 event. Returns a list of error codes."""
    errs = []; t = cat["types"][e["type"]]
    if e["actor"]["role"] not in t["actors"]: errs.append("ACTOR_NOT_ALLOWED")
    if e["source"]["type"] not in t["sources"]: errs.append("SOURCE_NOT_ALLOWED")
    sc = e["scope"]
    for k in t["scope"]["required"]:
        if k not in sc: errs.append("SCOPE_INVALID")
    for k in t["scope"]["forbidden"]:
        if k in sc: errs.append("SCOPE_INVALID")
    if e["stream_id"] != STREAM_OF[t["stream"]](e): errs.append("STREAM_MISMATCH")
    alg = t["algorithm"]; has = "algorithm_version" in e["source"]
    if (alg == "required" and not has) or (alg == "forbidden" and has) or (alg == "capture-only" and has != (e["source"]["type"] in ("camera", "simulation"))):
        errs.append("VERSION_MISMATCH")
    mono = "t_mono_ms" in e
    if (t["mono"] == "required" and not mono) or (t["mono"] == "forbidden" and mono): errs.append("RULE_VIOLATION")
    em = e["execution_mode"]
    if t["stream"] != "session":
        if em != "not_applicable": errs.append("EXECUTION_MODE_MISMATCH")
    else:
        if em == "not_applicable": errs.append("EXECUTION_MODE_MISMATCH")
        if e["type"] == "session.started":
            if e["seq"] != 1: errs.append("RULE_VIOLATION")
            if e["payload"]["source_mode"] != em or START_SOURCE[em] != e["source"]["type"]: errs.append("EXECUTION_MODE_MISMATCH")
            if (em == "report_only") != (e["payload"]["capture_context"] is None): errs.append("RULE_VIOLATION")
        elif t["sources"] == ["camera", "simulation"] and e["source"]["type"] != em: errs.append("EXECUTION_MODE_MISMATCH")
    if e["data_origin"] in cat["rules"]["origin_ref_required_for"] and "origin_ref" not in e: errs.append("ORIGIN_REF_REQUIRED")
    if e["data_origin"] == "live" and not real_data_gate_open: errs.append("REAL_DATA_GATE_CLOSED")
    if e["type"] == "prescription.published":
        p = e["payload"]
        if p["limits_version"] != limits["limits_version"] or p["target_sets"] > limits["max_sets"] or p["target_repetitions"] > limits["max_repetitions"] \
           or p["target_sets"] * p["target_repetitions"] > limits["max_product"]: errs.append("LIMITS_EXCEEDED")
        if e["seq"] != p["revision"] or sc.get("prescription_revision") != p["revision"]: errs.append("RULE_VIOLATION")
        if (p["supersedes_revision"] if p["revision"] > 1 else None) != (p["revision"] - 1 if p["revision"] > 1 else None): errs.append("RULE_VIOLATION")
    return sorted(set(errs))

def check_session_stream(events, prescription_payload):
    """Stream-level rules for one session stream (ordered by seq). Needs the frozen prescription payload."""
    errs = []; side = prescription_payload["side"]
    start = next((e for e in events if e["type"] == "session.started"), None)
    for e in events:
        if start and e["execution_mode"] != start["execution_mode"]: errs.append("EXECUTION_MODE_MISMATCH")
        if e["type"] == "cycle.accepted":
            h = e["payload"]["handedness"]
            if h is not None and h["label"] != side: errs.append("HANDEDNESS_INCOMPATIBLE_ACCEPTED")
        if e["type"] == "cycle.rejected" and e["payload"]["reason"] == "handedness_incompatible":
            h = e["payload"]["handedness"]
            if h is None or h["label"] == side: errs.append("RULE_VIOLATION")
    return sorted(set(errs))

ENTITY_PREFIX = {"participant": "p", "therapist": "t", "care_link": "cl", "functional_assessment": "fa", "goal": "gl", "encounter": "en",
                 "reassessment": "ra", "instrumental_measurement": "im", "draft": "dr"}
def compute_entity_hash(ent): return hash_canonical({k: v for k, v in ent.items() if k != "hash"})
def check_entity_semantics(ent, cat, real_data_gate_open=False):
    errs = []
    if ent["entity_id"].split("_")[0] != ENTITY_PREFIX[ent["entity_type"]]: errs.append("RULE_VIOLATION")
    if ent["hash"] != compute_entity_hash(ent): errs.append("ENTITY_HASH_INVALID")
    if (ent["version"] == 1) != (ent["prev_hash"] is None): errs.append("ENTITY_CHAIN_BROKEN")
    if ent["data_origin"] in cat["rules"]["origin_ref_required_for"] and "origin_ref" not in ent: errs.append("ORIGIN_REF_REQUIRED")
    if ent["data_origin"] == "live" and not real_data_gate_open: errs.append("REAL_DATA_GATE_CLOSED")
    p = ent["payload"]
    if ent["entity_type"] == "goal":
        achieved = p["status"] == "achieved_confirmed"
        if achieved != (p["confirmed_by"] is not None and p["confirmed_at"] is not None) or (p["confirmed_by"] is None) != (p["confirmed_at"] is None): errs.append("GOAL_CONFIRMATION_REQUIRED")
        if achieved and ent["author"]["role"] != "therapist": errs.append("GOAL_CONFIRMATION_REQUIRED")
    if ent["entity_type"] in ("care_link", "functional_assessment", "goal", "encounter", "reassessment", "instrumental_measurement") and ent["author"]["role"] != "therapist": errs.append("ROLE_NOT_ALLOWED")
    if ent["entity_type"] == "draft" and p["status"] == "confirmed" and (p["confirmed_by"] is None): errs.append("DRAFT_NOT_CONFIRMED")
    if ent["entity_type"] == "draft" and p["draft_kind"] == "session_report_proposal" and ent["author"]["role"] != "participant": errs.append("ROLE_NOT_ALLOWED")
    return sorted(set(errs))

def check_entity_chain(versions):
    errs = []; vs = sorted(versions, key=lambda v: v["version"])
    for i, v in enumerate(vs):
        if v["version"] != i + 1: errs.append("ENTITY_VERSION_CONFLICT")
        if i > 0 and v["prev_hash"] != vs[i - 1]["hash"]: errs.append("ENTITY_CHAIN_BROKEN")
    return sorted(set(errs))
