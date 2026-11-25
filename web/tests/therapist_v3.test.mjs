import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertContractRoute, createV3Client, V3ApiError } from "../v3/api_client.mjs";
import { canonicalJson, hashCanonical, sha256Hex } from "../v3/canonical.mjs";
import {
  canPublishEvolution,
  canPublishSummary,
  evaluateFactGate,
  foldEffectiveReviews,
  formatApiErrorMessage,
  formatExecutionMode,
  formatOriginLabel,
  getPublishableEvolutionSeries,
  getPublishableSummaryItems,
  scanForbiddenOutputs,
} from "../v3/therapist_model.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..");
const V3_DIR = path.join(WEB_DIR, "v3");
const REPO_ROOT = path.resolve(WEB_DIR, "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts", "CL06_3-r1");

test("canonical.mjs matches all CL06.3 canonical-vectors.v3.json vectors", async () => {
  const vectorsPath = path.join(CONTRACTS_DIR, "fixtures", "valid", "canonical-vectors.v3.json");
  const data = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));
  const vectors = Array.isArray(data.vectors) ? data.vectors : data;
  assert.ok(vectors.length > 0, "Expected canonical vectors fixture to be non-empty");

  for (const vec of vectors) {
    const inputVal = Object.prototype.hasOwnProperty.call(vec, "raw_json")
      ? JSON.parse(vec.raw_json)
      : vec.value;
    const canon = canonicalJson(inputVal);
    if (typeof vec.canonical === "string") {
      assert.equal(canon, vec.canonical, `Canonical mismatch on vector ${vec.id || vec.name}`);
    }
    if (typeof vec.sha256 === "string") {
      const digest = await sha256Hex(canon);
      assert.equal(digest, vec.sha256, `SHA-256 mismatch on vector ${vec.id || vec.name}`);
      assert.equal(await hashCanonical(inputVal), vec.sha256);
    }
  }
});

test("therapist_model origin labels mirror limitations.v2.json", () => {
  const limsPath = path.join(CONTRACTS_DIR, "contracts", "catalogs", "limitations.v2.json");
  const lims = JSON.parse(fs.readFileSync(limsPath, "utf8"));
  for (const [origin, prefix] of Object.entries(lims.origin_prefix)) {
    const label = formatOriginLabel(origin);
    if (prefix.trim()) {
      assert.equal(label, prefix.trim(), `Origin label mismatch for ${origin}`);
    } else {
      assert.ok(label.length > 0, "Live origin still formats non-empty fallback label");
    }
  }
});

test("therapist_model execution modes always include canonical mode identifier", () => {
  for (const mode of ["report_only", "camera", "simulation", "not_applicable"]) {
    const formatted = formatExecutionMode(mode);
    assert.ok(formatted.includes(mode), `Formatted mode "${formatted}" must include "${mode}"`);
  }
});

test("therapist_model review gate blocks unreviewed, annotated, rejected, stale, and non-eligible facts", () => {
  const f02 = {
    fact: { fact_id: "f_02", type: "F02", flags: { summary_eligible: true } },
    contentHash: "a".repeat(64),
    effectiveReview: null,
  };
  const f09 = {
    fact: { fact_id: "f_09", type: "F09", flags: { summary_eligible: false } },
    contentHash: "b".repeat(64),
    effectiveReview: { decision: "approve", content_hash: "b".repeat(64) },
  };
  const rejected = {
    fact: { fact_id: "f_03", type: "F03", flags: { summary_eligible: true } },
    contentHash: "c".repeat(64),
    effectiveReview: { decision: "reject", content_hash: "c".repeat(64) },
  };
  const stale = {
    fact: { fact_id: "f_04", type: "F04", flags: { summary_eligible: true } },
    contentHash: "d".repeat(64),
    effectiveReview: { decision: "approve", content_hash: "e".repeat(64) },
  };

  assert.equal(evaluateFactGate(f02).publishable, false);
  assert.equal(evaluateFactGate(f09).publishable, false);
  assert.equal(evaluateFactGate(rejected).publishable, false);
  assert.equal(evaluateFactGate(stale).publishable, false);
  assert.equal(canPublishSummary([f02, f09, rejected, stale]), false);
  assert.equal(
    canPublishEvolution(
      [{ series_key_hash: "1".repeat(64), items: [{ fact_id: "f_02", content_hash: "a".repeat(64) }] }],
      [f02, f09, rejected, stale]
    ),
    false
  );

  // Fold reviews: annotate must never change effective status
  const folded = foldEffectiveReviews([
    { event_id: "1".repeat(64), payload: { fact_id: "f_02", decision: "annotate", content_hash: "a".repeat(64) } },
  ]);
  assert.equal(folded.f_02, undefined);

  // Approving f_02 with matching current content_hash enables summary and matching evolution series
  const approvedF02 = {
    ...f02,
    effectiveReview: { decision: "approve", content_hash: "a".repeat(64) },
  };
  assert.equal(evaluateFactGate(approvedF02).publishable, true);
  assert.equal(canPublishSummary([approvedF02, f09, rejected, stale]), true);
  assert.deepEqual(getPublishableSummaryItems([approvedF02, f09, rejected, stale]), [
    { fact_id: "f_02", content_hash: "a".repeat(64) },
  ]);
  assert.equal(
    canPublishEvolution(
      [{ series_key_hash: "1".repeat(64), items: [{ fact_id: "f_02", content_hash: "a".repeat(64) }] }],
      [approvedF02]
    ),
    true
  );
  // Stale series hash does not enable evolution publish
  assert.equal(
    canPublishEvolution(
      [{ series_key_hash: "1".repeat(64), items: [{ fact_id: "f_02", content_hash: "f".repeat(64) }] }],
      [approvedF02]
    ),
    false
  );

  // F1 regression: if cached series mix one still-approved series (F02) with any obsolete/unreviewed/stale series (F03/F04),
  // canPublishEvolution MUST return false and getPublishableEvolutionSeries MUST exclude unsafe series.
  const mixedSeries = [
    { series_key_hash: "1".repeat(64), items: [{ fact_id: "f_02", content_hash: "a".repeat(64) }] },
    { series_key_hash: "2".repeat(64), items: [{ fact_id: "f_03_old", content_hash: "c".repeat(64) }] },
    { series_key_hash: "3".repeat(64), items: [{ fact_id: "f_04_old", content_hash: "d".repeat(64) }] },
  ];
  const refreshedFacts = [
    approvedF02,
    { fact: { fact_id: "f_03_new", type: "F03", flags: { summary_eligible: true } }, contentHash: "7".repeat(64), effectiveReview: null },
    { fact: { fact_id: "f_04_new", type: "F04", flags: { summary_eligible: true } }, contentHash: "8".repeat(64), effectiveReview: null },
  ];
  assert.equal(
    canPublishEvolution(mixedSeries, refreshedFacts),
    false,
    "F1: canPublishEvolution must be false when any cached series contains obsolete/unreviewed facts"
  );
  assert.deepEqual(
    getPublishableEvolutionSeries(mixedSeries, refreshedFacts).map((s) => s.series_key_hash),
    ["1".repeat(64)]
  );
});

test("therapist_model error formatter surfaces contract error codes cleanly", () => {
  const codes = [
    "UNREVIEWED_FACT_IN_EVOLUTION",
    "CONTENT_HASH_STALE",
    "COMPARABILITY_VIOLATION",
    "FORBIDDEN",
    "SCOPE_VIOLATION",
    "NOT_FOUND",
    "UNAUTHENTICATED",
  ];
  for (const code of codes) {
    const msg = formatApiErrorMessage({ code, status: 409 });
    assert.ok(msg.includes(`[${code}]`), `Error message must include [${code}]: ${msg}`);
    assert.ok(msg.includes("HTTP 409"));
  }
});

test("therapist_model forbidden-output scanner flags cmp-v1 violations and passes v3 UI copy", () => {
  const badSamples = [
    "Tendência positiva com significância estatística",
    "Previsão de recuperação em 3 semanas",
    "Alerta de piora detectado",
    "Escore global de recuperação: 82%",
    "Porcentagem de recuperação: 70%",
    "O participante melhorou bastante",
    "Worsening alert triggered",
    "Global recovery score 80",
  ];
  for (const sample of badSamples) {
    const findings = scanForbiddenOutputs(sample);
    assert.ok(findings.length > 0, `Expected forbidden output scanner to flag: "${sample}"`);
  }

  // Scan static HTML and JS copy in web/v3/therapist.html
  const html = fs.readFileSync(path.join(V3_DIR, "therapist.html"), "utf8");
  const visibleHtmlText = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  assert.deepEqual(
    scanForbiddenOutputs(visibleHtmlText),
    [],
    "web/v3/therapist.html must contain zero forbidden clinical output terms"
  );
});

test("api_client strictly allows declared /api/v3 contract routes and rejects /api/v1", async () => {
  const contractPath = path.join(CONTRACTS_DIR, "contracts", "api", "api-contract.v3.json");
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  const contractIds = new Set(contract.endpoints.map((ep) => ep.id));

  const validSamples = [
    ["POST", "/api/v3/auth/therapist", "auth.therapist"],
    ["POST", "/api/v3/participants", "participants.create"],
    ["POST", "/api/v3/participants/p_12345678/assessments", "assessments.create"],
    ["POST", "/api/v3/participants/p_12345678/goals", "goals.create"],
    ["POST", "/api/v3/prescriptions", "prescriptions.publish"],
    ["GET", "/api/v3/participants/p_12345678/prescription/current", "prescriptions.current"],
    ["GET", "/api/v3/participants/p_12345678/facts", "facts.list"],
    ["GET", "/api/v3/facts/f_abc/evidence", "facts.evidence"],
    ["POST", "/api/v3/reviews", "reviews.record"],
    ["POST", "/api/v3/summaries", "summaries.publish"],
    ["GET", "/api/v3/summaries/sum_12345678", "summaries.get"],
    ["GET", "/api/v3/participants/p_12345678/evolution/series", "evolution.series"],
    ["POST", "/api/v3/evolution", "evolution.publish"],
    ["GET", "/api/v3/evolution/evo_12345678", "evolution.get"],
    ["GET", "/api/v3/participants/p_12345678/timeline", "timeline.get"],
  ];

  for (const [method, url, expectedId] of validSamples) {
    assert.ok(contractIds.has(expectedId), `Endpoint id ${expectedId} must exist in api-contract.v3.json`);
    assert.equal(assertContractRoute(method, url), expectedId);
  }

  assert.throws(() => assertContractRoute("GET", "/api/v1/cases"), /non-v3 path rejected/);
  assert.throws(() => assertContractRoute("GET", "/api/cases"), /non-v3 path rejected/);
  assert.throws(() => assertContractRoute("POST", "/api/v3/undeclared"), /undeclared v3 route/);

  // Missing token fails client-side with UNAUTHENTICATED before fetch is called
  let fetchCalled = false;
  const unauthClient = createV3Client({
    getToken: () => null,
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("should not call fetch without token");
    },
  });
  await assert.rejects(
    () => unauthClient.listFacts("p_12345678"),
    (err) => err instanceof V3ApiError && err.code === "UNAUTHENTICATED"
  );
  assert.equal(fetchCalled, false);

  // Error envelope parsing
  const errClient = createV3Client({
    getToken: () => "tok_test",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: { code: "CONTENT_HASH_STALE", message: "stale hash" },
        }),
        { status: 409, headers: { "content-type": "application/json" } }
      ),
  });
  await assert.rejects(
    () => errClient.publishSummary({ participant_id: "p_12345678", items: [] }),
    (err) => err instanceof V3ApiError && err.code === "CONTENT_HASH_STALE" && err.status === 409
  );
});

test("Row 8 legacy isolation: web/v3 contains zero imports/links to legacy web/*.js, web/index.html, or /api/v1", () => {
  const v3Files = fs.readdirSync(V3_DIR);
  assert.ok(v3Files.length > 0);
  const forbiddenPatterns = [
    /\/api\/v1\b/i,
    /['"]\.\.\/[^'"]*\.js['"]/i,
    /['"]\.\.\/index\.html['"]/i,
    /from\s+['"]node:/i,
  ];
  for (const name of v3Files) {
    const full = path.join(V3_DIR, name);
    if (!fs.statSync(full).isFile()) continue;
    const text = fs.readFileSync(full, "utf8");
    for (const pat of forbiddenPatterns) {
      assert.equal(
        pat.test(text),
        false,
        `web/v3/${name} matched forbidden legacy/node pattern ${pat}`
      );
    }
  }
});

test("Row 6 coverage: every web/v3/*.html file is listed in web/tests/browser/pages.json", () => {
  const htmlFiles = fs
    .readdirSync(V3_DIR)
    .filter((name) => name.endsWith(".html"))
    .map((name) => `/v3/${name}`)
    .sort();
  const pagesCfg = JSON.parse(
    fs.readFileSync(path.join(WEB_DIR, "tests", "browser", "pages.json"), "utf8")
  );
  const listedPaths = pagesCfg.pages.map((p) => p.path).sort();
  for (const p of htmlFiles) {
    assert.ok(listedPaths.includes(p), `HTML page ${p} is missing from web/tests/browser/pages.json`);
  }
});
