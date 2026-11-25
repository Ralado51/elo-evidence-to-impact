# ADR-016 — Voice and transcription are P0 experimental with a mandatory alternative

**Status:** PROPOSED (PX-03). Revises ADR-007. Implements PD-05 and PD-06.

## Context
The PRD lists voice capture, transcription and structured extraction as P0 experimental (CLI12, BTS12, INT01–INT09, REM06, ACC06).

## Decision
1. Everything in this family is experimental and optional. A non-voice, non-LLM path (`manual_form`) must always complete the same task.
2. Voice requires a distinct `microphone` consent scope (consent.* `scopes`). Camera consent does not imply it. Legacy consents get no inferred scopes.
3. Raw audio is not retained by default: `draft.audio_retained` is the constant `false`; a schema with `true` is invalid.
4. Output is always a `draft` entity: proposals with state present | missing | ambiguous. Nothing becomes a record until a named person confirms it (`DRAFT_NOT_CONFIRMED`). A participant's report proposal can only be authored by the participant.
5. No real or sensitive data goes to external services before validation (PD-05). No provider or model is chosen. Ollama is out of scope. Retention period and legal basis of transcripts are open (PX-02).

## Alternatives
Voice as P1 (PO kept it P0 experimental); automatic acceptance of extraction (rejected: RN-confirmation).

## Consequences
Behavior (consent check before dictation, confirmation flow) is PENDING implementation (V3-S5, V3-S6).

## Evidence
`draft.schema.json`, `consent.*.schema.json`, fixtures `voice_draft_without_microphone_ref`, `draft_audio_retained`, `draft_confirmed_without_confirmer`.
