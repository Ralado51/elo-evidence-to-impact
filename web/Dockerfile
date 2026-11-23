# Stage 1: fetch the hand-landmark runtime and model at build time, so the app serves them itself.
# The browser then never contacts a third party while the camera is on (the CSP allows only 'self').
FROM node:22-alpine AS vendor
WORKDIR /v
RUN npm pack @mediapipe/tasks-vision@1.2.3 && tar xzf mediapipe-tasks-vision-1.2.3.tgz
ADD https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task /v/package/hand_landmarker.task

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html styles.css app.js counter.js hand.js /usr/share/nginx/html/app/
COPY --from=vendor /v/package/vision_bundle.mjs /v/package/hand_landmarker.task /usr/share/nginx/html/app/vendor/
COPY --from=vendor /v/package/wasm/ /usr/share/nginx/html/app/vendor/wasm/
EXPOSE 80
