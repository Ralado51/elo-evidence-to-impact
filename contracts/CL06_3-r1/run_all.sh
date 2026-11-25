#!/usr/bin/env bash
# Runs every CL06.3 test in Python and JavaScript and writes reports/test-results.json
set -u
cd "$(dirname "$0")"
mkdir -p reports
py=$(python3 -m unittest discover -s tests/python -v 2>&1); pyrc=$?
js=$(node --test tests/js/contracts.test.mjs 2>&1); jsrc=$?
pyn=$(echo "$py" | grep -E "^Ran " | awk '{print $2}')
jsn=$(echo "$js" | grep -E "^# tests" | awk '{print $3}'); jsp=$(echo "$js" | grep -E "^# pass" | awk '{print $3}'); jsf=$(echo "$js" | grep -E "^# fail" | awk '{print $3}')
pyskip=$(echo "$py" | grep -c "skipped")
python3 - "$pyrc" "$jsrc" "${pyn:-0}" "${jsn:-0}" "${jsp:-0}" "${jsf:-0}" <<'P'
import json, sys
pyrc, jsrc, pyn, jsn, jsp, jsf = map(int, sys.argv[1:7])
cases = json.load(open("fixtures/adversarial/cases.v3.json"))["cases"]
pend = [c["id"] for c in cases if c["status"] == "PENDING_IMPLEMENTATION"]
r = {"python": {"tests": pyn, "exit_code": pyrc}, "javascript": {"tests": jsn, "pass": jsp, "fail": jsf, "exit_code": jsrc},
     "contract_tests_status": "PASS" if pyrc == 0 and jsrc == 0 else "FAIL",
     "adversarial": {"executable_now": sum(1 for c in cases if c["status"] == "EXECUTABLE_NOW"), "pending_implementation": pend,
                     "note": "Pending cases are NOT counted as passed. They are conformance data for a future verifier/service."},
     "verifier_status": "NOT_IMPLEMENTED", "verifier_approved": False}
json.dump(r, open("reports/test-results.json", "w"), indent=1); print(json.dumps(r, indent=1))
P
exit $(( pyrc | jsrc ))
