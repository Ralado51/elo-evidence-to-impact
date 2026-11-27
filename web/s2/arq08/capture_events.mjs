import { hashCanonical } from "../../v3/canonical.mjs";

export const PROTOCOL_VERSION = "contador-exp-1"; // experimental, not clinically validated (PO B2)
export const SIMULATION_MODE = "simulation";
export const DATA_ORIGIN = "synthetic_fixture";

/** Build and hash one v3 client-authored event on a simulation capture stream. Stream position is owned by the caller. */
export async function buildCaptureEvent({ type, scope, seq, prevHash, occurredAt, tMonoMs, payload, algorithmVersion = PROTOCOL_VERSION }) {
  const streamId = "session:" + scope.session_id;
  const isReport = type === "report.submitted";
  const body = {
    event_id: await hashCanonical({ seq, stream_id: streamId }),
    schema_version: 3,
    type,
    stream_id: streamId,
    seq,
    prev_hash: prevHash,
    occurred_at: occurredAt,
    ...(isReport ? {} : { t_mono_ms: tMonoMs }),
    actor: { role: "participant", id: scope.participant_id },
    scope: { ...scope },
    source: isReport ? { type: "participant_report" } : { type: "simulation", algorithm_version: algorithmVersion },
    execution_mode: SIMULATION_MODE,
    data_origin: DATA_ORIGIN,
    payload,
  };
  return { ...body, hash: await hashCanonical(body) };
}
