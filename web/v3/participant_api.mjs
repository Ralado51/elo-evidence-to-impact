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

    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: reqOptions.body !== undefined ? JSON.stringify(reqOptions.body) : undefined,
      });
    } catch (err) {
      throw new ParticipantApiError({
        code: "NETWORK_ERROR",
        status: 0,
        message: err instanceof Error ? err.message : "Network request failed.",
      });
    }

    let data = null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const errObj = data && typeof data === "object" && data.error ? data.error : null;
      const code =
        (errObj && typeof errObj.code === "string" && errObj.code) ||
        (response.status === 401
          ? "UNAUTHENTICATED"
          : response.status === 403
            ? "FORBIDDEN"
            : response.status === 404
              ? "NOT_FOUND"
              : "HTTP_ERROR");
      const message =
        (errObj && typeof errObj.message === "string" && errObj.message) ||
        `HTTP ${response.status}`;
      throw new ParticipantApiError({
        code,
        status: response.status,
        message,
        details: errObj?.details ?? null,
      });
    }

    return {
      endpointId,
      status: response.status,
      headers: response.headers,
      data,
    };
  }

  return {
    redeemInvite(inviteToken) {
      return request("POST", "/api/v3/auth/invite", {
        auth: false,
        body: { invite_token: inviteToken },
      });
    },
    getCurrentPrescription(participantId) {
      return request(
        "GET",
        `/api/v3/participants/${encodeURIComponent(participantId)}/prescription/current`
      );
    },
    listGoals(participantId) {
      return request(
        "GET",
        `/api/v3/participants/${encodeURIComponent(participantId)}/goals`
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
    getSummary(summaryId) {
      return request("GET", `/api/v3/summaries/${encodeURIComponent(summaryId)}`);
    },
    getEvolution(evolutionId) {
      return request("GET", `/api/v3/evolution/${encodeURIComponent(evolutionId)}`);
    },
  };
}
