import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { hashCanonical } from "../v3/canonical.mjs";
import { assistanceSeries, headline } from "../v3/painel_model.mjs";

const catalog = JSON.parse(readFileSync(new URL(
  "../../contracts/CL06_3-r1/contracts/catalogs/comparability-rules.v1.json", import.meta.url,
)));
const base = {
  participant_id: "p_synthetic01", body_segment: "hand", laterality: "right",
  movement_task: "organizar-a-mesa", method: "reported_assistance", unit: "ordinal",
  protocol: "none", algorithm_version: "none", observation_quality_class: "not_applicable",
  execution_mode: "report_only", data_origin_class: "synthetic_fixture", fact_type: "F04",
  fact_definition_version: "1", limits_version: "limits-v1",
};
const fact = (type, session, revision = 1) => ({
  fact_id: type + "_" + session + "_" + revision,
  type,
  scope: { org_id: "org_synthetic", participant_id: base.participant_id,
    session_id: session, prescription_id: "rx_synthetic", prescription_revision: revision },
  params: { execution: "complete" },
});
const item = async (f, level) => ({
  fact_id: f.fact_id, content_hash: await hashCanonical(f), session_date_local: "2026-11-27",
  context: { assistance_level: level },
});
const group = async (key, items) => ({
  series_key: key, series_key_hash: await hashCanonical(key), items,
});
const change = (a, b) => ({
  dimension: "assistance_level", from_fact_id: a.fact_id, to_fact_id: b.fact_id,
});

test("FIX-05: both intermediate changes survive equal endpoints; absence is not stability", async () => {
  const [a, b, c] = ["session_a", "session_b", "session_c"].map((id) => fact("F04", id));
  const f04 = await group(base, await Promise.all([item(a, "some"), item(b, "full"), item(c, "some")]));
  const response = { series: [f04], context_changes: { [f04.series_key_hash]: [change(a, b), change(b, c)] } };
  const { series } = await assistanceSeries(response, [c, a, b]);
  assert.deepEqual(series[0].transitions.map((tr) => tr.direction), ["more_help_reported", "less_help_reported"]);
  const gap = await assistanceSeries({ series: [f04] }, [a, b, c]);
  assert.deepEqual(gap.series[0].transitions, []);
  assert.notEqual(headline(series), headline(gap.series));
});

test("FIX-06: preserve separate assistance series and catalog split notice", async () => {
  const a = fact("F04", "session_right");
  const b = fact("F04", "session_left");
  const groups = [
    await group(base, [await item(a, "some")]),
    await group({ ...base, laterality: "left" }, [await item(b, "full")]),
  ];
  const { series } = await assistanceSeries({ series: groups, notices: [{
    kind: "series_split", series_key_hashes: groups.map((g) => g.series_key_hash), differing_keys: ["laterality"],
  }] }, [b, a]);
  assert.deepEqual(series.map((s) => s.chain.map((i) => i.factId)), [[a.fact_id], [b.fact_id]]);
  assert.deepEqual(series.map((s) => s.splitKeys), [["laterality"], ["laterality"]]);
  assert.deepEqual(series.map((s) => s.transitions), [[], []]);
});

test("FIX-07/08: match only approved execution of the same session and prescription version", async () => {
  const a = fact("F04", "session_a");
  const b = fact("F04", "session_b");
  const c = fact("F04", "session_c");
  const d = fact("F04", "session_d");
  const execB = fact("F03", "session_b");
  const oldA = fact("F03", "session_a", 2);
  const staleD = fact("F03", "session_d");
  const pendingC = fact("F03", "session_c");
  const f04 = await group(base, await Promise.all([a, b, c, d].map((f) => item(f, "some"))));
  const f03 = await group({ ...base, fact_type: "F03", method: "reported_execution", unit: "category" }, [
    await item(staleD), await item(execB), await item(oldA),
  ]);
  const changedD = { ...staleD, params: { execution: "partial" } };
  const { series, approvedIds } = await assistanceSeries({ series: [f03, f04] }, [oldA, d, changedD, c, execB, pendingC, a, b]);
  assert.deepEqual(series[0].chain.map((i) => i.execution), ["unreported", "complete", "unreported", "unreported"]);
  assert.equal(approvedIds.has(pendingC.fact_id), false);
  assert.equal(approvedIds.has(changedD.fact_id), false);
});

test("fixture covers exactly the frozen 14 technical keys", () => {
  assert.equal(catalog.technical_criteria.keys.length, 14);
  assert.deepEqual(Object.keys(base).sort(), [...catalog.technical_criteria.keys].sort());
});
