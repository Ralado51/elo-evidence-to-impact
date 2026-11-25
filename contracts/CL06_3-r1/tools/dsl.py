"""Tiny DSL -> JSON Schema (draft 2020-12 subset used by CL06.3)."""
import copy
VERSION = "3.0.0"
def sch(id_, body, defs=None):
    d = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": f"elo:contracts:{VERSION}:{id_}"}
    d.update(body)
    if defs: d["$defs"] = defs
    return d
def S(pattern=None, enum=None, min=None, max=None, const=None, nullable=False):
    d = {"type": ["string", "null"] if nullable else "string"}
    if pattern: d["pattern"] = pattern
    if enum: d["enum"] = list(enum) + ([None] if nullable else [])
    if min is not None: d["minLength"] = min
    if max is not None: d["maxLength"] = max
    if const is not None: d = {"const": const}
    return d
def I(min=None, max=None, nullable=False):
    d = {"type": ["integer", "null"] if nullable else "integer"}
    if min is not None: d["minimum"] = min
    if max is not None: d["maximum"] = max
    return d
def N(min=None, max=None, nullable=False):
    d = {"type": ["number", "null"] if nullable else "number"}
    if min is not None: d["minimum"] = min
    if max is not None: d["maximum"] = max
    return d
B = lambda nullable=False: {"type": ["boolean", "null"] if nullable else "boolean"}
C = lambda v: {"const": v}
def A(item, min=None, max=None, unique=False):
    d = {"type": "array", "items": item}
    if min is not None: d["minItems"] = min
    if max is not None: d["maxItems"] = max
    if unique: d["uniqueItems"] = True
    return d
def O(props, required=None, optional=()):
    req = [k for k in props if k not in optional] if required is None else required
    return {"type": "object", "properties": props, "required": req, "additionalProperties": False}
def ONE(*variants): return {"oneOf": list(variants)}
# shared patterns (identical to CL06.1 primitives where they exist)
BODY = "[A-Za-z0-9-]{8,64}"
P = dict(org=f"^o_{BODY}$", therapist=f"^t_{BODY}$", participant=f"^p_{BODY}$", rx=f"^rx_{BODY}$", session=f"^s_{BODY}$",
         cal=f"^cal_{BODY}$", summ=f"^sum_{BODY}$", evo=f"^evo_{BODY}$", meas=f"^ms_{BODY}$", ent=f"^(cl|fa|gl|en|ra|im|dr)_{BODY}$",
         fact="^f_[0-9a-f]{64}$", hex="^[0-9a-f]{64}$", algo="^[a-z0-9][a-z0-9.-]{1,40}$",
         inst=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$", date=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
         consent="^consent-[0-9]{4}-[0-9]{2}-[0-9]{2}-v[0-9]{1,3}$", key="^[a-z][a-z0-9_]{1,48}$", proto="^proto_[A-Za-z0-9-]{4,48}$",
         actor="^(p|t|sys)_" + BODY + "$", limits=r"^limits-v[0-9]{1,3}$", ver=r"^[0-9]+\.[0-9]+\.[0-9]+$")
def pat(k, nullable=False): return S(pattern=P[k], nullable=nullable)
hexs = lambda nullable=False: S(pattern=P["hex"], nullable=nullable)
inst = lambda: S(pattern=P["inst"])
date = lambda nullable=False: S(pattern=P["date"], nullable=nullable)
