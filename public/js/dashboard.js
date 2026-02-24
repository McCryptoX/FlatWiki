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

  onReady(() => {
    const mobileToggle = document.querySelector("[data-mobile-menu-toggle]");
    const mobileClose = document.querySelector("[data-mobile-menu-close]");
    const mobileSidebar = document.querySelector("[data-mobile-sidebar]");
    const mobileOverlay = document.querySelector("[data-mobile-overlay]");

    if (
      !(mobileToggle instanceof HTMLButtonElement) ||
      !(mobileSidebar instanceof HTMLElement) ||
      !(mobileOverlay instanceof HTMLElement)
    ) {
      return;
    }

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
        return;
      }
      unlockBodyScroll();
      const target = drawerFocusOrigin instanceof HTMLElement ? drawerFocusOrigin : mobileToggle;
      target.focus();
      drawerFocusOrigin = null;
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
  });
})();
