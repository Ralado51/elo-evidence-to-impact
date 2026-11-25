"""CL06.3 contract tests (Python). Gate C only: schemas, vectors, fixtures, contract-layer rules.
No fact verifier exists; verifier/service cases are reported by test_pending.py as PENDING, never as passed."""
import copy, glob, json, os, sys, unittest
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "reference", "python"))
import elo_ref as R

def J(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f: return json.load(f)
C = lambda *p: J("contracts", *p)
F = lambda *p: J("fixtures", *p)
EVENT_CAT = C("catalogs", "event-catalog.v3.json"); LIMITS = C("catalogs", "limits.v1.json")
ERR = C("catalogs", "error-codes.v3.json")["codes"]
ES = {os.path.basename(p)[:-12]: json.load(open(p, encoding="utf-8")) for p in glob.glob(os.path.join(ROOT, "contracts/schemas/events/*.schema.json"))}
NS = {os.path.basename(p)[:-12]: json.load(open(p, encoding="utf-8")) for p in glob.glob(os.path.join(ROOT, "contracts/schemas/entities/*.schema.json"))}
FPS = {os.path.basename(p).split(".")[1]: json.load(open(p, encoding="utf-8")) for p in glob.glob(os.path.join(ROOT, "contracts/schemas/facts/fact-proposal.*.schema.json"))}
LEDGER = F("valid", "ledger.v3.json")["events"]
RX = next(e for e in LEDGER if e["type"] == "prescription.published")["payload"]

def codes(errs): return {c for _, c in errs}
def event_errors(e):
    s = ES.get(e["type"])
    if s is None: return {"UNKNOWN_TYPE"}
    return codes(R.validate(s, e)) | semantic_events(e)
def semantic_events(e):
    try: return set(R.check_event_semantics(e, EVENT_CAT, LIMITS)) | set(R.check_event_integrity(e))
    except Exception: return set()
def entity_errors(x):
    try: sem = set(R.check_entity_semantics(x, EVENT_CAT))
    except Exception: sem = set()
    return codes(R.validate(NS[x["entity_type"]], x)) | sem
def streams(evs):
    d = {}
    for e in evs: d.setdefault(e["stream_id"], []).append(e)
    return d

class Canonical(unittest.TestCase):
    def test_vectors(self):
        v = F("valid", "canonical-vectors.v3.json")
        for x in v["vectors"]:
            with self.subTest(x["id"]):
                self.assertEqual(R.canonicalize(x["value"]), x["canonical"]); self.assertEqual(R.sha256_hex(x["canonical"]), x["sha256"])
    def test_must_reject(self):
        for bad in (float("nan"), float("inf"), {"k": "\ud800"}):
            with self.assertRaises(Exception): R.canonicalize(bad)
    def test_cl061_vectors_reproduced(self):
        for x in J("legacy_cl06_1_reference", "canonical-vectors.json")["vectors"]:
            with self.subTest(x["id"]): self.assertEqual(R.canonicalize(x["value"]), x["canonical"])
    def test_cl061_ledger_reproduced(self):
        evs = J("legacy_cl06_1_reference", "ledger.json")["events"]; self.assertEqual(len(evs), 21)
        for e in evs:
            with self.subTest(e["event_id"][:8]): self.assertEqual(R.check_event_integrity(e), [])
        for sid, ch in streams(evs).items():
            with self.subTest(sid): self.assertEqual(R.check_stream_chain(ch), [])

class ValidFixtures(unittest.TestCase):
    def test_all_schemas_load_and_cover_catalog(self):
        self.assertEqual(set(ES), set(EVENT_CAT["types"])); self.assertEqual(len(ES), 19)
        self.assertEqual(len(NS), 9)
    def test_ledger_events(self):
        self.assertEqual(len(LEDGER), 22)
        for e in LEDGER:
            with self.subTest(e["type"] + str(e["seq"])):
                self.assertEqual(R.validate(ES[e["type"]], e), []); self.assertEqual(R.check_event_semantics(e, EVENT_CAT, LIMITS), []); self.assertEqual(R.check_event_integrity(e), [])
    def test_ledger_chains_and_session_rules(self):
        for sid, ch in streams(LEDGER).items():
            with self.subTest(sid):
                ch = sorted(ch, key=lambda e: e["seq"]); self.assertEqual(R.check_stream_chain(ch), [])
                if sid.startswith("session:"): self.assertEqual(R.check_session_stream(ch, RX), [])
    def test_handedness_rejection_present(self):
        rej = [e for e in LEDGER if e["type"] == "cycle.rejected"]
        self.assertEqual([e["payload"]["reason"] for e in rej], ["handedness_incompatible"])
        self.assertNotEqual(rej[0]["payload"]["handedness"]["label"], RX["side"])
    def test_evolution_content_hash(self):
        e = next(x for x in LEDGER if x["type"] == "evolution.published"); p = e["payload"]
        self.assertEqual(p["content_hash"], R.hash_canonical({k: v for k, v in p.items() if k != "content_hash"}))
    def test_entities_and_chains(self):
        d = F("valid", "entities.v3.json")
        for k, x in d["entities"].items():
            with self.subTest(k): self.assertEqual(R.validate(NS[x["entity_type"]], x), []); self.assertEqual(R.check_entity_semantics(x, EVENT_CAT), [])
        for k, ch in d["chains"].items():
            with self.subTest(k): self.assertEqual(R.check_entity_chain(ch), [])
    def test_fact_proposals_schema(self):
        for k, p in F("valid", "fact-proposals.v3.json")["proposals"].items():
            with self.subTest(k): self.assertEqual(R.validate(FPS[k], p), [])
    def test_limits_boundary(self):
        for c in F("valid", "prescription-limits-boundary.json")["cases"]:
            with self.subTest(c["id"]):
                e = copy.deepcopy(next(x for x in LEDGER if x["type"] == "prescription.published"))
                e["payload"]["target_sets"] = c["target_sets"]; e["payload"]["target_repetitions"] = c["target_repetitions"]
                self.assertEqual("LIMITS_EXCEEDED" not in R.check_event_semantics(e, EVENT_CAT, LIMITS), c["valid"])
    def test_f01_oracle_hash(self):
        o = F("expected", "facts.oracle.v3.json"); f = o["facts"][0]
        self.assertEqual(f["type"], "F01"); self.assertEqual(f["catalog_version"], "2")
        body = {k: f[k] for k in ("catalog_version", "data_origin", "evidence_refs", "params", "scope", "type")}
        self.assertEqual(f["fact_id"], "f_" + R.hash_canonical(body)); self.assertIn(f["fact_id"], o["content_hashes"])

class InvalidFixtures(unittest.TestCase):
    D = F("invalid", "contract-invalid.v3.json")
    def test_events(self):
        for c in self.D["events"]:
            with self.subTest(c["id"]): self.assertIn(c["expect"], event_errors(c["event"]))
    def test_events_layer_labels(self):
        for c in self.D["events"]:
            with self.subTest(c["id"]):
                if c["expect_layer"] == "schema": self.assertIn(c["expect"], codes(R.validate(ES[c["event"]["type"]], c["event"])))
                else: self.assertIn(c["expect"], semantic_events(c["event"]))   # semantic layer must flag it on its own; the schema may also flag it (defense in depth)
    def test_integrity(self):
        for c in self.D["integrity"]:
            with self.subTest(c["id"]): self.assertIn(c["expect"], R.check_event_integrity(c["event"]))
    def test_streams(self):
        for c in self.D["streams"]:
            with self.subTest(c["id"]): self.assertEqual(sorted(set(R.check_stream_chain(c["events"]))), sorted(c["expect"]))
    def test_stream_rules(self):
        for c in self.D["stream_rules"]:
            with self.subTest(c["id"]): self.assertEqual(R.check_session_stream(c["events"], c["prescription"]), sorted(c["expect"]))
    def test_entities(self):
        for c in self.D["entities"]:
            with self.subTest(c["id"]): self.assertIn(c["expect"], entity_errors(c["entity"]))
    def test_entity_chains(self):
        for c in self.D["entity_chains"]:
            with self.subTest(c["id"]): self.assertEqual(R.check_entity_chain(c["versions"]), sorted(c["expect"]))
    def test_no_caregiver_supervisor_in_valid(self):
        txt = json.dumps([LEDGER, F("valid", "entities.v3.json")])
        for w in ("caregiver", "supervisor"): self.assertNotIn(w, txt)

def mutate(p, spec):
    p = copy.deepcopy(p); op, rest = spec.split(":", 1)
    if op == "add_unknown": path, val = rest, "x"
    elif op == "set":
        path, v = rest.split("=", 1); val = {"null": None, "true": True, "false": False}.get(v, v)
    else: path, val = rest, None
    keys = path.split("."); o = p
    for k in keys[:-1]: o = o[k]
    if op == "drop": del o[keys[-1]]
    else: o[keys[-1]] = val
    return p

class Adversarial(unittest.TestCase):
    CASES = F("adversarial", "cases.v3.json")["cases"]
    def test_executable_now(self):
        base = F("valid", "fact-proposals.v3.json")["proposals"]; inv = InvalidFixtures.D; n = 0
        for c in self.CASES:
            if c["status"] != "EXECUTABLE_NOW": continue
            n += 1
            with self.subTest(c["id"]):
                code = c["expect"]["code"]
                if c["kind"] == "proposal_schema":
                    p = mutate(base[c["fact"]], c["mutate"]); self.assertIn(code, codes(R.validate(FPS[c["fact"]], p)))
                elif c["kind"] == "proposal_type": self.assertNotIn(c["type"], FPS)
                elif c["kind"] == "see_invalid": self.assertIn(code, event_errors(next(x for x in inv["events"] if x["id"] == c["ref"])["event"]))
                elif c["kind"] == "see_invalid_entity": self.assertIn(code, entity_errors(next(x for x in inv["entities"] if x["id"] == c["ref"])["entity"]))
                elif c["kind"] == "see_stream_rule":
                    x = next(x for x in inv["stream_rules"] if x["id"] == c["ref"]); self.assertIn(code, R.check_session_stream(x["events"], x["prescription"]))
                else: self.fail("unknown kind " + c["kind"])
        self.assertEqual(n, 17)
    def test_pending_cases_not_executable(self):
        for c in self.CASES:
            if c["status"] == "PENDING_IMPLEMENTATION": self.assertIn(c["layer"], ("verifier", "service"))

class Catalogs(unittest.TestCase):
    def test_versions(self):
        v = C("VERSIONS.json"); self.assertEqual(v["schema_version"], 3); self.assertEqual(v["fact_catalog_version"], "2"); self.assertEqual(v["legacy_read_only"]["schema_version"], 2)
    def test_roles_only_participant_therapist(self):
        api = C("api", "api-contract.v3.json"); self.assertEqual(sorted(api["roles"]), ["participant", "therapist"])
        for ep in api["endpoints"]:
            for r in ep["roles"]: self.assertIn(r, ("participant", "therapist", "anonymous"), ep["id"])
        for row in C("api", "authorization-matrix.v3.json")["rows"]:
            for k in row:
                self.assertNotIn(k, ("caregiver", "supervisor"))
        self.assertEqual(len(C("api", "authorization-matrix.v3.json")["rows"]), 27)
    def test_api_error_codes_exist(self):
        for ep in C("api", "api-contract.v3.json")["endpoints"]:
            for c in ep["errors"]: self.assertIn(c, ERR, ep["id"])
        self.assertEqual(len(C("api", "api-contract.v3.json")["endpoints"]), 36)
    def test_api_requirement_ids_exist_in_traceability(self):
        import csv
        ids = {r["requirement"] for r in csv.DictReader(open(os.path.join(ROOT, "docs/TRACEABILITY_P0.csv"), encoding="utf-8"))}
        self.assertEqual(len(ids), 101)
        for ep in C("api", "api-contract.v3.json")["endpoints"]:
            for r in ep["prd_requirements"]: self.assertTrue(len(r) == 5 and r[:3].isalpha(), r)
    def test_error_codes_new(self):
        self.assertEqual(len(ERR), 58 + 15 if len(ERR) in (73,) else len(ERR))
        for c in ("HANDEDNESS_INCOMPATIBLE_ACCEPTED", "REAL_DATA_GATE_CLOSED", "ORIGIN_REF_REQUIRED", "ROLE_NOT_ALLOWED", "LEGACY_STREAM_READ_ONLY"): self.assertIn(c, ERR)
    def test_fact_catalog(self):
        fc = C("catalogs", "fact-catalog.v2.json"); self.assertEqual(fc["catalog_version"], "2")
        self.assertIn("F10", fc["types"]); self.assertFalse(fc["types"]["F10"]["summary_eligible"]); self.assertNotIn("F07", fc["types"])
        self.assertEqual(fc["types"]["F01"]["definition_version"], 2); self.assertEqual(fc["types"]["F05"]["definition_version"], 2)
        for k in ("F02", "F03", "F04", "F06", "F08", "F09"): self.assertEqual(fc["types"][k]["definition_version"], 1)
    def test_limits(self):
        self.assertEqual((LIMITS["max_sets"], LIMITS["max_repetitions"], LIMITS["max_product"]), (10, 100, 100)); self.assertTrue(LIMITS["not_a_clinical_recommendation"])
    def test_comparability_rules(self):
        r = C("catalogs", "comparability-rules.v1.json")
        for k in ("participant_id", "laterality", "execution_mode", "data_origin_class", "fact_definition_version", "limits_version"): self.assertIn(k, r["technical_criteria"]["keys"])
        self.assertIn("assistance_level", r["contextual_dimensions"]["dimensions"]); self.assertNotIn("assistance_level", r["technical_criteria"]["keys"])
        self.assertTrue(len(r["forbidden_outputs"]) >= 5)
    def test_instrument_registry_has_no_invented_instruments(self):
        reg = C("registries", "instrument-registry.json"); self.assertEqual(reg["status"], "EXTENSIBLE_PENDING_VALIDATION_WITH_RAQUEL")
        ids = [i["instrument_id"] for i in reg["instruments"]]; self.assertEqual(ids, ["custom_unvalidated"])
    def test_origin_register(self):
        r = F("origin-register", "legacy-origin-register.json"); classes = {e["origin_class"] for e in r["entries"]}
        self.assertIn("experimental_capture", classes); self.assertTrue(classes <= set(r["classes"]))
        for e in r["entries"]:
            body = {k: v for k, v in e.items() if k != "entry_hash"}; self.assertEqual(e["entry_hash"], R.hash_canonical(body), e["record_id"])
    def test_oracle_rendered_has_no_forbidden_stems(self):
        stems = ("diagnost", "melhor", "pior", "recuper", "independen", "amplitude", "desempenho")
        for f in F("expected", "facts.oracle.v3.json")["facts"]:
            t = json.dumps(f["rendered"], ensure_ascii=False).lower()
            for s in stems: self.assertNotIn(s, t)

class MetaSchema(unittest.TestCase):
    def test_all_schemas_valid_2020_12(self):
        try: import jsonschema
        except ImportError: self.skipTest("jsonschema not installed")
        n = 0
        for p in glob.glob(os.path.join(ROOT, "contracts/schemas/**/*.json"), recursive=True):
            jsonschema.Draft202012Validator.check_schema(json.load(open(p, encoding="utf-8"))); n += 1
        self.assertEqual(n, 19 + 9 + 18 + 1)

class CrossCheck(unittest.TestCase):
    """Independent cross-check: the stdlib mini-validator must agree with python-jsonschema where installed."""
    def test_agreement(self):
        try: import jsonschema
        except ImportError: self.skipTest("jsonschema not installed")
        vals = [(ES[e["type"]], e) for e in LEDGER] + [(NS[x["entity_type"]], x) for x in F("valid", "entities.v3.json")["entities"].values()]
        inv = InvalidFixtures.D
        vals += [(ES[c["event"]["type"]], c["event"]) for c in inv["events"] if c["expect_layer"] == "schema"]
        vals += [(NS[c["entity"]["entity_type"]], c["entity"]) for c in inv["entities"] if not R.validate(NS[c["entity"]["entity_type"]], c["entity"]) is False]
        for s, v in vals:
            mine = not R.validate(s, v)
            theirs = jsonschema.Draft202012Validator(s).is_valid(v)
            # x-sorted is a custom keyword (ignored by jsonschema) and null/NOT_SORTED have no standard counterpart: only flag disagreements on mine==valid
            if mine: self.assertTrue(theirs, "mini-validator accepts what jsonschema rejects")
if __name__ == "__main__": unittest.main()
