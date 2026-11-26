"use strict";
// Hand open/close counter: pure logic, no DOM, no camera. Input: one "openness" number per frame.
// Only derived numbers come out (repetitions, duration, amplitude). No image or raw landmark is kept.
(function (root) {
  function d2(a, b, aspect) { return Math.hypot((a.x - b.x) * aspect, a.y - b.y); }

  // openness = mean fingertip-to-wrist distance / wrist-to-middle-knuckle distance (scale-free)
  function openness(lm, aspect) {
    if (!lm || lm.length < 21) return null;
    var palm = d2(lm[0], lm[9], aspect);
    if (!(palm > 1e-4)) return null;
    var s = 0, tips = [8, 12, 16, 20];
    for (var k = 0; k < tips.length; k++) s += d2(lm[tips[k]], lm[0], aspect);
    return (s / 4) / palm;
  }

  function percentile(arr, p) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return a[lo] + (a[hi] - a[lo]) * (i - lo);
  }

  // 10 s of slow open/close -> personal thresholds (30% / 70% of the 10th-90th percentile range)
  function thresholdsFrom(values) {
    if (values.length < 30) return null;
    var lo = percentile(values, 0.1), hi = percentile(values, 0.9);
    if (hi - lo < 0.3) return null;
    return { closeBelow: lo + 0.3 * (hi - lo), openAbove: lo + 0.7 * (hi - lo),
             minAmp: Math.max(0.15, 0.5 * (hi - lo)), lo: lo, hi: hi };
  }

  // Defaults follow what real hands gave in the hand test (open about 1.6-1.7, closed about 0.6).
  function createCounter(opts) {
    var o = Object.assign({ closeBelow: 1.0, openAbove: 1.3, minAmp: 0.3,
      minCycleMs: 400, maxCycleMs: 10000, alpha: 0.4, lostMs: 600 }, opts || {});
    var state = "waiting", ema = null, depart = null, peak = null, trough = null,
        lastSeen = null, confSum = 0, confN = 0, reps = 0, ignored = 0;
    function reset() { state = "waiting"; ema = null; depart = null; peak = null; trough = null; confSum = 0; confN = 0; }
    return {
      get reps() { return reps; }, get state() { return state; },
      get ema() { return ema; }, get ignored() { return ignored; },
      get thresholds() { return { closeBelow: o.closeBelow, openAbove: o.openAbove, minAmp: o.minAmp }; },
      set: function (th) { Object.assign(o, th); reset(); },
      clear: function () { reps = 0; ignored = 0; reset(); },
      lost: function (t) { if (lastSeen !== null && t - lastSeen > o.lostMs && state !== "waiting") reset(); },
      feed: function (t, v, score) {
        lastSeen = t;
        ema = (ema === null) ? v : ema + o.alpha * (v - ema);
        var x = ema, sc = (score == null) ? 0 : score;
        if (state === "waiting") {
          if (x > o.openAbove) { state = "open"; peak = x; depart = null; confSum = 0; confN = 0; }
          return null;
        }
        confSum += sc; confN++;
        if (state === "open") {
          if (x > o.openAbove) { peak = Math.max(peak, x); depart = null; confSum = sc; confN = 1; }
          else {
            if (depart === null) depart = t;
            if (x < o.closeBelow) { state = "closed"; trough = x; }
          }
          return null;
        }
        trough = Math.min(trough, x);
        if (x > o.openAbove) {
          var t0 = depart, dur = t - t0, amp = peak - trough, p = peak, tr = trough;
          var conf = confN ? confSum / confN : null;
          state = "open"; peak = x; depart = null; confSum = sc; confN = 1;
          if (dur < o.minCycleMs || amp < o.minAmp) { ignored++; return null; }
          reps++;
          return { rep: reps, t_start_ms: Math.round(t0), duration_ms: Math.round(dur),
                   amplitude: +amp.toFixed(2), peak_open: +p.toFixed(2), min_closed: +tr.toFixed(2),
                   confidence: conf == null ? null : +conf.toFixed(2), slow: dur > o.maxCycleMs };
        }
        return null;
      }
    };
  }

  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

  // A repetition is "atypical" when it is far from the session's own pattern: much longer or shorter
  // than the median duration, or much smaller than the median amplitude. Needs at least 4 repetitions.
  // The repetition still counts; the flag lets the therapist see it. Returns the number of atypical reps.
  function markAtypical(events) {
    if (events.length < 4) { events.forEach(function (e) { e.atypical = false; }); return 0; }
    var md = median(events.map(function (e) { return e.duration_ms; })), ma = median(events.map(function (e) { return e.amplitude; }));
    var n = 0;
    events.forEach(function (e) {
      e.atypical = e.duration_ms > 2 * md || e.duration_ms < 0.5 * md || e.amplitude < 0.5 * ma;
      if (e.atypical) n++;
    });
    return n;
  }

  var api = { openness: openness, thresholdsFrom: thresholdsFrom, createCounter: createCounter, markAtypical: markAtypical };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.EloCounter = api;
})(typeof window !== "undefined" ? window : globalThis);
