import { hashCanonical } from "../../v3/canonical.mjs";

export const PROTOCOL_VERSION = "contador-exp-1"; // experimental, not clinically validated (PO B2)
export const SIMULATION_MODE = "simulation";
export const DATA_ORIGIN = "synthetic_fixture";
export const CAMERA_MODE = "camera";
export const CAMERA_ORIGIN = "experimental_capture"; // real capture is never classified as simulation (PO B1); "live" stays closed (PD-05)
export const CONSENT_VERSION = "consent-2026-11-27-v1";
// origin_ref identifies the experimental capture configuration (protocol + local model/library); it is not a clinical identifier.
export const originRef = (protocol = PROTOCOL_VERSION) => hashCanonical({ origin: CAMERA_ORIGIN, protocol, library: "tasks-vision-0.10.21", model: "hand_landmarker-float16-v1" });

/** Build and hash one v3 client-authored event on a simulation capture stream. Stream position is owned by the caller. */
export async function buildCaptureEvent({ type, scope, seq, prevHash, occurredAt, tMonoMs, payload, algorithmVersion = PROTOCOL_VERSION, mode = SIMULATION_MODE }) {
  const camera = mode === CAMERA_MODE;
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
    source: isReport ? { type: "participant_report" } : { type: mode, algorithm_version: algorithmVersion },
    execution_mode: mode,
    data_origin: camera ? CAMERA_ORIGIN : DATA_ORIGIN,
    ...(camera ? { origin_ref: await originRef(algorithmVersion) } : {}),
    payload,
  };
  return { ...body, hash: await hashCanonical(body) };
}

/** Consent stream event (stream "consent:<participant_id>", separate chain, no session scope, no monotonic time, no algorithm). */
export async function buildConsentEvent({ type, orgId, participantId, seq, prevHash, occurredAt, scopes = ["camera"] }) {
  if (type !== "consent.accepted" && type !== "consent.revoked") throw new TypeError("Invalid consent event type");
  const streamId = "consent:" + participantId;
  const body = {
    event_id: await hashCanonical({ seq, stream_id: streamId }),
    schema_version: 3, type, stream_id: streamId, seq, prev_hash: prevHash, occurred_at: occurredAt,
    actor: { role: "participant", id: participantId },
    scope: { org_id: orgId, participant_id: participantId },
    source: { type: "participant_report" },
    execution_mode: "not_applicable",
    data_origin: CAMERA_ORIGIN, origin_ref: await originRef(),
    payload: { consent_version: CONSENT_VERSION, scopes },
  };
  return { ...body, hash: await hashCanonical(body) };
}
