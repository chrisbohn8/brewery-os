// Brewery OS — service worker
//
// A service worker is a small script the browser keeps running alongside the page. This one
// keeps a copy of the app's own files on the device, so the app still opens with no signal.
//
// "Network first": when there's a connection you always get the latest version (and the saved
// copy is refreshed); when there isn't, or it's too slow to answer, the saved copy is used.
// It never touches database requests: those always go to the database (or fail, and the page
// shows its saved copy of the data instead — see "Offline" in app.js).

const CACHE = "brewery-os-app-v1";
const LIBRARY = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js";
const APP_FILES = ["./", "./index.html", "./style.css", "./app.js", LIBRARY];

// How long to wait for the network before using the saved copy. A brew floor often has
// "almost no signal", where requests hang instead of failing; this keeps the app quick to open.
const NETWORK_WAIT_MS = 4000;

// First install: save a copy of every app file
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()) // start working right away, without waiting for a reload
  );
});

// A new version of this file: remove copies saved under an older name
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const isAppFile = url.origin === self.location.origin || url.href === LIBRARY;
  if (!isAppFile) return; // database requests and anything else: leave them alone

  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);

  // Ask the network, and keep the saved copy up to date when it answers
  // ("no-cache" checks with the server every time, so a reload always gets a newly published
  // version instead of a copy the browser kept for a few minutes; unchanged files cost almost nothing)
  const fromNetwork = fetch(request, { cache: "no-cache" }).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });

  // ...but don't wait forever: after a few seconds, or as soon as the request fails, use the copy
  const tooSlow = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS));
  try {
    const response = await Promise.race([fromNetwork, tooSlow]);
    if (response) return response;
  } catch {
    // no connection: fall through to the saved copy
  }
  const saved = await cache.match(request, { ignoreSearch: true })
    || (request.mode === "navigate" ? await cache.match("./index.html") : undefined);
  return saved || fromNetwork; // nothing saved yet: keep waiting for the network after all
}
