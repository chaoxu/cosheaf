// Read | Build chrome lens (#131). The mode is applied to <html> before paint
// by an inline head script (no flash); this wires the sidebar toggle: reflect
// the current mode, and on click persist it (per user) and update the attribute
// live so the CSS lens switches without a reload. Pure presentation — Read just
// hides the contribute/forge chrome; every route still exists under Build.
(() => {
  const groups = [...document.querySelectorAll("[data-mode-toggle]")];
  if (groups.length === 0) return;
  const user = document.body.dataset.cosheafUser || "";
  const key = user ? `cosheaf:mode:${user}` : "cosheaf:mode";

  const current = () => (document.documentElement.getAttribute("data-cosheaf-mode") === "read" ? "read" : "build");

  const reflect = () => {
    const mode = current();
    for (const g of groups) {
      for (const opt of g.querySelectorAll(".mode-opt")) {
        opt.classList.toggle("active", opt.dataset.mode === mode);
        opt.setAttribute("aria-pressed", String(opt.dataset.mode === mode));
      }
    }
  };

  const set = (mode) => {
    const next = mode === "read" ? "read" : "build";
    document.documentElement.setAttribute("data-cosheaf-mode", next);
    try {
      localStorage.setItem(key, next);
    } catch (_e) {
      // Private mode / storage disabled: the lens still applies for this page.
    }
    reflect();
  };

  for (const g of groups) {
    g.addEventListener("click", (event) => {
      const opt = event.target instanceof Element ? event.target.closest(".mode-opt") : null;
      if (opt?.dataset.mode) set(opt.dataset.mode);
    });
  }
  reflect();
})();
