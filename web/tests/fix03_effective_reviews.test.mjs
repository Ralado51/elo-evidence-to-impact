// ARQ-02 FIX-03 (FIX02-R01): eligibility reconstructed from the server projection. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { createV3Client } from "../v3/api_client.mjs";
import { evaluateFactGate, getPublishableSummaryItems, canPublishSummary } from "../v3/therapist_model.mjs";

const mkEntry = (id, hash, review) => ({
  fact: { fact_id: id, type: "F01", flags: { summary_eligible: true } },
  contentHash: hash,
  effectiveReview: review || null,
});

test("listFacts requests the server projection only when asked (default URL unchanged)", async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); return new Response(JSON.stringify({ facts: [], catalog_version: "2" }), { status: 200, headers: { "content-type": "application/json" } }); };
  const c = createV3Client({ fetchImpl, getToken: () => "tok" });
  await c.listFacts("p_12345678");
  await c.listFacts("p_12345678", { includeReviews: true });
  assert.ok(!urls[0].includes("include="));
  assert.ok(urls[1].endsWith("/facts?include=reviews"));
});

test("projection restores eligibility: approved with same hash is publishable", () => {
  const e = mkEntry("f_a", "h1", { decision: "approve", content_hash: "h1", event_id: "e1", note: null });
  assert.equal(evaluateFactGate(e).status, "approved");
  assert.ok(canPublishSummary([e]));
});

test("obsolete approval after content change is stale, never publishable", () => {
  const e = mkEntry("f_a", "h2", { decision: "approve", content_hash: "h1", event_id: "e1", note: null });
  assert.equal(evaluateFactGate(e).status, "stale");
  assert.equal(getPublishableSummaryItems([e]).length, 0);
});

test("rejected and unreviewed stay ineligible", () => {
  const r = mkEntry("f_r", "h1", { decision: "reject", content_hash: "h1", event_id: "e2", note: null });
  const u = mkEntry("f_u", "h1", null);
  assert.equal(evaluateFactGate(r).status, "rejected");
  assert.equal(evaluateFactGate(u).status, "unreviewed");
  assert.equal(canPublishSummary([r, u]), false);
});

test("isolation: a participant's projection never leaks into another's entries", () => {
  const alfa = { f_a: { decision: "approve", content_hash: "h1", event_id: "e1", note: null } };
  const beta = {};
  const build = (proj) => [mkEntry("f_b", "h9", proj["f_b"])];
  assert.equal(canPublishSummary(build(alfa)), false);
  assert.equal(canPublishSummary(build(beta)), false);
});
