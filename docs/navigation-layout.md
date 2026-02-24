# Navigation & Layout Architecture

This project now uses three explicit layout modes to avoid ad-hoc page structures.

## 1) AppShell (default)
- Used by all regular pages.
- Structure:
  - Left: global sidebar navigation.
  - Topbar: breadcrumb (left), actions (right).
  - Content: centered page container with consistent responsive padding.
- Topbar actions are consistent across pages:
  - Search shortcut icon (opens `/search`)
  - Primary action (for authenticated users: `Neue Seite`)
  - Theme toggle
- Search duplication rule:
  - Home and search page own the primary search UI in content.
  - Topbar keeps only the shortcut icon (no full input field).

## 2) AdminShell (AppShell + Subnav)
- Admin pages stay inside AppShell and include an admin sub-navigation block in page content.
- Admin sub-navigation is a dedicated component (`renderAdminNav`), not custom one-off markup.
- Responsive behavior:
  - Desktop: vertical/column-like admin subnav block next to admin content.
  - Narrow viewports: subnav wraps into compact grid layout.

## 3) EditorShell (inside AppShell)
- "Neue Seite" and "Bearbeiten" now render inside AppShell (not separate fullscreen shell).
- Keeps navigation orientation, breadcrumb, and topbar actions consistent with the rest of the app.
- Editor-specific toolbar and settings remain available in content area.

## Consistency Rules for Future Pages
- New pages should default to AppShell.
- Use AdminShell only for `/admin/*` pages.
- Avoid introducing page-specific headers that duplicate topbar behavior.
- Keep one primary search input per page.
- Preserve accessibility basics:
  - visible focus states
  - icon buttons with `aria-label`
  - touch targets >= 44x44
