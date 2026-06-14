// Sidebar notifications badge (#129): fill the persistent global-notifications
// entry point with the caller's cross-repo unread count, and keep it live over
// the per-user SSE channel (#116) so it updates without a reload. Loaded on
// every signed-in page; a no-op when the badge element or EventSource is absent.
(() => {
  const badges = [...document.querySelectorAll("[data-notif-badge]")];
  if (badges.length === 0) return;

  const paint = (count) => {
    for (const el of badges) {
      if (count > 0) {
        el.textContent = count > 99 ? "99+" : String(count);
        el.hidden = false;
      } else {
        el.textContent = "";
        el.hidden = true;
      }
    }
  };

  const refresh = async () => {
    try {
      const res = await fetch("/api/v1/notifications", { credentials: "same-origin" });
      if (!res.ok) return;
      const body = await res.json();
      paint(Array.isArray(body.notifications) ? body.notifications.length : 0);
    } catch (_err) {
      // Transient failure; the next hint (or a reload) recovers.
    }
  };

  refresh();

  if (typeof EventSource === "undefined") return;
  let timer = null;
  const es = new EventSource("/api/v1/notifications/events");
  es.onmessage = (ev) => {
    let type = "";
    try {
      type = (JSON.parse(ev.data) || {}).type;
    } catch (_err) {
      return;
    }
    if (type !== "notification") return;
    // Debounce bursts — one PR action can fan out several webhooks.
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 400);
  };
})();
