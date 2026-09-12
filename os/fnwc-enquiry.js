/* ===========================================================================
   FNWC Enquiry - an enquiry from the website, from the form on the page to a
   lead in Window OS.

   Why this is its own file
   ------------------------
   The same enquiry is handled in three places that must agree exactly: the
   public website builds one, Firestore carries it, and Window OS and the phone
   turn it into a lead. The old arrangement had the website writing labelled
   lines of text and Window OS parsing them back with a comment warning "keys
   must match the labels the website writes" - which is a rule no file could
   enforce. They live here now, once.

   What it changes about the old behaviour
   ---------------------------------------
   The form had no server, so it composed a message and handed it to the
   visitor to send from their own SMS or email app. That works, but it loses
   people: half of them never press send in the app that opens, and the ones
   who do arrive as a message Liam has to paste in by hand.

   It now posts straight into a quarantine collection. Nothing a stranger sends
   lands in the leads list on its own - it waits in an inbox until it is
   accepted, so the worst a spammer can do is waste one tap.

   Sending is deliberately unauthenticated, because the sender is a member of
   the public. What keeps that safe is the Firestore rule: create only, no
   reading, no changing, no deleting, and a strict shape. Reading the inbox
   needs Liam's sign-in.
   =========================================================================== */
(function (global) {
  "use strict";

  /* The whole shape of an enquiry, in one place. Anything not on this list is
     dropped before sending - partly to keep the Firestore rule simple, partly
     so a stray form field can never quietly become a data leak. */
  var FIELDS = ["name", "phone", "email", "suburb", "windows", "storeys", "sides", "notes"];

  var LIMITS = {
    name: 80, phone: 40, email: 120, suburb: 80,
    windows: 10, storeys: 20, sides: 30, notes: 1000
  };

  var RATE_FALLBACK = {
    minSingle: 150, minDouble: 250,
    single: { out: 9, both: 13 },
    two: { out: 12, both: 16 }
  };

  function str(v, cap) {
    var s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
    return cap ? s.slice(0, cap) : s;
  }

  /* ---------- shape ---------- */

  function clean(data) {
    var out = {};
    FIELDS.forEach(function (k) {
      var v = str((data || {})[k], LIMITS[k]);
      if (v) out[k] = v;
    });
    return out;
  }

  function validate(data) {
    var d = clean(data);
    var errors = [];
    if (!d.name || d.name.length < 2) errors.push(["name", "I need a name to put to it."]);

    /* A phone number or an email - one of the two, or there is no way back to
       them and the enquiry is worthless to both sides. */
    var phoneDigits = (d.phone || "").replace(/[^0-9]/g, "");
    var emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email || "");
    if (phoneDigits.length < 8 && !emailOk) {
      errors.push(["phone", "I need a phone number or an email so I can get back to you."]);
    }
    if (d.email && !emailOk) errors.push(["email", "That email address does not look right."]);

    return { ok: !errors.length, errors: errors, data: d };
  }

  /* ---------- the ballpark ------------------------------------------------
     The same sum the quote calculator does for a plain window count. It is a
     ballpark and says so - the real price comes from looking at the place.
     --------------------------------------------------------------------- */

  function rateFrom(quoterSettings) {
    var q = quoterSettings;
    if (!q) return { card: RATE_FALLBACK, live: false };
    var num = function (v, d) { return (typeof v === "number" && isFinite(v) && v >= 0) ? v : d; };
    return {
      live: true,
      card: {
        minSingle: num(q.minSingle, RATE_FALLBACK.minSingle),
        minDouble: num(q.minDouble, RATE_FALLBACK.minDouble),
        single: { out: num(q.stdOut, RATE_FALLBACK.single.out), both: num(q.stdBoth, RATE_FALLBACK.single.both) },
        two: { out: num(q.upOut, RATE_FALLBACK.two.out), both: num(q.upBoth, RATE_FALLBACK.two.both) }
      }
    };
  }

  function estimate(data, quoterSettings) {
    var d = clean(data);
    var card = rateFrom(quoterSettings).card;
    var wins = parseInt(d.windows, 10);
    if (!isFinite(wins) || wins < 1) return 0;
    var two = /two|2/i.test(d.storeys || "");
    var both = /inside|both/i.test(d.sides || "");
    var per = (two ? card.two : card.single)[both ? "both" : "out"];
    return Math.max(two ? card.minDouble : card.minSingle, wins * per);
  }

  /* ---------- the message ------------------------------------------------
     Still produced, because the SMS and email buttons are the fallback for
     when there is no signal or the send fails, and because a message that
     arrives by text can still be pasted in. Labels here are the parse keys.
     --------------------------------------------------------------------- */

  var LABELS = { name: "Name", phone: "Phone", email: "Email", suburb: "Suburb",
                 windows: "Windows", storeys: "Storeys", sides: "Sides", notes: "Notes" };

  function toMessage(data) {
    var d = clean(data);
    var L = ["Window cleaning enquiry"];
    FIELDS.forEach(function (k) { if (d[k]) L.push(LABELS[k] + ": " + d[k]); });
    return L.join("\n");
  }

  function fromMessage(text) {
    var f = {};
    String(text == null ? "" : text).split(/\r?\n/).forEach(function (line) {
      var m = /^\s*([A-Za-z ]+)\s*:\s*(.+?)\s*$/.exec(line);
      if (m) f[m[1].trim().toLowerCase()] = m[2].trim();
    });
    if (!f.name && !f.phone && !f.email) return null;
    return clean(f);
  }

  /* ---------- becoming a lead ---------- */

  function toLead(data, quoterSettings, todayISO, uid) {
    var d = clean(data);
    var value = estimate(d, quoterSettings);

    var bits = [];
    if (d.windows) bits.push(d.windows + " windows");
    if (d.storeys) bits.push(d.storeys.toLowerCase() + " storey");
    if (d.sides) bits.push(d.sides.toLowerCase());
    if (d.notes) bits.push(d.notes);

    return {
      id: uid ? uid() : (Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4)),
      name: d.name || "(no name given)",
      phone: d.phone || "",
      email: d.email || "",
      suburb: d.suburb || "",
      value: value,
      source: "Website",
      stage: "new",
      received: todayISO,
      lastContact: "",
      notes: bits.join(". "),
      estimated: value > 0
    };
  }

  /* ---------- sending -----------------------------------------------------
     Straight into the enquiries collection, unauthenticated, because whoever
     is filling this in is a stranger. The Firestore rule allows create and
     nothing else. Every caller must be ready for this to fail and fall back to
     the SMS and email buttons - a form that silently swallows an enquiry is
     worse than one that never had a server.
     --------------------------------------------------------------------- */

  function toFirestoreFields(d, extra) {
    var fields = {};
    Object.keys(d).forEach(function (k) { fields[k] = { stringValue: d[k] }; });
    Object.keys(extra || {}).forEach(function (k) {
      var v = extra[k];
      fields[k] = typeof v === "number" ? { integerValue: String(Math.round(v)) } : { stringValue: String(v) };
    });
    return fields;
  }

  function fromFirestoreDoc(doc) {
    if (!doc || !doc.fields) return null;
    var out = { _name: doc.name || "" };
    Object.keys(doc.fields).forEach(function (k) {
      var f = doc.fields[k];
      out[k] = f.stringValue !== undefined ? f.stringValue
             : f.integerValue !== undefined ? Number(f.integerValue)
             : f.doubleValue !== undefined ? Number(f.doubleValue)
             : "";
    });
    out.id = String(out._name).split("/").pop();
    return out;
  }

  function submit(cfg, data, opts) {
    opts = opts || {};
    var v = validate(data);
    if (!v.ok) return Promise.reject(new Error(v.errors[0][1]));
    if (!cfg || !cfg.apiKey || !cfg.projectId || /PASTE/i.test(cfg.apiKey)) {
      return Promise.reject(new Error("Not set up to send"));
    }

    var fields = toFirestoreFields(v.data, {
      estimate: opts.estimate || 0,
      sentAt: new Date().toISOString(),
      page: opts.page || ""
    });

    var url = "https://firestore.googleapis.com/v1/projects/" + cfg.projectId +
              "/databases/(default)/documents/enquiries?key=" + encodeURIComponent(cfg.apiKey);

    /* If the network hangs, the visitor should get the SMS fallback rather
       than a spinner, so the wait is deliberately short. */
    var timeout = opts.timeoutMs || 8000;
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; reject(new Error("Took too long to send")); }
      }, timeout);

      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: fields })
      }).then(function (r) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (!r.ok) { reject(new Error("Could not send (" + r.status + ")")); return; }
        resolve(true);
      })["catch"](function (e) {
        if (done) return;
        done = true; clearTimeout(timer);
        reject(e);
      });
    });
  }

  /* ---------- the inbox, on Liam's side ---------- */

  function list(sync) {
    if (!sync || !sync.authedFetch) return Promise.reject(new Error("Sync is not set up"));
    return sync.authedFetch("enquiries?pageSize=100").then(function (r) {
      if (r.status === 404) return [];
      if (!r.ok) throw new Error("Could not read the inbox (" + r.status + ")");
      return r.json();
    }).then(function (d) {
      var docs = (d && d.documents) || [];
      return docs.map(fromFirestoreDoc).filter(Boolean)
        .sort(function (a, b) { return String(b.sentAt || "").localeCompare(String(a.sentAt || "")); });
    });
  }

  function remove(sync, id) {
    if (!sync || !sync.authedFetch) return Promise.reject(new Error("Sync is not set up"));
    return sync.authedFetch("enquiries/" + encodeURIComponent(id), { method: "DELETE" })
      .then(function (r) {
        if (!r.ok && r.status !== 404) throw new Error("Could not remove it (" + r.status + ")");
        return true;
      });
  }

  /* Spam that got through the rules. Not clever, just the obvious shapes -
     anything caught here is hidden rather than deleted, so a false positive
     costs nothing. */
  function looksLikeJunk(e) {
    var blob = [e.name, e.suburb, e.notes].join(" ");
    if (/https?:\/\/|<a\s|\[url|\bseo\b|crypto|bitcoin|viagra/i.test(blob)) return true;
    if (/(.)\1{12,}/.test(blob)) return true;                 /* aaaaaaaaaaaaaa */
    if (!e.phone && !e.email) return true;
    return false;
  }

  global.FNWCEnquiry = {
    FIELDS: FIELDS,
    LIMITS: LIMITS,
    LABELS: LABELS,
    RATE_FALLBACK: RATE_FALLBACK,
    clean: clean,
    validate: validate,
    estimate: estimate,
    rateFrom: rateFrom,
    toMessage: toMessage,
    fromMessage: fromMessage,
    toLead: toLead,
    submit: submit,
    list: list,
    remove: remove,
    looksLikeJunk: looksLikeJunk,
    _fromFirestoreDoc: fromFirestoreDoc,
    _toFirestoreFields: toFirestoreFields
  };

})(typeof window !== "undefined" ? window : this);
