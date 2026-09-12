/* ===========================================================================
   FNWC Geo - working out which jobs are near each other, and what order to do
   them in.

   Why this exists
   ---------------
   Jobs already record a suburb and a round-trip km figure, but nothing ever
   compared two of them. Booking Palm Cove and Gordonvale on the same day costs
   an hour and a half of driving you do not get paid for, and nothing in the
   system was in a position to notice.

   How it knows where anywhere is
   ------------------------------
   A table of Cairns-region suburbs with approximate centre points. They are
   good to a kilometre or so, which is far more than enough to answer the only
   question being asked: is this near that? Anything not in the table degrades
   quietly - it is listed as unplaced and you can put it in a zone yourself,
   which is kept in settings and used from then on.

   Driving times are estimates, not directions. This does not know about the
   Captain Cook being closed or school pickup on Sheridan Street. It is for
   ordering a day and spotting a silly one, not for promising a customer a
   time.
   =========================================================================== */
(function (global) {
  "use strict";

  /* Approximate suburb centres. Cairns and the usual run north and south.
     [lat, lon, zone] - lat is negative, this being the right hemisphere. */
  var SUBURBS = {
    /* Northern beaches */
    "palm cove":        [-16.7420, 145.6690, "Northern beaches"],
    "clifton beach":    [-16.7600, 145.6720, "Northern beaches"],
    "kewarra beach":    [-16.7760, 145.6870, "Northern beaches"],
    "trinity beach":    [-16.7880, 145.6960, "Northern beaches"],
    "trinity park":     [-16.8020, 145.6900, "Northern beaches"],
    "ellis beach":      [-16.7140, 145.6650, "Northern beaches"],
    "buchans point":    [-16.7280, 145.6650, "Northern beaches"],
    "yorkeys knob":     [-16.8150, 145.7210, "Northern beaches"],
    "holloways beach":  [-16.8390, 145.7380, "Northern beaches"],
    "machans beach":    [-16.8560, 145.7430, "Northern beaches"],
    "smithfield":       [-16.8280, 145.6950, "Northern beaches"],
    "caravonica":       [-16.8600, 145.6820, "Northern beaches"],

    /* Inner north */
    "stratford":        [-16.8790, 145.7280, "Inner north"],
    "freshwater":       [-16.8890, 145.7160, "Inner north"],
    "kamerunga":        [-16.8730, 145.7060, "Inner north"],
    "aeroglen":         [-16.8930, 145.7590, "Inner north"],
    "edge hill":        [-16.9000, 145.7520, "Inner north"],
    "whitfield":        [-16.9020, 145.7350, "Inner north"],

    /* City */
    "cairns city":      [-16.9186, 145.7781, "City"],
    "cairns":           [-16.9186, 145.7781, "City"],
    "cairns north":     [-16.9100, 145.7700, "City"],
    "parramatta park":  [-16.9230, 145.7660, "City"],
    "bungalow":         [-16.9320, 145.7550, "City"],
    "portsmith":        [-16.9430, 145.7680, "City"],
    "manunda":          [-16.9130, 145.7480, "City"],
    "manoora":          [-16.9060, 145.7350, "City"],
    "westcourt":        [-16.9280, 145.7460, "City"],

    /* West */
    "redlynch":         [-16.8830, 145.6930, "Western"],
    "brinsmead":        [-16.9020, 145.7130, "Western"],
    "kanimbla":         [-16.9100, 145.7080, "Western"],
    "mooroobool":       [-16.9230, 145.7250, "Western"],

    /* South */
    "earlville":        [-16.9420, 145.7280, "Southern"],
    "woree":            [-16.9560, 145.7370, "Southern"],
    "bayview heights":  [-16.9650, 145.7280, "Southern"],
    "white rock":       [-16.9760, 145.7460, "Southern"],
    "mount sheridan":   [-16.9860, 145.7280, "Southern"],
    "bentley park":     [-17.0080, 145.7340, "Southern"],
    "edmonton":         [-17.0150, 145.7430, "Southern"],
    "mount peter":      [-17.0300, 145.7300, "Southern"],
    "wrights creek":    [-17.0400, 145.7500, "Southern"],

    /* Far south. Zones here are meant to be one trip out and back, not a
       region on a map - Gordonvale and Innisfail are both "south" but they
       are nothing like the same day. */
    "gordonvale":       [-17.0950, 145.7830, "Far south"],
    "aloomba":          [-17.1200, 145.8400, "Far south"],
    "fishery falls":    [-17.1800, 145.8800, "Innisfail way"],
    "deeral":           [-17.2100, 145.9100, "Innisfail way"],
    "babinda":          [-17.3420, 145.9230, "Innisfail way"],
    "innisfail":        [-17.5230, 146.0290, "Innisfail way"],

    /* Up the range */
    "kuranda":          [-16.8190, 145.6380, "Kuranda way"],
    "speewah":          [-16.8400, 145.6100, "Kuranda way"],
    "koah":             [-16.8300, 145.5400, "Kuranda way"],
    "mareeba":          [-16.9980, 145.4190, "Tablelands"],
    "tolga":            [-17.2200, 145.4800, "Tablelands"],
    "atherton":         [-17.2680, 145.4770, "Tablelands"],
    "yungaburra":       [-17.2700, 145.5800, "Tablelands"],
    "malanda":          [-17.3500, 145.5900, "Tablelands"],
    "julatten":         [-16.6000, 145.3400, "Port Douglas run"],

    /* North to Port */
    "wangetti":         [-16.6700, 145.5700, "Port Douglas run"],
    "oak beach":        [-16.6200, 145.5200, "Port Douglas run"],
    "craiglie":         [-16.5100, 145.4600, "Port Douglas run"],
    "port douglas":     [-16.4840, 145.4650, "Port Douglas run"],
    "cooya beach":      [-16.4500, 145.3900, "Port Douglas run"],
    "newell beach":     [-16.4300, 145.4100, "Port Douglas run"],
    "mossman":          [-16.4610, 145.3720, "Port Douglas run"]
  };

  /* What people actually type. */
  var ALIASES = {
    "pt douglas": "port douglas", "port": "port douglas",
    "trinity bch": "trinity beach", "tbeach": "trinity beach",
    "yorkey's knob": "yorkeys knob", "yorkey knob": "yorkeys knob",
    "holloway's beach": "holloways beach", "holloway beach": "holloways beach",
    "machan's beach": "machans beach", "machan beach": "machans beach",
    "buchan's point": "buchans point",
    "mt sheridan": "mount sheridan", "mt peter": "mount peter",
    "cairns cbd": "cairns city", "city": "cairns city", "town": "cairns city",
    "nth cairns": "cairns north", "north cairns": "cairns north",
    "wright's creek": "wrights creek"
  };

  var DEFAULTS = {
    baseSuburb: "Cairns City",   /* where the day starts and ends */
    urbanKmh: 40,                /* around town, with lights */
    openKmh: 75                  /* once you are on a highway */
  };

  /* ---------- naming ---------- */

  function norm(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[.,]/g, " ")
      .replace(/\bqld\b|\bqueensland\b|\baustralia\b/g, " ")
      .replace(/\b\d{4}\b/g, " ")          /* a postcode typed on the end */
      .replace(/\s+/g, " ")
      .trim();
  }

  /* Custom places the user has placed themselves, kept in settings so they
     sync like everything else. */
  function extras(db) {
    var e = db && db.settings ? db.settings.extraSuburbs : null;
    return (e && typeof e === "object") ? e : {};
  }

  function lookup(name, db) {
    var n = norm(name);
    if (!n) return null;
    if (ALIASES[n]) n = ALIASES[n];

    var ex = extras(db);
    if (ex[n] && isFinite(ex[n][0]) && isFinite(ex[n][1])) {
      return { name: n, lat: ex[n][0], lon: ex[n][1], zone: ex[n][2] || "Yours", custom: true };
    }
    var s = SUBURBS[n];
    if (s) return { name: n, lat: s[0], lon: s[1], zone: s[2], custom: false };

    /* "Trinity Beach 4879" or "Palm Cove, Cairns" - take the longest known
       suburb name contained in what was typed, so the extra words do not stop
       it being recognised. It has to sit on word boundaries: a plain substring
       test makes "narnia2" match "narnia", which is how you end up quietly
       sending somebody to the wrong end of town. */
    function contains(hay, needle) {
      var i = hay.indexOf(needle);
      while (i !== -1) {
        var before = i === 0 ? " " : hay.charAt(i - 1);
        var after = i + needle.length >= hay.length ? " " : hay.charAt(i + needle.length);
        if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
        i = hay.indexOf(needle, i + 1);
      }
      return false;
    }

    var best = null;
    Object.keys(SUBURBS).forEach(function (k) {
      if (contains(n, k) && (!best || k.length > best.length)) best = k;
    });
    Object.keys(ex).forEach(function (k) {
      if (contains(n, k) && (!best || k.length > best.length)) best = k;
    });
    if (best) return lookup(best, db);
    return null;
  }

  function zoneOf(name, db) {
    var p = lookup(name, db);
    return p ? p.zone : null;
  }

  /* ---------- distance ----------------------------------------------------
     Straight line, then padded out, because roads are not straight and around
     here they are especially not - one road in and out of most places.
     --------------------------------------------------------------------- */

  function haversine(a, b) {
    var R = 6371;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLon = (b.lon - a.lon) * Math.PI / 180;
    var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /* 1.25 is the usual fudge between crow-flies and road distance in a town
     laid out along a coast with a range behind it. */
  function roadKm(a, b) { return Math.round(haversine(a, b) * 1.25 * 10) / 10; }

  function driveMinutes(km, db) {
    var s = settings(db);
    if (km <= 0) return 0;
    var urban = Math.min(km, 12);
    var open = Math.max(0, km - 12);
    return Math.round(2 + urban / s.urbanKmh * 60 + open / s.openKmh * 60);
  }

  function settings(db) {
    var s = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = db && db.settings ? db.settings[k] : undefined;
      s[k] = (v === undefined || v === null || v === "") ? DEFAULTS[k] : v;
    });
    return s;
  }

  function basePoint(db) {
    return lookup(settings(db).baseSuburb, db) || lookup(DEFAULTS.baseSuburb, db);
  }

  /* ---------- ordering a day ----------------------------------------------
     Nearest neighbour from base to get a sensible start, then 2-opt to undo
     the crossings it always leaves behind. For the handful of stops in a
     window cleaner's day this lands on the best route or within a whisker.
     --------------------------------------------------------------------- */

  function legKm(pts, order, base) {
    var total = 0, prev = base;
    for (var i = 0; i < order.length; i++) {
      total += roadKm(prev, pts[order[i]]);
      prev = pts[order[i]];
    }
    return Math.round((total + roadKm(prev, base)) * 10) / 10;   /* and home */
  }

  function orderStops(pts, base) {
    var n = pts.length;
    if (n <= 1) return pts.map(function (_, i) { return i; });

    var left = pts.map(function (_, i) { return i; });
    var order = [], cur = base;
    while (left.length) {
      var bi = 0, bd = Infinity;
      for (var i = 0; i < left.length; i++) {
        var d = roadKm(cur, pts[left[i]]);
        if (d < bd) { bd = d; bi = i; }
      }
      cur = pts[left[bi]];
      order.push(left[bi]);
      left.splice(bi, 1);
    }

    /* 2-opt: reverse any stretch that makes the loop shorter, until nothing
       does. n is tiny, so this costs nothing worth measuring. */
    var improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (var a = 0; a < order.length - 1; a++) {
        for (var b = a + 1; b < order.length; b++) {
          var trial = order.slice(0, a).concat(order.slice(a, b + 1).reverse(), order.slice(b + 1));
          if (legKm(pts, trial, base) < legKm(pts, order, base) - 0.05) {
            order = trial; improved = true;
          }
        }
      }
    }
    return order;
  }

  /* ---------- a day ---------- */

  function jobsOn(db, dateISO) {
    return (db.jobs || []).filter(function (j) {
      return j.date === dateISO && j.status !== "cancelled";
    });
  }

  function custOf(db, id) {
    return (db.customers || []).filter(function (c) { return c.id === id; })[0] || null;
  }

  function suburbOf(db, j) {
    if (j.suburb) return j.suburb;
    var c = custOf(db, j.customerId);
    return c ? c.suburb || "" : "";
  }

  /* Everything about one day: the order to do it in, what the driving costs,
     and whether the day as booked is silly. */
  function planDay(db, dateISO) {
    var jobs = jobsOn(db, dateISO);
    var base = basePoint(db);
    var placed = [], unplaced = [];

    jobs.forEach(function (j) {
      var p = lookup(suburbOf(db, j), db);
      if (p) placed.push({ job: j, point: p, customer: custOf(db, j.customerId) });
      else unplaced.push({ job: j, suburb: suburbOf(db, j), customer: custOf(db, j.customerId) });
    });

    var pts = placed.map(function (x) { return x.point; });
    var order = orderStops(pts, base);
    var best = placed.length ? legKm(pts, order, base) : 0;
    var asBooked = placed.length ? legKm(pts, pts.map(function (_, i) { return i; }), base) : 0;

    var stops = order.map(function (i, n) {
      var prev = n === 0 ? base : pts[order[n - 1]];
      var km = roadKm(prev, pts[i]);
      return {
        job: placed[i].job,
        customer: placed[i].customer,
        suburb: placed[i].point.name,
        zone: placed[i].point.zone,
        kmFromPrevious: km,
        minutesFromPrevious: driveMinutes(km, db)
      };
    });

    var homeKm = placed.length ? roadKm(pts[order[order.length - 1]], base) : 0;
    var driveMin = stops.reduce(function (a, s) { return a + s.minutesFromPrevious; }, 0) +
                   driveMinutes(homeKm, db);
    var workMin = jobs.reduce(function (a, j) { return a + (+j.actualMin || +j.estMin || 0); }, 0);
    var zones = {};
    stops.forEach(function (s) { zones[s.zone] = 1; });

    var fuel = +((db.settings || {}).fuelPerKm) || 0.28;

    return {
      date: dateISO,
      stops: stops,
      unplaced: unplaced,
      jobCount: jobs.length,
      km: best,
      kmAsBooked: asBooked,
      kmSaved: Math.round((asBooked - best) * 10) / 10,
      driveMinutes: driveMin,
      workMinutes: workMin,
      totalMinutes: driveMin + workMin,
      fuelCost: Math.round(best * fuel * 100) / 100,
      zones: Object.keys(zones),
      /* Two zones in a day is normal. Three, or a zone at each end of the
         map, is a day that will run long for no extra money. */
      scattered: Object.keys(zones).length >= 3 || best > 90,
      takings: jobs.reduce(function (a, j) { return a + (+j.price || 0); }, 0)
    };
  }

  /* ---------- where you are already going ---------------------------------
     The question worth answering while booking: am I near there any day soon
     anyway? Nothing saves more driving than putting the job on a day the ute
     is already pointed that way.
     --------------------------------------------------------------------- */

  function nearbyDays(db, suburb, fromISO, horizonDays) {
    var p = lookup(suburb, db);
    if (!p) return [];
    var base = basePoint(db);
    var from = fromISO || iso(new Date());
    /* A horizon of 0 is a real answer - "just today" - so it cannot be
       treated as "not supplied". */
    var horizon = (horizonDays == null) ? 21 : horizonDays;
    var byDate = {};

    (db.jobs || []).forEach(function (j) {
      if (j.status !== "scheduled") return;
      if (!j.date || j.date < from) return;
      var gap = daysBetween(from, j.date);
      if (gap == null || gap > horizon) return;
      var q = lookup(suburbOf(db, j), db);
      if (!q) return;
      var km = roadKm(p, q);
      if (!byDate[j.date] || km < byDate[j.date].km) {
        byDate[j.date] = { date: j.date, km: km, job: j, customer: custOf(db, j.customerId),
                           suburb: q.name, zone: q.zone, sameZone: q.zone === p.zone,
                           fromBase: roadKm(base, q) };
      }
    });

    /* What counts as "already up that way" depends on how far out the day
       goes. Another 20 km on a Port Douglas run is nothing; the same 20 km on
       a day spent around Edge Hill is a serious detour. So the allowance is a
       flat 15 km close to home, growing with the length of the trip. 15 is
       about twenty minutes around Cairns, and it stops pairs that really are
       one run - Edmonton and Gordonvale, say - falling just outside.

       Zone names deliberately do not decide this. Two places can share a zone
       and still be half an hour apart, and being told you are nearly there
       when you are not is worse than being told nothing. */
    return Object.keys(byDate).map(function (d) { return byDate[d]; })
      .filter(function (x) { return x.km <= Math.max(15, x.fromBase * 0.35); })
      .sort(function (a, b) { return a.km - b.km || a.date.localeCompare(b.date); });
  }

  /* Suburbs in the data that the table has never heard of, so they can be
     placed rather than silently ignored. */
  function unplacedSuburbs(db) {
    var seen = {};
    (db.jobs || []).forEach(function (j) {
      var s = suburbOf(db, j);
      if (s && !lookup(s, db)) seen[norm(s)] = (seen[norm(s)] || 0) + 1;
    });
    (db.customers || []).forEach(function (c) {
      if (c.suburb && !lookup(c.suburb, db)) seen[norm(c.suburb)] = (seen[norm(c.suburb)] || 0) + 1;
    });
    return Object.keys(seen).map(function (k) { return { suburb: k, count: seen[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
  }

  /* Put a suburb on the map by borrowing the position of one you know. */
  function placeSuburb(db, name, nearName) {
    var near = lookup(nearName, db);
    if (!near) return false;
    db.settings = db.settings || {};
    db.settings.extraSuburbs = db.settings.extraSuburbs || {};
    db.settings.extraSuburbs[norm(name)] = [near.lat, near.lon, near.zone];
    return true;
  }

  /* ---------- the run of upcoming days ---------- */

  function week(db, fromISO, count) {
    var from = fromISO || iso(new Date());
    var out = [];
    for (var i = 0; i < (count || 14); i++) {
      var d = addDays(from, i);
      var p = planDay(db, d);
      if (p.jobCount) out.push(p);
    }
    return out;
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

  global.FNWCGeo = {
    DEFAULTS: DEFAULTS,
    SUBURBS: SUBURBS,
    lookup: lookup,
    zoneOf: zoneOf,
    roadKm: roadKm,
    driveMinutes: driveMinutes,
    planDay: planDay,
    week: week,
    nearbyDays: nearbyDays,
    unplacedSuburbs: unplacedSuburbs,
    placeSuburb: placeSuburb,
    basePoint: basePoint,
    zones: function () {
      var z = {};
      Object.keys(SUBURBS).forEach(function (k) { z[SUBURBS[k][2]] = 1; });
      return Object.keys(z);
    },
    suburbNames: function () {
      return Object.keys(SUBURBS).sort();
    },
    _norm: norm,
    _iso: iso,
    _addDays: addDays
  };

})(typeof window !== "undefined" ? window : this);
