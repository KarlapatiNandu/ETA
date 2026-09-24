/* Bus Mitra service worker — push and notificationclick (BUILD_PLAN Stage 6).
 *
 * Plain JavaScript on purpose: it is served as-is from /sw.js, with no build step between the
 * source and what the browser runs. (Offline caching — Serwist — is a separate, later concern;
 * this file only receives and opens notifications.)
 *
 * The payload is what engine/workers/notify.ts sends: {title, body, tag, renotify,
 * requireInteraction, data: {notificationId, url, tier}, actions?}. A tap opens (or focuses) the
 * app at data.url; an action button opens the notification center, which performs the action
 * with the student's session — the worker has no token and never acts on its own.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
