/**
 * Elo v3 — CMP-07 CommandController (ARQ-02, addendum A1 / contracts 3.1.0).
 *
 * One controller per page. For every keyed command (one form = one business intention) it provides:
 *  - single-flight: a second submit (double click, Enter+click) while one is in flight, or within
 *    BURST_GUARD_MS after a success, is ignored (a deliberate repeat is a new intention with a new key);
 *  - one Idempotency-Key (UUID v4) per intention, reused for ambiguous failures (network, timeout, 5xx),
 *    so a lost response after commit is recovered by replay instead of a duplicate;
 *  - a bounded automatic-retry window: min(24 h, server retention - safety margin). After the window the
 *    intention becomes "unknown": no automatic resend, no silent new key; only `startNewIntention` clears it;
 *  - definite failures (4xx, including 409 IDEMPOTENCY_KEY_REUSED) and successes close the intention.
 *
 * The controller never stores or logs payloads, tokens or clinical data: only key, form id and timestamps.
 * Invite generation (single-use secret) uses `singleFlightOnly`: no key, nothing retained.
 */

export const MAX_AUTO_RETRY_MS = 24 * 3600 * 1000;
export const SAFETY_MARGIN_MS = 3600 * 1000;
export const BURST_GUARD_MS = 500; // submits of the same form right after a success are the same gesture (Enter+click, double click)
export const ASSUMED_RETENTION_DAYS = 1; // contract minimum, used until the server announces its own

/** Small non-cryptographic digest: lets the burst guard compare content without retaining it. */
export function digest(value) {
  const str = typeof value === "string" ? value : JSON.stringify(value ?? null);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return `${str.length}:${h}`;
}

export function isAmbiguousFailure(err) {
  const status = Number(err?.status ?? 0);
  return status === 0 || status === 408 || status >= 500;
}

export function createCommandController(options = {}) {
  const now = options.now || (() => Date.now());
  const uuid = options.uuid || (() => globalThis.crypto.randomUUID());
  let retentionDays = Number(options.retentionDays) > 0 ? Number(options.retentionDays) : ASSUMED_RETENTION_DAYS;
  const marginMs = options.marginMs ?? SAFETY_MARGIN_MS;
  const intentions = new Map(); // formId -> { key, startedAt }
  const inflight = new Set();
  const burstMs = options.burstMs ?? BURST_GUARD_MS;
  const lastOk = new Map(); // formId -> time of last success

  function withinBurst(id, sig) {
    const last = lastOk.get(id);
    if (!last) return false;
    if (sig !== undefined && last.sig !== sig) return false; // different content = different intention
    const elapsed = now() - last.at;
    return elapsed >= 0 && elapsed < burstMs; // a clock moved backwards never blocks a submit
  }
  function windowMs() {
    return Math.max(0, Math.min(MAX_AUTO_RETRY_MS, retentionDays * 86400000 - marginMs));
  }
  function setRetentionDays(days) {
    const n = Number(days);
    if (Number.isFinite(n) && n >= 1 && n <= 90) retentionDays = n;
  }
  function stateOf(formId) {
    if (inflight.has(formId)) return "in_flight";
    const it = intentions.get(formId);
    if (!it) return "idle";
    return now() - it.startedAt > windowMs() ? "unknown" : "pending_retry";
  }

  /**
   * @param {string} formId stable id of the form/command slot
   * @param {(key: string) => Promise<any>} send performs the request with the given key
   * @param {{signature?: unknown}} [runOptions] content signature for the burst guard (digested, never retained)
   * @returns {Promise<{status: "ok"|"error"|"ambiguous"|"unknown"|"ignored", result?: any, error?: any, key?: string}>}
   */
  async function run(formId, send, runOptions = {}) {
    const sig = runOptions.signature === undefined ? undefined : digest(runOptions.signature);
    if (inflight.has(formId)) return { status: "ignored" };
    if (withinBurst(formId, sig)) return { status: "ignored" };
    let it = intentions.get(formId);
    if (it && now() - it.startedAt > windowMs()) return { status: "unknown", key: it.key };
    if (!it) {
      it = { key: uuid(), startedAt: now() };
      intentions.set(formId, it);
    }
    inflight.add(formId);
    try {
      const result = await send(it.key);
      intentions.delete(formId);
      lastOk.set(formId, { at: now(), sig });
      return { status: "ok", result, key: it.key };
    } catch (error) {
      if (isAmbiguousFailure(error)) return { status: "ambiguous", error, key: it.key };
      intentions.delete(formId);
      return { status: "error", error, key: it.key };
    } finally {
      inflight.delete(formId);
    }
  }

  /** Single-flight without any key or retained state (single-use secrets). */
  async function singleFlightOnly(slotId, send) {
    const sig = undefined;
    if (inflight.has(slotId)) return { status: "ignored" };
    if (withinBurst(slotId, sig)) return { status: "ignored" };
    inflight.add(slotId);
    try {
      const result = await send();
      lastOk.set(slotId, { at: now(), sig });
      return { status: "ok", result };
    } catch (error) {
      return { status: "error", error };
    } finally {
      inflight.delete(slotId);
    }
  }

  /** Explicit new user intention: drops an unknown/pending intention so the next run gets a fresh key. */
  function startNewIntention(formId) {
    if (inflight.has(formId)) return false;
    intentions.delete(formId);
    return true;
  }

  return { run, singleFlightOnly, startNewIntention, stateOf, setRetentionDays, windowMs };
}
