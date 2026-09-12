/* ===========================================================================
   FNWC Follow-ups - who to chase for another clean, and who to ask for a
   review.

   Why this is its own file
   ------------------------
   Both Window OS and the phone app need to agree on exactly who is due and
   who has already been pestered. Working that out twice would guarantee they
   drift, and the failure would be silent: the phone tells you to text someone
   the PC knows you texted on Tuesday. So the rules live here once, as plain
   functions with no DOM in sight, and both front ends read from them.

   What it fixes about the old behaviour
   -------------------------------------
   - Nothing used to record that you had asked. The priority list would keep
     telling you to book Sarah in until a job actually appeared, so if she
     said "not until March" you got nagged about it daily.
   - Reviews were tracked per job. A customer on a three month cycle got asked
     for a Google review four times a year, which is how you turn a happy
     customer into an annoyed one.
   - Nobody was excluded for already being in the diary. A customer booked in
     for next Tuesday still showed up as needing a rebook.

   Everything it writes is optional and additive. An older copy of the tools
   reading this data just ignores the new fields.
   =========================================================================== */
(function (global) {
  "use strict";

  var DEFAULTS = {
    dueSoon: 21,        /* surface a rebook this many days before it is due */
    atRisk: 1.6,        /* past this multiple of the cycle they are drifting */
    reviewAfter: 2,     /* days after the job before asking for a review */
    reviewWindow: 30,   /* stop asking once the job is this old */
    rebookQuiet: 14,    /* days to stay quiet after asking about a rebook */
    reviewQuiet: 180,   /* days before the same person may be asked again */
    reviewUrl: ""       /* the Google review link, set in Settings */
  };

  /* ---------- dates ---------- */

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

  function parse(s) {
    if (!s) return null;
    var d = new Date(String(s).slice(0, 10) + "T00:00:00");
    return isNaN(d) ? null : d;
  }

  /* Whole days from a to b. Both are snapped to midnight first so a job at
     8am and one at 4pm on the same day are not a day apart. */
  function daysBetween(a, b) {
    var x = parse(typeof a === "string" ? a : iso(a));
    var y = parse(typeof b === "string" ? b : iso(b));
    if (!x || !y) return null;
    return Math.round((y - x) / 86400000);
  }

  /* Adding months has to cope with the short ones: three months on from the
     31st of August is the 30th of November, not the 1st of December. */
  function addMonths(d, n) {
    var day = d.getDate();
    var out = new Date(d.getFullYear(), d.getMonth() + n, 1);
    var lastDay = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
    out.setDate(Math.min(day, lastDay));
    return out;
  }

  /* ---------- reading the store ---------- */

  function settings(db) {
    var s = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = db && db.settings ? db.settings[k] : undefined;
      s[k] = (v === undefined || v === null || v === "") ? DEFAULTS[k] : v;
    });
    return s;
  }

  function isFinished(j) { return j.status === "done" || j.status === "paid" || j.status === "invoiced"; }
  function isBooked(j) { return j.status === "scheduled"; }

  function jobsFor(db, cid) {
    return (db.jobs || []).filter(function (j) { return j.customerId === cid; });
  }

  /* Most recently finished job, or null. */
  function lastFinished(db, cid) {
    var js = jobsFor(db, cid).filter(isFinished)
      .sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
    return js[0] || null;
  }

  /* A job still to come. Someone already in the diary is not someone to chase. */
  function nextBooked(db, cid, today) {
    var js = jobsFor(db, cid).filter(function (j) {
      return isBooked(j) && String(j.date || "") >= today;
    }).sort(function (a, b) { return String(a.date || "").localeCompare(String(b.date || "")); });
    return js[0] || null;
  }

  function avgValue(db, cid) {
    var js = jobsFor(db, cid).filter(isFinished);
    if (!js.length) return 0;
    return js.reduce(function (s, j) { return s + (+j.price || 0); }, 0) / js.length;
  }

  /* ---------- rebooks -----------------------------------------------------
     A customer is due when their last finished job plus their cycle has come
     round. The states match the ones Window OS already used, so the two tools
     describe the same customer the same way.
     --------------------------------------------------------------------- */

  function dueState(db, c, today) {
    var s = settings(db);
    /* A cycle typed in as text gives NaN, and NaN slips past a plain "> 0"
       check - it would go on to produce an Invalid Date and a follow-up with
       no real due date on it. */
    var freq = parseFloat(c.freqMonths);
    if (!isFinite(freq) || freq <= 0) return { state: "none" };

    var last = lastFinished(db, c.id);
    if (!last || !parse(last.date)) return { state: "none" };

    var due = addMonths(parse(last.date), freq);
    var days = daysBetween(today, iso(due));       /* negative once overdue */
    if (days == null) return { state: "none" };
    var cycleDays = freq * 30;
    var overdueBy = -days;

    var state = overdueBy > cycleDays * (s.atRisk - 1) ? "atrisk"
              : days < 0 ? "overdue"
              : days <= s.dueSoon ? "soon"
              : "ok";

    return { state: state, days: days, dueISO: iso(due), lastJob: last };
  }

  /* Why this customer is not in the list. Kept as a reason rather than a
     silent filter, because "why is nobody due?" is a fair question to ask of
     a screen that is empty. */
  function rebookSkip(db, c, today, st) {
    var s = settings(db);
    if (c.rebookOff) return "you turned chasing off for them";
    if (c.rebookSnoozeUntil && String(c.rebookSnoozeUntil) > today) {
      return "snoozed until " + c.rebookSnoozeUntil;
    }
    var booked = nextBooked(db, c.id, today);
    if (booked) return "already booked in for " + booked.date;

    if (c.rebookAskedAt) {
      /* Asking again is fair once the quiet period is up - people forget, and
         a second nudge months later is not pestering. */
      var since = daysBetween(c.rebookAskedAt, today);
      if (since != null && since < s.rebookQuiet) {
        return "asked " + (since === 0 ? "today" : since + " day" + (since === 1 ? "" : "s") + " ago");
      }
    }
    return null;
  }

  function rebooks(db, today) {
    today = today || iso(new Date());
    var out = [];

    (db.customers || []).forEach(function (c) {
      var st = dueState(db, c, today);
      if (st.state === "none" || st.state === "ok") return;

      var skip = rebookSkip(db, c, today, st);
      if (skip) return;

      var value = avgValue(db, c.id);
      /* Roughly how likely the nudge lands. Someone a few days past due is a
         much better bet than someone who drifted off a year ago. */
      var chance = st.state === "atrisk" ? 0.25 : st.state === "overdue" ? 0.55 : 0.7;

      out.push({
        customer: c,
        state: st.state,
        days: st.days,
        dueISO: st.dueISO,
        lastJob: st.lastJob,
        value: value,
        expected: value * chance,
        message: rebookMessage(c, st, db),
        why: st.state === "atrisk"
          ? "Was on a " + c.freqMonths + " month cycle and is " + Math.abs(st.days) +
            " days past due. This far gone they usually need a reason to come back."
          : st.state === "overdue"
            ? "Due " + Math.abs(st.days) + " days ago. Repeat work is the cheapest revenue you have."
            : "Due in " + st.days + " days. Booking ahead is what keeps the week full."
      });
    });

    /* Most money first, but never let a big drifted-off job outrank someone
       who is due this week and will almost certainly say yes. */
    out.sort(function (a, b) { return b.expected - a.expected; });
    return out;
  }

  /* Everyone with a cycle who is not being chased, and the reason. */
  function rebookSkipped(db, today) {
    today = today || iso(new Date());
    var out = [];
    (db.customers || []).forEach(function (c) {
      var st = dueState(db, c, today);
      if (st.state === "none" || st.state === "ok") return;
      var skip = rebookSkip(db, c, today, st);
      if (skip) out.push({ customer: c, reason: skip, state: st.state, days: st.days });
    });
    return out;
  }

  /* ---------- reviews -----------------------------------------------------
     Asked once per customer, not once per job. Somebody who has you back four
     times a year should be asked once, not every time you pack up.
     --------------------------------------------------------------------- */

  /* The old tools set reviewAsked on the job itself. That history still
     counts, so it is read here rather than thrown away or migrated - nothing
     is rewritten on disk. */
  function alreadyAsked(db, c) {
    if (c.reviewState === "asked" || c.reviewState === "done" || c.reviewState === "off") return true;
    return jobsFor(db, c.id).some(function (j) { return !!j.reviewAsked; });
  }

  function reviews(db, today) {
    today = today || iso(new Date());
    var s = settings(db);
    var out = [];

    (db.customers || []).forEach(function (c) {
      if (c.reviewState === "done" || c.reviewState === "off") return;

      var last = lastFinished(db, c.id);
      if (!last) return;

      var age = daysBetween(last.date, today);
      if (age == null || age < s.reviewAfter) return;   /* still too fresh */
      if (age > s.reviewWindow) return;                 /* too long ago to bring up */

      /* Asked before, on an older job? Leave a decent gap before trying again,
         and only if they have had you back since. */
      if (alreadyAsked(db, c)) {
        var when = c.reviewAskedAt;
        if (!when) return;                              /* old per-job flag, no date - let it lie */
        var since = daysBetween(when, today);
        if (since == null || since < s.reviewQuiet) return;
        if (String(last.date) <= String(when)) return;  /* no new job since asking */
      }

      var finished = jobsFor(db, c.id).filter(isFinished).length;

      out.push({
        customer: c,
        job: last,
        days: age,
        jobCount: finished,
        repeat: finished > 1,
        message: reviewMessage(c, db),
        why: finished > 1
          ? "Had you back " + finished + " times, and finished " + age +
            " days ago. Repeat customers write the best reviews and rarely mind being asked."
          : "Finished " + age + " days ago. The ask works best while it is still fresh."
      });
    });

    /* Repeat customers first - they are the ones who will actually do it. */
    out.sort(function (a, b) {
      if (a.repeat !== b.repeat) return a.repeat ? -1 : 1;
      return a.days - b.days;
    });
    return out;
  }

  /* ---------- the messages ------------------------------------------------
     Drafts only. Nothing in here sends anything by itself - it fills in the
     text and you decide whether to send it.
     --------------------------------------------------------------------- */

  function firstName(c) {
    var n = String((c && c.name) || "").trim();
    if (!n) return "there";
    /* A business name is not a first name - "Hi Palm Cove Rentals" reads like
       a mail merge, which is exactly what it is. */
    if (/\b(pty|ltd|rentals?|property|properties|realty|real estate|group|services|management|holdings|body corporate|strata)\b/i.test(n)) return n;
    return n.split(/\s+/)[0];
  }

  function rebookMessage(c, st, db) {
    var name = firstName(c);
    if (st.state === "atrisk") {
      return "Hi " + name + ", Liam here from Far North Window Cleaning. It has been a fair while since " +
        "I last did your windows and I was thinking of you - the salt builds up quicker than people " +
        "expect up here. Want me to swing past and sort them out? Happy to do you a good price.";
    }
    if (st.state === "overdue") {
      return "Hi " + name + ", Liam from Far North Window Cleaning. You are about due for your next " +
        "clean. Want me to lock in a time this week or next? Cheers.";
    }
    return "Hi " + name + ", Liam from Far North Window Cleaning. You are coming up for your next " +
      "clean in a couple of weeks. Want me to pencil in a day now while I have got room? Cheers.";
  }

  function reviewMessage(c, db) {
    var s = settings(db);
    var name = firstName(c);
    var msg = "Hi " + name + ", Liam from Far North Window Cleaning. Really glad you are happy with " +
      "the windows. If you have got a spare minute, a quick Google review makes a massive difference " +
      "to a small local business like mine.";
    /* The link is most of the job. Without it they have to go and find you,
       and almost nobody does. */
    if (s.reviewUrl) msg += "\n\n" + s.reviewUrl;
    msg += "\n\nNo worries if not. Thanks again.";
    return msg;
  }

  /* ---------- recording what you did --------------------------------------
     These change the object you hand them and nothing else. Saving, and
     re-reading first so a sync cannot be trampled, is the caller's job.
     --------------------------------------------------------------------- */

  function find(list, id) {
    return (list || []).filter(function (x) { return x.id === id; })[0] || null;
  }

  function markRebookAsked(db, cid, today) {
    var c = find(db.customers, cid);
    if (!c) return false;
    c.rebookAskedAt = today || iso(new Date());
    delete c.rebookSnoozeUntil;
    return true;
  }

  function snoozeRebook(db, cid, days, today) {
    var c = find(db.customers, cid);
    if (!c) return false;
    var base = parse(today || iso(new Date()));
    base.setDate(base.getDate() + (+days || 30));
    c.rebookSnoozeUntil = iso(base);
    return true;
  }

  function stopRebook(db, cid, off) {
    var c = find(db.customers, cid);
    if (!c) return false;
    if (off === false) delete c.rebookOff; else c.rebookOff = true;
    return true;
  }

  function markReview(db, cid, state, today) {
    var c = find(db.customers, cid);
    if (!c) return false;
    c.reviewState = state;                    /* asked | done | off */
    if (state === "asked") c.reviewAskedAt = today || iso(new Date());
    return true;
  }

  /* ---------- the one-line summary both apps show ---------- */

  function summary(db, today) {
    today = today || iso(new Date());
    var r = rebooks(db, today), v = reviews(db, today);
    return {
      rebooks: r.length,
      reviews: v.length,
      total: r.length + v.length,
      /* What the rebook list is realistically worth, not its face value. */
      expected: Math.round(r.reduce(function (s, x) { return s + x.expected; }, 0)),
      faceValue: Math.round(r.reduce(function (s, x) { return s + x.value; }, 0)),
      overdue: r.filter(function (x) { return x.state === "overdue" || x.state === "atrisk"; }).length
    };
  }

  global.FNWCFollowUps = {
    DEFAULTS: DEFAULTS,
    rebooks: rebooks,
    rebookSkipped: rebookSkipped,
    reviews: reviews,
    summary: summary,
    dueState: dueState,
    markRebookAsked: markRebookAsked,
    snoozeRebook: snoozeRebook,
    stopRebook: stopRebook,
    markReview: markReview,
    rebookMessage: rebookMessage,
    reviewMessage: reviewMessage,
    firstName: firstName,
    _addMonths: addMonths,
    _iso: iso
  };

})(typeof window !== "undefined" ? window : this);
