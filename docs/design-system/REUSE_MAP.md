# Reuse map — functional components (ARQ-01..04) × design system

All functional components are reused **as they are**; the design system only supplies their look.

| Functional component | Origin | Look supplied by | Visible effect |
|---|---|---|---|
| `date_field` + `field_error` (DateField, FieldError) | ARQ-01 | `.field`, `input`, `.field-error`, `[aria-invalid]` | error text + left bar + red border on the field |
| `command_controller` (single-intention commands, settled/unknown/ambiguous) | ARQ-02 | `.banner-*`, `.btn`, "another intention" button in the success banner | exclusive success/error banners, secondary button style |
| `domain_fields` (GoalTargetField, ItemState, instrument selector) | ARQ-03 | `.field`, `select`, `input:read-only` | derived unit shown as a read-only field |
| `validation_registry` | ARQ-03 | `.field-error` | specific messages per rule |
| `context_store` / ContextGuard | ARQ-04 | none (logic only) | stale results never painted → no flicker of another participant's data |
| `http_transport` | ARQ-04 | none | — |
| `feedback.mjs` (exclusive states, announce dedup, owner scope) | ARQ-04 | `.banner-error/-success`, `.elo-live-region` | banners with glyphs; live region unchanged |
| `legacyFindings` marker | ARQ-04 | `.badge-legacy`, `.data-card[data-legacy]` | amber badge + left bar on legacy goals |
| unit relabel (I-01) | ARQ-04 | `select` | none (text only) |
| i18n `bindText`/`applyI18n`, language switch | ARQ-01/E | `.lang-switch` | pill segmented control |
| `a11y.announce` (single live region) | S0 | `.elo-live-region` | collapsed when empty |
| Participant stage gating (`body[data-stage]`) | S1 | `.step-card` states (existing CSS) | dimmed future steps keep working |

Reuse of CSS classes: 41 `field`, 23 `target`, 14 `btn`, 10 `result-box`, 8 `step-card` (therapist page) are all restyled by selector, so no template had to change.
