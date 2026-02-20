## 20.02.2026 – Persistent Theme (feature/persistent-theme)

**Feature:** Dauerhaftes Theme für angemeldete User (Light/Dark/System).

- `UserRecord` + `PublicUser` um `theme: Theme` erweitert (`"light"|"dark"|"system"`, Default `"system"`)
- In-Memory-Migration: bestehende User-Datensätze ohne `theme`-Feld erhalten `"system"` beim ersten Load
- Neuer Endpoint `POST /api/user/theme` (Auth, CSRF via `X-CSRF-Token`-Header, Whitelist-Validation, Rate-Limit 10/min)
- Neuer Endpoint `GET /api/user/me` (Auth, gibt `theme` + Basis-Profil zurück)
- `src/lib/render.ts`: setzt `data-theme` auf `<html>` server-seitig für eingeloggte User (außer `system`)
- `public/theme-init.js`: erkennt server-gesetztes `data-theme`, synct in `localStorage`; Gäste: localStorage + `prefers-color-scheme`
- `public/theme-toggle.js`: Toggle POSTet via `fetch` + CSRF-Token an `/api/user/theme`; bei Gästen kein POST (kein CSRF im DOM)
- Atomic writes via bestehendes `writeJsonFile` + Mutation-Lock in `userStore`
- Security: Whitelist verhindert CSS-Injection; non-sensitive UI-Daten → keine Verschlüsselung; CSRF immer geprüft
- Perf: < 1 ms DB-Overhead; kein neues Framework, kein neuer Service

**Nächste Schritte:** Admin-Theme-Edit im User-Edit-Dialog
