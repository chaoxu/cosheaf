// PR files-changed: step through changes (#42). Enhances the diff pane with a
// Prev/Next-change control (+ n/p or j/k keys) that scrolls to and flashes each
// changed hunk. No-op on pages without a diff. Plain progressive enhancement:
// with JS off the diff still renders, just without the stepper.
(() => {
  if (typeof document === "undefined") return;

  function init() {
    const pane = document.querySelector('[data-testid^="diff-pane"]');
    const controls = document.querySelector(".diff-controls");
    if (!pane || !controls) return;

    // Change markers across shapes: source split/after rows (tr.marked), unified
    // patch rows (tr.add/tr.del), and rich blocks (.marked). Collapse a run of
    // adjacent sibling rows into one stop so Next jumps hunk-to-hunk.
    const all = Array.from(pane.querySelectorAll("tr.marked, tr.add, tr.del, .marked"));
    const stops = all.filter((el, i) => {
      const prev = all[i - 1];
      return !prev || prev !== el.previousElementSibling;
    });

    const nav = document.createElement("div");
    nav.className = "diff-change-nav";
    const count = document.createElement("span");
    count.className = "diff-change-count";
    nav.appendChild(count);

    if (stops.length === 0) {
      count.textContent = "No changes to step through";
      controls.appendChild(nav);
      return;
    }

    const mkBtn = (label, aria) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("aria-label", aria);
      return b;
    };
    const prevBtn = mkBtn("↑ Prev", "Previous change");
    const nextBtn = mkBtn("↓ Next", "Next change");
    nav.append(prevBtn, nextBtn);
    controls.appendChild(nav);

    let idx = -1;
    const render = () => {
      count.textContent = `${idx >= 0 ? idx + 1 : "—"} / ${stops.length} ${stops.length === 1 ? "change" : "changes"}`;
    };
    const go = (next) => {
      idx = ((next % stops.length) + stops.length) % stops.length;
      const el = stops[idx];
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      // Re-trigger the flash animation even when stepping onto the same element.
      el.classList.remove("change-focus");
      void el.offsetWidth;
      el.classList.add("change-focus");
      render();
    };
    prevBtn.addEventListener("click", () => go(idx - 1));
    nextBtn.addEventListener("click", () => go(idx + 1));
    render();

    document.addEventListener("keydown", (event) => {
      const t = event.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (t && t.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "n" || event.key === "j") {
        event.preventDefault();
        go(idx + 1);
      } else if (event.key === "p" || event.key === "k") {
        event.preventDefault();
        go(idx - 1);
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
