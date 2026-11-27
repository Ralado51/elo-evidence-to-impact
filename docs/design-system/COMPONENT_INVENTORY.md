# Visual component inventory

Status: **R** = restyled existing class (no markup change) · **N** = new `ds-*` class · **A** = already in the app, unchanged. Styleguide: `web/v3/ds/styleguide.html` (all rows are demonstrated there).

| Group | Component | Class / selector | Status | Notes |
|---|---|---|---|---|
| Foundations | Page, headings, text, mono | `body[data-ds]`, `h1–h3`, `.step-lead`, `.mono` | R | workspace / guided density |
| | Focus ring | `:focus-visible` | R | ink + yellow halo; inverted on graphite |
| Navigation | Header bar + brand mark | `.site-header`, `.painel-header`, `.elo-header`, `.site-brand` | R | graphite, yellow rule, home mark |
| | Step / section nav | `.therapist-nav`, `.participant-nav`, `.painel-nav`, `.elo-nav` | R | `aria-current` = yellow; scrolls horizontally on mobile |
| | Language switch | `.lang-switch` | R | pill segmented control, 48 px targets |
| | Skip link | `.skip-link` | R | yellow |
| Buttons & controls | Primary / secondary / dark / danger / disabled | `.btn-primary`, `.btn-secondary`, `.ds-btn-dark`, `.btn-stop` + `.ds-btn-danger`, `:disabled` | R / N | pill, 48 px (56 px guided) |
| | Choice buttons | `.choice-grid`, `.choice-btn[aria-pressed]` | R | ✓ + yellow when selected |
| | Checkbox / radio | `input[type=checkbox\|radio]` | R | 24 px, graphite accent |
| Form fields | Label + input / select / textarea | `.field`, `label`, `input`, `select`, `textarea` | R | 2 px strong border, 12 px radius |
| | Read-only, disabled | `input:read-only`, `:disabled` | R | |
| | Field error | `.field-error`, `[aria-invalid=true]` | R | text + left bar, never colour alone |
| | Fieldset / legend | `fieldset`, `legend` | R | |
| Cards & panels | Step card | `.step-card`, `.elo-card`, `.ds-card` | R / N | white, 16 px radius, shadow-1 |
| | Sub-panel | `.sub-panel` | R | |
| | Session / status bar | `.session-bar`, `.status-bar` | R | graphite with the home's dot grid |
| | Result box | `.result-box` | R | yellow-soft + ink left bar |
| | Data card / list | `.card-list`, `.data-card` | R | legacy variant `[data-legacy=true]` |
| | KPI tile | `.kpi-grid`, `.kpi` | R | painel |
| | Guide list (numbered steps) | `.guide-list` | R | participant |
| Tables | Table | `table`, `.ds-table`, `.ds-table-wrap` | R / N | graphite header; wrapper must be focusable when it scrolls |
| State indicators | Badges / chips | `.badge`, `.badge-origin/-mode/-approved/-confirmed/-rejected/-legacy`, `.chip-*`, `.ds-badge--ok/wait/bad` | R / N | glyph + text |
| Feedback | Banners | `.banner-error/-success/-warning/-info` | R | glyph via `::before`; `role=alert` set by `feedback.mjs` |
| | Live region | `.elo-live-region` | R | collapses when empty, stays in the a11y tree |
| Empty / loading | Empty state | `.ds-empty` | N | not yet wired in screens |
| | Loading | `.ds-loading`, `.ds-spinner`, `.ds-skeleton` | N | reduced-motion safe; not yet wired |
| Dialogs | Dialog / confirmation | `dialog`, `.ds-dialog`, `.ds-confirm`, `--danger` | N | native `<dialog>`; not yet used by the app |
| Layout | Shell, field grids, actions row | `main.main`, `.painel-main`, `.field-grid(-two)`, `.actions-row` | R | responsive |
| Painel / data | Charts, verdicts, timeline | `.chart`, `.verdict`, `.timeline`, `.session-row` | A | inherit new tokens |
**Not yet wired (needs JS, deliberately out of scope on this branch):** empty states, loading indicators and confirm dialogs. They are styled and demonstrated; wiring them touches `*_app.mjs`, which belongs to the ARQ-04 candidate.
