/* ===========================================================================
   FNWC Vehicle - the car, for tax.

   Why this exists
   ---------------
   Every job already records the round-trip kilometres. Nothing has ever used
   that for anything but a fuel estimate, which means a year of business travel
   records has been thrown away twelve months at a time. For a sole trader the
   car is usually the second biggest deduction after materials.

   The two methods, plainly
   ------------------------
   Cents per kilometre. Business kilometres times a rate the Tax Office sets
   each year, capped at a fixed number of kilometres per car per year. No
   logbook needed, but you still have to be able to show how you arrived at the
   number - which is exactly what this produces.

   Logbook. Twelve straight weeks that fairly represent the year give a
   business-use percentage. That percentage then applies to everything the car
   actually costs, and stands for five years. It is more work and usually worth
   considerably more, but it cannot be done retrospectively without records.

   What this is not
   ----------------
   Not tax advice, and it does not know the current rates - they change every
   year and anything hard-coded here would be wrong by the time it mattered.
   The rate and the cap are settings. Check them once a year against the Tax
   Office and put them in. What is actually claimable is between Liam and his
   accountant; this only keeps the record that lets them answer.
   =========================================================================== */
(function (global) {
  "use strict";

  var DEFAULTS = {
    /* Deliberately zero. A wrong rate quietly producing a confident number is
       worse than a blank asking to be filled in. */
    centsPerKm: 0,
    centsPerKmCap: 5000,
    logbookWeeks: 12,
    travelDefault: 30
  };

  function settings(db) {
    var s = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = db && db.settings ? db.settings[k] : undefined;
      s[k] = (v === undefined || v === null || v === "") ? DEFAULTS[k] : v;
    });
    return s;
  }

  /* ---------- dates ---------- */

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parse(s) {
    if (!s) return null;
    var d = new Date(String(s).slice(0, 10) + "T00:00:00");
    return isNaN(d) ? null : d;
  }
  function addDays(isoStr, n) {
    var d = parse(isoStr);
    if (!d) return null;
    d.setDate(d.getDate() + n);
    return iso(d);
  }
  function daysBetween(a, b) {
    var x = parse(a), y = parse(b);
    if (!x || !y) return null;
    return Math.round((y - x) / 86400000);
  }

  /* Australian financial year: 1 July to 30 June. fyOf returns the starting
     year, so 2026 means 2026/27. */
  function fyOf(isoStr) {
    var d = parse(isoStr);
    if (!d) return null;
    return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  }
  function fyRange(fy) { return { from: fy + "-07-01", to: (fy + 1) + "-06-30" }; }

  /* ---------- the trips ---------------------------------------------------
     One trip per job you actually went to. A job with no kilometres on it
     still happened, so it is counted with the default round trip rather than
     dropped - but it is marked as estimated, because a logbook full of guesses
     is worth less than one that says which is which.
     --------------------------------------------------------------------- */

  function wentThere(j) {
    return j.status === "done" || j.status === "invoiced" || j.status === "paid";
  }

  function custOf(db, id) {
    return (db.customers || []).filter(function (c) { return c.id === id; })[0] || null;
  }

  function trips(db, from, to) {
    var s = settings(db);
    var out = [];

    (db.jobs || []).forEach(function (j) {
      if (!wentThere(j)) return;
      if (!j.date) return;
      if (from && j.date < from) return;
      if (to && j.date > to) return;

      var km = parseFloat(j.km);
      var estimated = !(isFinite(km) && km > 0);
      if (estimated) {
        /* No kilometres recorded. Fall back to the travel minutes at a rough
           town speed, and failing that leave it at zero rather than invent. */
        var mins = parseFloat(j.travelMin);
        if (!isFinite(mins)) mins = parseFloat(s.travelDefault);
        km = isFinite(mins) && mins > 0 ? Math.round(mins / 60 * 40) : 0;
      }
      if (!(km > 0)) return;

      var c = custOf(db, j.customerId);
      out.push({
        date: j.date,
        km: Math.round(km * 10) / 10,
        estimated: estimated,
        jobId: j.id,
        customer: c ? c.name : "",
        suburb: j.suburb || (c ? c.suburb : "") || "",
        purpose: "Window cleaning job" + (j.suburb ? " - " + j.suburb : "")
      });
    });

    return out.sort(function (a, b) { return a.date.localeCompare(b.date); });
  }

  function totalKm(list) {
    return Math.round(list.reduce(function (a, t) { return a + t.km; }, 0) * 10) / 10;
  }

  /* ---------- a financial year ---------- */

  function year(db, fy) {
    fy = fy == null ? fyOf(iso(new Date())) : fy;
    var r = fyRange(fy);
    var list = trips(db, r.from, r.to);
    var est = list.filter(function (t) { return t.estimated; });

    return {
      fy: fy,
      label: fy + "/" + String(fy + 1).slice(2),
      from: r.from, to: r.to,
      trips: list,
      tripCount: list.length,
      km: totalKm(list),
      estimatedKm: totalKm(est),
      estimatedCount: est.length,
      recordedCount: list.length - est.length,
      /* How much of the total is a guess. Past about a fifth the number stops
         being something to put in a tax return with a straight face. */
      confidence: !list.length ? "none"
        : est.length / list.length > 0.5 ? "poor"
        : est.length / list.length > 0.2 ? "fair" : "good"
    };
  }

  function yearsWithTrips(db) {
    var seen = {};
    (db.jobs || []).forEach(function (j) {
      if (!wentThere(j) || !j.date) return;
      var f = fyOf(j.date);
      if (f != null) seen[f] = 1;
    });
    var now = fyOf(iso(new Date()));
    if (now != null) seen[now] = 1;
    return Object.keys(seen).map(Number).sort(function (a, b) { return b - a; });
  }

  /* ---------- cents per kilometre ---------- */

  function centsPerKmClaim(db, fy) {
    var s = settings(db);
    var y = year(db, fy);
    var rate = parseFloat(s.centsPerKm);
    var cap = parseFloat(s.centsPerKmCap);
    if (!isFinite(cap) || cap <= 0) cap = DEFAULTS.centsPerKmCap;

    var claimable = Math.min(y.km, cap);
    var haveRate = isFinite(rate) && rate > 0;

    return {
      fy: y.fy, label: y.label,
      km: y.km,
      cap: cap,
      claimableKm: Math.round(claimable * 10) / 10,
      overCap: y.km > cap,
      kmOverCap: Math.round(Math.max(0, y.km - cap) * 10) / 10,
      rate: haveRate ? rate : null,
      /* The rate is in cents, so the sum is kilometres times cents over 100. */
      amount: haveRate ? Math.round(claimable * rate) / 100 : null,
      needsRate: !haveRate
    };
  }

  /* ---------- the logbook -------------------------------------------------
     Twelve straight weeks. The best stretch to use is the one with the most
     business travel in it, because that is the stretch that gives the highest
     honest business-use percentage - and "representative" is the test, not
     "lowest".
     --------------------------------------------------------------------- */

  function periodEnd(startISO, weeks) {
    return addDays(startISO, (weeks || 12) * 7 - 1);
  }

  function logbookPeriod(db, startISO, weeks) {
    var s = settings(db);
    weeks = weeks || parseInt(s.logbookWeeks, 10) || 12;
    var endISO = periodEnd(startISO, weeks);
    var list = trips(db, startISO, endISO);
    var est = list.filter(function (t) { return t.estimated; });

    return {
      from: startISO, to: endISO, weeks: weeks,
      trips: list,
      tripCount: list.length,
      businessKm: totalKm(list),
      estimatedCount: est.length,
      days: (function () {
        var d = {};
        list.forEach(function (t) { d[t.date] = 1; });
        return Object.keys(d).length;
      })()
    };
  }

  /* The twelve weeks with the most business travel in them, tried from the
     first working day of each week rather than every single date. */
  function bestPeriod(db, fy, weeks) {
    var y = year(db, fy);
    if (!y.trips.length) return null;
    weeks = weeks || parseInt(settings(db).logbookWeeks, 10) || 12;

    var starts = {};
    y.trips.forEach(function (t) {
      /* Snap to the Monday of that week so the periods line up sensibly. */
      var d = parse(t.date);
      var back = (d.getDay() + 6) % 7;
      starts[addDays(t.date, -back)] = 1;
    });

    var best = null;
    Object.keys(starts).forEach(function (st) {
      if (periodEnd(st, weeks) > y.to) return;      /* must fit inside the year */
      var p = logbookPeriod(db, st, weeks);
      if (!best || p.businessKm > best.businessKm) best = p;
    });

    /* Every start runs past the end of the year - use the latest that fits the
       data rather than returning nothing. */
    if (!best) {
      var st2 = Object.keys(starts).sort()[0];
      best = logbookPeriod(db, st2, weeks);
    }
    return best;
  }

  /* Business use needs the total the car did, business and private together.
     Only Liam knows that - it comes off the odometer - so it is asked for
     rather than guessed at. */
  function businessUse(period, totalKmInPeriod) {
    var total = parseFloat(totalKmInPeriod);
    if (!isFinite(total) || total <= 0) return null;
    if (!period || !(period.businessKm > 0)) return null;
    var pct = Math.min(100, period.businessKm / total * 100);
    return {
      businessKm: period.businessKm,
      totalKm: Math.round(total * 10) / 10,
      privateKm: Math.round((total - period.businessKm) * 10) / 10,
      pct: Math.round(pct * 10) / 10
    };
  }

  /* ---------- comparing the two ---------- */

  function compare(db, fy, opts) {
    opts = opts || {};
    var cpk = centsPerKmClaim(db, fy);
    var runningCosts = parseFloat(opts.runningCosts);
    var pct = parseFloat(opts.businessUsePct);

    var logbookAmount = null;
    if (isFinite(runningCosts) && runningCosts > 0 && isFinite(pct) && pct > 0) {
      logbookAmount = Math.round(runningCosts * (pct / 100) * 100) / 100;
    }

    var better = null;
    if (cpk.amount != null && logbookAmount != null) {
      better = logbookAmount > cpk.amount ? "logbook" : "centsPerKm";
    }

    return {
      centsPerKm: cpk,
      logbook: { runningCosts: isFinite(runningCosts) ? runningCosts : null,
                 pct: isFinite(pct) ? pct : null, amount: logbookAmount },
      better: better,
      difference: (cpk.amount != null && logbookAmount != null)
        ? Math.round(Math.abs(logbookAmount - cpk.amount) * 100) / 100 : null
    };
  }

  /* ---------- what to hand the accountant ---------- */

  function csv(list) {
    var rows = [["Date", "Customer", "Suburb", "Purpose", "Kilometres", "Recorded or estimated"]];
    list.forEach(function (t) {
      rows.push([t.date, t.customer, t.suburb, t.purpose, String(t.km),
                 t.estimated ? "estimated" : "recorded"]);
    });
    return rows.map(function (r) {
      return r.map(function (c) {
        var v = String(c == null ? "" : c);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(",");
    }).join("\r\n");
  }

  global.FNWCVehicle = {
    DEFAULTS: DEFAULTS,
    trips: trips,
    totalKm: totalKm,
    year: year,
    yearsWithTrips: yearsWithTrips,
    centsPerKmClaim: centsPerKmClaim,
    logbookPeriod: logbookPeriod,
    bestPeriod: bestPeriod,
    businessUse: businessUse,
    compare: compare,
    csv: csv,
    fyOf: fyOf,
    fyRange: fyRange,
    _iso: iso,
    _addDays: addDays
  };

})(typeof window !== "undefined" ? window : this);
