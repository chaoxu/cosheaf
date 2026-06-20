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

  function documentScrollKey(urlValue) {
    try {
      var url = new URL(urlValue, window.location.href);
      var parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 6 && parts[2] === "src" && parts[3] === "branch") {
        return scrollKeyPrefix + parts[0] + "/" + parts[1] + "/" + decodeURIComponent(parts.slice(5).join("/"));
      }
      if (parts.length >= 3 && parts[2] === "_edit") {
        var path = url.searchParams.get("path");
        if (path) return scrollKeyPrefix + parts[0] + "/" + parts[1] + "/" + path;
      }
    } catch (_err) {}
    return null;
  }

  function rememberDocumentScroll() {
    if (!document.querySelector(".doc-with-toc")) return;
    var key = documentScrollKey(window.location.href);
    var container = appContent();
    if (!key || !container) return;
    try { sessionStorage.setItem(key, String(container.scrollTop)); } catch (_err) {}
  }

  function restoreDocumentScroll() {
    if (!document.querySelector(".doc-with-toc")) return;
    var key = documentScrollKey(window.location.href);
    var container = appContent();
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
