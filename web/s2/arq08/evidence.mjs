import { hashCanonical } from "../../v3/canonical.mjs";

/** Serialize a local synthetic candidate. Stream position belongs to the future session owner. */
export async function sealSyntheticCycle(candidate, { seq, prevHash, occurredAt }) {
  if (candidate.execution_mode !== "simulation" || candidate.data_origin !== "synthetic_fixture" ||
      !["cycle.accepted", "cycle.rejected"].includes(candidate.type) ||
      !Number.isInteger(seq) || seq < 1 || seq > 1_000_000_000 ||
      (seq === 1 ? prevHash !== null : !/^[0-9a-f]{64}$/.test(prevHash)) ||
      typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt)) ||
      new Date(occurredAt).toISOString() !== occurredAt) throw new TypeError("Invalid synthetic cycle position");
  const streamId = "session:" + candidate.scope.session_id;
  const event = {
    event_id: await hashCanonical({ stream_id: streamId, seq }),
    schema_version: 3,
    type: candidate.type,
    stream_id: streamId,
    seq,
    prev_hash: prevHash,
    occurred_at: occurredAt,
    t_mono_ms: candidate.t_mono_ms,
    actor: { role: "participant", id: candidate.scope.participant_id },
    scope: { ...candidate.scope },
    source: { type: "simulation", algorithm_version: candidate.algorithm_version },
    execution_mode: "simulation",
    data_origin: "synthetic_fixture",
    payload: structuredClone(candidate.payload),
  };
  return { ...event, hash: await hashCanonical(event) };
}
