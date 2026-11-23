"use strict";
// Camera panel for the hand open/close exercise. The camera is read in the browser by MediaPipe;
// the page draws only a skeleton on a black canvas. No MediaRecorder, toDataURL, toBlob or getImageData:
// nothing of the image is stored or sent. What leaves this module is a list of derived events.
(function (root) {
  var C = root.EloCounter;
  var MP = { url: "/app/vendor/vision_bundle.mjs", wasm: "/app/vendor/wasm", model: "/app/vendor/hand_landmarker.task" };

  function mount(box, tx) {
    var h = function (tag, attrs) {
      var el = document.createElement(tag);
      Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
      for (var i = 2; i < arguments.length; i++) el.append(arguments[i]);
      return el;
    };
    var cv = h("canvas", { width: 640, height: 480, "aria-label": tx.canvasLabel }), vid = h("video", { playsinline: "", muted: "" });
    var msg = h("div", { class: "hand-msg", role: "status" }, tx.hint);
    var stage = h("div", { class: "hand-stage" }, cv, vid, msg);
    var bStart = h("button", { type: "button" }, tx.start), bCal = h("button", { type: "button", class: "ghost", disabled: "" }, tx.calibrate),
        bReset = h("button", { type: "button", class: "ghost", disabled: "" }, tx.reset);
    var reps = h("b", {}, "0"), live = h("div", { class: "muted" }, "");
    box.append(stage, h("div", { class: "row" }, bStart, bCal, bReset),
      h("div", { class: "hand-big" }, reps, h("span", {}, " " + tx.repsLabel)), live);

    var ctx = cv.getContext("2d"), counter = C.createCounter(), events = [], landmarker = null, HL = null, stream = null, running = false, t0 = 0;
    var calibrating = false, calValues = [], calEnd = 0, wake = null;
    function say(t) { msg.textContent = t; msg.style.display = t ? "flex" : "none"; }

    async function loadModel() {
      if (landmarker) return;
      say(tx.loading);
      var mod = await import(MP.url);
      HL = mod.HandLandmarker;
      var fileset = await mod.FilesetResolver.forVisionTasks(MP.wasm), err;
      for (var d of ["GPU", "CPU"]) {
        try {
          landmarker = await HL.createFromOptions(fileset, { baseOptions: { modelAssetPath: MP.model, delegate: d }, runningMode: "VIDEO", numHands: 1,
            minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
          return;
        } catch (e) { err = e; }
      }
      throw err;
    }
    function draw(lm) {
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cv.width, cv.height);
      if (!lm) return;
      var W = cv.width, H = cv.height, conns = HL.HAND_CONNECTIONS || [];
      ctx.lineWidth = 3; ctx.strokeStyle = "#34a37f"; ctx.beginPath();
      conns.forEach(function (c) { var a = lm[c.start], b = lm[c.end]; ctx.moveTo(a.x * W, a.y * H); ctx.lineTo(b.x * W, b.y * H); });
      ctx.stroke(); ctx.fillStyle = "#e8eaed";
      lm.forEach(function (p) { ctx.beginPath(); ctx.arc(p.x * W, p.y * H, 4, 0, 6.2832); ctx.fill(); });
    }
    function ui(v) {
      reps.textContent = String(counter.reps);
      var st = tx.states[counter.state];
      live.textContent = tx.openness + ": " + (v == null ? "--" : v.toFixed(2)) + " | " + tx.state + ": " + st + (counter.ignored ? " | " + tx.ignored + ": " + counter.ignored : "") + (calibrating ? " | " + tx.calibrating : "");
    }
    function loop() {
      if (!running) return;
      var now = performance.now();
      if (vid.readyState >= 2) {
        var rel = now - t0, v = null, res = landmarker.detectForVideo(vid, now), lm = res.landmarks && res.landmarks[0];
        if (lm) {
          draw(lm); v = C.openness(lm, cv.width / cv.height);
          var sc = res.handedness && res.handedness[0] && res.handedness[0][0] ? res.handedness[0][0].score : null;
          if (v != null) { if (calibrating) calValues.push(v); var ev = counter.feed(rel, v, sc); if (ev) events.push(ev); }
        } else { draw(null); counter.lost(rel); }
        if (calibrating && now > calEnd) {
          calibrating = false; bCal.disabled = false;
          var th = C.thresholdsFrom(calValues);
          if (th) { counter.set(th); say(""); } else { say(tx.calFail); setTimeout(function () { say(""); }, 3500); }
        }
        ui(v == null ? counter.ema : v);
      }
      if (vid.requestVideoFrameCallback) vid.requestVideoFrameCallback(loop); else requestAnimationFrame(loop);
    }
    function stop() {
      running = false;
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null; vid.srcObject = null;
      try { if (wake) wake.release(); } catch (e) {}
      bStart.textContent = tx.start; bCal.disabled = true;
      ctx.clearRect(0, 0, cv.width, cv.height); say(tx.stopped);
    }
    bStart.onclick = async function () {
      if (running) { stop(); return; }
      bStart.disabled = true;
      try {
        await loadModel(); say(tx.opening);
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
        vid.srcObject = stream; await vid.play();
        cv.width = vid.videoWidth || 640; cv.height = vid.videoHeight || 480;
        try { if (navigator.wakeLock) wake = await navigator.wakeLock.request("screen"); } catch (e) {}
        running = true; t0 = performance.now(); bStart.textContent = tx.stop; bCal.disabled = bReset.disabled = false; say(""); loop();
      } catch (e) { say(tx.failed + (e && e.message ? e.message : e)); }
      bStart.disabled = false;
    };
    bCal.onclick = function () { calibrating = true; calValues = []; calEnd = performance.now() + 10000; bCal.disabled = true; };
    bReset.onclick = function () { counter.clear(); events = []; ui(null); };
    ui(null);
    return {
      stop: stop,
      // Derived numbers only. Marks atypical repetitions (they still count) before reading.
      result: function () { var n = C.markAtypical(events); return { reps: counter.reps, atypical: n }; },
      clear: function () { counter.clear(); events = []; ui(null); },
    };
  }
  root.EloHand = { mount: mount };
})(window);
