(function () {
  var observing = false;

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
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
