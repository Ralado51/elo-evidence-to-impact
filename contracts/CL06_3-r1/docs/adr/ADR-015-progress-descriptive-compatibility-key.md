# ADR-015 — Progress is descriptive and bound to a compatibility key

**Status:** PROPOSED (PX-03). Replaces ADR-009. Implements PD-02 and PD-04.

## Context
ADR-009 deferred progress and comparison. The PRD keeps descriptive history in P0 (PRG, MOT10, REM05). PD-02: no automated clinical inference; only authorized and reviewed information enters published evolution.

## Decision
1. Evolution is a descriptive series of reviewed facts. Allowed outputs: ordered items, the technical comparability key, descriptive differences, and `assistance_transitions` (less_help_reported | more_help_reported | unchanged). Forbidden: trend with significance, prediction, alert, global score, percentage recovery, any value word (`comparability-rules.v1.json` `forbidden_outputs`).
2. Two classes of criteria (adjustment 6). Technical keys decide whether two items may be compared: participant, body segment, laterality, movement task, method, unit, protocol, algorithm version, observation quality class, execution mode, data origin class, fact type, fact definition version, limits version. Contextual dimensions do not block comparison but travel with every item: assistance level, pain/fatigue signalled, dose prescribed, session end reason.
3. A change in reported assistance is itself an evolution indicator (F04, ordinal none<some<full). Unreported assistance is absent, never zero (RN008): no transition across an unreported session.
4. Semantic change (adjustment 7): F01 definition_version 2 (handedness) and F05 definition_version 2 are not comparable with v1 facts; `fact_definition_version` is part of the key.
5. PD-04: cycles with incompatible laterality are preserved as `cycle.rejected(handedness_incompatible)` with an explicit flag and are not counted as prescription compliance. Technical dose limits (<=10 sets, <=100 repetitions, product <=100; `limits-v1`) are versioned data, not clinical advice; the dose belongs to the therapist.

## Alternatives
- Statistical trend: rejected (clinical inference). Allow cross-origin comparison: rejected.

## Consequences
`evolution.published` binds each item to `content_hash`-bound reviews. Enforcement (COMPARABILITY_VIOLATION, UNREVIEWED_FACT_IN_EVOLUTION) needs a service: PENDING. Open: CL06.3-D1 (null handedness is counted and flagged, not rejected).

## Evidence
`comparability-rules.v1.json`, `evolution.published.schema.json`, `progress-series.schema.json`, fixtures V3-A4, V3-A6, V3-S1..S4.
