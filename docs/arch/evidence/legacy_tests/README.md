# Legacy test copies (ARQ-03, P-04)

| Test | Change | Justification | Assertions |
|---|---|---|---|
| `test_v3_evolution_timeline.py::test_timeline_get_entities_events_order_and_exclusions` | 3 setup payloads: `instrument_version` `"0.1"` → `"0"` | A2-04 (write-only): `0.1` is not an `instrument-registry.json` entry (`custom_unvalidated`, `0`, `unvalidated_custom`). Test data, not a normative expectation about instruments. | Unchanged (event order/exclusions). Original preserved as `test_v3_evolution_timeline.pre_arq03.py`. |
