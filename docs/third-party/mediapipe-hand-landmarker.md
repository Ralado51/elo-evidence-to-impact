# Third-Party Licence Record — MediaPipe Hand Landmarker (`hand_landmarker.task`)

## Release v1.0.1-mvp — verification completed on 2026-11-27

The release includes Google's MediaPipe Hand Landmarker (Full), float16 v1, at `web/s2/vendor/hand_landmarker.task` and the `@mediapipe/tasks-vision@0.10.21` browser runtime under `web/s2/vendor/`. The model and runtime are distributed under Apache-2.0. The [full license text](../../web/s2/vendor/LICENSE) and [third-party notices](../../NOTICE) accompany them.

- Page 2 of the [Google Hand Tracking Model Card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021.pdf#page=2) identifies the license as Apache License, Version 2.0.
- The [Google AI Edge guide](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker) links to the [LiteRT Community model](https://huggingface.co/litert-community/MediaPipe-HandLandmarker-Full). Its provenance table identifies Google's float16 version 1 artifact and states that the mirrored binary is byte-identical. The [published file record](https://huggingface.co/litert-community/MediaPipe-HandLandmarker-Full/blob/main/hand_landmarker.task) identifies the artifact and lists its SHA-256.
- The SHA-256 measured on the release file matches the published file record and the expected digest: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.

This verification supersedes the conditional classification in the historical S0-06 record below. That record describes the sources and scope of the earlier review.

## Historical S0-06 record

Status: Verification record produced under `S0-06` (PO-F14, PO-F10 / PD-13). No model file, runtime package, or code is added or bundled by this task.

---

## 1. Model and Runtime Identity

Model and runtime versions recorded here match those used by lab counter D (identified from lab inventory `DEPENDENCIES_AND_LICENSES.md`, sha256 `1157695df7f0f0efe9375d024c3f5133ff20843ac6965afe3af497dadc441685`; that inventory was used solely to identify the artifact versions and is **not** treated as a licence source):

- **Model artifact filename:** `hand_landmarker.task`
- **Model name, precision, and version (as published for lab D):** Hand Landmarker `float16`, version `1` (`Hand Landmarker float16 v1`), hosted by Google Cloud Storage at `storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` (read-only HTTP `HEAD` on 2026-11-25T10:01:35Z returned HTTP `200`, `Content-Length: 7819105`, `Last-Modified: Wed, 26 Apr 2023 03:33:24 GMT`, `ETag: "15318430ea3851670fe9914116a9cfad"`; the model binary was **not** downloaded, per task scope).
- **Model listing on the current Google AI Edge guide page:** `HandLandmarker (full)`, input shape `192 x 192, 224 x 224`, quantization type `float 16`, version label `Latest`.
- **Runtime npm package:** `@mediapipe/tasks-vision 0.10.21` (`_id`: `@mediapipe/tasks-vision@0.10.21`, published by `mediapipe@google.com` / `mrschmidt@google.com`; `dist.shasum`: `b78df074763e0c7fdf8606c60121d65c9199bbf6`, `fileCount`: `11`, `unpackedSize`: `20529652`).

---

## 2. Official Sources Fetched

All sources below were fetched read-only over public HTTPS without credentials. Raw copies are retained outside the product repository under `workspace/scratch/S0-06/`.

| # | Source Role | Official URL | Retrieved (UTC) | Raw Scratch Copy | Raw Copy SHA-256 |
|---|---|---|---|---|---|
| S1 | Hand Landmarker guide page (redirected from `https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker`) | https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker | `2026-11-25T09:58:12Z` | `hand_landmarker_guide.html` | `7d94ec7ae626fd82fd8f2e3b64436799eafc359052204ede1d02590557fcb718` |
| S2 | Hand Landmarker Web/JS guide (markdown) | https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js.md.txt | `2026-11-25T09:58:55Z` | `hand_landmarker_web_js.md.txt` | `8134b52c9be2ca603ca30864fe2a4e2e16f7ebffa0e30845442c707922943f18` |
| S3 | Hand Tracking Model Card PDF (Google-hosted) | https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021.pdf | `2026-11-25T09:58:53Z` | `hand_landmarker_model_card.pdf` | `43127ff8a92e22717f0d8c30dab3efef4641a29cbf50b15ae3de001be94ab76b` |
| S4 | `google-ai-edge/mediapipe` repository `LICENSE` | https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE | `2026-11-25T09:58:14Z` | `mediapipe_repo_license.html` | `fd6c5b473d788abbcfa32e44dffb36347db9ccc62b94b9b1682196f3a92f6562` |
| S5 | `google-ai-edge/mediapipe` repository `README.md` | https://github.com/google-ai-edge/mediapipe/blob/master/README.md | `2026-11-25T09:58:54Z` | `mediapipe_repo_readme.html` | `26475952d068bb849dafc0f7d30b3fddae2f348acfcb193b1388726cb1f5046b` |
| S6 | `@mediapipe/tasks-vision@0.10.21` npm registry metadata | https://registry.npmjs.org/@mediapipe/tasks-vision/0.10.21 | `2026-11-25T09:58:14Z` | `npm_tasks_vision_0.10.21.json` | `0532a86edf8d33b583dbe18488d7df716eeafb27d8c72d7f3c63f79d7023c7bd` |

Additional negative checks (read-only HTTP status checks; no files created because all returned HTTP `404`):

- Root `NOTICE` in `github.com/google-ai-edge/mediapipe` (`master/NOTICE`): HTTP `404`.
- Sidecar `LICENSE` files under `storage.googleapis.com/mediapipe-models/` (`.../LICENSE`, `.../hand_landmarker/LICENSE`, `.../hand_landmarker/hand_landmarker/LICENSE`, `.../hand_landmarker/hand_landmarker/float16/1/LICENSE`): all HTTP `404`.

---

## 3. Verbatim Licence Statements and Exact Scope

### S1 — Hand Landmarker Guide Page (`https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker`)

- **Where it appears:** Page footer licence paragraph (`<p>` inside the site footer).
- **Verbatim licence statement:**
  > Except as otherwise noted, the content of this page is licensed under the Creative Commons Attribution 4.0 License, and code samples are licensed under the Apache 2.0 License. For details, see the Google Developers Site Policies.
- **SPDX ID stated verbatim:** None printed as an SPDX identifier string (the text names Creative Commons Attribution 4.0 License and Apache 2.0 License).
- **Additional factual observation (`## Models`, `<h2 id="models">Models</h2>`):**
  > The Hand Landmarker uses a model bundle with two packaged models: a palm detection model and a hand landmarks detection model. You need a model bundle that contains both these models to run this task.
  - The `Models` table lists `HandLandmarker (full)`, input shape `192 x 192, 224 x 224`, quantization type `float 16`, and `Latest`. No licence statement for the model file appears in this section or elsewhere on the page.
  - At retrieval time (`2026-11-25T09:58:12Z`), the table's links for `HandLandmarker (full)`, `Model card`, and `Latest` point to an external host (`huggingface.co`, outside the Google-controlled domains defined as official sources for this task).
- **Scope (no inference beyond quoted text):** Names **documentation page content** (Creative Commons Attribution 4.0 License) and **code samples** (Apache 2.0 License). Does **not** name the model file (`hand_landmarker.task`), the model card, the model family, the code repository, or the npm package.

### S2 — Hand Landmarker Web/JS Guide (`https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js.md.txt`)

- **Where it appears:** `## Setup -> ### Model` and `## Create the task`.
- **Verbatim licence statement:** None stated in this file.
- **Relevant verbatim model-loading text (`### Model` and `## Create the task`):**
  > The MediaPipe Hand Landmarker task requires a trained model that is compatible with this task.
  > Select and download a model, and then store it within your project directory:
  > `modelAssetPath: "hand_landmarker.task"`
- **SPDX ID stated verbatim:** None stated.
- **Scope (no inference beyond quoted text):** States **no licence**. Names `hand_landmarker.task` solely as a model asset path configured separately from `@mediapipe/tasks-vision`.

### S3 — Hand Tracking Model Card PDF (`https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021.pdf`)

- **Where it appears:**
  - Identity header: Page 1 of 7, title banner and `SOLUTION DETAILS`.
  - Licence statement: Page 2 of 7, bottom-right section `LICENSED UNDER`.
  - Release reference: Page 2 of 7, bottom-left section `DOCUMENTATION`.
- **Verbatim identity text (Page 1, banner and `SOLUTION DETAILS`):**
  > MODEL CARD
  > MediaPipe Hands (Lite/Full)
  >
  > Hand tracking neural network pipelines: Lite and Full, to predict 2D and 3D hand landmarks on an image / video sequence. Both pipelines consist of:
  > - Hand detector model, which locates hand region
  > - Hand tracking model, which predict 2D keypoints, 3D world keypoints, handedness on a cropped area around hand
  > - MediaPipe graph, with hand tracking logic.
- **Verbatim licence statement (Page 2, `LICENSED UNDER`):**
  > LICENSED UNDER
  > Apache License, Version 2.0
  *(The link annotation on `Apache License, Version 2.0` points to the Apache 2.0 licence text on `apache.org`.)*
- **SPDX ID stated verbatim:** None printed as an SPDX identifier string (states `Apache License, Version 2.0`).
- **Additional factual text on the card (not licence clauses; recorded verbatim without legal interpretation):**
  - Page 2, `DOCUMENTATION`:
    > Example usage included as part of MediaPipe February 2021 release
  - Page 3, `Limitations -> TRAINING`:
    > The model has been trained on limited datasets and is meant for experimental usage.
  - Page 3, `Ethical Considerations -> HUMAN LIFE`:
    > The model is not intended for human life-critical decisions. The primary intended application is for research and entertainment purposes.
- **Scope (no inference beyond quoted text):** Names the **model card** and **model family / solution** (`MediaPipe Hands (Lite/Full)`, Lite and Full hand tracking neural network pipelines with detector input `192 x 192 x 3` and tracker input `224 x 224 x 3`). Does **not** name the model file `hand_landmarker.task`, does **not** mention `float16`, does **not** mention version `1` (`float16/1`), and does **not** mention the MediaPipe Tasks `.task` bundle format (the GCS object `hand_landmarker.task` carries `Last-Modified: Wed, 26 Apr 2023 03:33:24 GMT`).

### S4 — `google-ai-edge/mediapipe` Repository `LICENSE` (`https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE`)

- **Where it appears:** Root `LICENSE` file of the `google-ai-edge/mediapipe` GitHub repository (218 lines total: lines 1–202 are Apache License Version 2.0; lines 203–218 are a scoped third-party notice).
- **Verbatim licence header (lines 1–2):**
  > Apache License
  > Version 2.0, January 2004
- **Verbatim redistribution / attribution / NOTICE clauses (lines 89–128, Section 4):**
  > 4. Redistribution. You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications, and in Source or Object form, provided that You meet the following conditions:
  >
  > (a) You must give any other recipients of the Work or Derivative Works a copy of this License; and
  >
  > (b) You must cause any modified files to carry prominent notices stating that You changed the files; and
  >
  > (c) You must retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work, excluding those notices that do not pertain to any part of the Derivative Works; and
  >
  > (d) If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file, excluding those notices that do not pertain to any part of the Derivative Works, in at least one of the following places: within a NOTICE text file distributed as part of the Derivative Works; within the Source form or documentation, if provided along with the Derivative Works; or, within a display generated by the Derivative Works, if and wherever such third-party notices normally appear. The contents of the NOTICE file are for informational purposes only and do not modify the License. You may add Your own attribution notices within Derivative Works that You distribute, alongside or as an addendum to the NOTICE text from the Work, provided that such additional attribution notices cannot be construed as modifying the License.
  >
  > You may add Your own copyright statement to Your modifications and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License.
- **Verbatim scoped third-party notice (lines 203–218):**
  > For files under tasks/cc/text/language_detector/custom_ops/utils/utf/
  >
  > The authors of this software are Rob Pike and Ken Thompson.
  > Copyright (c) 2002 by Lucent Technologies.
- **SPDX ID stated verbatim:** None printed as an SPDX identifier string (full text of `Apache License, Version 2.0, January 2004`).
- **Scope (no inference beyond quoted text):** Covers the **`google-ai-edge/mediapipe` code repository** (with lines 203–218 scoped explicitly to `tasks/cc/text/language_detector/custom_ops/utils/utf/`). Does **not** name `hand_landmarker.task` or pre-trained `.task` model binaries hosted outside the repository on Google Cloud Storage.

### S5 — `google-ai-edge/mediapipe` Repository `README.md` (`https://github.com/google-ai-edge/mediapipe/blob/master/README.md`)

- **Where it appears:** Repository root `README.md`, `## Solutions` (lines 66–67).
- **Verbatim licence statement:** None stated in `README.md`.
- **Relevant verbatim model mention (`## Solutions`):**
  > **MediaPipe models**: Pre-trained, ready-to-run models for use with each solution.
- **SPDX ID stated verbatim:** None stated.
- **Scope (no inference beyond quoted text):** States **no licence** for MediaPipe models or for `hand_landmarker.task`.

### S6 — `@mediapipe/tasks-vision@0.10.21` npm Package Metadata (`https://registry.npmjs.org/@mediapipe/tasks-vision/0.10.21`)

- **Where it appears:** Top-level JSON object of the npm registry version manifest for `@mediapipe/tasks-vision` version `0.10.21`.
- **Verbatim metadata statements:**
  ```json
  "_id": "@mediapipe/tasks-vision@0.10.21"
  "name": "@mediapipe/tasks-vision"
  "version": "0.10.21"
  "description": "MediaPipe Vision Tasks"
  "license": "Apache-2.0"
  "author": {"name": "mediapipe@google.com"}
  "_npmUser": {"name": "mrschmidt", "email": "mrschmidt@google.com"}
  ```
- **SPDX ID stated verbatim:** `Apache-2.0` (top-level `"license"` field).
- **Scope (no inference beyond quoted text):** Covers the **`@mediapipe/tasks-vision` npm package, version `0.10.21`** (JavaScript/WASM runtime library). Does **not** name or include `hand_landmarker.task`.

---

## 4. Summary Scope Matrix

| Source | Licence / SPDX Stated | Explicitly Names | Explicitly Covers `hand_landmarker.task` (`float16`, v1)? |
|---|---|---|---|
| S1 — Hand Landmarker guide page | CC-BY-4.0 (page content); Apache 2.0 (code samples) | Documentation page content and code samples | **No** |
| S2 — Hand Landmarker Web/JS guide | None stated | `hand_landmarker.task` as external `modelAssetPath` only | **No** |
| S3 — Hand Tracking Model Card PDF (Oct 2021) | `Apache License, Version 2.0` (no SPDX string) | Model card and model family/solution `MediaPipe Hands (Lite/Full)` | **No** (does not name `hand_landmarker.task`, `float16`, or v1) |
| S4 — `google-ai-edge/mediapipe` `LICENSE` | `Apache License, Version 2.0, January 2004` (+ Lucent notice for `tasks/cc/text/language_detector/custom_ops/utils/utf/`) | Code repository `google-ai-edge/mediapipe` | **No** |
| S5 — `google-ai-edge/mediapipe` `README.md` | None stated | Repository overview / MediaPipe Solutions | **No** |
| S6 — `@mediapipe/tasks-vision@0.10.21` npm metadata | `Apache-2.0` (SPDX) | npm package `@mediapipe/tasks-vision@0.10.21` | **No** |

---

## 5. Attribution and `NOTICE` Obligations

From the quoted licences (without adding legal interpretation beyond the quoted text):

1. **Apache License, Version 2.0 (quoted verbatim in S4 Section 4; referenced by S1 code samples, S3 model card, S6 npm package):**
   - **Section 4(a):** Give recipients of the Work or Derivative Works a copy of the Apache License, Version 2.0.
   - **Section 4(b):** Cause any modified files to carry prominent notices stating that the files were changed.
   - **Section 4(c):** Retain, in the Source form of any Derivative Works distributed, all copyright, patent, trademark, and attribution notices from the Source form of the Work (excluding notices that do not pertain to any part of the Derivative Works).
   - **Section 4(d):** If the Work includes a `NOTICE` text file as part of its distribution, include a readable copy of the pertinent attribution notices from that `NOTICE` file in at least one of: a distributed `NOTICE` text file, the Source form or documentation distributed with Derivative Works, or a display generated by Derivative Works where third-party notices normally appear.
2. **Presence of `NOTICE` / extra attribution text in the checked official sources:**
   - `google-ai-edge/mediapipe` repository: **no root `NOTICE` file found** (`master/NOTICE` returned HTTP `404`). The appended Lucent Technologies notice in `LICENSE` lines 203–218 states verbatim `For files under tasks/cc/text/language_detector/custom_ops/utils/utf/` (a separate text language-detector component, not Hand Landmarker).
   - Hand Tracking Model Card PDF (S3): **no separate `NOTICE` text stated** on the card beyond `Apache License, Version 2.0`.
   - `@mediapipe/tasks-vision@0.10.21` npm metadata (S6): states `"license": "Apache-2.0"` and `"author": {"name": "mediapipe@google.com"}`; **no separate `NOTICE` text stated** in the registry metadata JSON.
3. **Creative Commons Attribution 4.0 License (S1 page footer):**
   - Applies to the documentation page content on `developers.google.com` if reproduced (attribution obligation under CC-BY-4.0); does not apply to code samples (Apache 2.0) and does not state terms for the `.task` binary.

---

## 6. Classification

**Classification: `CONDITIONAL`**

**Justification (strictly from Sections 3 and 4, without inference beyond the quoted text):**

- Official Google sources **do** state `Apache License, Version 2.0` / `Apache-2.0` for the **model family / model card** (`MediaPipe Hands (Lite/Full)` in S3), for the **code repository** (`google-ai-edge/mediapipe` in S4), for the **npm runtime package** (`@mediapipe/tasks-vision@0.10.21` in S6), and for **documentation code samples** (S1). Therefore the status is **not** `UNCLEAR`.
- However, **no** checked official Google source explicitly states a licence for the **`hand_landmarker.task` (`float16`, version `1`) model artifact file itself**: S3 describes the October 2021 `MediaPipe Hands (Lite/Full)` family without naming `hand_landmarker.task`, `float16`, or version `1`; S4 covers the source repository; S6 covers the npm package (which does not bundle `hand_landmarker.task`); S1 covers only page text and code samples while linking its `Models` table to an external host (`huggingface.co`, outside the official Google domains defined for this task); and no sidecar `LICENSE` file exists at the checked paths under `storage.googleapis.com/mediapipe-models/`. Therefore the status does **not** meet the criterion for `CLEAR`.
- Because an official licence statement exists only for the model family/card, code repository, and npm package — and not explicitly for the `hand_landmarker.task` file itself — the classification is **`CONDITIONAL`**.

Per `S0-06` and `PO-F16`, this `CONDITIONAL` result requires Product Owner decision before any task (`S2-01`) depends on or distributes `hand_landmarker.task`.
