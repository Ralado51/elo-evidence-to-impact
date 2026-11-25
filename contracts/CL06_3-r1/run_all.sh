#!/usr/bin/env bash
# Runs every CL06.3 test in Python and JavaScript and writes reports/test-results.json
set -u
cd "$(dirname "$0")" || exit 1
mkdir -p reports
py=$(python3 -m unittest discover -s tests/python -v 2>&1)
pyrc=$?
js=$(node --test --test-reporter=tap tests/js/contracts.test.mjs 2>&1)
jsrc=$?
PY_OUT="$py" JS_OUT="$js" python3 - "$pyrc" "$jsrc" <<'P'
import json, os, re, sys

pyrc, jsrc = map(int, sys.argv[1:3])
py_out = os.environ.get("PY_OUT", "")
js_out = os.environ.get("JS_OUT", "")

py_matches = re.findall(r"^-{10,}\r?\nRan (\d+) tests? in [0-9.]+s\s*$", py_out, flags=re.MULTILINE)
py_parse_ok = len(py_matches) == 1
pyn = int(py_matches[0]) if py_parse_ok else 0
py_status_ok = bool(re.search(r"^OK\s*$", py_out, flags=re.MULTILINE))

def parse_tap_metric(text, key):
    matches = re.findall(rf"^# {key} (\d+)\s*$", text, flags=re.MULTILINE)
    if len(matches) != 1:
        return None
    return int(matches[0])

jsn_raw = parse_tap_metric(js_out, "tests")
jsp_raw = parse_tap_metric(js_out, "pass")
jsf_raw = parse_tap_metric(js_out, "fail")
js_parse_ok = all(v is not None for v in (jsn_raw, jsp_raw, jsf_raw))
jsn = jsn_raw if jsn_raw is not None else 0
jsp = jsp_raw if jsp_raw is not None else 0
jsf = jsf_raw if jsf_raw is not None else 0

errors = []
if pyrc != 0:
    errors.append(f"python suite exited with code {pyrc}")
if not py_parse_ok:
    errors.append("failed to parse python unittest summary count")
elif pyn <= 0:
    errors.append("python unittest ran zero tests")
if pyrc == 0 and not py_status_ok:
    errors.append("python unittest output missing OK status")

if jsrc != 0:
    errors.append(f"javascript suite exited with code {jsrc}")
if not js_parse_ok:
    errors.append("failed to parse javascript TAP summary counts (tests/pass/fail)")
else:
    if jsn <= 0:
        errors.append("javascript test runner ran zero tests")
    if jsf != 0:
        errors.append(f"javascript test runner reported {jsf} failure(s)")
    if jsp != jsn:
        errors.append(f"javascript pass count ({jsp}) != total tests ({jsn})")

all_ok = not errors

with open("fixtures/adversarial/cases.v3.json", encoding="utf-8") as fh:
    cases = json.load(fh)["cases"]
pend = [c["id"] for c in cases if c["status"] == "PENDING_IMPLEMENTATION"]

r = {
    "python": {"tests": pyn, "exit_code": pyrc},
    "javascript": {"tests": jsn, "pass": jsp, "fail": jsf, "exit_code": jsrc},
    "contract_tests_status": "PASS" if all_ok else "FAIL",
    "adversarial": {
        "executable_now": sum(1 for c in cases if c["status"] == "EXECUTABLE_NOW"),
        "pending_implementation": pend,
        "note": "Pending cases are NOT counted as passed. They are conformance data for a future verifier/service.",
    },
    "verifier_status": "NOT_IMPLEMENTED",
    "verifier_approved": False,
}

out_json = json.dumps(r, indent=1)
with open("reports/test-results.json", "w", encoding="utf-8") as fh:
    fh.write(out_json)
print(out_json)

if not all_ok:
    for err in errors:
        print(f"ERROR: {err}", file=sys.stderr)
    sys.exit(pyrc or jsrc or 1)
P
