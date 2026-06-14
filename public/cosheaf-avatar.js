// Profile picture in the chrome (#150). Cosheaf renders initials chips by
// default. If the signed-in user has uploaded a custom avatar (served via the
// /account/avatar proxy so the backing forge URL stays hidden), swap THEIR own
// chips — the sidebar identity and their own thread participant chips — for the
// image. Other users keep their initials chips, so there are no per-participant
// forge lookups. A no-op when the proxy 404s (no custom avatar).
(() => {
  const me = document.body.dataset.cosheafUser || "";
  if (!me) return;
  const probe = new Image();
  probe.onload = () => {
    for (const chip of document.querySelectorAll(`.avatar-chip[aria-label="${CSS.escape(me)}"]`)) {
      if (chip.tagName === "IMG") continue;
      const img = document.createElement("img");
      img.className = "avatar-chip avatar-chip-img";
      img.src = "/account/avatar";
      img.alt = me;
      img.title = me;
      chip.replaceWith(img);
    }
  };
  probe.src = "/account/avatar";
})();
