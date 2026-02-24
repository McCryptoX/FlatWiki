(function () {
  "use strict";

  function getEffective() {
    var attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
    var s = localStorage.getItem("fw-theme");
    if (s === "dark" || s === "light") return s;
    return "dark";
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("fw-theme", theme);
    updateIcons();
  }

  function updateIcons() {
    var icons = document.querySelectorAll(".theme-toggle-icon");
    var sunIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"/></svg>';
    for (var i = 0; i < icons.length; i++) {
      icons[i].innerHTML = sunIcon;
    }
  }

  // Persist theme server-side for logged-in users.
  // Reads CSRF token from the logout form (always present when user is logged in).
  function persistThemeToServer(theme) {
    var csrfInput = document.querySelector('input[name="_csrf"]');
    if (!csrfInput) return; // guest — no CSRF token available, skip
    var csrf = csrfInput.value;
    if (!csrf) return;

    fetch("/api/user/theme", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf
      },
      body: JSON.stringify({ theme: theme }),
      credentials: "same-origin"
    }).catch(function () {
      // Non-critical: ignore network errors; localStorage already updated
    });
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-theme-toggle]");
    if (!btn) return;
    var next = getEffective() === "dark" ? "light" : "dark";
    apply(next);
    persistThemeToServer(next);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateIcons);
  } else {
    updateIcons();
  }

  matchMedia("(prefers-color-scheme:dark)").addEventListener("change", function () {
    if (!localStorage.getItem("fw-theme")) {
      document.documentElement.setAttribute(
        "data-theme",
        matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light"
      );
      updateIcons();
    }
  });
})();
