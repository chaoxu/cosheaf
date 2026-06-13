// Home inbox liveness (#116): subscribe to the per-user notification SSE
// channel and refetch the server-rendered inbox fragment on a hint, so the
// cross-repo home inbox updates live instead of only on full page load. The
// inbox HTML is owned by the server (/account/inbox) — never duplicated here.
(() => {
  const slot = document.getElementById("home-inbox-slot");
  if (!slot || typeof EventSource === "undefined") return;

  let timer = null;
  const refresh = async () => {
    try {
      const res = await fetch("/account/inbox", { credentials: "same-origin" });
      if (res.ok) slot.innerHTML = await res.text();
    } catch (_err) {
      // Transient fetch failure; the next hint (or a reload) recovers.
    }
  };

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
