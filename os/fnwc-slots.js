/* ===========================================================================
   FNWC Slots - what time of day a job is booked for.

   Why slots rather than a clock time
   ----------------------------------
   Standing at somebody's door you do not say "10:40". You say "Tuesday
   morning" or "first thing Wednesday", because you cannot know how the job
   before it will run. A window cleaner's day is a handful of blocks, not a
   calendar full of appointments, so that is what this books - with an exact
   time available for the ones that genuinely need it, like a real estate
   inspection or a shop that opens at nine.

   What it is for beyond writing it down
   -------------------------------------
   Once a job has a time on it, three things become possible that were not.
   The diary can run in the order you will actually do it. Route planning
   stops being free to reorder a morning job into the afternoon. And booking
   on the doorstep can tell you the morning is already full before you promise
   it to somebody.
   =========================================================================== */
(function (global) {
  "use strict";

  /* Blocks, not appointments. They do not overlap, and they add up to a day
     that ends at a reasonable hour. */
  var SLOTS = [
    { id: "early",   label: "First up",   short: "1st",   from: "07:00", to: "09:00" },
    { id: "morning", label: "Morning",    short: "AM",    from: "09:00", to: "12:00" },
    { id: "midday",  label: "Midday",     short: "Noon",  from: "12:00", to: "13:00" },
    { id: "arvo",    label: "Afternoon",  short: "PM",    from: "13:00", to: "16:00" },
    { id: "late",    label: "Late arvo",  short: "Late",  from: "16:00", to: "18:00" }
  ];

  var ANY = { id: "", label: "Anytime", short: "", from: "", to: "" };

  function bySlotId(id) {
    for (var i = 0; i < SLOTS.length; i++) if (SLOTS[i].id === id) return SLOTS[i];
    return null;
  }

  /* ---------- reading a job ---------- */

  function minutesOf(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
    if (!m) return null;
    var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
    return h * 60 + mi;
  }

  function fmtTime(hhmm) {
    var mins = minutesOf(hhmm);
    if (mins == null) return "";
    var h = Math.floor(mins / 60), mi = mins % 60;
    var ampm = h >= 12 ? "pm" : "am";
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + (mi ? ":" + (mi < 10 ? "0" : "") + mi : "") + ampm;
  }

  /* An exact time beats a slot, because it was chosen deliberately. */
  function labelOf(job) {
    if (!job) return "";
    if (job.time) return fmtTime(job.time);
    var s = bySlotId(job.slot);
    return s ? s.label : "";
  }

  function shortOf(job) {
    if (!job) return "";
    if (job.time) return fmtTime(job.time);
    var s = bySlotId(job.slot);
    return s ? s.short : "";
  }

  /* Where a job sits in the running order of a day. Anything with no time on
     it goes last, because a job you have not promised a time for is the one
     you move when the day slips. */
  function sortKey(job) {
    if (!job) return 9999;
    var t = minutesOf(job.time);
    if (t != null) return t;
    var s = bySlotId(job.slot);
    if (s) return minutesOf(s.from);
    return 9999;
  }

  function sortJobs(jobs) {
    return (jobs || []).slice().sort(function (a, b) {
      var d = sortKey(a) - sortKey(b);
      if (d) return d;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
  }

  /* Jobs that share a time bucket can be reordered freely between themselves;
     jobs in different buckets cannot. This is what route planning needs. */
  function bucketOf(job) {
    var k = sortKey(job);
    return k === 9999 ? 9999 : Math.floor(k / 60) * 60;
  }

  /* ---------- how full a day is ------------------------------------------
     Work time plus the driving, because an hour of driving fills the morning
     just as effectively as an hour on the tools.
     --------------------------------------------------------------------- */

  function jobMinutes(db, j) {
    var work = parseInt(j.actualMin, 10);
    if (!isFinite(work) || work <= 0) work = parseInt(j.estMin, 10) || 0;
    var travel = parseInt(j.travelMin, 10);
    if (!isFinite(travel)) travel = parseInt((db.settings || {}).travelDefault, 10) || 0;
    return work + travel;
  }

  function onDay(db, dateISO) {
    return (db.jobs || []).filter(function (j) {
      return j.date === dateISO && j.status !== "cancelled";
    });
  }

  function slotLoad(db, dateISO, excludeJobId) {
    var out = {};
    SLOTS.forEach(function (s) { out[s.id] = { minutes: 0, jobs: [] }; });
    out[""] = { minutes: 0, jobs: [] };

    onDay(db, dateISO).forEach(function (j) {
      if (excludeJobId && j.id === excludeJobId) return;
      var id = bySlotId(j.slot) ? j.slot : "";
      /* A job with an exact time is counted against the block it falls in. */
      if (!id && j.time) {
        var t = minutesOf(j.time);
        SLOTS.forEach(function (s) {
          if (t != null && t >= minutesOf(s.from) && t < minutesOf(s.to)) id = s.id;
        });
      }
      out[id].minutes += jobMinutes(db, j);
      out[id].jobs.push(j);
    });
    return out;
  }

  function slotCapacity(slot) {
    var a = minutesOf(slot.from), b = minutesOf(slot.to);
    return (a == null || b == null) ? 0 : b - a;
  }

  /* ---------- booking on the doorstep -------------------------------------
     The question worth answering while somebody is standing in front of you:
     can I actually do this then, or am I about to promise a morning that is
     already gone?
     --------------------------------------------------------------------- */

  function check(db, dateISO, slotId, estMin, excludeJobId) {
    var load = slotLoad(db, dateISO, excludeJobId);
    var slot = bySlotId(slotId);
    var adding = parseInt(estMin, 10) || 0;

    if (!slot) {
      var day = 0;
      Object.keys(load).forEach(function (k) { day += load[k].minutes; });
      var perDay = (parseFloat((db.settings || {}).hoursPerDay) || 7) * 60;
      return {
        slot: null, ok: day + adding <= perDay,
        booked: day, adding: adding, capacity: perDay,
        jobs: [],
        message: day + adding > perDay
          ? "That day is already about " + Math.round(day / 60 * 10) / 10 + " hours."
          : ""
      };
    }

    var here = load[slot.id];
    var cap = slotCapacity(slot);
    var after = here.minutes + adding;

    return {
      slot: slot,
      ok: after <= cap,
      booked: here.minutes,
      adding: adding,
      capacity: cap,
      jobs: here.jobs,
      message: !here.jobs.length ? ""
        : after > cap
          ? slot.label + " is already " + Math.round(here.minutes / 60 * 10) / 10 +
            " hours with " + here.jobs.length + " job" + (here.jobs.length === 1 ? "" : "s") +
            ". Adding this would not fit."
          : here.jobs.length + " job" + (here.jobs.length === 1 ? "" : "s") +
            " already booked that " + slot.label.toLowerCase() + "."
    };
  }

  /* The next block on that day with room in it, for suggesting an alternative
     rather than just saying no. */
  function firstFree(db, dateISO, estMin, excludeJobId) {
    for (var i = 0; i < SLOTS.length; i++) {
      var c = check(db, dateISO, SLOTS[i].id, estMin, excludeJobId);
      if (c.ok) return SLOTS[i];
    }
    return null;
  }

  /* ---------- the running order ---------- */

  function dayOrder(db, dateISO) {
    return sortJobs(onDay(db, dateISO));
  }

  global.FNWCSlots = {
    SLOTS: SLOTS,
    ANY: ANY,
    bySlotId: bySlotId,
    labelOf: labelOf,
    shortOf: shortOf,
    sortKey: sortKey,
    sortJobs: sortJobs,
    bucketOf: bucketOf,
    slotLoad: slotLoad,
    slotCapacity: slotCapacity,
    jobMinutes: jobMinutes,
    check: check,
    firstFree: firstFree,
    dayOrder: dayOrder,
    fmtTime: fmtTime,
    _minutesOf: minutesOf
  };

})(typeof window !== "undefined" ? window : this);
