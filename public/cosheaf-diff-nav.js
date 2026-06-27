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
      const explicit = Array.from(pane.querySelectorAll("[data-diff-stop]"));
      if (explicit.length > 0) return explicit;

      // Change markers across shapes: source rows (tr.marked), unified patch rows
      // (tr.add/tr.del), split source cells (td.add/td.del), rich blocks
      // (.marked). Collapse adjacent rows into one stop.
      const raw = Array.from(pane.querySelectorAll("tr.marked, tr.add, tr.del, .source-split-lines td.add, .source-split-lines td.del, .marked"));
      const all = Array.from(new Set(raw.map((el) => el.closest(".source-split-lines tr") || el))).filter((el) => {
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

    const alignRichSplit = () => {
      const split = pane.matches(".rich-split") ? pane : pane.querySelector(".rich-split");
      if (!split) return;
      pane.dataset.richGapApplying = "1";
      for (const spacer of split.querySelectorAll(".cf-doc-layout-gap[data-cf-layout-gap-id]")) spacer.style.height = "";
      const sections = split.querySelectorAll(":scope > section");
      if (sections.length < 2) {
        setTimeout(() => {
          delete pane.dataset.richGapApplying;
        }, 0);
        return;
      }
      const bySide = Array.from(sections).map((section) => {
        const content = new Map();
        const gaps = new Map();
        for (const el of section.querySelectorAll("[data-rich-gap-content-ids]")) {
          for (const id of (el.getAttribute("data-rich-gap-content-ids") || "").split(/\s+/)) {
            if (id && !content.has(id)) content.set(id, el);
          }
        }
        for (const el of section.querySelectorAll(".cf-doc-layout-gap[data-cf-layout-gap-id]")) {
          const id = el.getAttribute("data-cf-layout-gap-id");
          if (id && !gaps.has(id)) gaps.set(id, el);
        }
        return { content, gaps };
      });
      const ids = Array.from(new Set([
        ...bySide[0].content.keys(),
        ...bySide[1].content.keys(),
      ]))
        .filter((id) => bySide[0].content.has(id) || bySide[1].content.has(id))
        .sort((a, b) => richGapNumber(a) - richGapNumber(b));
      for (const id of ids) {
        let left = bySide[0].content.get(id);
        let right = bySide[1].content.get(id);
        const leftMissingGap = bySide[0].gaps.get(`${id}-missing`) ?? bySide[0].gaps.get(id);
        const rightMissingGap = bySide[1].gaps.get(`${id}-missing`) ?? bySide[1].gaps.get(id);
        if (!left && right && leftMissingGap) {
          setRichGapHeight(leftMissingGap, heightThroughOppositeContent(leftMissingGap, right));
          continue;
        }
        if (!right && left && rightMissingGap) {
          setRichGapHeight(rightMissingGap, heightThroughOppositeContent(rightMissingGap, left));
          continue;
        }
        if (!left || !right) continue;
        let leftTop = left.getBoundingClientRect().top;
        let rightTop = right.getBoundingClientRect().top;
        const delta = Math.round(Math.abs(leftTop - rightTop));
        if (delta > 1) {
          const sideIndex = leftTop < rightTop ? 0 : 1;
          const gap = bySide[sideIndex].gaps.get(`${id}-before`);
          if (gap) {
            setRichGapHeight(gap, delta);
            left = bySide[0].content.get(id);
            right = bySide[1].content.get(id);
            leftTop = left.getBoundingClientRect().top;
            rightTop = right.getBoundingClientRect().top;
          }
        }
        const leftBottom = left.getBoundingClientRect().bottom;
        const rightBottom = right.getBoundingClientRect().bottom;
        const bottomDelta = Math.round(Math.abs(leftBottom - rightBottom));
        if (bottomDelta > 1) {
          const gap = bySide[leftBottom < rightBottom ? 0 : 1].gaps.get(`${id}-after`);
          if (gap) setRichGapHeight(gap, bottomDelta);
        }
      }
      setTimeout(() => {
        delete pane.dataset.richGapApplying;
      }, 0);
    };

    const setRichGapHeight = (gap, height) => {
      gap.style.height = `${Math.max(0, Math.round(height))}px`;
    };

    const heightThroughOppositeContent = (gap, content) =>
      Math.max(content.getBoundingClientRect().height, content.getBoundingClientRect().bottom - gap.getBoundingClientRect().top);

    const richGapNumber = (id) => Number.parseInt(id.replace(/^rich-gap-(\d+).*$/, "$1"), 10) || 0;

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
      alignRichSplit();
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
      if (pane.dataset.richGapApplying === "1") return;
      clearTimeout(timer);
      timer = setTimeout(rescan, 120);
    }).observe(pane, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", () => {
      clearTimeout(timer);
      timer = setTimeout(rescan, 120);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
