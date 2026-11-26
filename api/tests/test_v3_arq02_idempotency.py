"""ARQ-02 / CMP-07+08 (PD-02, A1 / contracts 3.1.0): command idempotency by ``Idempotency-Key``.

Reproduces D04 / S1-03 / FIX-02 at the API on the pre-fix baseline (the header is ignored, so a retry
duplicates the record) and proves the A1 semantics afterwards. All data is synthetic.
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import logging
import threading
import uuid

import pytest
from test_v3_clinical import _make_seeded_app, _valid_fa_payload
from test_v3_goals import _valid_goal_payload

H = "Idempotency-Key"
REPLAYED = "Idempotency-Replayed"


def key() -> str:
    return str(uuid.uuid4())


def auth(tok: str, k: str | None = None, **extra) -> dict:
    h = {"Authorization": f"Bearer {tok}", **extra}
    if k is not None:
        h[H] = k
    return h


def goals(client, ctx, k=None, payload=None, pid=None, tok=None):
    return client.post(f"/api/v3/participants/{pid or ctx['p1_id']}/goals", headers=auth(tok or ctx["t1_tok"], k), json=payload or _valid_goal_payload())


def n_entities(app, etype, pid):
    return len(app.state.v3_store.list_latest_entities(etype, pid))


def dedup_rows(app):
    return app.state.v3_store.db.execute("SELECT * FROM v3_command_dedup").fetchall()


def total_rows(app):
    db = app.state.v3_store.db
    return tuple(db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("v3_entities", "v3_events", "v3_command_dedup"))


# ---------- core semantics -------------------------------------------------------------------------------
def test_same_key_same_payload_replays_original_result_without_duplicating(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    r1 = goals(client, ctx, k)
    r2 = goals(client, ctx, k)
    assert r1.status_code == 201 and r2.status_code == 201
    assert r2.json() == r1.json() and r2.json()["version"] == 1
    assert REPLAYED not in r1.headers and r2.headers.get(REPLAYED) == "true"
    assert n_entities(app, "goal", ctx["p1_id"]) == 1


@pytest.mark.parametrize("path,payload", [("assessments", _valid_fa_payload()), ("encounters", {"encounter_date": "2026-11-23", "modality": "in_person", "duration_min": 30, "prescription_ref": None, "assessment_ref": None, "therapist_note": None})])
def test_other_clinical_creates_are_idempotent(monkeypatch, path, payload):
    _app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    a = client.post(f"/api/v3/participants/{ctx['p1_id']}/{path}", headers=auth(ctx["t1_tok"], k), json=payload)
    b = client.post(f"/api/v3/participants/{ctx['p1_id']}/{path}", headers=auth(ctx["t1_tok"], k), json=payload)
    assert a.status_code == b.status_code == 201 and a.json() == b.json() and b.headers.get(REPLAYED) == "true"


def test_same_key_different_payload_is_409_and_creates_nothing(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    assert goals(client, ctx, k).status_code == 201
    r = goals(client, ctx, k, _valid_goal_payload(goal_text="Synthetic goal: a different one."))
    assert r.status_code == 409 and r.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert n_entities(app, "goal", ctx["p1_id"]) == 1


def test_different_keys_identical_payload_are_two_legitimate_intentions(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    a, b = goals(client, ctx, key()), goals(client, ctx, key())
    assert a.status_code == b.status_code == 201 and a.json()["entity_id"] != b.json()["entity_id"]
    assert REPLAYED not in b.headers
    assert n_entities(app, "goal", ctx["p1_id"]) == 2


def test_legacy_clients_without_header_are_unchanged(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    assert goals(client, ctx).status_code == 201 and goals(client, ctx).status_code == 201
    assert n_entities(app, "goal", ctx["p1_id"]) == 2 and dedup_rows(app) == []


def test_key_identifies_the_intention_not_the_payload_hash(monkeypatch):
    _app, client, ctx = _make_seeded_app(monkeypatch)
    k1, k2 = key(), key()
    a = goals(client, ctx, k1)
    # a replay of k1 with the SAME payload but sent while another key exists must still map to k1's entity
    goals(client, ctx, k2)
    again = goals(client, ctx, k1)
    assert again.json()["entity_id"] == a.json()["entity_id"]


# ---------- replay is by immutable reference (Q1) --------------------------------------------------------
def test_replay_after_a_later_revision_returns_the_original_version_not_the_latest(monkeypatch):
    _app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    v1 = goals(client, ctx, k)
    eid = v1.json()["entity_id"]
    rev = client.post(f"/api/v3/goals/{eid}/versions", headers=auth(ctx["t1_tok"], key()), json=_valid_goal_payload(goal_text="Synthetic goal: revised text."))
    assert rev.status_code == 201 and rev.json()["version"] == 2
    again = goals(client, ctx, k)
    assert again.status_code == 201 and again.json()["version"] == 1 and again.json() == v1.json()
    assert again.headers.get(REPLAYED) == "true"


def test_registry_stores_references_only_never_clinical_content_or_secrets(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    marker = "ZXQ-UNIQUE-CLINICAL-MARKER"
    goals(client, ctx, key(), _valid_goal_payload(goal_text=f"Synthetic goal {marker}."))
    client.post("/api/v3/invites", headers=auth(ctx["t1_tok"], key()), json={"participant_id": ctx["p1_id"]})
    dump = json.dumps([list(map(str, r)) for r in dedup_rows(app)])
    assert marker not in dump and "invite_token" not in dump and ctx["t1_tok"] not in dump
    cols = [c[1] for c in app.state.v3_store.db.execute("PRAGMA table_info(v3_command_dedup)").fetchall()]
    assert not {"body", "request_body", "response_body", "payload"} & set(cols)


def test_replay_performs_no_writes(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    goals(client, ctx, k)
    before = total_rows(app)
    for _ in range(3):
        assert goals(client, ctx, k).headers.get(REPLAYED) == "true"
    assert total_rows(app) == before


# ---------- atomicity, failures, lost response (Q3) -------------------------------------------------------
def test_response_lost_after_commit_is_recoverable_by_the_original_key(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    goals(client, ctx, k)  # client never reads the response
    retry = goals(client, ctx, k)
    assert retry.status_code == 201 and retry.headers.get(REPLAYED) == "true"
    assert n_entities(app, "goal", ctx["p1_id"]) == 1


def test_failure_before_commit_leaves_nothing_and_the_retry_executes_once(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    store = app.state.v3_store
    real = store.insert_entity_version
    calls = {"n": 0}

    def boom(*a, **kw):
        calls["n"] += 1
        raise RuntimeError("simulated crash before commit")

    monkeypatch.setattr(store, "insert_entity_version", boom)
    k = key()
    with pytest.raises(RuntimeError):
        goals(client, ctx, k)
    assert n_entities(app, "goal", ctx["p1_id"]) == 0 and dedup_rows(app) == []
    monkeypatch.setattr(store, "insert_entity_version", real)
    ok = goals(client, ctx, k)
    assert ok.status_code == 201 and REPLAYED not in ok.headers
    assert n_entities(app, "goal", ctx["p1_id"]) == 1 and len(dedup_rows(app)) == 1


def test_rollback_between_effect_and_idempotency_record_is_atomic(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    from elo.v3 import command_dedup

    def boom(self, *a, **kw):
        raise RuntimeError("simulated failure while recording idempotency")

    monkeypatch.setattr(command_dedup.CommandDedupStore, "record", boom)
    k = key()
    with pytest.raises(RuntimeError):
        goals(client, ctx, k)
    assert n_entities(app, "goal", ctx["p1_id"]) == 0 and dedup_rows(app) == [], "effect must roll back with the record"
    monkeypatch.undo()
    assert goals(client, ctx, k).status_code == 201


def test_only_successful_outcomes_are_recorded_and_the_key_stays_usable(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    bad = goals(client, ctx, k, {"goal_text": ""})
    assert bad.status_code == 400 and dedup_rows(app) == []
    assert goals(client, ctx, k).status_code == 201 and len(dedup_rows(app)) == 1


# ---------- concurrency ----------------------------------------------------------------------------------
def test_concurrent_requests_with_same_key_produce_exactly_one_effect(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    with cf.ThreadPoolExecutor(8) as ex:
        rs = list(ex.map(lambda _: goals(client, ctx, k), range(8)))
    assert {r.status_code for r in rs} == {201}
    assert sum(1 for r in rs if REPLAYED not in r.headers) == 1
    assert len({r.json()["entity_id"] for r in rs}) == 1
    assert n_entities(app, "goal", ctx["p1_id"]) == 1


def test_concurrent_same_key_with_different_payloads_one_wins_others_conflict(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    pays = [_valid_goal_payload(goal_text=f"Synthetic goal variant {i}.") for i in range(6)]
    with cf.ThreadPoolExecutor(6) as ex:
        rs = list(ex.map(lambda p: goals(client, ctx, k, p), pays))
    assert sorted(r.status_code for r in rs) == [201] + [409] * 5
    assert n_entities(app, "goal", ctx["p1_id"]) == 1


def test_concurrent_different_keys_all_execute(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    with cf.ThreadPoolExecutor(6) as ex:
        rs = list(ex.map(lambda _: goals(client, ctx, key()), range(6)))
    assert {r.status_code for r in rs} == {201} and n_entities(app, "goal", ctx["p1_id"]) == 6


# ---------- authorization re-evaluated on every replay; revocation race (req. 1) -------------------------
def test_replay_after_care_link_revocation_is_denied_and_discloses_nothing(monkeypatch):
    _app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    assert goals(client, ctx, k).status_code == 201
    rv = client.post(f"/api/v3/care-links/{ctx['cl1_id']}:revoke", headers=auth(ctx["t1_tok"]), json={})
    assert rv.status_code == 200
    r = goals(client, ctx, k)
    assert r.status_code in (403, 404) and REPLAYED not in r.headers and "goal_text" not in r.text


def test_replay_by_another_therapist_or_org_is_denied(monkeypatch):
    _app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    goals(client, ctx, k)
    for tok in (ctx["t2_tok"], ctx["t3_tok"], ctx["p1_tok"]):
        r = goals(client, ctx, k, tok=tok)
        assert r.status_code in (401, 403, 404) and REPLAYED not in r.headers


def test_revocation_racing_with_commands_never_lets_an_effect_land_after_the_revoke(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    db = app.state.v3_store.db
    stop = threading.Event()
    results = []

    def writer():
        while not stop.is_set():
            results.append(goals(client, ctx, key()).status_code)

    ts = [threading.Thread(target=writer) for _ in range(3)]
    for t in ts:
        t.start()
    while len(results) < 6:
        pass
    rv = client.post(f"/api/v3/care-links/{ctx['cl1_id']}:revoke", headers=auth(ctx["t1_tok"], key()), json={})
    assert rv.status_code == 200
    mark = len(results)
    while len(results) < mark + 6:
        pass
    stop.set()
    for t in ts:
        t.join()
    rev_rowid = db.execute("SELECT MAX(rowid) FROM v3_entities WHERE entity_id = ? AND version = 2", (ctx["cl1_id"],)).fetchone()[0]
    late = db.execute("SELECT COUNT(*) FROM v3_entities WHERE entity_type = 'goal' AND rowid > ?", (rev_rowid,)).fetchone()[0]
    assert late == 0, "no goal may be committed after the revocation committed"
    assert results[-1] in (403, 404)


# ---------- isolation (org / principal / operation / resource) ---------------------------------------------
def test_same_key_is_independent_across_resources_operations_principals_and_orgs(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    enc = {"encounter_date": "2026-11-23", "modality": "in_person", "duration_min": 30, "prescription_ref": None, "assessment_ref": None, "therapist_note": None}
    p2 = client.post("/api/v3/participants", headers=auth(ctx["t1_tok"]), json={"alias": "ARQ02 P2", "side": "left"}).json()["entity_id"]
    p3 = client.post("/api/v3/participants", headers=auth(ctx["t3_tok"]), json={"alias": "ARQ02 P3", "side": "left"}).json()["entity_id"]
    rs = [
        goals(client, ctx, k),
        goals(client, ctx, k, pid=p2),
        client.post(f"/api/v3/participants/{ctx['p1_id']}/encounters", headers=auth(ctx["t1_tok"], k), json=enc),
        goals(client, ctx, k, pid=p3, tok=ctx["t3_tok"]),
    ]
    assert [r.status_code for r in rs] == [201] * 4
    assert all(REPLAYED not in r.headers for r in rs)
    assert len(dedup_rows(app)) == 4


# ---------- other keyed operations -------------------------------------------------------------------------
def test_participants_create_replays_with_its_care_link_header(monkeypatch):
    _app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    a = client.post("/api/v3/participants", headers=auth(ctx["t1_tok"], k), json={"alias": "Idem P", "side": "right"})
    b = client.post("/api/v3/participants", headers=auth(ctx["t1_tok"], k), json={"alias": "Idem P", "side": "right"})
    assert a.status_code == b.status_code == 201 and a.json() == b.json()
    assert a.headers["X-Elo-Care-Link-Id"] == b.headers["X-Elo-Care-Link-Id"] and b.headers.get(REPLAYED) == "true"


def test_domain_uniqueness_constraints_are_preserved(monkeypatch):
    _app, client, ctx = _make_seeded_app(monkeypatch)
    pid = "p_" + uuid.uuid4().hex[:16]
    ok = client.post("/api/v3/participants", headers=auth(ctx["t1_tok"], key()), json={"alias": "U", "side": "right", "participant_id": pid})
    dup = client.post("/api/v3/participants", headers=auth(ctx["t1_tok"], key()), json={"alias": "U", "side": "right", "participant_id": pid})
    assert ok.status_code == 201 and dup.status_code == 409 and dup.json()["error"]["code"] == "ENTITY_VERSION_CONFLICT"


def test_care_link_revoke_replays_and_a_keyless_second_revoke_still_conflicts(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    a = client.post(f"/api/v3/care-links/{ctx['cl1_id']}:revoke", headers=auth(ctx["t1_tok"], k), json={})
    b = client.post(f"/api/v3/care-links/{ctx['cl1_id']}:revoke", headers=auth(ctx["t1_tok"], k), json={})
    assert a.status_code == b.status_code == 200 and a.json() == b.json() and b.headers.get(REPLAYED) == "true"
    c = client.post(f"/api/v3/care-links/{ctx['cl1_id']}:revoke", headers=auth(ctx["t1_tok"]), json={})
    assert c.status_code == 409 and c.json()["error"]["code"] == "CONFLICT_IMMUTABLE"
    assert len(app.state.v3_store.get_entity_versions(ctx["cl1_id"])) == 2


# ---------- headers per endpoint category (req. 3) ---------------------------------------------------------
BAD_KEYS = ["not-a-uuid", str(uuid.uuid4()).upper(), str(uuid.uuid1()), "", str(uuid.uuid4()) + "x", f"{uuid.uuid4()},{uuid.uuid4()}"]


@pytest.mark.parametrize("bad", BAD_KEYS)
def test_invalid_key_on_keyed_operation_is_400_and_has_no_effect(monkeypatch, bad):
    app, client, ctx = _make_seeded_app(monkeypatch)
    r = client.post(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=auth(ctx["t1_tok"], bad), json=_valid_goal_payload())
    assert r.status_code == 400 and r.json()["error"]["code"] == "IDEMPOTENCY_KEY_INVALID"
    assert n_entities(app, "goal", ctx["p1_id"]) == 0


def test_duplicated_header_lines_on_keyed_operation_are_400(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    r = client.post(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=[(b"authorization", f"Bearer {ctx['t1_tok']}".encode()), (b"idempotency-key", key().encode()), (b"idempotency-key", key().encode())], json=_valid_goal_payload())
    assert r.status_code == 400 and r.json()["error"]["code"] == "IDEMPOTENCY_KEY_INVALID"
    assert n_entities(app, "goal", ctx["p1_id"]) == 0


def test_header_is_ignored_even_if_invalid_on_gets_anonymous_and_excluded_operations(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    bad = {H: "garbage"}
    assert client.get(f"/api/v3/participants/{ctx['p1_id']}/goals", headers=auth(ctx["t1_tok"], "garbage")).status_code == 200
    assert client.get("/api/v3/health", headers=bad).status_code == 200
    assert client.post("/api/v3/auth/therapist", headers=bad, json={"username": "nobody", "password": "x"}).status_code == 401
    i1 = client.post("/api/v3/invites", headers=auth(ctx["t1_tok"], "garbage"), json={"participant_id": ctx["p1_id"]})
    assert i1.status_code == 201
    fv = client.post("/api/v3/facts/verify", headers=auth(ctx["t1_tok"], "garbage"), json={})
    assert fv.json().get("error", {}).get("code") != "IDEMPOTENCY_KEY_INVALID", "excluded operation must ignore the header"
    assert dedup_rows(app) == []


def test_invites_are_excluded_from_storage_and_every_call_issues_a_distinct_secret(monkeypatch):
    app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    a = client.post("/api/v3/invites", headers=auth(ctx["t1_tok"], k), json={"participant_id": ctx["p1_id"]})
    b = client.post("/api/v3/invites", headers=auth(ctx["t1_tok"], k), json={"participant_id": ctx["p1_id"]})
    assert a.status_code == b.status_code == 201 and a.json()["invite_token"] != b.json()["invite_token"]
    assert REPLAYED not in b.headers and dedup_rows(app) == []


def test_events_batch_natural_idempotency_is_preserved_and_header_is_ignored(monkeypatch):
    from test_v3_ledger import _make_consent_event
    from test_v3_ledger import _make_seeded_app as ledger_app

    app, client, ctx = ledger_app(monkeypatch)
    ev = _make_consent_event(org_id=ctx["org_a"], participant_id=ctx["p1_id"], seq=1, prev_hash=None)
    h = {"Authorization": f"Bearer {ctx['p1_tok']}", H: "garbage"}
    a = client.post("/api/v3/events:batch", headers=h, json={"events": [ev]})
    b = client.post("/api/v3/events:batch", headers=h, json={"events": [ev]})
    assert a.status_code == b.status_code == 200
    assert a.json()["results"][0]["status"] == "stored" and b.json()["results"][0]["status"] != "stored"
    assert REPLAYED not in b.headers and dedup_rows(app) == []


# ---------- retention / expiry (Q6) -------------------------------------------------------------------------
def _clock(monkeypatch, start_ms=1_800_000_000_000):
    from elo.v3 import command_dedup

    state = {"t": start_ms}
    monkeypatch.setattr(command_dedup, "_now_ms", lambda: state["t"])
    return state


DAY = 86_400_000


def test_default_retention_is_seven_days_and_expiry_makes_the_key_a_new_intention(monkeypatch):
    clock = _clock(monkeypatch)
    app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    first = goals(client, ctx, k)
    clock["t"] += 7 * DAY - 1000
    assert goals(client, ctx, k).headers.get(REPLAYED) == "true"
    clock["t"] += 2000
    again = goals(client, ctx, k)
    assert again.status_code == 201 and REPLAYED not in again.headers
    assert again.json()["entity_id"] != first.json()["entity_id"]
    assert n_entities(app, "goal", ctx["p1_id"]) == 2


def test_retention_at_the_minimum_of_one_day(monkeypatch):
    monkeypatch.setenv("ELO_V3_IDEMPOTENCY_RETENTION_DAYS", "1")
    clock = _clock(monkeypatch)
    _app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    goals(client, ctx, k)
    clock["t"] += DAY - 1000
    assert goals(client, ctx, k).headers.get(REPLAYED) == "true"
    clock["t"] += 2000
    assert REPLAYED not in goals(client, ctx, k).headers
    h = client.get("/api/v3/health")
    assert h.headers["Idempotency-Retention-Days"] == "1"
    assert h.json() == {"status": "ok", "versions": {"schema": 3, "catalog": "2", "contracts": "3.0.0"}}, "3.0.0 body is frozen"


@pytest.mark.parametrize("bad", ["0", "91", "-3", "abc", "1.5", ""])
def test_invalid_retention_configuration_fails_at_startup(monkeypatch, bad):
    monkeypatch.setenv("ELO_V3_IDEMPOTENCY_RETENTION_DAYS", bad)
    with pytest.raises(ValueError, match="RETENTION"):
        _make_seeded_app(monkeypatch)


def test_expired_rows_are_swept_without_touching_clinical_tables(monkeypatch):
    clock = _clock(monkeypatch)
    app, client, ctx = _make_seeded_app(monkeypatch)
    goals(client, ctx, key())
    clinical_before = total_rows(app)[:2]
    clock["t"] += 8 * DAY
    goals(client, ctx, key())  # any later write triggers the sweep
    assert len(dedup_rows(app)) == 1, "expired record purged, new one kept"
    assert total_rows(app)[0] == clinical_before[0] + 1, "clinical rows never purged"


def test_config_change_does_not_shorten_existing_records(monkeypatch):
    _clock(monkeypatch)
    app, client, ctx = _make_seeded_app(monkeypatch)
    k = key()
    goals(client, ctx, k)
    row = app.state.v3_store.db.execute("SELECT created_at, expires_at FROM v3_command_dedup").fetchone()
    assert row[1] - row[0] == 7 * DAY


# ---------- diagnostics hygiene (req. 7) ---------------------------------------------------------------------
def test_logs_never_contain_clinical_data_tokens_or_credentials(monkeypatch, caplog):
    _app, client, ctx = _make_seeded_app(monkeypatch)
    marker = "QQ-CLINICAL-LOG-MARKER"
    caplog.set_level(logging.DEBUG)
    k = key()
    goals(client, ctx, k, _valid_goal_payload(goal_text=f"Synthetic goal {marker}."))
    goals(client, ctx, k, _valid_goal_payload(goal_text=f"Synthetic goal {marker}."))
    goals(client, ctx, k, _valid_goal_payload(goal_text="Synthetic goal different."))
    blob = "\n".join(r.getMessage() for r in caplog.records)
    assert marker not in blob and ctx["t1_tok"] not in blob and "Bearer" not in blob and k not in blob
