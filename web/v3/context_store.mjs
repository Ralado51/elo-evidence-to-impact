// ARQ-04 / CMP-10 — ContextStore + ContextGuard (pure module, no DOM).
// Controls what is DISPLAYED, never what is persisted: writes are never aborted (D-ARQ4 / FIX-37.1).
//  - reads:  begin(channel) aborts the previous read of that channel; the LAST REQUESTED wins; late results/errors are dropped.
//  - writes: capture() before the await; commit() renders only if the context is still current, otherwise orphan() reconciles.
//  - reset(reason): logout / principal change is a context boundary; aborts reads, invalidates tickets, runs resetters.
// Two levels: "principal" (lists, auth) is invalidated only by principal change/logout; "participant" (default) by any switch.

export function isAbortError(err) {
  return !!err && (err.name === "AbortError" || err.code === "ABORTED" || err.code === "ABORT_ERR");
}

export function createContextStore() {
  let principalGen = 0;
  let generation = 0;
  let scope = { principalId: null, role: null, participantId: null };
  const resetters = new Set();
  const channels = new Map(); // channel -> { op }
  const notices = new Map(); // participantId -> [notice] (memory only; never persisted)

  const snapshot = () => Object.freeze({ ...scope, principalGen, generation });

  function abortAll(reason, { includePrincipalLevel }) {
    for (const [name, entry] of channels) {
      if (!entry.op) continue;
      if (entry.op.level === "participant" || includePrincipalLevel) {
        entry.op.superseded = true;
        entry.op.controller.abort();
        entry.op = null;
      }
      void name; void reason;
    }
  }

  function runResetters(reason) {
    for (const fn of [...resetters]) {
      try { fn(reason, snapshot()); } catch { /* a resetter must never break a context switch */ }
    }
  }

  /** Move to another principal/participant. Returns true when the context actually changed. */
  function switchTo(next = {}) {
    const n = {
      principalId: next.principalId ?? scope.principalId,
      role: next.role ?? scope.role,
      participantId: next.participantId === undefined ? scope.participantId : (next.participantId || null),
    };
    const principalChanged = n.principalId !== scope.principalId || n.role !== scope.role;
    const participantChanged = n.participantId !== scope.participantId;
    if (!principalChanged && !participantChanged) return false;
    scope = n;
    generation += 1;
    if (principalChanged) principalGen += 1;
    abortAll(principalChanged ? "principal" : "switch", { includePrincipalLevel: principalChanged });
    runResetters(principalChanged ? "principal" : "switch");
    return true;
  }

  /** Hard boundary (logout, reload restore): everything in flight becomes obsolete, even if ids are unchanged. */
  function reset(reason = "logout") {
    scope = { principalId: null, role: null, participantId: null };
    generation += 1;
    principalGen += 1;
    abortAll(reason, { includePrincipalLevel: true });
    notices.clear(); // pending reconciliation notices and any one-time secret die with the principal
    runResetters(reason);
  }

  function begin(channel, { level = "participant" } = {}) {
    const prev = channels.get(channel);
    if (prev?.op) { prev.op.superseded = true; prev.op.controller.abort(); }
    const controller = new AbortController();
    const gen = generation;
    const pGen = principalGen;
    const op = {
      level, controller, superseded: false, finished: false,
      signal: controller.signal,
      isCurrent() {
        if (op.superseded) return false;
        return level === "principal" ? pGen === principalGen : gen === generation;
      },
      commit(fn) { return op.isCurrent() ? fn() : undefined; },
      /** Error path: silent when obsolete or aborted; the caller's handler runs only for the current context. */
      fail(err, fn) { if (isAbortError(err) || !op.isCurrent()) return undefined; return fn(err); },
      done() { op.finished = true; const c = channels.get(channel); if (c && c.op === op) c.op = null; },
    };
    channels.set(channel, { op });
    return op;
  }

  /** Writes: capture the context BEFORE the await. Never receives a signal. */
  function capture({ level = "participant" } = {}) {
    const gen = generation;
    const pGen = principalGen;
    const at = snapshot();
    const ticket = {
      scope: at,
      participantId: at.participantId,
      isCurrent() { return level === "principal" ? pGen === principalGen : gen === generation; },
      commit(fn) { return ticket.isCurrent() ? fn() : undefined; },
      /** Context moved on: run the reconciliation instead of rendering (never a silent drop). */
      orphan(fn) { return ticket.isCurrent() ? undefined : fn(at); },
      settle(onCurrent, onOrphan) { return ticket.isCurrent() ? onCurrent() : onOrphan(at); },
    };
    return ticket;
  }

  function addNotice(participantId, notice) {
    if (!participantId) return;
    if (!notices.has(participantId)) notices.set(participantId, []);
    notices.get(participantId).push({ ...notice, at: Date.now() });
  }
  function takeNotices(participantId) {
    const list = notices.get(participantId) || [];
    notices.delete(participantId);
    return list;
  }

  return {
    current: snapshot,
    switchTo,
    reset,
    begin,
    capture,
    addNotice,
    takeNotices,
    onReset(fn) { resetters.add(fn); return () => resetters.delete(fn); },
    _debug: { channels: () => [...channels.keys()] },
  };
}
