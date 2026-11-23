# web

Static bilingual interface (pt-BR and English), served by nginx at `/app/`. No framework.

## "At home" tab (between sessions)

- `counter.js`: hand open/close counter, pure logic (no DOM, no camera). `node web/test_counter.js` runs the synthetic tests.
  Known limit: at 700 ms per cycle (1.4 repetitions per second) it undercounts in about 19% of synthetic runs; tested from 800 ms.
- `hand.js`: camera panel. MediaPipe Hand Landmarker runs in the browser; the page draws only a skeleton on a black canvas.
  No `MediaRecorder`, `toDataURL`, `toBlob` or `getImageData`: nothing of the image is stored or sent. Only repetition counts leave the panel.
- The tab sends plan, sensor events, patient reports and draft claims to `POST /api/home/verify` and shows the verdict and reason for each claim.
- Draft claims here are built by rules. The local model's draft comes later; the verifier stays deterministic code.

## Build notes

The Dockerfile fetches `@mediapipe/tasks-vision@1.2.3` and the hand model at build time, so the app serves them itself and the CSP stays `'self'`
(plus `'wasm-unsafe-eval'` for the wasm runtime). The build needs internet access to `registry.npmjs.org` and `storage.googleapis.com`.
Synthetic data only; never use real patient data.
