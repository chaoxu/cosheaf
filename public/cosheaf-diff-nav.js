// PR files-changed: step through changes (#42). Enhances the diff pane with a
// Prev/Next-change control (+ n/p or j/k keys) that scrolls to and flashes each
// changed hunk. No-op on pages without a diff. Plain progressive enhancement:
// with JS off the diff still renders, just without the stepper.
//
// Rich-mode diffs mark changed blocks ASYNCHRONOUSLY — the reader island hydrates
// and adds `.marked` after load — so we re-scan on pane mutations rather than
// querying once. The rescan no-ops when the change set is unchanged, so our own
// `.change-focus` toggle doesn't trigger a rebuild loop.
(() => {
  if (typeof document === "undefined") return;

  function init() {
    const pane = document.querySelector('[data-testid^="diff-pane"]');
    const controls = document.querySelector(".diff-controls");
    if (!pane || !controls) return;

    let stops = [];
    let idx = -1;
    let nav = null;
    let count = null;

    // The previous element sibling, skipping interleaved inline-comment rows, so a
    // run of changed source lines split by a comment still counts as one hunk.
    const prevSkippingComments = (el) => {
      let p = el.previousElementSibling;
      while (p && (p.classList.contains("line-comment-row") || p.classList.contains("line-comment"))) {
        p = p.previousElementSibling;
      }
      return p;
    };

    const collect = () => {
      // Change markers across shapes: source rows (tr.marked), unified patch rows
      // (tr.add/tr.del), rich blocks (.marked). Collapse adjacent rows into one stop.
      const all = Array.from(pane.querySelectorAll("tr.marked, tr.add, tr.del, .marked")).filter((el) => {
        // Rich readers can mark both a compound block and its children. The
        // nested markers are visually transparent, so keep the stepper aligned
        // with the visible highlight regions.
        return !(el.classList.contains("marked") && !el.matches("tr.marked") && el.parentElement?.closest(".marked"));
      });
      return all.filter((el, i) => {
        const prev = all[i - 1];
        return !prev || prevSkippingComments(el) !== prev;
      });
    };

    const sameStops = (a, b) => a.length === b.length && a.every((el, i) => el === b[i]);

    const render = () => {
      if (!count) return;
      count.textContent = stops.length
        ? `${idx >= 0 ? idx + 1 : "—"} / ${stops.length} ${stops.length === 1 ? "change" : "changes"}`
        : "No changes to step through";
    };

    const go = (next) => {
      if (!stops.length) return;
      idx = ((next % stops.length) + stops.length) % stops.length;
      const el = stops[idx];
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      // Re-trigger the flash even when stepping onto the same element.
      el.classList.remove("change-focus");
      void el.offsetWidth;
      el.classList.add("change-focus");
      render();
    };

    const mkBtn = (label, aria) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = `${aria} (keys: n / p)`;
      b.setAttribute("aria-label", aria);
      return b;
    };

    const rebuild = () => {
      if (nav) nav.remove();
      nav = document.createElement("div");
      nav.className = "diff-change-nav";
      count = document.createElement("span");
      count.className = "diff-change-count";
      count.setAttribute("role", "status");
      count.setAttribute("aria-live", "polite");
      nav.appendChild(count);
      if (stops.length > 0) {
        const prevBtn = mkBtn("↑ Prev", "Previous change");
        const nextBtn = mkBtn("↓ Next", "Next change");
        prevBtn.addEventListener("click", () => go(idx - 1));
        nextBtn.addEventListener("click", () => go(idx + 1));
        nav.append(prevBtn, nextBtn);
      }
      controls.appendChild(nav);
      render();
    };

    const rescan = () => {
      const next = collect();
      if (sameStops(next, stops) && nav) return; // unchanged (e.g. our own focus toggle)
      stops = next;
      idx = -1;
      rebuild();
    };

    document.addEventListener("keydown", (event) => {
      if (stops.length === 0) return;
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

    rescan();
    // Catch the reader's async `.marked` application (rich mode). The rescan
    // no-ops when stops are unchanged, so the focus-class toggle won't loop.
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(rescan, 120);
    }).observe(pane, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
