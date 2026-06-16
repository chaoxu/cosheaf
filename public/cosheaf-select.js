// Custom dropdown island (#106). Progressively enhances every server-rendered
// native <select> into a flat/square/monochrome listbox that matches the app
// chrome, because the browser/OS-native option popup (rounded, blue highlight,
// system font) can't be styled cross-browser.
//
// Hard rules this file keeps:
// - The real <select> stays in the DOM as the submitted form field and source
//   of truth. We only hide it visually (and from the a11y tree) and mirror it.
//   With JS disabled the native control still works and submits.
// - On user selection we write back to the native select (.value / option
//   .selected) and dispatch native `input` + `change` events so existing
//   listeners (e.g. cosheaf-preferences.js) still run.
// - We observe the native select so programmatic .value changes and option
//   disabled/added/removed mutations made by other scripts re-sync the widget.
// - The popup uses the native Popover API (top layer) so it escapes
//   overflow:clip / overflow:hidden ancestors; it is positioned against the
//   viewport and repositioned on scroll/resize, closed on outside click /
//   Esc / scroll-away.
// - Excluded: any select inside `.web-editor-statusbar` (React-controlled —
//   enhancing it from outside React would fight React re-renders) and any
//   select carrying `data-no-enhance`. See #106 deviation note.
(() => {
  if (typeof document === "undefined") return;
  // Popover API is required for the top-layer escape. Without it, leave native
  // selects untouched — they still work, just unstyled popups (graceful).
  const supportsPopover =
    typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;
  if (!supportsPopover) return;

  let idSeq = 0;
  const enhanced = new WeakSet();

  const shouldSkip = (select) =>
    select.dataset.noEnhance !== undefined ||
    select.closest("[data-no-enhance]") !== null ||
    select.closest(".web-editor-statusbar") !== null;

  const labelText = (option) =>
    (option.label || option.textContent || "").trim();

  // Option-icon glyphs for selects that opt in via data-option-icon="<name>":
  // each option row and the trigger then show the icon before the label. Built
  // as real SVG nodes (never an HTML string) so no sanitizer is needed; this
  // plain public script can't import server routes/icons.ts, the same constraint
  // as the editor's inlined pencil (#186). `branch` mirrors the server
  // branchIcon() (lucide git-branch) so branch dropdowns match chrome icons
  // rendered elsewhere (#187).
  const SVG_NS = "http://www.w3.org/2000/svg";
  const OPTION_ICONS = {
    branch: [
      ["path", { d: "M15 6a9 9 0 0 0-9 9V3" }],
      ["circle", { cx: "18", cy: "6", r: "3" }],
      ["circle", { cx: "6", cy: "18", r: "3" }],
    ],
  };
  function buildIcon(children) {
    const svg = document.createElementNS(SVG_NS, "svg");
    const frame = {
      width: "13", height: "13", viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round",
      "stroke-linejoin": "round", class: "lucide cf-opt-icon", "aria-hidden": "true",
    };
    for (const [k, v] of Object.entries(frame)) svg.setAttribute(k, v);
    for (const [tag, attrs] of children) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    }
    return svg;
  }

  /** @param {HTMLSelectElement} select */
  function enhance(select) {
    if (enhanced.has(select) || shouldSkip(select)) return;
    enhanced.add(select);

    const multiple = select.multiple;
    const id = `cf-select-${++idSeq}`;
    const listId = `${id}-list`;
    const optionIcon = OPTION_ICONS[select.dataset.optionIcon];

    // Set a row's or the trigger's text. When the select opts into an option
    // icon, prepend the icon and keep the text in its own ellipsis-able span.
    const setLabel = (container, text) => {
      if (!optionIcon) {
        container.textContent = text;
        return;
      }
      container.textContent = "";
      container.classList.add("has-opt-icon");
      const label = document.createElement("span");
      label.className = "cf-opt-label";
      label.textContent = text;
      container.append(buildIcon(optionIcon), label);
    };

    // Trigger button: replaces the visual select; tab order matches the select.
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "cf-select-trigger";
    trigger.id = `${id}-trigger`;
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", listId);
    if (select.disabled) trigger.disabled = true;
    const ariaLabel = select.getAttribute("aria-label");
    if (ariaLabel) trigger.setAttribute("aria-label", ariaLabel);
    else if (select.labels && select.labels.length) {
      trigger.setAttribute("aria-labelledby", ensureLabelId(select.labels[0]));
    }

    const triggerText = document.createElement("span");
    triggerText.className = "cf-select-value";
    const chevron = document.createElement("span");
    chevron.className = "cf-select-chevron";
    chevron.setAttribute("aria-hidden", "true");
    trigger.append(triggerText, chevron);

    // Listbox popover: top layer, escapes overflow:clip ancestors.
    const listbox = document.createElement("div");
    listbox.className = "cf-select-listbox";
    listbox.id = listId;
    listbox.setAttribute("role", "listbox");
    listbox.setAttribute("popover", "manual");
    if (multiple) listbox.setAttribute("aria-multiselectable", "true");
    if (ariaLabel) listbox.setAttribute("aria-label", ariaLabel);

    // Visually hide the native select but keep it submittable and in the DOM.
    // `aria-hidden` removes the duplicate from the a11y tree; the button is the
    // accessible control. Keep it focusable-by-script-only via tabindex -1 so
    // label clicks land on the trigger, not the hidden select.
    select.classList.add("cf-select-native");
    select.setAttribute("aria-hidden", "true");
    select.tabIndex = -1;

    const wrap = document.createElement("span");
    wrap.className = "cf-select";
    if (multiple) wrap.classList.add("cf-select--multiple");
    select.parentNode.insertBefore(wrap, select);
    wrap.append(select, trigger, listbox);

    /** @type {HTMLDivElement[]} option rows, parallel to select.options */
    let rows = [];
    let activeIndex = -1; // index into select.options of the active descendant

    function rebuildOptions() {
      listbox.textContent = "";
      rows = [];
      Array.from(select.options).forEach((option, i) => {
        const row = document.createElement("div");
        row.className = "cf-select-option";
        row.id = `${id}-opt-${i}`;
        row.setAttribute("role", "option");
        setLabel(row, labelText(option) || " ");
        if (option.disabled) row.setAttribute("aria-disabled", "true");
        row.addEventListener("click", () => {
          if (option.disabled) return;
          chooseIndex(i);
        });
        row.addEventListener("mousemove", () => setActive(i, false));
        listbox.append(row);
        rows[i] = row;
      });
      syncSelectedState();
    }

    function syncSelectedState() {
      const options = select.options;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const option = options[i];
        if (!row || !option) continue;
        row.setAttribute("aria-selected", option.selected ? "true" : "false");
        row.classList.toggle("is-selected", option.selected);
        if (option.disabled) row.setAttribute("aria-disabled", "true");
        else row.removeAttribute("aria-disabled");
      }
      updateTriggerText();
    }

    function updateTriggerText() {
      if (multiple) {
        const chosen = Array.from(select.selectedOptions).map(labelText);
        triggerText.textContent = chosen.length
          ? chosen.join(", ")
          : (select.dataset.placeholder || "Select…");
        triggerText.classList.toggle("is-placeholder", chosen.length === 0);
        return;
      }
      const option = select.selectedOptions[0] || select.options[select.selectedIndex];
      setLabel(triggerText, option ? labelText(option) : "");
      triggerText.classList.remove("is-placeholder");
    }

    function isOpen() {
      return listbox.matches(":popover-open");
    }

    function setActive(index, scroll = true) {
      if (activeIndex >= 0 && rows[activeIndex]) rows[activeIndex].classList.remove("is-active");
      activeIndex = index;
      if (index >= 0 && rows[index]) {
        rows[index].classList.add("is-active");
        listbox.setAttribute("aria-activedescendant", rows[index].id);
        if (scroll) rows[index].scrollIntoView({ block: "nearest" });
      } else {
        listbox.removeAttribute("aria-activedescendant");
      }
    }

    function firstEnabled(from, dir) {
      const n = select.options.length;
      for (let step = 0; step < n; step++) {
        const i = from + dir * step;
        if (i < 0 || i >= n) break;
        if (!select.options[i].disabled) return i;
      }
      return -1;
    }

    function chooseIndex(i) {
      const option = select.options[i];
      if (!option || option.disabled) return;
      if (multiple) {
        option.selected = !option.selected;
        emitChange();
        syncSelectedState();
        setActive(i);
        // Multi-select stays open so several can be toggled.
      } else {
        if (select.selectedIndex !== i) {
          select.selectedIndex = i;
          emitChange();
        }
        syncSelectedState();
        close(true);
      }
    }

    function emitChange() {
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function open() {
      if (isOpen() || trigger.disabled) return;
      rebuildOptions();
      position();
      listbox.showPopover();
      trigger.setAttribute("aria-expanded", "true");
      const start = select.selectedIndex >= 0 && !select.options[select.selectedIndex].disabled
        ? select.selectedIndex
        : firstEnabled(0, 1);
      setActive(start);
      addOpenListeners();
    }

    function close(focusTrigger) {
      if (!isOpen()) return;
      listbox.hidePopover();
      trigger.setAttribute("aria-expanded", "false");
      setActive(-1);
      removeOpenListeners();
      if (focusTrigger) trigger.focus();
    }

    function position() {
      // Fixed positioning against the viewport (the popover is in the top
      // layer, so it ignores ancestor overflow/transform). Flip above when the
      // list would overflow the bottom of the viewport.
      // getBoundingClientRect()/innerHeight are visual (post-zoom) coords, but
      // CSS lengths we set are re-multiplied by the root zoom (#154 density), so
      // every length written below is divided by `zoom` to land where intended.
      const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const r = trigger.getBoundingClientRect();
      listbox.style.minWidth = `${r.width / zoom}px`;
      listbox.style.left = `${Math.round(r.left / zoom)}px`;
      listbox.style.top = "0px";
      listbox.style.maxHeight = "";
      // Measure after width is set; rect height stays in visual space like r.
      const lh = listbox.getBoundingClientRect().height;
      const below = window.innerHeight - r.bottom;
      const above = r.top;
      const margin = 6;
      if (below >= lh + margin || below >= above) {
        listbox.style.top = `${Math.round((r.bottom + 4) / zoom)}px`;
        listbox.style.maxHeight = `${Math.max(80, below - margin - 4) / zoom}px`;
      } else {
        listbox.style.top = `${Math.round(Math.max(margin, r.top - lh - 4) / zoom)}px`;
        listbox.style.maxHeight = `${Math.max(80, above - margin - 4) / zoom}px`;
      }
    }

    const onScroll = () => {
      if (!isOpen()) return;
      // Scroll-away: if the trigger left the viewport, close; else reposition.
      const r = trigger.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) close(false);
      else position();
    };
    const onResize = () => {
      if (isOpen()) position();
    };
    const onDocPointer = (event) => {
      if (!isOpen()) return;
      if (wrap.contains(event.target) || listbox.contains(event.target)) return;
      close(false);
    };
    function addOpenListeners() {
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onResize);
      document.addEventListener("pointerdown", onDocPointer, true);
    }
    function removeOpenListeners() {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerdown", onDocPointer, true);
    }

    // Type-ahead buffer (matches native select behaviour).
    let typeBuffer = "";
    let typeTimer = null;
    function typeAhead(char) {
      typeBuffer += char.toLowerCase();
      if (typeTimer) clearTimeout(typeTimer);
      typeTimer = setTimeout(() => {
        typeBuffer = "";
      }, 600);
      const n = select.options.length;
      const from = (activeIndex >= 0 ? activeIndex : select.selectedIndex) + 1;
      for (let step = 0; step < n; step++) {
        const i = (from + step) % n;
        const option = select.options[i];
        if (option.disabled) continue;
        if (labelText(option).toLowerCase().startsWith(typeBuffer)) {
          setActive(i);
          return;
        }
      }
    }

    trigger.addEventListener("click", () => {
      if (isOpen()) close(true);
      else open();
    });

    trigger.addEventListener("keydown", (event) => {
      const key = event.key;
      if (!isOpen()) {
        if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
          event.preventDefault();
          open();
        } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          open();
          typeAhead(key);
        }
        return;
      }
      switch (key) {
        case "ArrowDown": {
          event.preventDefault();
          const next = firstEnabled((activeIndex < 0 ? -1 : activeIndex) + 1, 1);
          if (next >= 0) setActive(next);
          break;
        }
        case "ArrowUp": {
          event.preventDefault();
          const prev = firstEnabled((activeIndex < 0 ? select.options.length : activeIndex) - 1, -1);
          if (prev >= 0) setActive(prev);
          break;
        }
        case "Home": {
          event.preventDefault();
          const first = firstEnabled(0, 1);
          if (first >= 0) setActive(first);
          break;
        }
        case "End": {
          event.preventDefault();
          const last = firstEnabled(select.options.length - 1, -1);
          if (last >= 0) setActive(last);
          break;
        }
        case "Enter":
        case " ": {
          event.preventDefault();
          if (activeIndex >= 0) chooseIndex(activeIndex);
          break;
        }
        case "Escape": {
          event.preventDefault();
          close(true);
          break;
        }
        case "Tab": {
          close(false);
          break;
        }
        default: {
          if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            typeAhead(key);
          }
        }
      }
    });

    // Reflect changes made to the native select by other scripts: programmatic
    // .value writes, option disabled toggles, and option add/remove. Both a
    // `change` listener (for .value writes that dispatch change, like our own)
    // and a MutationObserver (for attribute/childList changes that don't).
    select.addEventListener("change", () => {
      if (isOpen()) rebuildOptions();
      else syncSelectedState();
    });
    const observer = new MutationObserver(() => {
      // Disabled state on the select itself.
      trigger.disabled = select.disabled;
      if (isOpen()) {
        rebuildOptions();
        position();
      } else {
        rebuildOptions();
      }
    });
    observer.observe(select, {
      attributes: true,
      attributeFilter: ["disabled"],
      childList: true,
      subtree: true,
    });

    rebuildOptions();
  }

  function ensureLabelId(label) {
    if (!label.id) label.id = `cf-lbl-${++idSeq}`;
    return label.id;
  }

  function enhanceAll(root) {
    const scope = root instanceof Element || root instanceof Document ? root : document;
    if (scope instanceof Element && scope.matches && scope.matches("select")) enhance(scope);
    const selects = scope.querySelectorAll ? scope.querySelectorAll("select") : [];
    for (const select of selects) {
      if (select instanceof HTMLSelectElement) enhance(select);
    }
  }

  enhanceAll(document);
  // Enhance selects added later (e.g. by disclosure toggles or fragment swaps).
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) enhanceAll(node);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
