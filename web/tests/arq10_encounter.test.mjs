import assert from "node:assert/strict";
import test from "node:test";
import { createV3Client } from "../v3/api_client.mjs";
import { createCommandController } from "../v3/command_controller.mjs";

test("remote Encounter uses the original command key and payload after a lost response", async () => {
  const calls = [];
  const client = createV3Client({
    baseUrl: "http://localhost",
    getToken: () => "synthetic-token",
    async fetchImpl(url, options) {
      calls.push({ url, key: new Headers(options.headers).get("Idempotency-Key"), payload: JSON.parse(options.body) });
      if (calls.length === 1) throw new TypeError("response lost");
      return Response.json({ entity_id: "en_fixture01", version: 1 }, { status: 201 });
    },
  });
  const commands = createCommandController({ consumeUntilEdit: true });
  const payload = { encounter_date: "2026-11-23", modality: "remote_external", duration_min: null,
    prescription_ref: null, assessment_ref: null, therapist_note: "Fixture" };
  const send = (key) => client.createEncounter("p_fixture01", payload, { idempotencyKey: key });
  assert.equal((await commands.run("encounter", send, { signature: payload })).status, "ambiguous");
  assert.equal((await commands.run("encounter", send, { signature: payload })).status, "ok");
  assert.equal((await commands.run("encounter", send, { signature: payload })).status, "settled");
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/participants\/p_fixture01\/encounters$/);
  assert.match(calls[0].key, /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls[0], calls[1]);
});
