# Dependências e licenças

O inventário inicial de arquivos na conta, /tmp, /opt e /usr/share não localizou modelo ou runtime MediaPipe reutilizável. O usuário autorizou a obtenção neste mandato. Os artefatos foram baixados para diretório temporário, verificados por inventário e os arquivos de execução foram copiados para app/vendor/mediapipe, sem instalação global.

| Dependência | Origem e licença | Tamanho e finalidade |
|---|---|---|
| @mediapipe/tasks-vision 0.10.21 | Distribuição oficial Google no registro npm, Apache-2.0. [Tarball](https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.21.tgz) · [Licença upstream](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE) | 5,9 MiB comprimidos; cerca de 19 MiB locais incluindo WASM SIMD e fallback. |
| Hand Landmarker float16 v1 | Artefato do Google AI Edge. A ficha da família Hand Tracking declara Apache-2.0; a ficha descreve a família e não é arquivo de licença interno do bundle. [Modelo oficial](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task) · [Ficha da família](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021.pdf) | 7,5 MiB, pesos locais de detecção e landmarks. |
| Python 3 e Node.js | Ferramentas já presentes | Python serve arquivos estáticos. Node 24 executa testes, sem npm install. |

O diretório distribuído mede aproximadamente 27 MiB. O navegador carrega a variante WASM adequada, o módulo e o modelo pela mesma origem. A política de conteúdo impede conexões de aplicação com outras origens. A captura é ligada somente após ação explícita. [API Hand Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker)
