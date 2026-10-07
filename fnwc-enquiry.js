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
  /* `services` and `windows` carry what the quote form asks now; `storeys` and
     `sides` stay because older enquiries have them and the lead conversion
     still reads them. Nothing here is required except a name and a way to
     ring them back. */
  var FIELDS = ["name", "phone", "email", "suburb", "services", "windows",
                "storeys", "sides", "notes"];

  /* Where the visitor came from. Kept apart from the fields above because it
     is not something anybody typed - it is recorded about them, and it should
     never end up in a message addressed to the customer. */
  var TRACKING = ["utm_source", "utm_medium", "utm_campaign", "utm_content",
                  "utm_term", "referrer", "landingPage"];

  var LIMITS = {
    name: 80, phone: 40, email: 120, suburb: 80,
    services: 160, windows: 20, storeys: 20, sides: 30, notes: 1000,
    utm_source: 100, utm_medium: 100, utm_campaign: 150, utm_content: 150,
    utm_term: 150, referrer: 300, landingPage: 300
  };

  /* What the form offers, in the order it offers it. Here rather than in the
     page so the inbox can show the same words back. */
  var SERVICES = ["Outside windows", "Inside + outside", "Sliding doors",
                  "Screens", "Tracks", "Other"];

  /* Bands rather than an exact count, because nobody standing in their lounge
     room knows they have nineteen windows. The range is what a place that size
     usually comes to - indicative only, and the page says so. */
  var BANDS = [
    { id: "1-5",   label: "1 to 5",    low: 150, high: 200 },
    { id: "6-10",  label: "6 to 10",   low: 180, high: 280 },
    { id: "11-20", label: "11 to 20",  low: 260, high: 420 },
    { id: "21-30", label: "21 to 30",  low: 400, high: 600 },
    { id: "30+",   label: "More than 30", low: 550, high: 0 },
    { id: "?",     label: "Not sure",  low: 0,   high: 0 }
  ];

  function bandOf(id) {
    for (var i = 0; i < BANDS.length; i++) if (BANDS[i].id === id) return BANDS[i];
    return null;
  }

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

  /* ---------- where they came from ---------------------------------------
     Read once when the page loads and kept for the session, because a visitor
     who lands on an ad link, reads the FAQ, then comes back to the form has
     lost the query string by the time they submit. sessionStorage rather than
     localStorage: a different visit is a different campaign.
     --------------------------------------------------------------------- */

  var TRACK_KEY = "fnwc-src";

  function captureTracking(win) {
    win = win || (typeof window !== "undefined" ? window : null);
    if (!win) return {};
    var got = {};
    try {
      var q = new win.URLSearchParams(win.location.search);
      TRACKING.forEach(function (k) {
        if (k.indexOf("utm_") !== 0) return;
        var v = str(q.get(k), LIMITS[k]);
        if (v) got[k] = v;
      });
      /* Facebook's own click id is worth keeping even when the UTMs are
         missing, which happens when an ad links straight to the page. */
      var fbclid = str(q.get("fbclid"), 100);
      if (fbclid && !got.utm_source) { got.utm_source = "facebook"; got.utm_medium = "paid"; }
    } catch (e) {}

    var stored = {};
    try { stored = JSON.parse(win.sessionStorage.getItem(TRACK_KEY) || "{}") || {}; } catch (e) {}

    /* A fresh campaign on this visit replaces whatever was remembered. */
    var merged = Object.keys(got).length ? got : stored;

    if (!merged.landingPage) {
      try { merged.landingPage = str(stored.landingPage || win.location.href, LIMITS.landingPage); } catch (e) {}
    }
    if (!merged.referrer) {
      try {
        var r = stored.referrer || (win.document && win.document.referrer) || "";
        /* Our own pages are not a referrer worth recording. */
        if (r && r.indexOf(win.location.host) === -1) merged.referrer = str(r, LIMITS.referrer);
      } catch (e) {}
    }

    try { win.sessionStorage.setItem(TRACK_KEY, JSON.stringify(merged)); } catch (e) {}
    return merged;
  }

  function tracking(win) {
    win = win || (typeof window !== "undefined" ? window : null);
    if (!win) return {};
    try { return JSON.parse(win.sessionStorage.getItem(TRACK_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }

  function cleanTracking(data) {
    var out = {};
    TRACKING.forEach(function (k) {
      var v = str((data || {})[k], LIMITS[k]);
      if (v) out[k] = v;
    });
    return out;
  }

  /* A plain English summary of where a lead came from, for the inbox. */
  function sourceLabel(e) {
    if (!e) return "";
    if (e.utm_source) {
      var bits = [e.utm_source];
      if (e.utm_campaign) bits.push(e.utm_campaign);
      if (e.utm_content) bits.push(e.utm_content);
      return bits.join(" / ");
    }
    if (e.referrer) {
      try { return "via " + new URL(e.referrer).hostname.replace(/^www\./, ""); }
      catch (err) { return "via " + e.referrer; }
    }
    return "straight to the site";
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
    var two = /two|2|double|upstairs/i.test(d.storeys || "");
    var both = /inside/i.test(d.services || d.sides || "");
    var per = (two ? card.two : card.single)[both ? "both" : "out"];
    var floor = two ? card.minDouble : card.minSingle;

    /* An exact count, from the old form or somebody who typed one. */
    var wins = parseInt(d.windows, 10);
    if (isFinite(wins) && wins > 0 && String(d.windows).indexOf("-") === -1) {
      return Math.max(floor, wins * per);
    }

    /* Otherwise a band. The midpoint is what gets priced, so the single figure
       a lead carries is a fair middle rather than a flattering low end. */
    var band = bandOf(d.windows);
    if (!band || !band.low) return 0;
    var mid = band.high ? (band.low + band.high) / 2 : band.low;
    return Math.max(floor, Math.round(mid / 10) * 10);
  }

  /* The range to show a visitor. Deliberately a range - a single number reads
     as a promise, and the real price comes from looking at the place. */
  function estimateRange(data, quoterSettings) {
    var d = clean(data);
    var band = bandOf(d.windows);
    if (!band || !band.low) return null;
    var two = /two|2|double|upstairs/i.test(d.storeys || "");
    var both = /inside/i.test(d.services || d.sides || "");
    var card = rateFrom(quoterSettings).card;
    var floor = two ? card.minDouble : card.minSingle;

    /* Inside as well as out is most of the extra work, and upstairs needs the
       pole, so both lift the range rather than being ignored. */
    var lift = (both ? 1.35 : 1) * (two ? 1.3 : 1);
    var low = Math.max(floor, Math.round(band.low * lift / 10) * 10);
    var high = band.high ? Math.max(low + 40, Math.round(band.high * lift / 10) * 10) : 0;
    return { low: low, high: high, openEnded: !band.high };
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
    if (d.services) bits.push(d.services);
    if (d.windows) bits.push(d.windows + " windows");
    if (d.storeys) bits.push(d.storeys.toLowerCase() + " storey");
    if (d.sides) bits.push(d.sides.toLowerCase());
    if (d.notes) bits.push(d.notes);
    var src = sourceLabel(data);
    if (src && src !== "straight to the site") bits.push("From " + src);
    if (data && data.photos) bits.push("Photos attached");

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

    var extra = {
      estimate: opts.estimate || 0,
      sentAt: new Date().toISOString(),
      page: opts.page || ""
    };

    /* Where they came from, recorded alongside rather than inside the fields
       the customer filled in. */
    var track = cleanTracking(opts.tracking || tracking());
    Object.keys(track).forEach(function (k) { extra[k] = track[k]; });

    /* Photo links, if any were uploaded first. Stored as one string because a
       Firestore rule can check a string's length and cannot easily police an
       array of them. */
    if (opts.photos && opts.photos.length) {
      extra.photos = opts.photos.slice(0, 6).join(" ").slice(0, 1500);
    }

    var fields = toFirestoreFields(v.data, extra);

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

  /* ---------- photos ------------------------------------------------------
     Optional, and genuinely useful - a photo of the back of the house answers
     more than the window count ever will.

     These go to Firebase Storage, not Firestore, because a Firestore document
     tops out at a megabyte and a phone photo is several. Storage has to be
     switched on in the Firebase console with its own rule before any of this
     works; `storageReady` is how the page finds out, so an upload box is never
     shown to a customer when it cannot work.
     --------------------------------------------------------------------- */

  /* The bucket is never guessed from the project id. A bucket that does not
     exist answers exactly the same 404 as a file that does not exist inside
     one that does, so there is no way to probe for it - which means a guess
     would put an upload button in front of customers that silently fails.
     Storage is considered available only when the bucket has been written into
     the config by hand, which is the same moment it actually gets switched on.
     See SETUP-ENQUIRIES.md. */
  function bucketOf(cfg) {
    return (cfg && cfg.storageBucket) ? cfg.storageBucket : null;
  }

  function storageReady(cfg) {
    var bucket = bucketOf(cfg);
    var ok = !!(bucket && cfg.apiKey && !/PASTE/i.test(cfg.apiKey));
    return Promise.resolve(ok);
  }

  /* Squeezed hard before it leaves the phone. A customer on mobile data should
     not be uploading four megabytes, and the photo only has to be good enough
     to count windows and see how dirty they are. */
  function shrink(file, maxPx, quality) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) { reject(new Error("That is not an image")); return; }
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error("Could not read that file")); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error("Could not read that image")); };
        img.onload = function () {
          var w = img.width, h = img.height;
          var m = maxPx || 1400;
          if (w > m || h > m) { var s = Math.min(m / w, m / h); w = Math.round(w * s); h = Math.round(h * s); }
          var cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          cv.getContext("2d").drawImage(img, 0, 0, w, h);
          cv.toBlob(function (b) {
            b ? resolve(b) : reject(new Error("Could not shrink that image"));
          }, "image/jpeg", quality || 0.7);
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  function uploadPhoto(cfg, file, opts) {
    opts = opts || {};
    var bucket = bucketOf(cfg);
    if (!bucket) return Promise.reject(new Error("Photo uploads are not set up"));

    return shrink(file, opts.maxPx, opts.quality).then(function (blob) {
      if (blob.size > 3 * 1024 * 1024) throw new Error("That photo is too big");
      var name = "enquiries/" + Date.now() + "-" +
                 Math.random().toString(36).slice(2, 8) + ".jpg";
      var url = "https://firebasestorage.googleapis.com/v0/b/" + encodeURIComponent(bucket) +
                "/o?uploadType=media&name=" + encodeURIComponent(name);
      return fetch(url, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob })
        .then(function (r) {
          if (!r.ok) throw new Error("Could not upload that photo (" + r.status + ")");
          return r.json();
        }).then(function (d) {
          var token = d && d.downloadTokens ? d.downloadTokens.split(",")[0] : "";
          return "https://firebasestorage.googleapis.com/v0/b/" + bucket + "/o/" +
                 encodeURIComponent(name) + "?alt=media" + (token ? "&token=" + token : "");
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
    TRACKING: TRACKING,
    LIMITS: LIMITS,
    LABELS: LABELS,
    SERVICES: SERVICES,
    BANDS: BANDS,
    RATE_FALLBACK: RATE_FALLBACK,
    bandOf: bandOf,
    clean: clean,
    validate: validate,
    estimate: estimate,
    estimateRange: estimateRange,
    rateFrom: rateFrom,
    captureTracking: captureTracking,
    tracking: tracking,
    cleanTracking: cleanTracking,
    sourceLabel: sourceLabel,
    storageReady: storageReady,
    uploadPhoto: uploadPhoto,
    shrink: shrink,
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
