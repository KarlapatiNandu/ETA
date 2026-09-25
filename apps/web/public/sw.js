/* Bus Mitra service worker — push and notificationclick (BUILD_PLAN Stage 6).
 *
 * Plain JavaScript on purpose: it is served as-is from /sw.js, with no build step between the
 * source and what the browser runs.
 *
 * Offline (Stage 9): a navigation that fails is answered with /offline.html, cached at install.
 * Nothing else is ever cached — a live map or an ETA served from a cache would be a fabricated
 * position (invariant 2), so offline the app says it is offline instead. (Serwist, named in
 * ARCH §2.1, is not needed for a one-page shell.)
 *
 * The payload is what engine/workers/notify.ts sends: {title, body, tag, renotify,
 * requireInteraction, data: {notificationId, url, tier}, actions?}. A tap opens (or focuses) the
 * app at data.url; an action button opens the notification center, which performs the action
 * with the student's session — the worker has no token and never acts on its own.
 */

const SHELL = "bm-shell-v1";
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll([OFFLINE, "/icons/icon-192.png"]))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  ),
);

// page loads only: API calls, the SSE stream and assets go straight to the network, uncached
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});

self.addEventListener("push", (event) => {
  let msg;
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { title: "Bus Mitra", body: event.data ? event.data.text() : "" };
  }
  const data = msg.data || {};
  const options = {
    body: msg.body || "",
    data,
    // T3 progress for one trip shares a tag: each update replaces the last instead of stacking
    tag: msg.tag || undefined,
    renotify: Boolean(msg.tag && msg.renotify),
    requireInteraction: Boolean(msg.requireInteraction),
    actions: Array.isArray(msg.actions) ? msg.actions.slice(0, 2) : [],
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(msg.title || "Bus Mitra", options),
      // an open tab refreshes its badge at once (and the e2e harness times the arrival)
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((wins) =>
          wins.forEach((w) => w.postMessage({ type: "bm:push", data, at: Date.now() })),
        ),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  const id = data.notificationId;
  let url = data.url || "/notifications";
  if (event.action && id)
    url = `/notifications?act=${encodeURIComponent(event.action)}&n=${encodeURIComponent(id)}`;
  else if (id) url += `${url.includes("?") ? "&" : "?"}n=${encodeURIComponent(id)}`;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          w.navigate(url);
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
