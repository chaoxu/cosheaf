(function () {
  var observing = false;
  var scrollKeyPrefix = "cosheaf:doc-scroll:";

  function setCollapsed(side, collapsed) {
    var attr = side === "left" ? "data-cosheaf-left-rail" : "data-cosheaf-right-rail";
    var key = side === "left" ? "cosheaf:left-rail" : "cosheaf:right-rail";
    if (collapsed) {
      document.documentElement.setAttribute(attr, "collapsed");
      try { localStorage.setItem(key, "collapsed"); } catch (_err) {}
    } else {
      document.documentElement.removeAttribute(attr);
      try { localStorage.setItem(key, "expanded"); } catch (_err) {}
    }
  }

  function isCollapsed(side) {
    var attr = side === "left" ? "data-cosheaf-left-rail" : "data-cosheaf-right-rail";
    return document.documentElement.getAttribute(attr) === "collapsed";
  }

  function installToggle(container, side) {
    if (!container || container.querySelector(":scope > .rail-collapse-toggle")) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "rail-collapse-toggle";
    button.dataset.railSide = side;
    function sync() {
      var collapsed = isCollapsed(side);
      button.setAttribute("aria-expanded", collapsed ? "false" : "true");
      button.setAttribute("aria-label", collapsed ? "Expand " + side + " rail" : "Collapse " + side + " rail");
      button.title = button.getAttribute("aria-label") || "";
      button.textContent = side === "left" ? (collapsed ? ">" : "<") : (collapsed ? "<" : ">");
    }
    button.addEventListener("click", function () {
      setCollapsed(side, !isCollapsed(side));
      sync();
    });
    sync();
    container.prepend(button);
  }

  function appContent() {
    return document.querySelector(".app-content");
  }

  function visibleDocumentScroller() {
    var candidates = Array.prototype.slice.call(document.querySelectorAll(".doc-main"));
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      if (!(candidate instanceof HTMLElement)) continue;
      var rect = candidate.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (candidate.scrollHeight > candidate.clientHeight + 1) return candidate;
    }
    return appContent();
  }

  function documentScrollKey(urlValue) {
    try {
      var url = new URL(urlValue, window.location.href);
      var parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 6 && parts[2] === "src" && parts[3] === "branch") {
        return scrollKeyPrefix + parts[0] + "/" + parts[1] + "/" + decodeURIComponent(parts.slice(5).join("/"));
      }
    } catch (_err) {}
    return null;
  }

  function rememberDocumentScroll() {
    if (!document.querySelector(".doc-with-toc")) return;
    var key = documentScrollKey(window.location.href);
    var container = visibleDocumentScroller();
    if (!key || !container) return;
    try { sessionStorage.setItem(key, String(container.scrollTop)); } catch (_err) {}
  }

  function restoreDocumentScroll() {
    if (!document.querySelector(".doc-with-toc")) return;
    var key = documentScrollKey(window.location.href);
    var container = visibleDocumentScroller();
    if (!key || !container) return;
    var value = null;
    try { value = sessionStorage.getItem(key); } catch (_err) {}
    if (value === null) return;
    var top = Number(value);
    if (!Number.isFinite(top) || top <= 0) return;
    requestAnimationFrame(function () {
      container.scrollTo({ top: top, left: 0, behavior: "auto" });
    });
  }

  function scrollByKey(container, key) {
    var line = 48;
    var page = Math.max(line, container.clientHeight * 0.86);
    switch (key) {
      case "ArrowDown":
        container.scrollBy({ top: line, behavior: "auto" });
        return true;
      case "ArrowUp":
        container.scrollBy({ top: -line, behavior: "auto" });
        return true;
      case "PageDown":
      case " ":
        container.scrollBy({ top: page, behavior: "auto" });
        return true;
      case "PageUp":
        container.scrollBy({ top: -page, behavior: "auto" });
        return true;
      case "Home":
        container.scrollTo({ top: 0, behavior: "auto" });
        return true;
      case "End":
        container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
        return true;
      default:
        return false;
    }
  }

  function installDocumentKeyScroll() {
    document.addEventListener("keydown", function (event) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      var target = event.target;
      if (target instanceof HTMLElement) {
        if (target.closest("input, textarea, select, [contenteditable='true']")) return;
      }
      var container = visibleDocumentScroller();
      if (!container || container.scrollHeight <= container.clientHeight + 1) return;
      if (!scrollByKey(container, event.key)) return;
      event.preventDefault();
    });
  }

  function installModeScrollBridge() {
    document.addEventListener("click", function (event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var target = event.target;
      if (!(target instanceof HTMLElement)) return;
      var anchor = target.closest("a[data-doc-mode-link]");
      if (!anchor) return;
      rememberDocumentScroll();
    }, { capture: true });
    restoreDocumentScroll();
    installDocumentKeyScroll();
  }

  function boot() {
    installToggle(document.querySelector(".app-sidebar"), "left");
    document.querySelectorAll(".web-editor-outline, .doc-rail, .thread-rail").forEach(function (rightRail) {
      installToggle(rightRail, "right");
    });
    if (!observing && "MutationObserver" in window && document.body) {
      observing = true;
      new MutationObserver(function () {
        document.querySelectorAll(".web-editor-outline, .doc-rail, .thread-rail").forEach(function (rightRail) {
          installToggle(rightRail, "right");
        });
      }).observe(document.body, { childList: true, subtree: true });
    }
    installModeScrollBridge();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
