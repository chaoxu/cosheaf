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
