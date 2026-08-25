// v3: styles.css moved into the hashed Vite bundle — bumping the name makes
// activate() evict the old cache, which still holds the stale unhashed
// /styles.css and every superseded hashed bundle.
const CACHE = "snakechain-v3";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network-first for documents: a cache-first shell would keep serving a
// stale index.html forever (referencing hashed bundles that no longer exist
// after a deploy). Hashed assets stay cache-first — they are immutable.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || !req.url.startsWith(self.location.origin)) return;

  if (req.destination === "document" || req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/"))),
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (
            res.ok &&
            (req.destination === "script" ||
              req.destination === "style" ||
              req.destination === "font" ||
              req.destination === "image")
          ) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
