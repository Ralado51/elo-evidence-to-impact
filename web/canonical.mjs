// CL06.3 canonical JSON (RFC 8785 subset), hashing, and envelope/stream integrity (JavaScript).
//
// Origin-Source: contracts/CL06_3/reference/js/elo_ref.mjs
// Origin-SHA256: 70d4ad27309e3ffd84e2a606265d0425ab8e9f42bd80809849879bc0f362e5f6
// Origin-License: Apache-2.0
// Origin-Attribution: Airton Justino O. Junior (Elo CL06.3 contract package; ported per PO-F10)
//
// Node built-in modules only (node:crypto). Mirrors api/src/elo/canonical.py byte for byte.

import { createHash } from "node:crypto";

export class CanonicalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

function ser(v) {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new CanonicalizationError("non-finite number");
      return JSON.stringify(Object.is(v, -0) ? 0 : v);
    case "string":
      if (!v.isWellFormed()) throw new CanonicalizationError("lone surrogate");
      return JSON.stringify(v);
    case "object":
      if (Array.isArray(v)) return "[" + v.map(ser).join(",") + "]";
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
        throw new CanonicalizationError("not plain");
      }
      return "{" + Object.keys(v).sort().map((k) => ser(k) + ":" + ser(v[k])).join(",") + "}";
    default:
      throw new CanonicalizationError("unsupported " + typeof v);
  }
}

export const canonicalize = ser;
export const canonicalBytes = (v) => Buffer.from(canonicalize(v), "utf8");
export const sha256Hex = (t) => createHash("sha256").update(t, "utf8").digest("hex");
export const hashCanonical = (v) => sha256Hex(canonicalize(v));

export function contentHash(v) {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const { content_hash: _drop, ...rest } = v;
    return hashCanonical(rest);
  }
  return hashCanonical(v);
}

export const computeEventId = (streamId, seq) => hashCanonical({ seq, stream_id: streamId });

export function computeEventHash(e) {
  const { hash: _drop, ...rest } = e;
  return hashCanonical(rest);
}

export function checkEventIntegrity(e) {
  const errs = [];
  if (e.event_id !== computeEventId(e.stream_id, e.seq)) errs.push("EVENT_ID_INVALID");
  if (e.hash !== computeEventHash(e)) errs.push("HASH_INVALID");
  if ((e.seq === 1) !== (e.prev_hash === null)) errs.push("GENESIS_INVALID");
  return errs;
}

export function checkStreamChain(events) {
  const errs = [];
  const bySeq = new Map();
  for (const e of events) {
    errs.push(...checkEventIntegrity(e));
    if (bySeq.has(e.seq) && bySeq.get(e.seq).hash !== e.hash) errs.push("HASH_CONFLICT");
    if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  }
  for (const [s, e] of bySeq) {
    if (s > 1 && bySeq.has(s - 1) && e.prev_hash !== bySeq.get(s - 1).hash) errs.push("CHAIN_BROKEN");
  }
  return errs;
}
