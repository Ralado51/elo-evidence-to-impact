# Addendum A1 — Transactional idempotency (contracts 3.1.0)

- **Amends:** `contracts/CL06_3-r1` (contracts 3.0.0). The 3.0.0 package, its files, manifest and hashes are preserved byte-identical; this addendum is a separate package that records its base manifest hash in `contracts/VERSIONS.json` (`base_manifest_sha256`).
- **Scope:** ARQ-02 only (PD-02). PD-01, PD-05, PD-07, PD-08 remain open. No new routes.
- **Authority:** PO ratification of the ARQ-02 normative delta (Q1–Q6 and additional requirements 1–7).

## Normative rules
1. **Header.** `Idempotency-Key`: exactly one lowercase UUID v4 per business intention. A new legitimate intention always uses a new key, even with identical content. The payload hash is never the intent identity.
2. **Scope.** `(org_id, principal.id, operation_id, resource_key, key)`.
3. **Fingerprint.** `sha256(canonical({v:1,op,resource,body}))` computed with the existing canonical hasher (no second canonicalizer).
4. **Same key, same fingerprint (Q1).** The original result is rebuilt from immutable references (entity id + version, event id, ids-only results), preserving HTTP status, entity, version and semantic result. It is never rebuilt from the latest clinical version. Request/response bodies are not stored. Response header `Idempotency-Replayed: true`.
5. **Same key, different fingerprint.** `409 IDEMPOTENCY_KEY_REUSED`.
6. **Invalid key.** `400 IDEMPOTENCY_KEY_INVALID` (not a single lowercase UUID v4, duplicated header lines, comma lists) on keyed operations only.
7. **Optional on the wire (Q2).** Omitting the header preserves pre-3.1.0 behaviour. The first-party frontend must send it on every `keyed` operation. Making it mandatory in general requires a new contractual decision.
8. **Only successes recorded (Q3).** Only 2xx outcomes are recorded. Effect and registry row are committed in one transaction; if the response is lost after commit, the operation stays recoverable with the original key.
9. **Excluded operations (Q4).** `invites.create` (single-use secret), `auth.*`, `facts.verify` ignore the header and never touch the registry. The frontend protects invite generation with single-flight only; the secret is never stored.
10. **Natural idempotency.** `events.batch` keeps its ledger natural idempotency; the header is ignored even if invalid.
11. **Retention (Q6).** Default 7 days, configurable 1–90 via `ELO_V3_IDEMPOTENCY_RETENTION_DAYS` (invalid value fails at startup). `expires_at` is fixed at creation. An expired key is an unknown key (new intention). Effective retention is exposed in response header `Idempotency-Retention-Days` (also on `/health`; the frozen `/health` body shape is unchanged).
12. **Client recovery window (Q6).** Automatic resend with the same key is limited to min(24 h, retention − safety margin). After it: automatic resend is suspended, an "unknown result" state is shown with guidance to consult/reconcile, and a new key is generated only on an explicit new user intention. Reconciliation tooling depending on ARQ-05 is documented as a dependency; unsafe automatic resend stays blocked.
13. **Authorization.** Re-evaluated on every replay with the existing engine, and re-checked inside the transaction so a concurrent care-link revocation cannot be bypassed.
14. **Permanent domain unique constraints** are preserved and remain the last line of defence.
15. **Logs.** Diagnostics carry only operation id and a short key reference; never clinical data, tokens or credentials.

## Header handling per endpoint category
| Category | Operations | Invalid / duplicated / comma-list | Absent |
|---|---|---|---|
| keyed | see `idempotency.classes.keyed` | 400 `IDEMPOTENCY_KEY_INVALID` | legacy behaviour |
| natural | `events.batch` | ignored | n/a |
| excluded | `invites.create`, `auth.*`, `facts.verify` | ignored | n/a |
| GET / anonymous | all | ignored | n/a |

`drafts.create|confirm|discard` exist in the 3.0.0 contract but are not implemented by the server; they are marked `deferred` and receive no idempotency behaviour in 3.1.0.

## Order of evaluation
authentication (401) → header syntax (400) → authorization chain → body parse/validation → dedup lookup (replay or 409) → execute → inside the transaction: re-authorize, late lookup, record → single commit.

## Traceability
D04, S1-03 (duplicate records on repeated submit), FIX-02, FIX-18 (error and success shown together). Status in the official defect control is set by the PO after independent validation; this addendum does not mark anything as homologated.
