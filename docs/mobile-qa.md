# Mobile QA Checklist

## Scope
- Target devices: iPhone Safari, Android Chrome, iPad Safari, small tablets.
- Breakpoint rule: `<md` drawer layout, `md+` persistent sidebar.

## Navigation + Layout
- [ ] On mobile (`<md`), sidebar is hidden by default and opens as off-canvas drawer.
- [ ] On tablet/desktop (`md+`), sidebar is permanently visible.
- [ ] Main content keeps readable max width and consistent horizontal padding.
- [ ] Header layering is correct: header below drawer, overlay below drawer.

## Drawer Behavior (Critical)
- [ ] Drawer opens via burger button.
- [ ] Drawer closes via close button.
- [ ] Drawer closes by tapping overlay.
- [ ] Drawer closes on `Esc`.
- [ ] Focus is trapped inside drawer while open (`Tab` and `Shift+Tab`).
- [ ] After close, focus returns to burger trigger.
- [ ] Background scrolling is locked while drawer is open (including iOS Safari).
- [ ] Safe-area insets apply (`env(safe-area-inset-top/bottom)`).

## Touch + Accessibility
- [ ] Icon buttons meet at least 44x44px tap target.
- [ ] Interactive rows in lists/cards have clear hover/focus surfaces.
- [ ] Keyboard focus rings are visible on links, buttons, form controls.
- [ ] Icon-only controls provide `aria-label`.
- [ ] Drawer toggle has `aria-expanded` + `aria-controls`.

## Content Robustness
- [ ] Markdown code blocks scroll horizontally instead of overflowing viewport.
- [ ] Tables remain usable on small screens with horizontal scroll.
- [ ] Long links in article content wrap and do not break layout.

## Manual Device Matrix
- [ ] iPhone Safari: open/close drawer, focus trap, scroll lock, code block/table overflow.
- [ ] Android Chrome: same checks as iPhone.
- [ ] iPad Safari: keyboard focus behavior and drawer overlay/layering.

## Regression Flow Checks
- [ ] Login/logout reachable on mobile and desktop.
- [ ] Search + advanced filters usable from mobile and desktop.
- [ ] Open article, edit/save, history view still functional.
- [ ] Admin and uploads pages remain reachable for admin users.
