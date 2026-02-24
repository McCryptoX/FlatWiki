(() => {
  "use strict";

  const onReady =
    window.FW && typeof window.FW.onReady === "function"
      ? window.FW.onReady
      : (callback) => {
          if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", callback, { once: true });
            return;
          }
          callback();
        };

  const getErrorMessage = (payload) => {
    if (!payload || typeof payload !== "object") return "Watch-Status konnte nicht aktualisiert werden.";
    const error = payload.error;
    return typeof error === "string" && error.trim().length > 0 ? error.trim() : "Watch-Status konnte nicht aktualisiert werden.";
  };

  const setWatchUiState = ({ button, label, feedback, watching, message, isError }) => {
    button.classList.toggle("is-watching", watching);
    button.setAttribute("aria-pressed", watching ? "true" : "false");
    if (label) {
      label.textContent = watching ? "Beobachtet" : "Beobachten";
    }

    if (feedback) {
      feedback.textContent = message || "";
      feedback.classList.toggle("is-error", Boolean(isError));
    }
  };

  onReady(() => {
    if (window.location.pathname === "/search") {
      const searchMainInput = document.querySelector("#search-main-q");
      if (searchMainInput instanceof HTMLInputElement) {
        searchMainInput.focus();
      }
    }

    const isEditableTarget = (target) => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
      if (target instanceof HTMLInputElement) {
        const nonText = new Set(["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image"]);
        return !nonText.has((target.type || "text").toLowerCase());
      }
      return false;
    };

    const focusPrimarySearch = () => {
      const candidates = document.querySelectorAll('input[name="q"][type="search"], .search-box input[name="q"]');
      for (const candidate of candidates) {
        if (!(candidate instanceof HTMLInputElement)) continue;
        const hidden =
          candidate.disabled ||
          candidate.offsetParent === null ||
          candidate.closest("[hidden]") !== null ||
          candidate.getAttribute("aria-hidden") === "true";
        if (hidden) continue;
        candidate.focus();
        candidate.select();
        return true;
      }
      return false;
    };

    const handleGlobalEscape = () => {
      window.dispatchEvent(new CustomEvent("fw:escape"));
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.type === "search" && active.value.length > 0) {
        active.value = "";
        active.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };

    window.addEventListener("keydown", (event) => {
      if (event.defaultPrevented) return;

      if (event.key === "Escape") {
        handleGlobalEscape();
        return;
      }

      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (!focusPrimarySearch()) return;
      event.preventDefault();
    });

    const mobileToggle = document.querySelector("[data-mobile-menu-toggle]");
    const mobileClose = document.querySelector("[data-mobile-menu-close]");
    const mobileSidebar = document.querySelector("[data-mobile-sidebar]");
    const mobileOverlay = document.querySelector("[data-mobile-overlay]");

    if (
      mobileToggle instanceof HTMLButtonElement &&
      mobileSidebar instanceof HTMLElement &&
      mobileOverlay instanceof HTMLElement
    ) {
      let drawerFocusOrigin = null;
      let lockedScrollY = 0;
      const getFocusableInDrawer = () =>
        Array.from(
          mobileSidebar.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((element) => element instanceof HTMLElement && !element.hasAttribute("inert") && element.offsetParent !== null);

      const lockBodyScroll = () => {
        lockedScrollY = window.scrollY || window.pageYOffset || 0;
        document.body.style.top = `-${lockedScrollY}px`;
        document.body.style.width = "100%";
        document.body.classList.add("drawer-open");
      };

      const unlockBodyScroll = () => {
        const top = document.body.style.top;
        document.body.classList.remove("drawer-open");
        document.body.style.top = "";
        document.body.style.width = "";
        const offset = Number.parseInt(top || "0", 10);
        const restoreTo = Number.isFinite(offset) ? Math.abs(offset) : lockedScrollY;
        window.scrollTo(0, restoreTo);
      };

      const setMobileMenu = (open) => {
        mobileSidebar.classList.toggle("open", open);
        mobileOverlay.hidden = !open;
        mobileToggle.setAttribute("aria-expanded", open ? "true" : "false");
        mobileSidebar.setAttribute("aria-hidden", open ? "false" : "true");
        mobileSidebar.toggleAttribute("inert", !open);
        document.body.classList.toggle("mobile-menu-open", open);
        if (open) {
          drawerFocusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : mobileToggle;
          lockBodyScroll();
          const focusables = getFocusableInDrawer();
          const first = focusables[0];
          if (first instanceof HTMLElement) first.focus();
        } else {
          unlockBodyScroll();
          const target = drawerFocusOrigin instanceof HTMLElement ? drawerFocusOrigin : mobileToggle;
          target.focus();
          drawerFocusOrigin = null;
        }
      };

      mobileToggle.addEventListener("click", () => {
        setMobileMenu(!mobileSidebar.classList.contains("open"));
      });

      if (mobileClose instanceof HTMLButtonElement) {
        mobileClose.addEventListener("click", () => setMobileMenu(false));
      }

      mobileOverlay.addEventListener("click", () => setMobileMenu(false));
      mobileSidebar.addEventListener("keydown", (event) => {
        if (event.key !== "Tab" || !mobileSidebar.classList.contains("open")) return;
        const focusables = getFocusableInDrawer();
        if (focusables.length < 1) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) return;
        const current = document.activeElement;
        if (event.shiftKey && current === first) {
          event.preventDefault();
          last.focus();
          return;
        }
        if (!event.shiftKey && current === last) {
          event.preventDefault();
          first.focus();
        }
      });
      window.addEventListener("fw:escape", () => {
        if (mobileSidebar.classList.contains("open")) setMobileMenu(false);
      });
      window.addEventListener("resize", () => {
        if (window.innerWidth > 768 && mobileSidebar.classList.contains("open")) {
          setMobileMenu(false);
        }
      });
    }

    const watchForms = document.querySelectorAll("form[data-watch-form]");
    if (watchForms.length < 1 || typeof window.fetch !== "function") {
      return;
    }

    for (const formElement of watchForms) {
      if (!(formElement instanceof HTMLFormElement)) continue;

      const button = formElement.querySelector("[data-watch-button]");
      if (!(button instanceof HTMLButtonElement)) continue;

      const label = formElement.querySelector("[data-watch-label]");
      const feedback = formElement.querySelector("[data-watch-feedback]");

      let pending = false;

      formElement.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (pending) return;

        pending = true;
        button.disabled = true;
        button.classList.add("is-pending");

        const formData = new FormData(formElement);
        const body = new URLSearchParams();
        for (const [key, value] of formData.entries()) {
          if (typeof value === "string") {
            body.append(key, value);
          }
        }

        body.set("mode", "toggle");

        if (feedback instanceof HTMLElement) {
          feedback.textContent = "Speichern...";
          feedback.classList.remove("is-error");
        }

        try {
          const response = await fetch(formElement.action, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "X-Requested-With": "XMLHttpRequest"
            },
            body,
            credentials: "same-origin"
          });

          const payload = await response.json().catch(() => null);
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error(getErrorMessage(payload));
          }

          setWatchUiState({
            button,
            label: label instanceof HTMLElement ? label : null,
            feedback: feedback instanceof HTMLElement ? feedback : null,
            watching: Boolean(payload.watching),
            message: typeof payload.message === "string" ? payload.message : "",
            isError: false
          });
        } catch (error) {
          setWatchUiState({
            button,
            label: label instanceof HTMLElement ? label : null,
            feedback: feedback instanceof HTMLElement ? feedback : null,
            watching: button.getAttribute("aria-pressed") === "true",
            message: error instanceof Error ? error.message : "Watch-Status konnte nicht aktualisiert werden.",
            isError: true
          });
        } finally {
          pending = false;
          button.disabled = false;
          button.classList.remove("is-pending");
        }
      });
    }
  });
})();
