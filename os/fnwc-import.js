/* ===========================================================================
   FNWC Import - getting an existing customer list in without a Sunday
   afternoon of typing.

   The problem
   -----------
   Everything else here is worth exactly as much as what is in it, and the only
   way in was a form, one customer at a time. Eighty customers that way is
   three hours on a phone keyboard, which means it does not happen, which means
   the whole thing sits empty.

   What it takes
   -------------
   Whatever people actually have. A spreadsheet column pasted in, a CSV
   exported from somewhere, contacts copied off a phone, or a list typed into
   a notes app. It works out which column is which by looking at the data
   rather than demanding a particular order, and where it cannot tell, it says
   so rather than guessing and filing a phone number as a suburb.

   Nothing is written until it has been shown back
   -----------------------------------------------
   Import is the one operation that can quietly wreck a database, so this
   parses, matches against what is already there, and hands back a plan. The
   caller shows the plan and only then applies it. Anything that looks like an
   existing customer is an update, not a second copy of them.
   =========================================================================== */
(function (global) {
  "use strict";

  var FIELDS = ["name", "phone", "email", "suburb", "freqMonths", "notes"];

  /* Column names people actually use, lowercased. */
  var HEADERS = {
    name: /^(name|customer|client|full ?name|contact)$/,
    phone: /^(phone|mobile|mob|number|phone ?no|contact ?number|tel)$/,
    email: /^(e-?mail|email ?address)$/,
    suburb: /^(suburb|area|town|location|address|street|addr)$/,
    freqMonths: /^(repeat|frequency|every|cycle|repeat ?every.*|months?|interval)$/,
    notes: /^(notes?|comments?|details|what we do|job|remarks)$/
  };

  function str(v) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim(); }

  /* ---------- recognising a value by its shape ---------- */

  function looksLikePhone(v) {
    var digits = str(v).replace(/[^0-9]/g, "");
    if (digits.length < 8 || digits.length > 15) return false;
    /* Mostly digits, allowing the usual spaces, brackets and plus. */
    return /^[0-9 ()+\-]+$/.test(str(v));
  }
  function looksLikeEmail(v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str(v)); }
  function looksLikeMonths(v) {
    var s = str(v).toLowerCase();
    var m = /^(\d{1,2})\s*(m|mo|month|months)?$/.exec(s);
    if (!m) return false;
    var n = parseInt(m[1], 10);
    return n >= 1 && n <= 24;
  }
  /* A name has letters and is not obviously one of the other things. */
  function looksLikeName(v) {
    var s = str(v);
    if (!s || s.length < 2) return false;
    if (looksLikePhone(s) || looksLikeEmail(s)) return false;
    return /[A-Za-z]/.test(s);
  }

  /* ---------- splitting the text up ---------- */

  /* A CSV line, respecting quotes. Tabs are handled by the caller picking the
     delimiter, since a pasted spreadsheet column arrives tab separated. */
  function splitLine(line, delim) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (q) {
        if (ch === '"') {
          if (line.charAt(i + 1) === '"') { cur += '"'; i++; }
          else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(str);
  }

  /* Whichever separator appears most consistently is the one in use. */
  function pickDelimiter(lines) {
    var best = ",", bestScore = -1;
    [",", "\t", ";", "|"].forEach(function (d) {
      var counts = lines.slice(0, 20).map(function (l) { return splitLine(l, d).length; });
      var max = Math.max.apply(null, counts);
      if (max < 2) return;
      var consistent = counts.filter(function (c) { return c === max; }).length;
      var score = max * 10 + consistent;
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }

  /* ---------- working out which column is which ---------- */

  function headerMap(cells) {
    var map = {}, used = {};
    cells.forEach(function (cell, i) {
      var c = str(cell).toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z ?]/g, "").trim();
      Object.keys(HEADERS).forEach(function (f) {
        if (used[f]) return;
        if (HEADERS[f].test(c)) { map[i] = f; used[f] = 1; }
      });
    });
    return Object.keys(map).length ? map : null;
  }

  /* No header row, so judge each column by what is in it. */
  function shapeMap(rows) {
    var cols = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    var map = {}, used = {};
    var score = function (test) {
      return function (ci) {
        var hits = 0, seen = 0;
        rows.forEach(function (r) {
          var v = r[ci];
          if (!str(v)) return;
          seen++;
          if (test(v)) hits++;
        });
        return seen ? hits / seen : 0;
      };
    };

    /* Email, phone and a cycle in months are distinctive enough to find by
       shape wherever they sit, so those take the best-scoring column. */
    var byShape = [
      ["email", score(looksLikeEmail), 0.6],
      ["phone", score(looksLikePhone), 0.6],
      ["freqMonths", score(looksLikeMonths), 0.7]
    ];

    byShape.forEach(function (o) {
      var field = o[0], fn = o[1], need = o[2];
      var best = -1, bestScore = need;
      for (var ci = 0; ci < cols; ci++) {
        if (used[ci]) continue;
        var s = fn(ci);
        if (s > bestScore) { bestScore = s; best = ci; }
      }
      if (best >= 0) { map[best] = field; used[best] = 1; }
    });

    /* The name is different. A suburb looks exactly as much like a name as a
       name does, so picking whichever scores highest is a coin toss - and one
       stray phone number in the name column loses it the toss. Position is the
       far stronger signal: take the leftmost column that reads as names at
       all. */
    var nameScore = score(looksLikeName);
    for (var ci = 0; ci < cols; ci++) {
      if (used[ci]) continue;
      if (nameScore(ci) >= 0.6) { map[ci] = "name"; used[ci] = 1; break; }
    }

    /* Whatever is left over, in order: suburb then notes. The first unclaimed
       column after the name is far more often a suburb than anything else. */
    ["suburb", "notes"].forEach(function (f) {
      for (var ci = 0; ci < cols; ci++) {
        if (used[ci]) continue;
        map[ci] = f; used[ci] = 1;
        return;
      }
    });

    return map;
  }

  /* ---------- one row to one customer ---------- */

  function rowToCustomer(cells, map) {
    var c = {};
    Object.keys(map).forEach(function (i) {
      var f = map[i], v = str(cells[i]);
      if (!v) return;
      if (f === "freqMonths") {
        var m = /(\d{1,2})/.exec(v);
        var n = m ? parseInt(m[1], 10) : 0;
        c.freqMonths = (n >= 1 && n <= 24) ? n : 0;
      } else if (c[f]) {
        c[f] = c[f] + " " + v;             /* two columns of the same thing */
      } else c[f] = v;
    });

    /* A row whose "name" is plainly a phone number got mapped wrong - move it
       rather than creating a customer called 0412 345 678. */
    if (c.name && looksLikePhone(c.name) && !c.phone) { c.phone = c.name; delete c.name; }
    if (c.name && looksLikeEmail(c.name) && !c.email) { c.email = c.name; delete c.name; }

    return c;
  }

  /* ---------- parsing the lot ---------- */

  function parse(text, opts) {
    opts = opts || {};
    var lines = String(text == null ? "" : text)
      .split(/\r?\n/).map(function (l) { return l.replace(/\s+$/, ""); })
      .filter(function (l) { return l.trim().length; });

    if (!lines.length) return { rows: [], map: {}, delimiter: ",", hadHeader: false };

    var delim = opts.delimiter || pickDelimiter(lines);
    var cells = lines.map(function (l) { return splitLine(l, delim); });

    var map = null, hadHeader = false;
    if (opts.map) { map = opts.map; }
    else {
      map = headerMap(cells[0]);
      if (map) { hadHeader = true; cells = cells.slice(1); }
      else map = shapeMap(cells);
    }

    var rows = cells.map(function (r) { return rowToCustomer(r, map); })
                    .filter(function (c) { return c.name || c.phone || c.email; });

    return { rows: rows, map: map, delimiter: delim, hadHeader: hadHeader };
  }

  /* ---------- matching against what is already there --------------------
     Deciding two records are the same person is the part that does damage
     when it gets it wrong, so it only matches on things that are actually
     unique - a phone number or an email. A shared name is not enough; there
     is more than one Dave in Cairns.
     --------------------------------------------------------------------- */

  function digits(v) { return str(v).replace(/[^0-9]/g, "").replace(/^61/, "0"); }

  /* A name reduced to something comparable. Spreadsheets keep people as
     "Toomey, Dave" and phones keep the same person as "Dave Toomey", so the
     word order is thrown away along with the punctuation. */
  function nameKey(v) {
    return str(v).toLowerCase().replace(/[^a-z ]/g, " ")
      .split(/\s+/).filter(Boolean).sort().join(" ");
  }

  function findExisting(db, c) {
    var list = db.customers || [];
    var d = digits(c.phone);
    var e = str(c.email).toLowerCase();

    if (d.length >= 8) {
      var byPhone = list.filter(function (x) { return digits(x.phone) === d; })[0];
      if (byPhone) return { customer: byPhone, on: "phone" };
    }
    if (e) {
      var byEmail = list.filter(function (x) { return str(x.email).toLowerCase() === e; })[0];
      if (byEmail) return { customer: byEmail, on: "email" };
    }
    /* Same name and same suburb, with no contact details to tell them apart,
       is close enough to be worth flagging - but as a maybe, not a match. */
    var n = nameKey(c.name), s = str(c.suburb).toLowerCase();
    if (n && s) {
      var maybe = list.filter(function (x) {
        return nameKey(x.name) === n && str(x.suburb).toLowerCase() === s;
      })[0];
      if (maybe) return { customer: maybe, on: "name and suburb", unsure: true };
    }
    return null;
  }

  /* ---------- the plan ---------- */

  function plan(db, rows) {
    var out = { add: [], update: [], skip: [], seen: {} };

    rows.forEach(function (c, i) {
      if (!c.name) {
        out.skip.push({ row: i, customer: c, why: "no name" });
        return;
      }

      /* A duplicate inside the pasted list itself. */
      var key = digits(c.phone) || str(c.email).toLowerCase() || str(c.name).toLowerCase();
      if (out.seen[key]) {
        out.skip.push({ row: i, customer: c, why: "already in this list" });
        return;
      }
      out.seen[key] = 1;

      var hit = findExisting(db, c);
      if (hit) {
        /* Only fields that are actually new. Importing must never blank
           something already recorded. */
        var changes = {};
        FIELDS.forEach(function (f) {
          var incoming = c[f];
          if (incoming === undefined || incoming === "" || incoming === 0) return;
          var current = hit.customer[f];
          if (current === undefined || current === null || current === "" || current === 0) {
            changes[f] = incoming;
          }
        });
        if (Object.keys(changes).length) {
          out.update.push({ row: i, customer: c, existing: hit.customer,
                            matchedOn: hit.on, unsure: !!hit.unsure, changes: changes });
        } else {
          out.skip.push({ row: i, customer: c, why: "already have them, nothing new",
                          existing: hit.customer });
        }
        return;
      }

      out.add.push({ row: i, customer: c });
    });

    delete out.seen;
    out.total = rows.length;
    return out;
  }

  /* Applies a plan to the store handed in. The caller re-reads and saves, as
     everywhere else here. `choose` decides which entries to act on. */
  function apply(db, thePlan, uid, choose) {
    var want = choose || function () { return true; };
    var added = 0, updated = 0;
    db.customers = db.customers || [];

    thePlan.add.forEach(function (a) {
      if (!want(a, "add")) return;
      var c = { id: uid ? uid() : String(Math.random()).slice(2),
                name: "", phone: "", email: "", suburb: "", source: "Import",
                freqMonths: 0, notes: "" };
      FIELDS.forEach(function (f) { if (a.customer[f] !== undefined) c[f] = a.customer[f]; });
      db.customers.push(c);
      added++;
    });

    thePlan.update.forEach(function (u) {
      if (!want(u, "update")) return;
      var target = db.customers.filter(function (x) { return x.id === u.existing.id; })[0];
      if (!target) return;
      Object.keys(u.changes).forEach(function (f) { target[f] = u.changes[f]; });
      updated++;
    });

    return { added: added, updated: updated };
  }

  global.FNWCImport = {
    FIELDS: FIELDS,
    parse: parse,
    plan: plan,
    apply: apply,
    findExisting: findExisting,
    _splitLine: splitLine,
    _pickDelimiter: pickDelimiter,
    _headerMap: headerMap,
    _shapeMap: shapeMap,
    _looksLikePhone: looksLikePhone
  };

})(typeof window !== "undefined" ? window : this);
