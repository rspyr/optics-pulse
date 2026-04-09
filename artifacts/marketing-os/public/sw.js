self.addEventListener("push", (event) => {
  let data = { title: "New Lead", body: "You have a new lead!" };
  try {
    if (event.data) {
      data = Object.assign(data, event.data.json());
    }
  } catch (e) {
    console.warn("[SW] Failed to parse push data:", e);
  }

  const scope = self.registration.scope;

  const options = {
    body: data.body,
    icon: new URL("favicon.ico", scope).href,
    badge: new URL("favicon.ico", scope).href,
    tag: "new-lead-" + (data.leadId || Date.now()),
    data: { url: new URL("pulse", scope).href, leadId: data.leadId },
    requireInteraction: true,
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || self.registration.scope;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (new URL(client.url).origin === new URL(targetUrl).origin && "focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
