/* ===========================================================================
   FNWC Money - what has not been invoiced, what has not been paid, and who
   needs chasing today.

   Why this is its own file
   ------------------------
   Same reason as fnwc-followups.js: the phone and the PC have to agree about
   who owes you money and who has already been reminded, or you end up texting
   somebody twice about the same invoice. The rules live here once.

   What it fixes about the old behaviour
   -------------------------------------
   - Window OS only chased jobs with the status "done". The moment you marked
     one "invoiced" it dropped out of the list entirely, so the jobs furthest
     along the process were the ones nothing was watching.
   - Nothing recorded when an invoice was actually issued. Lateness was
     measured from the day you did the work, which is not when the clock
     starts, so a job invoiced three weeks late looked three weeks overdue on
     the day it was sent.
   - There was no such thing as a due date, so "overdue" was a feeling rather
     than a fact.

   Old jobs carry none of the new fields. Rather than rewrite anything on disk,
   the reads below fall back to the job date, so history still behaves sensibly
   and nothing has to be migrated.
   =========================================================================== */
(function (global) {
  "use strict";

  var DEFAULTS = {
    invoiceTerms: 7,       /* days to pay */
    remindEvery: 7,        /* leave this long between reminders */
    chaseAfter: 0,         /* days past due before the first reminder */
    callAfter: 30,         /* past this, a text is not going to do it */
    invoicePrefix: "INV-"
  };

  /* ---------- dates ---------- */

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parse(s) {
    if (!s) return null;
    var d = new Date(String(s).slice(0, 10) + "T00:00:00");
    return isNaN(d) ? null : d;
  }
  function days(a, b) {
    var x = parse(a), y = parse(b);
    if (!x || !y) return null;
    return Math.round((y - x) / 86400000);
  }
  function addDays(isoStr, n) {
    var d = parse(isoStr);
    if (!d) return null;
    d.setDate(d.getDate() + n);
    return iso(d);
  }
  function today() { return iso(new Date()); }

  function settings(db) {
    var s = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = db && db.settings ? db.settings[k] : undefined;
      s[k] = (v === undefined || v === null || v === "") ? DEFAULTS[k] : v;
    });
    return s;
  }

  function money(n) { return Math.round((+n || 0) * 100) / 100; }
  function custOf(db, id) {
    return (db.customers || []).filter(function (c) { return c.id === id; })[0] || null;
  }

  /* ---------- reading a job ------------------------------------------------
     A job counts as invoiced if it says so, or if it is sitting in a status
     that only makes sense after an invoice went out. Legacy jobs have no
     invoicedAt, so the job date stands in - it is the best guess available and
     it is better than treating them as never invoiced at all.
     --------------------------------------------------------------------- */

  function isPaid(j) { return j.status === "paid"; }
  function isInvoiced(j) { return !!j.invoicedAt || j.status === "invoiced" || j.status === "paid"; }
  function isFinished(j) { return j.status === "done" || j.status === "invoiced" || j.status === "paid"; }

  function invoicedOn(j) { return j.invoicedAt || (j.status === "invoiced" || j.status === "paid" ? j.date : null); }

  function dueOn(db, j) {
    if (j.dueAt) return j.dueAt;
    var from = invoicedOn(j);
    if (!from) return null;
    return addDays(from, parseInt(settings(db).invoiceTerms, 10) || 0);
  }

  /* ---------- what still needs an invoice ---------- */

  function unbilled(db, t) {
    t = t || today();
    var out = [];
    (db.jobs || []).forEach(function (j) {
      if (j.status !== "done") return;       /* done, but nothing sent yet */
      if (isInvoiced(j)) return;
      if (!(+j.price > 0)) return;           /* nothing to invoice */
      var age = days(j.date, t);
      out.push({
        job: j,
        customer: custOf(db, j.customerId),
        amount: money(j.price),
        age: age == null ? 0 : age,
        why: age == null ? "Finished, not invoiced yet."
          : age === 0 ? "Finished today. Getting it out now is the single best thing you can do for the cash."
          : "Finished " + age + " day" + (age === 1 ? "" : "s") +
            " ago and still not invoiced. The clock does not start until you send it."
      });
    });
    out.sort(function (a, b) { return b.age - a.age || b.amount - a.amount; });
    return out;
  }

  /* ---------- what is owed ---------- */

  var STATES = ["awaiting", "due", "overdue", "serious", "call"];

  function outstanding(db, t) {
    t = t || today();
    var s = settings(db);
    var out = [];

    (db.jobs || []).forEach(function (j) {
      if (!isInvoiced(j) || isPaid(j)) return;
      if (j.status === "cancelled") return;

      var due = dueOn(db, j);
      var late = due ? days(due, t) : null;     /* positive once past due */
      var state = late == null ? "awaiting"
                : late >= s.callAfter ? "call"
                : late >= 14 ? "serious"
                : late > 0 ? "overdue"
                : late === 0 ? "due"
                : "awaiting";

      out.push({
        job: j,
        customer: custOf(db, j.customerId),
        amount: money(j.price),
        invoicedAt: invoicedOn(j),
        dueAt: due,
        late: late,
        state: state,
        invoiceNo: j.invoiceNo || null,
        remindedAt: j.remindedAt || null,
        reminders: +j.reminderCount || 0,
        why: state === "awaiting"
            ? (due ? "Due " + due + ". Nothing to do yet." : "Invoiced, but no due date recorded.")
          : state === "due" ? "Due today."
          : state === "call" ? "Over " + late + " days late. Texts have not worked - this one needs a phone call."
          : state === "serious" ? late + " days late. Worth being direct now."
          : late + " day" + (late === 1 ? "" : "s") + " late."
      });
    });

    /* Latest and largest first - that is the order you want to work them. */
    out.sort(function (a, b) {
      var al = a.late == null ? -9999 : a.late, bl = b.late == null ? -9999 : b.late;
      return bl - al || b.amount - a.amount;
    });
    return out;
  }

  /* ---------- who to chase today -----------------------------------------
     Being owed money is not the same as being due a reminder. Somebody
     reminded yesterday gets left alone; somebody a month late needs ringing,
     not texting again.
     --------------------------------------------------------------------- */

  function toChase(db, t) {
    t = t || today();
    var s = settings(db);
    return outstanding(db, t).filter(function (o) {
      if (o.late == null) return false;
      if (o.late < s.chaseAfter) return false;
      if (o.late < 0) return false;
      if (o.remindedAt) {
        var since = days(o.remindedAt, t);
        if (since != null && since < s.remindEvery) return false;
      }
      return true;
    }).map(function (o) {
      o.message = reminderMessage(db, o);
      o.byPhone = o.state === "call";
      return o;
    });
  }

  /* ---------- the messages ------------------------------------------------
     Drafts only, and they get firmer as the thing ages. The first one assumes
     it was missed, because it usually was. Nothing here is rude, because you
     have to work in this town afterwards.
     --------------------------------------------------------------------- */

  function firstName(c) {
    var n = String((c && c.name) || "").trim();
    if (!n) return "there";
    if (/\b(pty|ltd|rentals?|property|properties|realty|real estate|group|services|management|holdings|body corporate|strata)\b/i.test(n)) return n;
    return n.split(/\s+/)[0];
  }

  function niceMoney(n) {
    return "$" + (money(n)).toFixed(2).replace(/\.00$/, "");
  }

  var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
                "August", "September", "October", "November", "December"];

  /* These dates go into a text message to a customer, so "2026-09-01" will not
     do - it reads like a database rather than a person. */
  function niceDay(isoStr) {
    var d = parse(isoStr);
    if (!d) return null;
    var s = d.getDate() + " " + MONTHS[d.getMonth()];
    if (d.getFullYear() !== new Date().getFullYear()) s += " " + d.getFullYear();
    return s;
  }

  function payDetails(db) {
    var s = db && db.settings ? db.settings : {};
    var bits = [];
    if (s.accName) bits.push(s.accName);
    if (s.bsb) bits.push("BSB " + s.bsb);
    if (s.acc) bits.push("Acc " + s.acc);
    return bits.length ? bits.join("\n") : "";
  }

  function reminderMessage(db, o) {
    var name = firstName(o.customer);
    var amt = niceMoney(o.amount);
    var ref = o.invoiceNo ? " (" + o.invoiceNo + ")" : "";
    var bank = payDetails(db);
    var L = [];

    if (o.state === "due" || o.late <= 0) {
      L.push("Hi " + name + ", Liam from Far North Window Cleaning. Just a heads up that the invoice for " +
             amt + ref + " is due today. No rush if it is already on its way.");
    } else if (o.late < 14) {
      L.push("Hi " + name + ", Liam from Far North Window Cleaning. Just a friendly reminder about the " +
             amt + ref + " invoice - it was due on " + (niceDay(o.dueAt) || "recently") +
             ". Easily missed, so no stress at all, but if you could sort it when you get a minute that would be great.");
    } else if (o.state === "serious") {
      L.push("Hi " + name + ", Liam from Far North Window Cleaning. The invoice for " + amt + ref +
             " is now " + o.late + " days overdue. I am a one man operation so it does make a difference. " +
             "Could you let me know when it will be paid, or give me a call if there is a problem with it?");
    } else {
      L.push("Hi " + name + ", Liam from Far North Window Cleaning. The " + amt + ref +
             " invoice is now " + o.late + " days overdue and I have not heard back. " +
             "Can you give me a ring so we can sort it out? Happy to work something out if money is tight - " +
             "I just need to know where I stand.");
    }

    if (bank) { L.push(""); L.push(bank); }
    return L.join("\n");
  }

  /* ---------- invoice numbers ---------------------------------------------
     Carries on from whatever is already in the store, so numbering does not
     restart if this runs on a second device.
     --------------------------------------------------------------------- */

  function nextInvoiceNo(db) {
    var s = settings(db);
    var prefix = s.invoicePrefix || "";
    var top = 0;
    (db.jobs || []).forEach(function (j) {
      if (!j.invoiceNo) return;
      var m = String(j.invoiceNo).match(/(\d+)\s*$/);
      if (m) top = Math.max(top, parseInt(m[1], 10) || 0);
    });
    var n = top + 1;
    return prefix + (n < 1000 ? ("000" + n).slice(-4) : String(n));
  }

  /* ---------- recording what happened --------------------------------------
     These change the object handed to them and nothing else. Re-reading the
     store first and saving afterwards is the caller's job, same as everywhere
     else here.
     --------------------------------------------------------------------- */

  function findJob(db, id) {
    return (db.jobs || []).filter(function (j) { return j.id === id; })[0] || null;
  }

  function markInvoiced(db, jobId, t, no) {
    var j = findJob(db, jobId);
    if (!j) return null;
    t = t || today();
    /* Issuing twice would renumber it and restart the clock, which is how you
       end up chasing somebody for an invoice they already paid. */
    if (!j.invoicedAt) {
      j.invoicedAt = t;
      j.invoiceNo = no || j.invoiceNo || nextInvoiceNo(db);
      j.dueAt = addDays(t, parseInt(settings(db).invoiceTerms, 10) || 0);
    }
    if (j.status === "done") j.status = "invoiced";
    return j;
  }

  function markPaid(db, jobId, t) {
    var j = findJob(db, jobId);
    if (!j) return null;
    j.status = "paid";
    j.paidAt = t || today();
    return j;
  }

  function markReminded(db, jobId, t) {
    var j = findJob(db, jobId);
    if (!j) return null;
    j.remindedAt = t || today();
    j.reminderCount = (+j.reminderCount || 0) + 1;
    return j;
  }

  /* ---------- the figures both apps show ---------- */

  function summary(db, t) {
    t = t || today();
    var ub = unbilled(db, t), os = outstanding(db, t), ch = toChase(db, t);
    var sum = function (list) { return money(list.reduce(function (a, x) { return a + x.amount; }, 0)); };
    var late = os.filter(function (o) { return o.late != null && o.late > 0; });

    /* How long people actually take to pay, from the jobs that have been.
       Worth knowing before you agree to 30 day terms with anyone. */
    var paid = (db.jobs || []).filter(function (j) {
      return isPaid(j) && j.paidAt && invoicedOn(j);
    });
    var avg = null;
    if (paid.length) {
      var tot = paid.reduce(function (a, j) {
        var d = days(invoicedOn(j), j.paidAt);
        return a + (d == null || d < 0 ? 0 : d);
      }, 0);
      avg = Math.round(tot / paid.length);
    }

    return {
      unbilled: ub.length, unbilledValue: sum(ub),
      outstanding: os.length, owed: sum(os),
      overdue: late.length, overdueValue: sum(late),
      toChase: ch.length,
      /* Everything earned but not yet in the bank. */
      atStake: money(sum(ub) + sum(os)),
      avgDaysToPay: avg,
      oldest: late.length ? late[0].late : null
    };
  }

  global.FNWCMoney = {
    DEFAULTS: DEFAULTS,
    STATES: STATES,
    unbilled: unbilled,
    outstanding: outstanding,
    toChase: toChase,
    summary: summary,
    nextInvoiceNo: nextInvoiceNo,
    markInvoiced: markInvoiced,
    markPaid: markPaid,
    markReminded: markReminded,
    reminderMessage: reminderMessage,
    dueOn: dueOn,
    invoicedOn: invoicedOn,
    isInvoiced: isInvoiced,
    isFinished: isFinished,
    firstName: firstName,
    _iso: iso,
    _addDays: addDays
  };

})(typeof window !== "undefined" ? window : this);
