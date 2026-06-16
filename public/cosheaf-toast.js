// App-wide toast primitive (#184). Toasts are for discrete/navigational events
// (merge, PR opened, errors, upload done) — NOT for continuous save-state, which
// the editor shows persistently inline. Two entry points:
//   - window.cosheafToast(message, { kind }) — fire imperatively from an island.
//   - a one-shot toast carried across a server redirect via ?toast=…&toastKind=…
//     (merge/PR confirmations land on a different page), shown + stripped on load.
(() => {
  let host = null;
  function ensureHost() {
    if (host) return host;
    host = document.createElement("div");
    host.className = "toast-host";
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
    return host;
  }
  function toast(message, opts) {
    if (!message) return;
    const kind = (opts && opts.kind) || "info";
    const el = document.createElement("div");
    el.className = `toast toast--${kind === "error" ? "error" : kind === "success" ? "success" : "info"}`;
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.textContent = message;
    ensureHost().appendChild(el);
    requestAnimationFrame(() => el.classList.add("toast--in"));
    const dismiss = () => {
      el.classList.remove("toast--in");
      setTimeout(() => el.remove(), 200);
    };
    const timer = setTimeout(dismiss, kind === "error" ? 6000 : 3500);
    el.addEventListener("click", () => {
      clearTimeout(timer);
      dismiss();
    });
  }
  window.cosheafToast = toast;

  // Create the aria-live host up front, empty, so screen readers monitor it
  // before any toast text is inserted (a region populated in the same paint as
  // it's created may not be announced).
  ensureHost();

  // Flash carried across a redirect (e.g. the editor's Merge/Open-PR navigation).
  const params = new URLSearchParams(location.search);
  const flash = params.get("toast");
  if (flash) {
    toast(flash, { kind: params.get("toastKind") || "success" });
    params.delete("toast");
    params.delete("toastKind");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
  }
})();
