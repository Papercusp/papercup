# Papercup

The first reference install of Papercusp — a 5-department fictional company
with a cross-dept message bus, directives, and an automated YouTube
shareholder-briefing pipeline.

This standalone Next.js app is the eventual home of Papercup's admin UI. As of
Stage 4 of the Papercusp/Papercup split, it's a **shell** that redirects
to the legacy Papercup admin still living at `apps/web/app/papercup/*` (port
3001). The physical extraction is intentionally deferred — see PLAN.md for
the staged migration plan.

## Dev

```sh
npm run dev:papercup     # from repo root, port 3061
```
