/* ===========================================================================
   Service worker for the phone app.

   It exists for one reason: an app added to the iPhone home screen will happily
   show you a version of the page from days ago, and there is no way to set
   cache headers on GitHub Pages to stop it.

   So: network first, always. Every load goes and asks the server for the real
   file. The cache is only a fallback for when there is no signal - which does
   happen, out past Kuranda - so the app still opens and all your data is still
   there, because that lives in localStorage and not in here.

   The trade-off is deliberate. Cache-first would load a few hundred
   milliseconds quicker and would be wrong on the day it mattered.
   =========================================================================== */

var CACHE = "fnwc-v1";
var ASSETS = ["./", "./index.html", "./fnwc-sync.js", "./fnwc-firebase-config.js",
              "./manifest.webmanifest"];

self.addEventListener("install", function (e) {
  /* Do not wait for the old worker to let go - the whole point is to get the
     new version in front of you now. */
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(ASSETS)["catch"](function () { /* offline first run */ });
    })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches["delete"](k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   /* Firestore et al: leave alone */

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    })["catch"](function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match("./index.html");
      });
    })
  );
});

/* Lets the page ask for an immediate takeover after it spots an update. */
self.addEventListener("message", function (e) {
  if (e.data === "skipWaiting") self.skipWaiting();
});
