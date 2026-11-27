import { performRequest } from "./http_transport.mjs";
/**
 * Elo v3 — Participant HTTP client strictly constrained to participant-allowed
 * /api/v3 contract routes (ACCEPTANCE Row 2, Row 3, Row 9, Row 12).
 *
 * Zero legacy routes, zero therapist-only routes, zero Node-only imports.
 */

const ALLOWED_PARTICIPANT_V3_ROUTES = Object.freeze([
  { method: "POST", id: "auth.invite", regex: /^\/api\/v3\/auth\/invite$/ },
  {
    method: "GET",
    id: "prescriptions.current",
    regex: /^\/api\/v3\/participants\/[^/]+\/prescription\/current$/,
  },
  {
    method: "GET",
    id: "goals.list",
    regex: /^\/api\/v3\/participants\/[^/]+\/goals$/,
  },
  { method: "POST", id: "events.batch", regex: /^\/api\/v3\/events:batch$/ },
  {
    method: "GET",
    id: "summaries.get",
    regex: /^\/api\/v3\/summaries\/[^/]+$/,
  },
  {
    method: "GET",
    id: "evolution.get",
    regex: /^\/api\/v3\/evolution\/[^/]+$/,
  },
]);

export class ParticipantApiError extends Error {
  /**
   * @param {{ code: string, status: number, message: string, codes?: string[], details?: unknown }} info
   */
  constructor({ code, status, message, codes = [], details = null }) {
    super(message || code);
    this.name = "ParticipantApiError";
    this.code = code;
    this.status = status;
    this.codes = codes;
    this.details = details;
  }
}

/**
 * Verify that (method, pathWithQuery) matches one of the participant-allowed /api/v3 routes.
 *
 * @param {string} method
 * @param {string} pathWithQuery
 * @returns {string}
 */
export function assertParticipantContractRoute(method, pathWithQuery) {
  const upper = String(method || "").toUpperCase();
  const pathname = String(pathWithQuery || "").split("?")[0];
  // Read-only index of the participant's own publications (docs/PROPOSTA_API_CONSOLE.md). Content still uses contract routes.
  if (upper === "GET" && /^\/api\/console\/v1\/participants\/[^/]+\/publications$/.test(pathname)) {
    return "console.publications";
  }
  if (!pathname.startsWith("/api/v3/")) {
    throw new Error(`Contract violation: non-v3 path rejected (${upper} ${pathname})`);
  }
  const match = ALLOWED_PARTICIPANT_V3_ROUTES.find(
    (entry) => entry.method === upper && entry.regex.test(pathname)
  );
  if (!match) {
    throw new Error(
      `Contract violation: route not participant-allowed in api-contract.v3.json (${upper} ${pathname})`
    );
  }
  return match.id;
}

/**
 * Select the most informative error code from a rejected events:batch item's codes array.
 *
 * @param {string[]} codes
 * @returns {string}
 */
function pickPrimaryBatchErrorCode(codes) {
  const list = Array.isArray(codes) ? codes : [];
  for (const priority of ["FORBIDDEN", "CONSENT_REQUIRED", "SCOPE_VIOLATION", "INVALID_TRANSITION"]) {
    if (list.includes(priority)) return priority;
  }
  return list[0] || "RULE_VIOLATION";
}

/**
 * Create a participant v3 API client.
 *
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, getToken?: () => string | null }} [options]
 */
export function createParticipantClient(options = {}) {
  const baseUrl = (options.baseUrl || "").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const getToken = options.getToken || (() => null);

  async function request(method, path, reqOptions = {}) {
    const endpointId = assertParticipantContractRoute(method, path);
    const useAuth = reqOptions.auth !== false;
    const headers = {
      Accept: "application/json",
    };
    if (reqOptions.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (useAuth) {
      const token = getToken();
      if (!token) {
        throw new ParticipantApiError({
          code: "UNAUTHENTICATED",
          status: 401,
          message: "Missing participant bearer token.",
        });
      }
      headers.Authorization = `Bearer ${token}`;
    }

    const out = await performRequest({
      fetchImpl,
      url: `${baseUrl}${path}`,
      method,
      headers,
      body: reqOptions.body,
      signal: reqOptions.signal,
      makeError: (info) => new ParticipantApiError(info),
    });
    return { endpointId, status: out.status, headers: out.headers, data: out.data };
  }

  return {
    redeemInvite(inviteToken) {
      return request("POST", "/api/v3/auth/invite", {
        auth: false,
        body: { invite_token: inviteToken },
      });
    },
    getCurrentPrescription(participantId, opts = {}) {
      return request(
        "GET",
        `/api/v3/participants/${encodeURIComponent(participantId)}/prescription/current`,
        { signal: opts.signal }
      );
    },
    listGoals(participantId, opts = {}) {
      return request(
        "GET",
        `/api/v3/participants/${encodeURIComponent(participantId)}/goals`,
        { signal: opts.signal }
      );
    },
    async postEventsBatch(events) {
      const res = await request("POST", "/api/v3/events:batch", {
        body: { events },
      });
      const results = Array.isArray(res.data?.results) ? res.data.results : [];
      const rejected = results.find((item) => item?.status === "rejected");
      if (rejected) {
        const codes = Array.isArray(rejected.codes) ? rejected.codes : [];
        const primary = pickPrimaryBatchErrorCode(codes);
        throw new ParticipantApiError({
          code: primary,
          status: res.status,
          codes,
          message: `Batch item rejected: ${codes.join(", ")}`,
          details: results,
        });
      }
      return res;
    },
    listPublications(participantId, opts = {}) {
      return request("GET", `/api/console/v1/participants/${encodeURIComponent(participantId)}/publications`, { signal: opts.signal });
    },
    getSummary(summaryId, opts = {}) {
      return request("GET", `/api/v3/summaries/${encodeURIComponent(summaryId)}`, { signal: opts.signal });
    },
    getEvolution(evolutionId, opts = {}) {
      return request("GET", `/api/v3/evolution/${encodeURIComponent(evolutionId)}`, { signal: opts.signal });
    },
  };
}
