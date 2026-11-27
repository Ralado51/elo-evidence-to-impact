# Dependências e licenças

O repositório e o bundle de release incluem o runtime MediaPipe, as variantes WASM SIMD e fallback e o modelo `hand_landmarker.task` em `web/s2/vendor/`. O navegador carrega esses arquivos pela mesma origem. Esses componentes de terceiros são distribuídos com o texto integral da Apache License, Version 2.0 em [LICENSE](LICENSE) e os avisos no [NOTICE](../../../NOTICE).

| Dependência | Versão e licença | Origem |
|---|---|---|
| MediaPipe Tasks Vision | `@mediapipe/tasks-vision@0.10.21`, Apache-2.0 | [Pacote npm](https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.21.tgz) |
| MediaPipe Hand Landmarker (Full) | float16 v1, Apache-2.0 | [Model Card do Google, p. 2](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021.pdf#page=2) · [Modelo e procedência LiteRT](https://huggingface.co/litert-community/MediaPipe-HandLandmarker-Full) · [Arquivo e SHA-256 publicados](https://huggingface.co/litert-community/MediaPipe-HandLandmarker-Full/blob/main/hand_landmarker.task) |

SHA-256 verificado do modelo distribuído: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.

Consulte o [registro de verificação](../../../docs/third-party/mediapipe-hand-landmarker.md) para a correspondência entre o arquivo distribuído e a revisão publicada pelo LiteRT.
