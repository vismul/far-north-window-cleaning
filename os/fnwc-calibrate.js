/* ===========================================================================
   FNWC Calibrate - what the jobs you have already done say about the prices
   you are quoting.

   The idea
   --------
   Every finished job is a completed experiment: you guessed it would take
   estMin, it actually took actualMin, and you charged price. Thirty of those
   and the quote calculator can stop being a rate card somebody wrote down once
   and start being a description of how you actually work.

   Two separate questions, which used to get muddled
   -------------------------------------------------
   1. Are your time estimates right? If every job runs 20% over, every quote is
      20% optimistic and no amount of raising prices fixes the fact that you
      fit four jobs in a day instead of five.
   2. Are your prices right? Given how long jobs really take, including the
      driving, what are you actually earning an hour against what you meant to?

   Honesty about sample size
   -------------------------
   Three jobs is not a calibration, it is an anecdote. Everything here carries
   a confidence, nothing is applied on its own, and below five samples it
   refuses to give a number at all rather than dress up noise as a finding.
   The median is used rather than the mean throughout, so one shocker of a day
   does not rewrite your rate card.
   =========================================================================== */
(function (global) {
  "use strict";

  var DEFAULTS = {
    targetRate: 90,        /* what you meant to earn an hour */
    travelDefault: 30,     /* round-trip driving when a job does not say */
    timeFactor: 1          /* accepted correction to time estimates */
  };

  /* Below this, say nothing. Between here and "fair", say it quietly. */
  var MIN_SAMPLES = 5;
  var FAIR_SAMPLES = 12;
  var GOOD_SAMPLES = 30;

  function settings(db) {
    var s = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = db && db.settings ? db.settings[k] : undefined;
      s[k] = (v === undefined || v === null || v === "") ? DEFAULTS[k] : v;
    });
    return s;
  }

  function confidenceOf(n) {
    if (n < MIN_SAMPLES) return "none";
    if (n < FAIR_SAMPLES) return "early";
    if (n < GOOD_SAMPLES) return "fair";
    return "good";
  }

  function median(list) {
    if (!list.length) return null;
    var s = list.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function round(n, dp) {
    var f = Math.pow(10, dp == null ? 2 : dp);
    return Math.round(n * f) / f;
  }

  function isFinished(j) {
    return j.status === "done" || j.status === "invoiced" || j.status === "paid";
  }

  function travelOf(db, j) {
    var t = j.travelMin;
    if (t === undefined || t === null || t === "") return +settings(db).travelDefault || 0;
    return +t || 0;
  }

  /* ---------- the usable jobs ---------------------------------------------
     A job counts as evidence only if somebody wrote down how long it really
     took. Anything absurd is thrown out rather than allowed to drag the
     median around - a job logged as four minutes or three days is a typo, not
     a data point.
     --------------------------------------------------------------------- */

  function samples(db) {
    return (db.jobs || []).filter(function (j) {
      if (!isFinished(j)) return false;
      var a = +j.actualMin;
      return isFinite(a) && a >= 10 && a <= 960;
    });
  }

  /* Jobs that could have taught you something and did not. */
  function missing(db) {
    return (db.jobs || []).filter(function (j) {
      if (!isFinished(j)) return false;
      var a = +j.actualMin;
      return !(isFinite(a) && a >= 10 && a <= 960);
    }).sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
  }

  function coverage(db) {
    var have = samples(db).length, lack = missing(db).length;
    var total = have + lack;
    return {
      logged: have, missing: lack, total: total,
      pct: total ? Math.round(have / total * 100) : 0,
      confidence: confidenceOf(have),
      needed: Math.max(0, MIN_SAMPLES - have)
    };
  }

  /* ---------- question 1: are the time estimates right? ---------- */

  function timeBias(db) {
    var use = samples(db).filter(function (j) { return +j.estMin >= 10; });
    var ratios = use.map(function (j) { return +j.actualMin / +j.estMin; })
                    .filter(function (r) { return r >= 0.2 && r <= 5; });
    var n = ratios.length;
    var conf = confidenceOf(n);

    if (conf === "none") {
      return { n: n, confidence: conf, factor: null,
               advice: n === 0
                 ? "Nothing to go on yet. Log how long jobs actually take and this starts working."
                 : "Only " + n + " job" + (n === 1 ? "" : "s") + " logged so far. " +
                   (MIN_SAMPLES - n) + " more and there is something worth saying." };
    }

    var m = median(ratios);
    var over = m > 1;
    var pct = Math.round(Math.abs(m - 1) * 100);

    return {
      n: n,
      confidence: conf,
      factor: round(m, 3),
      pct: pct,
      direction: pct < 5 ? "right" : over ? "under" : "over",
      advice: pct < 5
        ? "Your time estimates are about right. Keep them."
        : over
          ? "Jobs run about " + pct + "% longer than you quote them. That is why days overrun - " +
            "the work is fine, the guess is short."
          : "Jobs come in about " + pct + "% quicker than you quote them. You may be leaving " +
            "room in the day you could sell.",
      /* How many worked out slower than quoted - a median hides whether it is
         everything or one or two disasters. */
      overCount: ratios.filter(function (r) { return r > 1.05; }).length,
      underCount: ratios.filter(function (r) { return r < 0.95; }).length
    };
  }

  /* ---------- question 2: are the prices right? ---------------------------
     Driving counts. An hour on the tools is not an hour of your day if it took
     forty minutes each way to get there.
     --------------------------------------------------------------------- */

  function jobRate(db, j) {
    var mins = +j.actualMin + travelOf(db, j);
    if (!(mins > 0)) return null;
    return (+j.price || 0) / (mins / 60);
  }

  function rateAchieved(db) {
    var s = settings(db);
    var use = samples(db);
    var rates = use.map(function (j) { return jobRate(db, j); })
                   .filter(function (r) { return r != null && isFinite(r) && r > 0; });
    var n = rates.length;
    var conf = confidenceOf(n);
    var target = +s.targetRate || 90;

    if (conf === "none") {
      return { n: n, confidence: conf, rate: null, target: target,
               advice: "Not enough logged jobs to say what you are really earning an hour." };
    }

    var m = median(rates);
    var gap = m - target;
    var pctShort = target > 0 ? Math.round((target - m) / target * 100) : 0;

    /* On-tools rate ignores the driving. The gap between the two is what the
       travelling is quietly costing. */
    var onTools = median(use.map(function (j) {
      return (+j.price || 0) / (+j.actualMin / 60);
    }).filter(function (r) { return isFinite(r) && r > 0; }));

    return {
      n: n, confidence: conf,
      rate: round(m, 0),
      onToolsRate: round(onTools, 0),
      target: target,
      gap: round(gap, 0),
      pctShort: pctShort,
      meetingTarget: m >= target,
      /* What prices would have to do to hit the target, if nothing else
         changed. Deliberately not applied anywhere by itself. */
      priceLift: m > 0 ? Math.max(0, Math.round((target / m - 1) * 100)) : 0,
      travelCost: round(onTools - m, 0),
      advice: m >= target
        ? "You are earning " + Math.round(m) + " an hour against a " + target + " target, driving included. " +
          "The rate card is doing its job."
        : "You are earning about " + Math.round(m) + " an hour against a " + target + " target once driving " +
          "is counted. That is " + pctShort + "% short."
    };
  }

  /* ---------- where the money is actually made ----------------------------
     Grouping tells you more than an average ever will: it is usually one
     suburb or one kind of job dragging the whole thing down.
     --------------------------------------------------------------------- */

  function groupBy(db, keyFn, minN) {
    var buckets = {};
    samples(db).forEach(function (j) {
      var k = keyFn(j);
      if (!k) return;
      (buckets[k] = buckets[k] || []).push(j);
    });
    var out = [];
    Object.keys(buckets).forEach(function (k) {
      var js = buckets[k];
      if (js.length < (minN || 3)) return;
      var rates = js.map(function (j) { return jobRate(db, j); })
                    .filter(function (r) { return r != null && isFinite(r) && r > 0; });
      if (!rates.length) return;
      out.push({
        key: k, n: js.length,
        rate: round(median(rates), 0),
        takings: round(js.reduce(function (a, j) { return a + (+j.price || 0); }, 0), 2),
        medianMinutes: Math.round(median(js.map(function (j) { return +j.actualMin; })))
      });
    });
    return out.sort(function (a, b) { return b.rate - a.rate; });
  }

  function bySuburb(db, minN) {
    return groupBy(db, function (j) {
      var s = (j.suburb || "").trim();
      return s ? s.toLowerCase() : null;
    }, minN);
  }

  /* Jobs do not record what was on them beyond a line of text, so this reads
     the words. Rough, but "inside and out" versus "outside only" is the split
     that actually matters to the price. */
  function byKind(db, minN) {
    return groupBy(db, function (j) {
      var s = String(j.services || "").toLowerCase();
      if (!s) return null;
      if (/\bin\s*(and|&|\+)\s*out\b|inside and out|both sides/.test(s)) return "inside and out";
      if (/\bexterior\b|outside only|\bouts(ide)?\b/.test(s)) return "outside only";
      if (/two storey|2 storey|double storey|upstairs/.test(s)) return "two storey";
      if (/screen/.test(s)) return "screens included";
      return null;
    }, minN);
  }

  /* The handful of jobs worth actually looking at. */
  function outliers(db, count) {
    var use = samples(db).map(function (j) {
      return { job: j, rate: jobRate(db, j), ratio: +j.estMin >= 10 ? +j.actualMin / +j.estMin : null };
    }).filter(function (x) { return x.rate != null && isFinite(x.rate); });

    var sorted = use.slice().sort(function (a, b) { return a.rate - b.rate; });
    return {
      worst: sorted.slice(0, count || 3),
      best: sorted.slice(-(count || 3)).reverse()
    };
  }

  /* ---------- what to actually do about it ---------------------------------
     One screen's worth of conclusions, in the order they are worth acting on,
     and nothing at all when there is not enough to go on.
     --------------------------------------------------------------------- */

  function report(db) {
    var cov = coverage(db);
    var time = timeBias(db);
    var rate = rateAchieved(db);
    var s = settings(db);
    var actions = [];

    if (cov.confidence === "none") {
      actions.push({
        kind: "log",
        title: "Log how long jobs take",
        detail: cov.needed + " more finished job" + (cov.needed === 1 ? "" : "s") +
                " with a real time on them and this can start telling you whether your prices work.",
        weight: 100
      });
    }

    if (time.confidence !== "none" && time.direction === "under") {
      actions.push({
        kind: "time",
        title: "Quote " + time.pct + "% more time",
        detail: time.advice + " Accepting this pads the quote calculator's time estimate, which " +
                "changes the hourly rate it shows you, not the price it quotes.",
        factor: time.factor,
        weight: 80 + Math.min(20, time.pct)
      });
    }

    if (rate.confidence !== "none" && !rate.meetingTarget) {
      actions.push({
        kind: "price",
        title: "You are " + rate.pctShort + "% under your target rate",
        detail: rate.advice + " Putting prices up " + rate.priceLift + "% would close it, though " +
                "quoting less travel or being pickier about far jobs does the same work.",
        lift: rate.priceLift,
        weight: 70 + Math.min(25, rate.pctShort)
      });
    }

    /* Judged as a share of what you earn, not as a dollar figure. Losing $17
       an hour to driving sounds minor until you notice it is a quarter of a
       $72 hour. A flat threshold would stay quiet on exactly the businesses
       that most need telling. */
    var travelShare = rate.onToolsRate > 0 ? rate.travelCost / rate.onToolsRate : 0;
    if (rate.confidence !== "none" && rate.travelCost > 8 && travelShare >= 0.15) {
      actions.push({
        kind: "travel",
        title: "Driving is costing you " + Math.round(rate.travelCost) + " an hour, " +
               Math.round(travelShare * 100) + "% of what you earn",
        detail: "On the tools you are on " + rate.onToolsRate + " an hour, but " + rate.rate +
                " once the driving is counted. Grouping jobs by area is worth more to you than " +
                "a price rise.",
        weight: 60 + Math.min(20, rate.travelCost / 5)
      });
    }

    if (cov.missing > 0 && cov.confidence !== "none") {
      actions.push({
        kind: "log",
        title: cov.missing + " finished job" + (cov.missing === 1 ? "" : "s") + " with no time logged",
        detail: "Every one you log sharpens this. You are at " + cov.pct + "% logged.",
        weight: 30
      });
    }

    actions.sort(function (a, b) { return b.weight - a.weight; });

    return {
      coverage: cov, time: time, rate: rate, actions: actions,
      appliedFactor: +s.timeFactor || 1,
      /* Enough to say something useful at all. */
      usable: cov.confidence !== "none"
    };
  }

  /* ---------- applying it -------------------------------------------------
     Accepting the time correction stores a single number. The quote screens
     multiply their time estimate by it, which changes the hourly rate they
     show you - that number is the whole point of the exercise. It does not
     touch the rate card, because what you charge stays your decision.
     --------------------------------------------------------------------- */

  function acceptTimeFactor(db, factor) {
    var f = parseFloat(factor);
    if (!isFinite(f) || f < 0.5 || f > 2.5) return false;
    db.settings = db.settings || {};
    db.settings.timeFactor = round(f, 3);
    return true;
  }

  function clearTimeFactor(db) {
    if (db.settings) delete db.settings.timeFactor;
    return true;
  }

  function timeFactor(db) {
    var f = parseFloat(settings(db).timeFactor);
    return isFinite(f) && f >= 0.5 && f <= 2.5 ? f : 1;
  }

  /* Apply the correction to a quoted on-site figure. */
  function adjustMinutes(db, mins) {
    return Math.round((+mins || 0) * timeFactor(db));
  }

  function logTime(db, jobId, minutes) {
    var j = (db.jobs || []).filter(function (x) { return x.id === jobId; })[0];
    if (!j) return false;
    var m = parseInt(minutes, 10);
    if (!isFinite(m) || m < 1) return false;
    j.actualMin = m;
    return true;
  }

  global.FNWCCalibrate = {
    DEFAULTS: DEFAULTS,
    MIN_SAMPLES: MIN_SAMPLES,
    samples: samples,
    missing: missing,
    coverage: coverage,
    timeBias: timeBias,
    rateAchieved: rateAchieved,
    jobRate: jobRate,
    bySuburb: bySuburb,
    byKind: byKind,
    outliers: outliers,
    report: report,
    acceptTimeFactor: acceptTimeFactor,
    clearTimeFactor: clearTimeFactor,
    timeFactor: timeFactor,
    adjustMinutes: adjustMinutes,
    logTime: logTime,
    _median: median,
    _confidence: confidenceOf
  };

})(typeof window !== "undefined" ? window : this);
