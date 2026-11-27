# Elo Design System v0.1

Branch `research/frontend-v3` (from ARQ-04 candidate `b1e7a51`, which is **not modified**). Synthetic data only. No framework, no contract change, no JavaScript change.

## 1. Where it comes from
The visual reference is the existing Elo home, `landing/index.html`. Everything below was read from its code, not invented:

| Home element | Value / rule | Where it lives now |
|---|---|---|
| Graphite | `#262626` (`--char`), `#323232` | header, session bar, KPI tiles, dark buttons |
| Yellow | `#fff56b` (`--yel`), soft `#fffbc7` | primary action, selected item, hover, result box, focus halo |
| White / paper | `#fff`, page `#f6f5f1` (`--soft`) | surfaces / page of working screens |
| Pill buttons | `border-radius: 999px`, 700 weight | all `.btn`, language switch, badges |
| Radii | 10 / 12 / 14 / 22 px | `--ds-radius-sm … xl` |
| Dot grid hero | `radial-gradient(rgba(255,255,255,.07) 1px …)` 18 px | session bar, styleguide hero (`--ds-dots`) |
| Brand mark | the two-bars-two-rungs SVG | `.site-brand::before` mask, in yellow |
| Yellow strip / nav highlight | yellow active item | 4 px yellow rule under the header; current item in yellow |
| Status hues | ok `#17766b`, bad `#b4372c`, wait `#9a6208` | status borders; text shades darkened to AA |
| System font, 15 px base | `system-ui` | kept (1 rem base; larger in guided mode) |

Preserved: yellow + graphite + white. Added only what the home lacks for a full platform: AA-safe text shades, a spacing scale, a type scale, target sizes, focus ring, density modes.

## 2. Use of dark (not indiscriminate)
Dark graphite is used exactly where the home uses it for emphasis: header bar, session bar, KPI tiles, table header, hero. Working surfaces (forms, tables, evidence review, timeline) stay light for long reading. The participant interface stays light and calm; dark appears only in the header and the status bar.

## 3. Two densities, one identity
| | workspace (`body[data-ds="workspace"]`) | guided (`body[data-ds="guided"]`) |
|---|---|---|
| Users | therapist (`therapist.html`), painel, v3 base | participant (`participant.html`) |
| Goal | productivity, organisation, readability | simplicity, legibility, motor accessibility, low cognitive load |
| Targets | 48 px | 56 px buttons/inputs, full-width on mobile |
| Type | 1 rem / 1.55 | 1.125 rem / 1.6 |
| Layout | 72 rem shell, two-column field grids | 52 rem single column, numbered steps, one primary action |
| Choices | selects, inputs | large `choice-btn` with ✓ + yellow fill when selected |
The same density can be applied to a region with `.ds-guided`.

## 4. Tokens
`web/v3/ds/ds-tokens.css` — primitives (`--ds-*`) and a **semantic remap of the legacy `--elo-*` tokens**, so `base.css` and every page stylesheet adopt the system without edits. `tokens.css`/`tokens.json` are untouched.
- Colour: ink, graphite, graphite-2, yellow, yellow-soft, white, paper, line, line-strong (`#6b6760`, ≥ 3:1 for interactive borders), muted; status ok/bad/wait/info each with `text`, border and `bg` shades.
- Type: xs 0.8125 · sm 0.9375 · base 1 · md 1.125 · lg 1.375 · xl 1.75 · 2xl clamp(1.75rem, 4vw, 2.5rem).
- Space (4 px grid): 1–12. Radius: sm 8 · md 12 · lg 16 · xl 22 · pill. Shadow: 1, glow (the home's hot-node glow).
- Targets: 3 rem / 3.5 rem. Focus: 3 px ink outline + 2 px offset + yellow halo (ink halo on dark) — visible on light and on graphite.

## 5. Components (shared)
`web/v3/ds/ds-components.css` (loaded last). Full list in `COMPONENT_INVENTORY.md`: buttons & controls, form fields, cards & panels, navigation, tables, state indicators (badges), feedback messages (banners, field errors, result box), empty states, loading, confirmations, dialogs. Existing class names are restyled in place (no markup change); new `ds-*` classes cover what the app does not have yet (empty, loading, skeleton, danger button, dialog/confirm, table wrapper, badges). Reuse of ARQ-01..04 functional components is in `REUSE_MAP.md`.

## 6. Rules (do / don't)
- Primary action: yellow pill with ink text and ink border. One per step. Secondary: white with strong border. Destructive/stop: white with red text and red border (never red fill).
- State is never colour alone: every status carries a glyph (✓ ✕ ⏳) and text. Errors also use a left bar + `aria-invalid`.
- Selected = yellow fill + ✓ glyph + 2 px ink border (not only a colour change).
- Legacy records keep their stored content; the "Registro legado" badge + amber left bar marks them (ARQ-04 CMP-02).
- No new fonts, icons libraries, or JS frameworks. Only inline CSS-mask for the brand mark.
- Motion: only spinner/skeleton; both stop under `prefers-reduced-motion`.

## 7. What changed in the repository (branch diff vs ARQ-04 candidate)
- New: `web/v3/ds/{ds-tokens,ds-components,styleguide}.{css,html,mjs}`, `scripts/ds_{contrast,a11y,screenshots}.mjs`, `docs/design-system/**`.
- Edited: the four v3 HTML files — **two `<link>` lines and a `data-ds` attribute on `<body>`**. No ids, classes, `data-i18n` keys or scripts were touched.
- Not touched: `api/`, `contracts/`, all `web/v3/*.mjs`, existing CSS files, `landing/`, tests.

## 8. How to run it (isolated)
```
PORT_WEB=8090 PORT_API=8010 scripts/demo_up.sh
ELO_PLAYWRIGHT_DIR=/tmp/pwdir node web/tests/browser/seed_demo.mjs --origin http://127.0.0.1:8090
open http://127.0.0.1:8090/v3/ds/styleguide.html     # also /v3/therapist.html, /v3/participant.html, /v3/painel.html
PORT_WEB=8090 PORT_API=8010 scripts/demo_up.sh down
```
This is a local demo environment; the UAT environment is not touched.

## 9. Decisions taken autonomously (open to veto)
1. Header = graphite with a 4 px yellow rule (the home puts yellow in a top strip; the rule keeps the strip's role without a second bar).
2. Working surfaces = paper `#f6f5f1` (the home's own soft grey), not white, so white cards read as the focus.
3. Link colour = ink, underlined (the home's links inherit colour); the old blue was dropped.
4. Orange focus colour dropped in favour of ink + yellow halo (identity + higher contrast).
5. Participant nav keeps the numbered steps and adds the yellow numerals as the "where am I" cue.
