# UI Migration Notes (Sidebar + Cards Mix)

## What Changed
- Global app shell now uses:
  - Persistent desktop sidebar (navigation + active states)
  - Top header with breadcrumb and primary action
  - Mobile off-canvas drawer with overlay
- Drawer behavior now includes:
  - open/close via trigger, close button, overlay click, and `Esc`
  - focus trap while open
  - focus restoration to trigger on close
  - body scroll lock compatible with mobile browsers
- Theme tokens were aligned to clearer dark-mode surface contrast.
- Dashboard/ToC rows now use clickable row containers with explicit hover/focus surfaces.
- Main content container now uses consistent responsive horizontal padding.

## Files Updated
- `src/lib/render.ts`
- `public/css/theme.css`
- `public/css/components.css`
- `public/js/main.js`
- `docs/mobile-qa.md`

## Rollback
1. Revert these files in git.
2. Rebuild assets and TypeScript output.
3. Re-run smoke checks for login, search, article view/edit, admin, uploads.

## Notes
- Backend/template bindings were preserved (routes, form fields, query params, dynamic placeholders).
- Interaction logic remains lightweight and framework-free.
