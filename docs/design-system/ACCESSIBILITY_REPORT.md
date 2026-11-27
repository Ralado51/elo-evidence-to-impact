# Accessibility report — WCAG 2.2 AA (automated + analytic; manual items listed)

Scope: `web/v3/{therapist,participant,painel,index}.html`, `web/v3/ds/styleguide.html`, plus the home (`landing/`) as reference. Synthetic data. Evidence: `a11y-results.json`, `node scripts/ds_contrast.mjs`, screenshots in `screens/`.

## 1. Results
| Check | Method | Result |
|---|---|---|
| Rule violations (WCAG 2.0/2.1/2.2 A+AA tags) | axe-core, 6 pages + 2 authenticated states (therapist complete, therapist field-error), at desktop 1440, tablet 834, mobile 390, reflow 320 | **0 violations on all v3 screens**; 4 on the home (see §2) |
| Contrast of every text/background and UI/focus pair | `scripts/ds_contrast.mjs` (27 pairs) | **27/27 pass** (text ≥ 4.5:1, borders/focus ≥ 3:1; lowest text pair 6.31:1) |
| 1.4.10 Reflow | scrollWidth vs clientWidth at 320 px, every screen | **no horizontal scroll** (tables scroll inside a focusable, labelled region) |
| 2.5.8 Target size (minimum) | bounding box of buttons, inputs, selects, nav links | v3: all ≥ 48 px (participant buttons/inputs 56 px). Home: nav links 34 px (≥ 24 px minimum, below the project's 48 px policy; reference, not changed) |
| 2.4.7 / 2.4.13 Focus visible | CSS: 3 px ink outline + yellow halo, inverted on graphite | pass by construction (ratio 13–17:1); keyboard run in `participant_journey` / `therapist_journey` still green |
| 1.4.1 Use of colour | every status has glyph + text; selected = ✓ + fill + border; errors = text + left bar + `aria-invalid` | pass by construction |
| 2.3.3 / reduced motion | spinner and skeleton stop under `prefers-reduced-motion` | pass |

## 2. Findings
1. **Home `.notice` (landing, `#9a6208` on `#f5e8cc`) = 4.2:1 < 4.5:1** — axe "serious", 1 element on each viewport. Pre-existing in the reference page, which this branch does not change. The design system's warning text shade (`#6f4504`, 6.84:1) fixes it; recommended for the landing when the home is next touched.
2. Home nav links are 34 px high (see above). Same recommendation.
3. Fixed during this work (found by the audit): language switch was 40 px high → 48 px; styleguide scrollable table wrapper was not keyboard-focusable → `tabindex=0`, `role=region`, label; empty `elo-live-region` rendered as a blank yellow box → collapsed (kept in the accessibility tree so announcements still work).

## 3. Motor accessibility (participant)
56 px buttons and fields, full-width actions on mobile, 12 px gaps between adjacent targets, "Parar por dor / cansaço" are separate red-outlined buttons (not colour only, labelled), no dragging or timing gestures, numbered one-step-at-a-time instructions, selected choices shown by ✓ + fill. Therapist screens keep 48 px.

## 4. Not covered — needs a human
- Screen-reader pass (NVDA/VoiceOver/TalkBack): not run. Markup was not changed, so the existing reading order/labels are those already homologated; the new CSS-generated glyphs (`✓ ✕ ⏳`) are decorative `::before` content and may be read by some readers — to verify.
- 200 % / 400 % browser zoom by hand, Windows High Contrast / forced colours (the 2 px borders and outlines should survive; not tested), and touch use on a real phone by a person with a motor limitation.
- 3.3.8 Accessible authentication and 3.3.7 Redundant entry: no cognitive-function test was introduced by this work; the existing login fields were not re-audited for paste/autocomplete behaviour.
- Automated tools find roughly a third of WCAG issues; this report is not a conformance claim.
