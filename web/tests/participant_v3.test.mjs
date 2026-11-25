import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertParticipantContractRoute,
  createParticipantClient,
  ParticipantApiError,
} from "../v3/participant_api.mjs";
import {
  ASSISTANCE_CHOICES,
  EXECUTION_CHOICES,
  buildReportSubmittedEvent,
  buildSessionControlEvent,
  buildSessionStartedEvent,
  formatParticipantError,
  generateSessionId,
  nextMonotonicIso,
  projectPrescriptionForDisplay,
  resolveEvolutionSeriesOriginLabel,
  resolveSummaryOriginLabel,
  scanForbiddenOutputs,
  scanParticipantSensitiveLeaks,
} from "../v3/participant_model.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..");
const V3_DIR = path.join(WEB_DIR, "v3");
const REPO_ROOT = path.resolve(WEB_DIR, "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts", "CL06_3-r1");

test("participant_model builds hash-chained report-only session events with valid shapes", async () => {
  const sid = generateSessionId();
  assert.match(sid, /^s_[A-Za-z0-9-]{8,64}$/);

  const t1 = nextMonotonicIso();
  const t2 = nextMonotonicIso(t1);
  const t3 = nextMonotonicIso(t2);
  const t4 = nextMonotonicIso(t3);
  assert.ok(Date.parse(t2) > Date.parse(t1));
  assert.ok(Date.parse(t3) > Date.parse(t2));
  assert.ok(Date.parse(t4) > Date.parse(t3));

  const common = {
    participantId: "p_testpart001",
    orgId: "o_testorg001",
    sessionId: sid,
    prescriptionId: "rx_testrx0001",
    prescriptionRevision: 1,
  };

  const ev1 = await buildSessionStartedEvent({ ...common, occurredAt: t1 });
  assert.equal(ev1.type, "session.started");
  assert.equal(ev1.seq, 1);
  assert.equal(ev1.prev_hash, null);
  assert.equal(ev1.execution_mode, "report_only");
  assert.equal(ev1.data_origin, "synthetic_fixture");
  assert.equal(ev1.payload.source_mode, "report_only");
  assert.equal(ev1.payload.capture_context, null);
  assert.match(ev1.event_id, /^[0-9a-f]{64}$/);
  assert.match(ev1.hash, /^[0-9a-f]{64}$/);

  const ev2 = await buildSessionControlEvent({
    ...common,
    seq: 2,
    prevHash: ev1.hash,
    occurredAt: t2,
    action: "start",
  });
  assert.equal(ev2.prev_hash, ev1.hash);
  assert.equal(ev2.payload.action, "start");
  assert.equal(ev2.payload.interrupt_reason, null);

  const ev3 = await buildSessionControlEvent({
    ...common,
    seq: 3,
    prevHash: ev2.hash,
    occurredAt: t3,
    action: "pain",
  });
  assert.equal(ev3.prev_hash, ev2.hash);
  assert.equal(ev3.payload.action, "pain");

  const ev4 = await buildReportSubmittedEvent({
    ...common,
    seq: 4,
    prevHash: ev3.hash,
    occurredAt: t4,
    execution: "partial",
    assistance: "unreported",
  });
  assert.equal(ev4.type, "report.submitted");
  assert.equal(ev4.prev_hash, ev3.hash);
  assert.equal(ev4.payload.execution, "partial");
  assert.equal(ev4.payload.assistance, "unreported");
  assert.equal(ev4.payload.reporter_role, "participant");

  await assert.rejects(() =>
    buildReportSubmittedEvent({
      ...common,
      seq: 5,
      prevHash: ev4.hash,
      execution: "invalid_val",
      assistance: "none",
    })
  );
});

test("participant_model basic report choices map 'Não sei / prefiro não dizer' to unreported", () => {
  const execUnrep = EXECUTION_CHOICES.find((c) => c.value === "unreported");
  const assistUnrep = ASSISTANCE_CHOICES.find((c) => c.value === "unreported");
  assert.ok(execUnrep && /n[aã]o sei/i.test(execUnrep.label));
  assert.ok(assistUnrep && /n[aã]o sei/i.test(assistUnrep.label));
});

test("participant_model strips hashes/actor ids from prescription view and resolves origin labels", () => {
  const rxEvent = {
    event_id: "a".repeat(64),
    hash: "b".repeat(64),
    data_origin: "synthetic_fixture",
    execution_mode: "not_applicable",
    actor: { role: "therapist", id: "t_secrettherapist" },
    scope: { org_id: "o_demo0001", participant_id: "p_secretpart01" },
    payload: {
      prescription_id: "rx_demo00001",
      revision: 1,
      exercise_id: "organizar-a-mesa",
      permitted_movement: "hand_open_close",
      side: "right",
      target_sets: 2,
      target_repetitions: 10,
      sessions_per_week: 3,
      valid_from: "2026-10-01",
      valid_to: "2026-10-31",
      instructions_ptbr: "Organizar a mesa com calma.",
      created_by: "t_secrettherapist",
    },
  };
  const projected = projectPrescriptionForDisplay(rxEvent);
  assert.equal(projected.originLabel, "[Dados sintéticos]");
  assert.equal(projected.executionMode, "report_only");
  assert.deepEqual(scanParticipantSensitiveLeaks(JSON.stringify(projected)), []);

  assert.equal(
    resolveSummaryOriginLabel({
      rendered_facts: [{ text_ptbr: "[Dados sintéticos] Sessão encerrada normalmente." }],
    }),
    "[Dados sintéticos]"
  );
  assert.equal(
    resolveEvolutionSeriesOriginLabel({
      data_origin_class: "synthetic_fixture",
      origin_prefix: "[Dados sintéticos] ",
    }),
    "[Dados sintéticos]"
  );

  assert.ok(scanParticipantSensitiveLeaks("hash " + "c".repeat(64)).length > 0);
  assert.ok(scanParticipantSensitiveLeaks("actor t_therapist01").length > 0);
  assert.ok(scanParticipantSensitiveLeaks("note_refs []").length > 0);
});

test("participant_api allows strictly participant-permitted contract routes and flags rejected batch items", async () => {
  const contractPath = path.join(CONTRACTS_DIR, "contracts", "api", "api-contract.v3.json");
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  const participantAllowed = new Map(
    contract.endpoints
      .filter((ep) => ep.roles.includes("participant") || ep.roles.includes("anonymous"))
      .map((ep) => [ep.id, ep])
  );

  const validSamples = [
    ["POST", "/api/v3/auth/invite", "auth.invite"],
    ["GET", "/api/v3/participants/p_12345678/prescription/current", "prescriptions.current"],
    ["GET", "/api/v3/participants/p_12345678/goals", "goals.list"],
    ["POST", "/api/v3/events:batch", "events.batch"],
    ["GET", "/api/v3/summaries/sum_12345678", "summaries.get"],
    ["GET", "/api/v3/evolution/evo_12345678", "evolution.get"],
  ];
  for (const [method, url, expectedId] of validSamples) {
    assert.ok(
      participantAllowed.has(expectedId),
      `Route ${expectedId} must be participant/anonymous allowed in api-contract.v3.json`
    );
    assert.equal(assertParticipantContractRoute(method, url), expectedId);
  }

  // Reject therapist-only routes and non-v3 paths
  assert.throws(() => assertParticipantContractRoute("POST", "/api/v3/prescriptions"));
  assert.throws(() => assertParticipantContractRoute("POST", "/api/v3/reviews"));
  assert.throws(() => assertParticipantContractRoute("GET", "/api/v3/participants/p_12345678/facts"));
  assert.throws(() => assertParticipantContractRoute("GET", "/api/v1/cases"));

  // D-S0-04-1 rejected batch item (HTTP 200, status rejected, FORBIDDEN / CONSENT_REQUIRED) throws ParticipantApiError
  for (const code of ["FORBIDDEN", "CONSENT_REQUIRED"]) {
    const client = createParticipantClient({
      getToken: () => "tok_part",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [{ event_id: "0".repeat(64), status: "rejected", codes: [code] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
    });
    await assert.rejects(
      () => client.postEventsBatch([{ type: "fake" }]),
      (err) => err instanceof ParticipantApiError && err.code === code && err.status === 200
    );
    assert.ok(formatParticipantError({ code, status: 200 }).includes(`[${code}]`));
  }
});

test("Row 4/5/8/10/12 static invariants on web/v3/participant*", () => {
  const html = fs.readFileSync(path.join(V3_DIR, "participant.html"), "utf8");
  const appJs = fs.readFileSync(path.join(V3_DIR, "participant_app.mjs"), "utf8");
  const modelJs = fs.readFileSync(path.join(V3_DIR, "participant_model.mjs"), "utf8");

  // Row 4: Zero getUserMedia or mediaDevices usage anywhere in participant screen/modules
  for (const [name, content] of [
    ["participant.html", html],
    ["participant_app.mjs", appJs],
    ["participant_model.mjs", modelJs],
  ]) {
    assert.equal(
      /getUserMedia|mediaDevices/i.test(content),
      false,
      `${name} must never reference getUserMedia or mediaDevices`
    );
  }

  // Row 5: Zero text inputs or textareas inside #form-report
  const formMatch = html.match(/<form[^>]*id="form-report"[^>]*>([\s\S]*?)<\/form>/i);
  assert.ok(formMatch, "Expected #form-report in participant.html");
  assert.equal(
    /<input\b|<textarea\b/i.test(formMatch[1]),
    false,
    "Basic report form (#form-report) must require zero typing (no <input> or <textarea>)"
  );

  // Row 8: Zero forbidden cmp-v1 clinical output terms in participant.html
  const visibleHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  assert.deepEqual(scanForbiddenOutputs(visibleHtml), []);

  // Row 10: participant.html listed in pages.json
  const pagesCfg = JSON.parse(
    fs.readFileSync(path.join(WEB_DIR, "tests", "browser", "pages.json"), "utf8")
  );
  assert.ok(
    pagesCfg.pages.some((p) => p.path === "/v3/participant.html"),
    "/v3/participant.html must be listed in web/tests/browser/pages.json"
  );
});
