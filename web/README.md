# web

Static bilingual interface (pt-BR and English), served by nginx at `/app/`. No framework.

## "At home" tab (between sessions)

- `counter.js`: hand open/close counter, pure logic (no DOM, no camera). `node web/test_counter.js` runs the synthetic tests.
  Known limit: at 700 ms per cycle (1.4 repetitions per second) it undercounts in about 19% of synthetic runs; tested from 800 ms.
- `hand.js`: camera panel. MediaPipe Hand Landmarker runs in the browser; the page draws only a skeleton on a black canvas.
  No `MediaRecorder`, `toDataURL`, `toBlob` or `getImageData`: nothing of the image is stored or sent. Only repetition counts leave the panel.
- The tab sends plan, sensor events, patient reports and draft claims to `POST /api/home/verify` and shows the verdict and reason for each claim.
- Draft claims here are built by rules. The local model's draft comes later; the verifier stays deterministic code.

## Canonical JSON & Hashing (CL06.3)

- `canonical.mjs`: RFC 8785 subset canonical JSON, SHA-256 hashing, `event_id`, `content_hash`, and per-stream `prev_hash` / duplicate-`seq` integrity checks (Node built-in `node:crypto` only).

## Accessibility Base (`web/v3/`)

- `v3/tokens.json` & `v3/tokens.css`: single-source design tokens with WCAG 2.x AA verified foreground/background contrast pairs (`>= 4.5:1` text, `>= 3:1` large text, UI, and focus ring against every background token).
- `v3/base.css`: enlarged `>= 3rem` (48×48 CSS px) targets, visible `:focus-visible` outline (`>= 3px`), `@media (prefers-reduced-motion: reduce)` neutralisation, and zoom-friendly `rem` typography/layout rules.
- `v3/index.html` & `v3/a11y.mjs`: labelled `pt-BR` application shell (skip link, landmarks, native controls, text+icon+colour status variants, single live region) and `announce(message, { politeness })` helper (browser built-ins only).
- Run all Node built-in web tests (canonical + v3 accessibility; signals pass/fail strictly via process exit code):

```bash
node --test web/tests/*.test.mjs
```

## Build notes

The Dockerfile fetches `@mediapipe/tasks-vision@1.2.3` and the hand model at build time, so the app serves them itself and the CSP stays `'self'`
(plus `'wasm-unsafe-eval'` for the wasm runtime). The build needs internet access to `registry.npmjs.org` and `storage.googleapis.com`.
Synthetic data only; never use real patient data.
