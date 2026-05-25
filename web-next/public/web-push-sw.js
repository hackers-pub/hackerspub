self.addEventListener("push", (event) => {
  const fallbackUrl = "/notifications";
  let payload = {};
  if (event.data != null) {
    try {
      payload = event.data.json();
    } catch {
      payload = { body: event.data.text() };
    }
  }
  const safePayload = payload != null && typeof payload === "object"
    ? payload
    : {};

  const title = typeof safePayload.title === "string" &&
      safePayload.title.trim() !== ""
    ? safePayload.title
    : "Hackers' Pub";
  const targetPath = typeof safePayload.url === "string" &&
      safePayload.url.startsWith("/") &&
      !safePayload.url.startsWith("//")
    ? safePayload.url
    : fallbackUrl;
  const options = {
    body: typeof safePayload.body === "string" ? safePayload.body : undefined,
    icon: "/maskable-icon-192.png",
    badge: "/maskable-icon-192.png",
    data: {
      ...typeof safePayload.data === "object" && safePayload.data != null
        ? safePayload.data
        : {},
      url: targetPath,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const fallbackUrl = "/notifications";
  const targetPath = typeof event.notification.data?.url === "string" &&
      event.notification.data.url.startsWith("/") &&
      !event.notification.data.url.startsWith("//")
    ? event.notification.data.url
    : fallbackUrl;
  const targetUrl = new URL(targetPath, self.location.origin);

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const client of clientsList) {
      const clientUrl = new URL(client.url);
      if (
        clientUrl.origin === targetUrl.origin &&
        clientUrl.pathname === targetUrl.pathname
      ) {
        if ("navigate" in client) await client.navigate(targetUrl.href);
        return await client.focus();
      }
    }
    return await self.clients.openWindow(targetUrl.href);
  })());
});
