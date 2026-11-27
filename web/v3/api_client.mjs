import { performRequest } from "./http_transport.mjs";
/**
 * Elo v3 — Typed HTTP client strictly constrained to /api/v3 contract routes.
 *
 * Enforces Row 2 & Row 8 at runtime:
 * - Only /api/v3/* endpoints declared in api-contract.v3.json may be called.
 * - Zero legacy API or legacy web references.
 */

const ALLOWED_V3_ROUTE_PATTERNS = Object.freeze([
  { method: "GET", id: "health", regex: /^\/api\/v3\/health$/ },
  { method: "POST", id: "auth.therapist", regex: /^\/api\/v3\/auth\/therapist$/ },
  { method: "POST", id: "participants.create", regex: /^\/api\/v3\/participants$/ },
  { method: "POST", id: "invites.create", regex: /^\/api\/v3\/invites$/ },
  { method: "GET", id: "entities.versions", regex: /^\/api\/v3\/entities\/[^/]+\/versions$/ },
  { method: "POST", id: "assessments.create", regex: /^\/api\/v3\/participants\/[^/]+\/assessments$/ },
  { method: "GET", id: "assessments.list", regex: /^\/api\/v3\/participants\/[^/]+\/assessments$/ },
  { method: "POST", id: "goals.create", regex: /^\/api\/v3\/participants\/[^/]+\/goals$/ },
  { method: "GET", id: "goals.list", regex: /^\/api\/v3\/participants\/[^/]+\/goals$/ },
  { method: "POST", id: "prescriptions.publish", regex: /^\/api\/v3\/prescriptions$/ },
  { method: "GET", id: "prescriptions.current", regex: /^\/api\/v3\/participants\/[^/]+\/prescription\/current$/ },
  { method: "GET", id: "prescriptions.history", regex: /^\/api\/v3\/participants\/[^/]+\/prescriptions$/ },
  { method: "GET", id: "facts.list", regex: /^\/api\/v3\/participants\/[^/]+\/facts$/ },
  { method: "GET", id: "facts.evidence", regex: /^\/api\/v3\/facts\/[^/]+\/evidence$/ },
  { method: "POST", id: "reviews.record", regex: /^\/api\/v3\/reviews$/ },
  { method: "POST", id: "summaries.publish", regex: /^\/api\/v3\/summaries$/ },
  { method: "GET", id: "summaries.get", regex: /^\/api\/v3\/summaries\/[^/]+$/ },
  { method: "GET", id: "evolution.series", regex: /^\/api\/v3\/participants\/[^/]+\/evolution\/series$/ },
  { method: "POST", id: "evolution.publish", regex: /^\/api\/v3\/evolution$/ },
  { method: "GET", id: "evolution.get", regex: /^\/api\/v3\/evolution\/[^/]+$/ },
  { method: "GET", id: "timeline.get", regex: /^\/api\/v3\/participants\/[^/]+\/timeline$/ },
]);

export class V3ApiError extends Error {
  /**
   * @param {{ code: string, status: number, message: string, details?: unknown }} info
   */
  constructor({ code, status, message, details = null }) {
    super(message || code);
    this.name = "V3ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Verify that (method, pathWithQuery) matches one of the allowed /api/v3 contract routes.
 *
 * @param {string} method
 * @param {string} pathWithQuery
 * @returns {string} contract endpoint id
 */
export function assertContractRoute(method, pathWithQuery) {
  const upper = String(method || "").toUpperCase();
  const pathname = String(pathWithQuery || "").split("?")[0];
  if (!pathname.startsWith("/api/v3/")) {
    throw new Error(`Contract violation: non-v3 path rejected (${upper} ${pathname})`);
  }
  const match = ALLOWED_V3_ROUTE_PATTERNS.find(
    (entry) => entry.method === upper && entry.regex.test(pathname)
  );
  if (!match) {
    throw new Error(`Contract violation: undeclared v3 route (${upper} ${pathname})`);
  }
  return match.id;
}

/**
 * Create a v3 API client bound to an optional base URL and fetch implementation.
 *
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, getToken?: () => string | null }} [options]
 */
export function createV3Client(options = {}) {
  const baseUrl = (options.baseUrl || "").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const getToken = options.getToken || (() => null);

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, auth?: boolean }} [reqOptions]
   */
  async function request(method, path, reqOptions = {}) {
    // /api/console/v1/* are read-only index views (docs/PROPOSTA_API_CONSOLE.md), outside the contract table.
    const endpointId =
      reqOptions.console === true && path.startsWith("/api/console/v1/") && method.toUpperCase() === "GET"
        ? "console.view"
        : assertContractRoute(method, path);
    const useAuth = reqOptions.auth !== false;
    const headers = {
      Accept: "application/json",
    };
    if (reqOptions.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (reqOptions.idempotencyKey) {
      headers["Idempotency-Key"] = reqOptions.idempotencyKey;
    }
    if (useAuth) {
      const token = getToken();
      if (!token) {
        throw new V3ApiError({
          code: "UNAUTHENTICATED",
          status: 401,
          message: "Missing bearer token.",
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
      makeError: (info) => new V3ApiError(info),
    });
    return { endpointId, status: out.status, headers: out.headers, data: out.data };
  }

  return {
    health() {
      return request("GET", "/api/v3/health", { auth: false });
    },
    loginTherapist(username, password) {
      return request("POST", "/api/v3/auth/therapist", {
        auth: false,
        body: { username, password },
      });
    },
    listParticipants(q = "", opts = {}) {
      const qs = q ? `?q=${encodeURIComponent(q)}` : "";
      return request("GET", `/api/console/v1/participants${qs}`, { console: true, signal: opts.signal });
    },
    listPublications(participantId, opts = {}) {
      return request("GET", `/api/console/v1/participants/${encodeURIComponent(participantId)}/publications`, { console: true, signal: opts.signal });
    },
    createInvite(participantId, ttlSeconds = 3600) {
      return request("POST", "/api/v3/invites", { body: { participant_id: participantId, ttl_seconds: ttlSeconds } });
    },
    createParticipant(alias, side, opts = {}) {
      return request("POST", "/api/v3/participants", {
        body: { alias, side },
        idempotencyKey: opts.idempotencyKey,
      });
    },
    createAssessment(participantId, payload, opts = {}) {
      return request("POST", `/api/v3/participants/${encodeURIComponent(participantId)}/assessments`, {
        body: payload,
        idempotencyKey: opts.idempotencyKey,
      });
    },
    listAssessments(participantId, opts = {}) {
      return request("GET", `/api/v3/participants/${encodeURIComponent(participantId)}/assessments`, { signal: opts.signal });
    },
    createGoal(participantId, payload, opts = {}) {
      return request("POST", `/api/v3/participants/${encodeURIComponent(participantId)}/goals`, {
        body: payload,
        idempotencyKey: opts.idempotencyKey,
      });
    },
    listGoals(participantId, opts = {}) {
      return request("GET", `/api/v3/participants/${encodeURIComponent(participantId)}/goals`, { signal: opts.signal });
    },
    publishPrescription(draft, opts = {}) {
      return request("POST", "/api/v3/prescriptions", {
        body: draft,
        idempotencyKey: opts.idempotencyKey,
      });
    },
    getCurrentPrescription(participantId, opts = {}) {
      return request(
        "GET",
        `/api/v3/participants/${encodeURIComponent(participantId)}/prescription/current`,
        { signal: opts.signal }
      );
    },
    listFacts(participantId, range = {}, opts = {}) {
      const qs = new URLSearchParams();
      if (range.from) qs.set("from", range.from);
      if (range.to) qs.set("to", range.to);
      if (range.includeReviews) qs.set("include", "reviews");
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request("GET", `/api/v3/participants/${encodeURIComponent(participantId)}/facts${suffix}`, { signal: opts.signal });
    },
    getFactEvidence(factId, opts = {}) {
      return request("GET", `/api/v3/facts/${encodeURIComponent(factId)}/evidence`, { signal: opts.signal });
    },
    recordReview(payload, opts = {}) {
      return request("POST", "/api/v3/reviews", {
        body: payload,
        idempotencyKey: opts.idempotencyKey,
      });
    },
    publishSummary(payload, opts = {}) {
      return request("POST", "/api/v3/summaries", {
        body: payload,
        idempotencyKey: opts.idempotencyKey,
      });
    },
    getSummary(summaryId, opts = {}) {
      return request("GET", `/api/v3/summaries/${encodeURIComponent(summaryId)}`, { signal: opts.signal });
    },
    getEvolutionSeries(participantId, range = {}, opts = {}) {
      const qs = new URLSearchParams();
      if (range.from) qs.set("from", range.from);
      if (range.to) qs.set("to", range.to);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request(
        "GET",
        `/api/v3/participants/${encodeURIComponent(participantId)}/evolution/series${suffix}`,
        { signal: opts.signal }
      );
    },
    publishEvolution(payload, opts = {}) {
      return request("POST", "/api/v3/evolution", {
        body: payload,
        idempotencyKey: opts.idempotencyKey,
      });
    },
    getEvolution(evolutionId, opts = {}) {
      return request("GET", `/api/v3/evolution/${encodeURIComponent(evolutionId)}`, { signal: opts.signal });
    },
    getTimeline(participantId, opts = {}) {
      return request("GET", `/api/v3/participants/${encodeURIComponent(participantId)}/timeline`, { signal: opts.signal });
    },
  };
}
