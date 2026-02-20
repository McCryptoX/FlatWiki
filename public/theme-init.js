(function () {
  var root = document.documentElement;
  var serverTheme = root.getAttribute("data-theme");
  if (serverTheme === "light" || serverTheme === "dark") {
    try { localStorage.setItem("fw-theme", serverTheme); } catch (_) {}
    return;
  }
  var resolved = "dark";
  try {
    var saved = localStorage.getItem("fw-theme");
    if (saved === "dark" || saved === "light") {
      resolved = saved;
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
      resolved = "light";
    }
  } catch (_) {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
      resolved = "light";
    }
  }
  root.setAttribute("data-theme", resolved);
})();
