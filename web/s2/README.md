# S2 preview: hand counter (outside the S1 scope)

Kept out of `web/v3/` on purpose: the S1 harness (`e2e_journey.mjs`, Row 9 static scan) forbids `counter.js` inside `web/v3/`,
and S2 is not started. This page is a parked preview of S2-01, served at `/s2/contador.html` by `scripts/gateway.mjs`.
It is not part of the S1 acceptance and is not linked from the S1 screens.
