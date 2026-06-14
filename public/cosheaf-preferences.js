(() => {
  const select = document.querySelector("[data-document-theme-user]");
  if (!(select instanceof HTMLSelectElement)) return;
  const legacyKey = "cosheaf:document-theme";
  const user = select.dataset.documentThemeUser || "";
  const key = user ? `${legacyKey}:${user}` : legacyKey;
  const normalize = (value) => value === "blueprint-book" ? value : "default";
  select.value = normalize(localStorage.getItem(key) || localStorage.getItem(legacyKey));
  select.addEventListener("change", () => {
    localStorage.setItem(key, select.value);
    localStorage.setItem(legacyKey, select.value);
  });
})();

(() => {
  const modeSelect = document.querySelector("[data-diff-mode-user]");
  const shapeSelect = document.querySelector("[data-diff-shape-user]");
  if (!(modeSelect instanceof HTMLSelectElement) || !(shapeSelect instanceof HTMLSelectElement)) return;
  const legacyModeKey = "cosheaf:diff-mode";
  const legacyShapeKey = "cosheaf:diff-shape";
  const user = modeSelect.dataset.diffModeUser || "";
  const modeKey = user ? `${legacyModeKey}:${user}` : legacyModeKey;
  const shapeKey = user ? `${legacyShapeKey}:${user}` : legacyShapeKey;
  const normalizeMode = (value) => value === "source" ? "source" : "rich";
  const normalizeShape = (value, mode) => {
    const shape = value === "unified" || value === "split" || value === "after" ? value : "after";
    return mode === "rich" && shape === "unified" ? "after" : shape;
  };
  const sync = () => {
    const mode = normalizeMode(modeSelect.value);
    const shape = normalizeShape(shapeSelect.value, mode);
    modeSelect.value = mode;
    shapeSelect.value = shape;
    shapeSelect.querySelector('option[value="unified"]').disabled = mode === "rich";
    localStorage.setItem(modeKey, mode);
    localStorage.setItem(shapeKey, shape);
    localStorage.setItem(legacyModeKey, mode);
    localStorage.setItem(legacyShapeKey, shape);
  };
  const initialMode = normalizeMode(localStorage.getItem(modeKey) || localStorage.getItem(legacyModeKey));
  modeSelect.value = initialMode;
  shapeSelect.value = normalizeShape(localStorage.getItem(shapeKey) || localStorage.getItem(legacyShapeKey), initialMode);
  sync();
  modeSelect.addEventListener("change", sync);
  shapeSelect.addEventListener("change", sync);
})();

// Color scheme (#153): Light · Dark · System. The pre-paint head script sets
// html[data-cosheaf-color-scheme] before paint (no flash); this wires the
// settings select and applies the choice live on change. System defers to the
// OS via the CSS @media (prefers-color-scheme) rule, so no JS is needed to
// track OS changes. Default: Light.
(() => {
  const select = document.querySelector("[data-color-scheme-user]");
  if (!(select instanceof HTMLSelectElement)) return;
  const legacyKey = "cosheaf:color-scheme";
  const user = select.dataset.colorSchemeUser || "";
  const key = user ? `${legacyKey}:${user}` : legacyKey;
  const normalize = (value) => (value === "dark" || value === "system" ? value : "light");
  select.value = normalize(localStorage.getItem(key) || localStorage.getItem(legacyKey));
  select.addEventListener("change", () => {
    localStorage.setItem(key, select.value);
    localStorage.setItem(legacyKey, select.value);
    document.documentElement.setAttribute("data-cosheaf-color-scheme", select.value);
  });
})();

// Reader section numbering (#159): On · Off. The reader island reads this on
// hydration via readSectionNumbering() and passes sectionNumbering:false to
// Coflat (coflat#47) to hide heading numbers across reader/thread/diff; crossref
// numbers are unaffected. Applies on the next reader render. Default: On.
(() => {
  const select = document.querySelector("[data-section-numbering-user]");
  if (!(select instanceof HTMLSelectElement)) return;
  const legacyKey = "cosheaf:section-numbering";
  const user = select.dataset.sectionNumberingUser || "";
  const key = user ? `${legacyKey}:${user}` : legacyKey;
  const normalize = (value) => (value === "off" ? "off" : "on");
  select.value = normalize(localStorage.getItem(key) || localStorage.getItem(legacyKey));
  select.addEventListener("change", () => {
    localStorage.setItem(key, select.value);
    localStorage.setItem(legacyKey, select.value);
  });
})();

// Reading width (#151): Narrow · Normal · Wide. The pre-paint head script sets
// html[data-cosheaf-reading] before paint; this wires the settings select and
// applies the choice live (the CSS rule reflows the reader without reload).
// Normal keeps each surface's default; Narrow/Wide override the reading measure.
(() => {
  const select = document.querySelector("[data-reading-width-user]");
  if (!(select instanceof HTMLSelectElement)) return;
  const legacyKey = "cosheaf:reading-width";
  const user = select.dataset.readingWidthUser || "";
  const key = user ? `${legacyKey}:${user}` : legacyKey;
  const normalize = (value) => (value === "narrow" || value === "wide" ? value : "normal");
  select.value = normalize(localStorage.getItem(key) || localStorage.getItem(legacyKey));
  select.addEventListener("change", () => {
    localStorage.setItem(key, select.value);
    localStorage.setItem(legacyKey, select.value);
    document.documentElement.setAttribute("data-cosheaf-reading", select.value);
  });
})();

// UI density / display size (#154): Compact · Normal · Comfortable · Large.
// The pre-paint head script sets html[data-cosheaf-density] before paint (no
// reflow); this wires the settings select and applies the choice live. A single
// root zoom (var --cf-ui-zoom) scales the whole chrome. Default: Normal.
(() => {
  const select = document.querySelector("[data-density-user]");
  if (!(select instanceof HTMLSelectElement)) return;
  const legacyKey = "cosheaf:density";
  const user = select.dataset.densityUser || "";
  const key = user ? `${legacyKey}:${user}` : legacyKey;
  const normalize = (value) => (value === "compact" || value === "comfortable" || value === "large" ? value : "normal");
  select.value = normalize(localStorage.getItem(key) || localStorage.getItem(legacyKey));
  select.addEventListener("change", () => {
    localStorage.setItem(key, select.value);
    localStorage.setItem(legacyKey, select.value);
    document.documentElement.setAttribute("data-cosheaf-density", select.value);
  });
})();

// Persist + restore the issues/pulls list sort + state filter (#157). The list
// filter form carries data-list-prefs="issues|pulls"; we remember the user's
// last chosen state/sort (per user, per list kind) and re-apply it when they
// land on the list with no explicit param. Explicit URL params always win and
// update the saved choice; the defaults (state "open", empty sort) are cleared
// so the common default view never triggers a redundant redirect.
(() => {
  const form = document.querySelector("form[data-list-prefs]");
  if (!form) return;
  const kind = form.dataset.listPrefs;
  const user = document.body.dataset.cosheafUser || "";
  const key = (field) => `cosheaf:list:${kind}:${field}` + (user ? `:${user}` : "");
  const url = new URL(location.href);
  const hasState = url.searchParams.has("state");
  const hasSort = url.searchParams.has("sort");
  const remember = (field, value, def) => {
    if (value === null || value === def) localStorage.removeItem(key(field));
    else localStorage.setItem(key(field), value);
  };
  if (hasState || hasSort) {
    if (hasState) remember("state", url.searchParams.get("state"), "open");
    if (hasSort) remember("sort", url.searchParams.get("sort"), "");
    return;
  }
  const savedState = localStorage.getItem(key("state"));
  const savedSort = localStorage.getItem(key("sort"));
  if (!savedState && !savedSort) return;
  if (savedState) url.searchParams.set("state", savedState);
  if (savedSort) url.searchParams.set("sort", savedSort);
  location.replace(url.toString());
})();

// Default landing mode (#156): Read · Build · Last used. "read"/"build" force
// the chrome lens on every page load; "last" (default) follows the sticky
// last-toggled mode (cosheaf:mode, written by the sidebar toggle). The pre-paint
// head script reads cosheaf:landing-mode before the toggle hydrates so there's
// no flash; this just wires the settings select.
(() => {
  const select = document.querySelector("[data-landing-mode-user]");
  if (!(select instanceof HTMLSelectElement)) return;
  const legacyKey = "cosheaf:landing-mode";
  const user = select.dataset.landingModeUser || "";
  const key = user ? `${legacyKey}:${user}` : legacyKey;
  const normalize = (value) => (value === "read" || value === "build" ? value : "last");
  select.value = normalize(localStorage.getItem(key) || localStorage.getItem(legacyKey));
  select.addEventListener("change", () => {
    localStorage.setItem(key, select.value);
    localStorage.setItem(legacyKey, select.value);
  });
})();

// Autosave preference (#158): Off, or a debounce interval. With #162 autosave
// writes a local draft (not a commit); "off" disables drafting (manual save
// only). The editor reads this on mount via readAutosave(); this wires the
// settings select. Default: Every 1.5s.
(() => {
  const select = document.querySelector("[data-autosave-user]");
  if (!(select instanceof HTMLSelectElement)) return;
  const legacyKey = "cosheaf:autosave";
  const user = select.dataset.autosaveUser || "";
  const key = user ? `${legacyKey}:${user}` : legacyKey;
  const allowed = ["off", "1000", "1500", "3000", "5000"];
  const normalize = (value) => (allowed.includes(value) ? value : "1500");
  select.value = normalize(localStorage.getItem(key) || localStorage.getItem(legacyKey));
  select.addEventListener("change", () => {
    localStorage.setItem(key, select.value);
    localStorage.setItem(legacyKey, select.value);
  });
})();

// Default editor compose mode (#155): the page + comment editors seed their
// initial Rich/Source mode from this; the in-editor toggle still overrides
// per-session. Stored under the same per-user + legacy key pair the editor
// islands read via readEditorMode(). Default: Rich.
(() => {
  const select = document.querySelector("[data-editor-mode-user]");
  if (!(select instanceof HTMLSelectElement)) return;
  const legacyKey = "cosheaf:editor-mode";
  const user = select.dataset.editorModeUser || "";
  const key = user ? `${legacyKey}:${user}` : legacyKey;
  const normalize = (value) => (value === "source" ? "source" : "rich");
  select.value = normalize(localStorage.getItem(key) || localStorage.getItem(legacyKey));
  select.addEventListener("change", () => {
    localStorage.setItem(key, select.value);
    localStorage.setItem(legacyKey, select.value);
  });
})();

// Date/time rendering. The server emits <time data-cosheaf-time datetime="ISO">
// with an Absolute-short fallback; this rewrites every such element to the
// user's chosen format in their local timezone (fixing the server-tz bug), and
// keeps the full absolute timestamp on hover. Runs on every page (loaded
// globally), so it must not assume the settings select is present. Default:
// Relative.
(() => {
  const legacyKey = "cosheaf:time-format";
  const userKey = () => {
    const u = document.body && document.body.dataset ? document.body.dataset.cosheafUser || "" : "";
    return u ? `${legacyKey}:${u}` : legacyKey;
  };
  const normalize = (value) => (value === "absolute" ? "absolute" : "relative");
  let mode = normalize(localStorage.getItem(userKey()) || localStorage.getItem(legacyKey));

  const rel = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return "now";
    const m = Math.round(s / 60);
    if (m < 45) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 22) return `${h}h`;
    const d = Math.round(h / 24);
    if (d < 26) return `${d}d`;
    const mo = Math.round(d / 30.44);
    if (mo < 11) return `${mo}mo`;
    return `${Math.round(d / 365.25)}y`;
  };
  const absShort = (date) => date.toLocaleDateString(undefined, { year: "2-digit", month: "numeric", day: "numeric" });
  const full = (date) => date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  const applyOne = (el) => {
    const iso = el.getAttribute("datetime");
    if (!iso) return;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return;
    el.textContent = mode === "relative" ? rel(date.getTime()) : absShort(date);
    el.title = full(date);
  };
  const applyAll = (root) => {
    if (root instanceof Element && root.matches("time[data-cosheaf-time]")) applyOne(root);
    if (root.querySelectorAll) for (const el of root.querySelectorAll("time[data-cosheaf-time]")) applyOne(el);
  };
  applyAll(document);
  new MutationObserver((muts) => {
    for (const mu of muts) for (const node of mu.addedNodes) if (node.nodeType === 1) applyAll(node);
  }).observe(document.body, { childList: true, subtree: true });

  const pick = document.querySelector("[data-cosheaf-time-user]");
  if (pick instanceof HTMLSelectElement) {
    pick.value = mode;
    pick.addEventListener("change", () => {
      mode = normalize(pick.value);
      localStorage.setItem(userKey(), mode);
      localStorage.setItem(legacyKey, mode);
      applyAll(document);
    });
  }
})();
