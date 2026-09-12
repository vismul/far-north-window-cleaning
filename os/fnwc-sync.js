/* ===========================================================================
   FNWC Sync - keeps the phone and the PC holding the same data.

   Why this exists
   ---------------
   Every tool here keeps its data in localStorage. localStorage is tied to one
   browser on one device, so the phone and the PC were two separate businesses
   that happened to look alike. This file is the bit in the middle.

   How it works
   ------------
   Firestore holds one document per storage key. Each device polls it every few
   seconds, does a proper three-way merge against the last state it agreed on,
   writes the result back to both sides, and tells the page to redraw. Because
   the merge is three-way it knows the difference between "the other device
   added this" and "I deleted this" - a plain union would resurrect everything
   you ever deleted.

   It talks to the Firestore REST API with fetch() rather than the Firebase
   SDK. The SDK assumes a real web origin; these tools are opened straight from
   the Downloads folder, where the origin is "null" and half the SDK falls
   over. REST does not care.

   Nothing here blocks the app. If the network is down, or sync was never set
   up, every tool carries on exactly as it did before, writing to localStorage.
   Sync catches up when it can.
   =========================================================================== */
(function (global) {
  "use strict";

  if (global.FNWCSync) return;

  /* Keys we look after, and which of their fields are lists of records.
     A list is merged record by record; everything else is merged whole. */
  var SPEC = {
    "fnwc-os-v1":      ["leads", "jobs", "customers", "expenses"],
    "fnwc-quoter-v2":  [],
    "fnwc-invoice-v1": []
  };

  var POLL_MS = 4000;          /* how often we look for the other device */
  var POLL_IDLE_MS = 20000;    /* ... once the tab has been in the background */
  var AUTH_KEY = "fnwc-sync-auth";
  var DEV_KEY = "fnwc-sync-device";

  /* ---------- small helpers ---------- */

  function j(v) { try { return JSON.stringify(v); } catch (e) { return null; } }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function same(a, b) { return j(a) === j(b); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  var deviceId = lsGet(DEV_KEY);
  if (!deviceId) {
    deviceId = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    lsSet(DEV_KEY, deviceId);
  }

  /* ---------- the three-way merge ----------------------------------------
     base   what both devices last agreed on
     mine   what this device has now
     theirs what the server has now

     A field only one side touched takes that side's value. A field both sides
     touched takes mine - the device you are actually looking at wins, which is
     the least surprising outcome when you are the only person here.
     --------------------------------------------------------------------- */

  function mergeValue(base, mine, theirs) {
    var iMoved = !same(base, mine);
    var theyMoved = !same(base, theirs);
    if (iMoved && !theyMoved) return clone(mine);
    if (theyMoved && !iMoved) return clone(theirs);
    return clone(mine);                      /* both moved, or neither did */
  }

  /* When both devices touched the same record, merging the whole thing in
     one lump means the loser's change vanishes - edit a phone number on the
     PC while the phone snoozes that same customer, and the snooze is gone.
     Going field by field keeps both, and only a genuine clash on the same
     field falls back to "the device you are on wins". */
  function mergeRecord(base, mine, theirs) {
    if (typeof mine !== "object" || mine === null || Array.isArray(mine)) {
      return mergeValue(base, mine, theirs);
    }
    if (typeof theirs !== "object" || theirs === null || Array.isArray(theirs)) {
      return mergeValue(base, mine, theirs);
    }
    var out = {}, keys = {};
    [base || {}, mine, theirs].forEach(function (o) {
      Object.keys(o).forEach(function (k) { keys[k] = 1; });
    });
    Object.keys(keys).forEach(function (k) {
      var v = mergeValue((base || {})[k], mine[k], theirs[k]);
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  function indexById(list) {
    var m = {};
    (list || []).forEach(function (r) {
      if (r && r.id != null) m[String(r.id)] = r;
    });
    return m;
  }

  /* Merges one list of records. Order follows mine first, so the list does not
     reshuffle under you, then anything new from the other device is appended. */
  function mergeList(base, mine, theirs) {
    var B = indexById(base), M = indexById(mine), T = indexById(theirs);
    var out = [], seen = {};

    function decide(id) {
      var b = B[id], m = M[id], t = T[id];
      var hadIt = b !== undefined;
      var iHaveIt = m !== undefined, theyHaveIt = t !== undefined;

      if (hadIt && !iHaveIt) return undefined;        /* I deleted it */
      if (hadIt && !theyHaveIt) return undefined;     /* they deleted it */
      if (!iHaveIt && !theyHaveIt) return undefined;

      if (!hadIt) {
        /* New on one or both sides. Mine wins a genuine clash of ids, which
           only happens if two devices minted the same id - vanishingly rare. */
        return clone(iHaveIt ? m : t);
      }
      return mergeRecord(b, m, t);
    }

    (mine || []).forEach(function (r) {
      if (!r || r.id == null) { out.push(clone(r)); return; }
      var id = String(r.id);
      if (seen[id]) return;
      seen[id] = 1;
      var v = decide(id);
      if (v !== undefined) out.push(v);
    });

    (theirs || []).forEach(function (r) {
      if (!r || r.id == null) return;
      var id = String(r.id);
      if (seen[id]) return;
      seen[id] = 1;
      var v = decide(id);
      if (v !== undefined) out.push(v);
    });

    return out;
  }

  function mergeDoc(key, base, mine, theirs) {
    var lists = SPEC[key] || [];
    base = base || {}; mine = mine || {}; theirs = theirs || {};
    var out = {}, keys = {};

    [base, mine, theirs].forEach(function (o) {
      Object.keys(o || {}).forEach(function (k) { keys[k] = 1; });
    });

    Object.keys(keys).forEach(function (k) {
      if (lists.indexOf(k) !== -1) {
        out[k] = mergeList(base[k], mine[k], theirs[k]);
      } else {
        var v = mergeValue(base[k], mine[k], theirs[k]);
        if (v !== undefined) out[k] = v;
      }
    });
    return out;
  }

  /* ---------- auth -------------------------------------------------------
     One Firebase account, signed in once per device. We keep the refresh
     token only; the short-lived id token is fetched as needed and is never
     written to disk. The password is never stored anywhere.
     --------------------------------------------------------------------- */

  var cfg = global.FNWC_FIREBASE || null;
  var idToken = null, idTokenExp = 0;

  function configured() {
    return !!(cfg && cfg.apiKey && cfg.projectId && !/PASTE/i.test(cfg.apiKey));
  }

  function authState() {
    try { return JSON.parse(lsGet(AUTH_KEY) || "null"); } catch (e) { return null; }
  }
  function setAuthState(v) { v ? lsSet(AUTH_KEY, j(v)) : lsDel(AUTH_KEY); }

  function friendlyAuthError(code) {
    if (/EMAIL_NOT_FOUND|INVALID_PASSWORD|INVALID_LOGIN_CREDENTIALS/.test(code)) {
      return "That email and password did not match.";
    }
    if (/TOO_MANY_ATTEMPTS/.test(code)) return "Too many tries. Wait a few minutes.";
    if (/USER_DISABLED/.test(code)) return "That account has been disabled.";
    if (/API_KEY|INVALID_ARGUMENT/.test(code)) return "The Firebase key in fnwc-firebase-config.js looks wrong.";
    return code;
  }

  function signIn(email, password) {
    var url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" +
              encodeURIComponent(cfg.apiKey);
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: j({ email: email, password: password, returnSecureToken: true })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.idToken) {
        throw new Error(d && d.error && d.error.message
          ? friendlyAuthError(d.error.message) : "Sign in failed");
      }
      idToken = d.idToken;
      idTokenExp = Date.now() + (parseInt(d.expiresIn, 10) || 3600) * 1000 - 60000;
      setAuthState({ refreshToken: d.refreshToken, email: email, uid: d.localId });
      return d;
    });
  }

  function signOut() {
    setAuthState(null);
    idToken = null; idTokenExp = 0;
    Object.keys(SPEC).forEach(function (k) {
      lsDel(k + "__syncbase"); lsDel(k + "__syncparts");
    });
    setStatus("off", "Sync off");
  }

  function token() {
    if (idToken && Date.now() < idTokenExp) return Promise.resolve(idToken);
    var st = authState();
    if (!st || !st.refreshToken) return Promise.reject(new Error("not signed in"));
    return fetch("https://securetoken.googleapis.com/v1/token?key=" + encodeURIComponent(cfg.apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(st.refreshToken)
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.id_token) {
        /* Refresh token revoked, or the password was changed elsewhere. */
        setAuthState(null);
        throw new Error("Signed out - please sign in again");
      }
      idToken = d.id_token;
      idTokenExp = Date.now() + (parseInt(d.expires_in, 10) || 3600) * 1000 - 60000;
      if (d.refresh_token && st.refreshToken !== d.refresh_token) {
        st.refreshToken = d.refresh_token;
        setAuthState(st);
      }
      return idToken;
    });
  }

  /* ---------- Firestore REST --------------------------------------------
     The whole store goes up as one JSON string rather than as structured
     fields. Firestore cannot hold nested arrays natively and there is no
     value in making it try.

     One wrinkle: a Firestore document tops out at 1 MiB, and a handful of
     receipt photos will sail past that. So the string is cut into chunks and
     spread over as many documents as it needs - fnwc/KEY, fnwc/KEY~1,
     fnwc/KEY~2 and so on. The first one records how many there are.
     --------------------------------------------------------------------- */

  var CHUNK = 700000;          /* characters per document, well under 1 MiB */
  var MAX_CHUNKS = 12;         /* ~8 MB ceiling; localStorage gives out first */

  function docUrl(name) {
    return "https://firestore.googleapis.com/v1/projects/" + cfg.projectId +
           "/databases/(default)/documents/fnwc/" + encodeURIComponent(name);
  }
  function chunkName(key, i) { return i === 0 ? key : key + "~" + i; }

  function fetchDoc(name) {
    return token().then(function (t) {
      return fetch(docUrl(name), { headers: { Authorization: "Bearer " + t } });
    }).then(function (r) {
      if (r.status === 404) return null;               /* nothing stored yet */
      if (r.status === 403) throw new Error("Firestore rules are blocking this account");
      if (!r.ok) throw new Error("Firestore read failed (" + r.status + ")");
      return r.json();
    });
  }

  function getDoc(key) {
    return fetchDoc(key).then(function (d) {
      if (!d || !d.fields || !d.fields.blob) return null;
      var parts = d.fields.parts
        ? Number(d.fields.parts.integerValue || d.fields.parts.doubleValue || 1) : 1;
      var text = d.fields.blob.stringValue || "";
      if (parts <= 1) return finish(text);

      /* Pull the rest in order. They are only ever written together, so a
         missing one means a write was cut off half way - better to treat the
         whole read as "nothing there" than to parse a truncated store. */
      var rest = [];
      for (var i = 1; i < parts; i++) rest.push(i);
      return rest.reduce(function (p, i) {
        return p.then(function () {
          return fetchDoc(chunkName(key, i)).then(function (c) {
            if (!c || !c.fields || !c.fields.blob) throw new Error("partial");
            text += c.fields.blob.stringValue || "";
          });
        });
      }, Promise.resolve()).then(function () { return finish(text); },
        function (e) { if (e && e.message === "partial") return null; throw e; });

      function finish(s) {
        try { return { data: JSON.parse(s || "null") }; } catch (e) { return null; }
      }
    });
  }

  function writeChunk(name, fields) {
    return token().then(function (t) {
      return fetch(docUrl(name), {
        method: "PATCH",
        headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
        body: j({ fields: fields })
      });
    }).then(function (r) {
      if (!r.ok) throw new Error("Firestore write failed (" + r.status + ")");
      return true;
    });
  }

  function deleteChunk(name) {
    return token().then(function (t) {
      return fetch(docUrl(name), { method: "DELETE", headers: { Authorization: "Bearer " + t } });
    })["catch"](function () { /* a leftover that will not delete is harmless */ });
  }

  function putDoc(key, data) {
    var text = j(data) || "null";
    var parts = Math.max(1, Math.ceil(text.length / CHUNK));

    if (parts > MAX_CHUNKS) {
      throw new Error("Too much data to sync (" + Math.round(text.length / 1048576 * 10) / 10 +
                      " MB). Clear out some old receipt photos.");
    }

    /* The tail goes up first, so the first document - the one that says how
       many parts there are - is never pointing at chunks that have not landed
       yet. A sync interrupted half way then reads as the old state, not as a
       torn one. */
    var order = [];
    for (var i = parts - 1; i >= 1; i--) order.push(i);

    return order.reduce(function (p, i) {
      return p.then(function () {
        return writeChunk(chunkName(key, i), {
          blob: { stringValue: text.slice(i * CHUNK, (i + 1) * CHUNK) }
        });
      });
    }, Promise.resolve()).then(function () {
      return writeChunk(key, {
        blob: { stringValue: text.slice(0, CHUNK) },
        parts: { integerValue: String(parts) },
        ts: { integerValue: String(Date.now()) },
        dev: { stringValue: deviceId }
      });
    }).then(function () {
      /* Tidy up chunks left behind by a previously larger store - but only
         when it actually shrank, or every single sync would fire a dozen
         pointless deletes. Failing to delete one costs nothing anyway: the
         parts count on the first document is what a read goes by. */
      var had = parseInt(lsGet(key + "__syncparts") || "1", 10) || 1;
      lsSet(key + "__syncparts", String(parts));
      if (had <= parts) return;

      var stale = [];
      for (var k = parts; k < had; k++) stale.push(k);
      return stale.reduce(function (p, k) {
        return p.then(function () { return deleteChunk(chunkName(key, k)); });
      }, Promise.resolve());
    }).then(function () { return true; });
  }

  /* ---------- status pill ---------- */

  var pill = null, pillText = null, statusState = "off", statusText = "Sync off";

  function ensurePill() {
    if (pill || !document.body) return;
    if (global.FNWC_SYNC_NO_PILL) return;      /* the mobile app draws its own */

    var css = document.createElement("style");
    css.textContent =
      "#fnwcSyncPill{position:fixed;right:10px;bottom:10px;z-index:99999;" +
      "font:600 12px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
      "background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:999px;" +
      "padding:7px 12px;display:flex;align-items:center;gap:7px;cursor:pointer;" +
      "box-shadow:0 2px 10px rgba(0,0,0,.25);opacity:.9;-webkit-user-select:none;user-select:none}" +
      "#fnwcSyncPill:hover{opacity:1}" +
      "#fnwcSyncPill .dot{width:8px;height:8px;border-radius:50%;background:#64748b;flex:none}" +
      "#fnwcSyncPill.ok .dot{background:#22c55e}" +
      "#fnwcSyncPill.busy .dot{background:#38bdf8;animation:fnwcPulse 1s infinite}" +
      "#fnwcSyncPill.err .dot{background:#ef4444}" +
      "@keyframes fnwcPulse{0%,100%{opacity:1}50%{opacity:.25}}" +
      "@media print{#fnwcSyncPill{display:none}}";
    document.head.appendChild(css);

    pill = document.createElement("div");
    pill.id = "fnwcSyncPill";
    pill.innerHTML = '<span class="dot"></span><span class="t">Sync off</span>';
    pillText = pill.querySelector(".t");
    pill.addEventListener("click", openPanel);
    document.body.appendChild(pill);
  }

  var statusListeners = [];

  function setStatus(state, text) {
    statusState = state; statusText = text;
    ensurePill();
    if (pill) {
      pill.className = state === "ok" ? "ok" : state === "busy" ? "busy" : state === "err" ? "err" : "";
      pillText.textContent = text;
    }
    statusListeners.forEach(function (fn) { try { fn(state, text); } catch (e) {} });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ---------- the sign-in / status panel ---------- */

  function openPanel() {
    if (document.getElementById("fnwcSyncPanel")) return;
    var st = authState();

    var wrap = document.createElement("div");
    wrap.id = "fnwcSyncPanel";
    wrap.setAttribute("style",
      "position:fixed;inset:0;z-index:100000;background:rgba(2,6,23,.72);display:flex;" +
      "align-items:center;justify-content:center;padding:16px;" +
      "font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif");

    var btnDark = "width:100%;box-sizing:border-box;padding:12px;border:0;border-radius:9px;" +
                  "background:#0f172a;color:#fff;font-weight:600;font-size:15px;margin-bottom:8px;cursor:pointer";
    var btnPlain = "width:100%;box-sizing:border-box;padding:12px;border:1px solid #cbd5e1;border-radius:9px;" +
                   "background:#fff;color:#0f172a;font-weight:600;font-size:15px;margin-bottom:8px;cursor:pointer";
    var inp = "width:100%;box-sizing:border-box;padding:12px;border:1px solid #cbd5e1;" +
              "border-radius:9px;margin-bottom:8px;font-size:16px";

    var card = '<div style="background:#fff;color:#0f172a;border-radius:14px;max-width:380px;' +
               'width:100%;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.4)">';

    if (!configured()) {
      card += '<h3 style="margin:0 0 8px">Sync is not set up yet</h3>' +
        '<p style="margin:0 0 14px;color:#475569">Open <b>fnwc-firebase-config.js</b> and paste in the ' +
        'two keys from your Firebase project. The steps are written out in <b>SETUP-SYNC.md</b>, ' +
        'in this same folder. It takes about five minutes and you only do it once.</p>' +
        '<button data-x style="' + btnDark + '">Close</button>';
    } else if (st && st.refreshToken) {
      card += '<h3 style="margin:0 0 8px">Sync is on</h3>' +
        '<p style="margin:0 0 4px;color:#475569">Signed in as <b>' + esc(st.email) + '</b></p>' +
        '<p style="margin:0 0 14px;color:#475569">This device is <code>' + esc(deviceId) + '</code>. ' +
        'Status: ' + esc(statusText) + '</p>' +
        '<button data-now style="' + btnDark + '">Sync now</button>' +
        '<button data-out style="' + btnPlain + 'color:#b91c1c">Sign out of sync</button>' +
        '<button data-x style="' + btnPlain + '">Close</button>';
    } else {
      card += '<h3 style="margin:0 0 4px">Turn on sync</h3>' +
        '<p style="margin:0 0 14px;color:#475569">Sign in with the account you made in Firebase. ' +
        'You only do this once on each device.</p>' +
        '<input data-email type="email" autocomplete="username" placeholder="Email" style="' + inp + '">' +
        '<input data-pass type="password" autocomplete="current-password" placeholder="Password" style="' + inp + '">' +
        '<div data-msg style="color:#b91c1c;min-height:20px;margin-bottom:6px"></div>' +
        '<button data-in style="' + btnDark + '">Sign in</button>' +
        '<button data-x style="' + btnPlain + '">Not now</button>';
    }
    card += "</div>";

    wrap.innerHTML = card;
    document.body.appendChild(wrap);

    var q = function (s) { return wrap.querySelector(s); };
    function close() { wrap.remove(); }

    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    if (q("[data-x]")) q("[data-x]").onclick = close;
    if (q("[data-now]")) q("[data-now]").onclick = function () { close(); syncAll(true); };
    if (q("[data-out]")) q("[data-out]").onclick = function () {
      if (confirm("Sign out of sync on this device?\n\nNothing already on this device is deleted - " +
                  "it just stops talking to the other one.")) { signOut(); close(); }
    };
    if (q("[data-in]")) {
      var go = function () {
        var btn = q("[data-in]"), msg = q("[data-msg]");
        btn.disabled = true; btn.textContent = "Signing in...";
        msg.textContent = "";
        signIn(q("[data-email]").value.trim(), q("[data-pass]").value).then(function () {
          close(); setStatus("busy", "Syncing..."); syncAll(true);
        })["catch"](function (e) {
          msg.textContent = (e && e.message) || "Sign in failed";
          btn.disabled = false; btn.textContent = "Sign in";
        });
      };
      q("[data-in]").onclick = go;
      q("[data-pass]").addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
      setTimeout(function () { q("[data-email]").focus(); }, 30);
    }
  }

  /* ---------- the sync cycle ---------- */

  var listeners = [];
  var running = false;

  function readJSON(k) {
    var raw = lsGet(k);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function syncKey(key) {
    var mine = readJSON(key);
    return getDoc(key).then(function (remote) {
      var theirs = remote ? remote.data : null;

      /* First run on this device: treat the server as the shared starting
         point, so the very first merge adds rather than deletes. */
      var base = readJSON(key + "__syncbase");
      if (base === null) base = clone(theirs !== null ? theirs : mine);

      if (mine === null && theirs === null) return false;

      var merged;
      if (mine === null) merged = clone(theirs);
      else if (theirs === null) merged = clone(mine);
      else merged = mergeDoc(key, base, mine, theirs);

      var localChanged = !same(merged, mine);
      var remoteChanged = !same(merged, theirs);

      var work = remoteChanged ? putDoc(key, merged) : Promise.resolve();

      return work.then(function () {
        lsSet(key + "__syncbase", j(merged));
        if (localChanged) {
          lsSet(key, j(merged));
          return true;                        /* the page needs to redraw */
        }
        return false;
      });
    });
  }

  function syncAll(force) {
    if (running) return Promise.resolve();
    if (!configured()) { setStatus("off", "Sync off"); return Promise.resolve(); }

    var st = authState();
    if (!st || !st.refreshToken) { setStatus("off", "Sign in to sync"); return Promise.resolve(); }
    if (!navigator.onLine && !force) { setStatus("err", "Offline"); return Promise.resolve(); }

    running = true;
    setStatus("busy", "Syncing...");
    var anyChanged = false;

    return Object.keys(SPEC).reduce(function (p, k) {
      return p.then(function () {
        return syncKey(k).then(function (ch) { if (ch) anyChanged = true; });
      });
    }, Promise.resolve()).then(function () {
      running = false;
      setStatus("ok", "Synced " + hhmm(new Date()));
      if (anyChanged) listeners.forEach(function (fn) { try { fn(); } catch (e) {} });
    })["catch"](function (e) {
      running = false;
      var m = (e && e.message) || "Sync failed";
      setStatus("err", /signed out|not signed/i.test(m) ? "Sign in to sync"
                     : !navigator.onLine ? "Offline" : "Sync problem");
      if (global.console) console.warn("[fnwc-sync]", m);
    });
  }

  function hhmm(d) {
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  /* ---------- wiring -----------------------------------------------------
     We want a save in the app to reach the other device quickly without
     hammering Firestore on every keystroke. Wrapping setItem gives us that
     nudge with no changes to any of the tools themselves.
     --------------------------------------------------------------------- */

  var nudgeTimer = null;
  function nudge() {
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(function () { syncAll(); }, 900);
  }

  (function wrapSetItem() {
    try {
      var proto = Storage.prototype, orig = proto.setItem;
      proto.setItem = function (k, v) {
        var r = orig.apply(this, arguments);
        try { if (this === localStorage && SPEC.hasOwnProperty(k)) nudge(); } catch (e) {}
        return r;
      };
    } catch (e) { /* some browsers seal this; the poll still covers us */ }
  })();

  var timer = null;
  function schedule() {
    clearInterval(timer);
    timer = setInterval(function () { syncAll(); }, document.hidden ? POLL_IDLE_MS : POLL_MS);
  }

  function start() {
    ensurePill();
    var st = authState();
    if (!configured()) setStatus("off", "Sync off");
    else if (!st) setStatus("off", "Sign in to sync");
    else { setStatus("busy", "Syncing..."); syncAll(true); }

    schedule();
    document.addEventListener("visibilitychange", function () {
      schedule();
      if (!document.hidden) syncAll();
    });
    window.addEventListener("online", function () { syncAll(true); });
    window.addEventListener("focus", function () { syncAll(); });
  }

  global.FNWCSync = {
    start: start,
    syncNow: function () { return syncAll(true); },
    onRemoteChange: function (fn) { listeners.push(fn); },
    onStatus: function (fn) { statusListeners.push(fn); fn(statusState, statusText); },
    openPanel: openPanel,
    configured: configured,
    isOn: function () { var s = authState(); return !!(s && s.refreshToken && configured()); },
    account: function () { var s = authState(); return s ? s.email : null; },
    deviceId: deviceId,
    /* For the bits that talk to Firestore outside the store sync - reading the
       website enquiry inbox, mostly. Keeps token handling in one place rather
       than having a second copy of it drift out of step. */
    authedFetch: function (path, opts) {
      if (!configured()) return Promise.reject(new Error("Sync is not set up"));
      return token().then(function (t) {
        var o = opts || {};
        o.headers = Object.assign({ Authorization: "Bearer " + t }, o.headers || {});
        return fetch("https://firestore.googleapis.com/v1/projects/" + cfg.projectId +
                     "/databases/(default)/documents/" + path, o);
      });
    },
    signOut: signOut,
    status: function () { return { state: statusState, text: statusText }; },
    _merge: mergeDoc                  /* used by the self-test in SETUP-SYNC.md */
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

})(window);
