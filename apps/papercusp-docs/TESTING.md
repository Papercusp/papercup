# TESTING — @papercupai/papercusp-docs

Public-facing user manual for Papercusp. Engine: **Starlight (on Astro)** —
migrated off fumadocs 2026-05-20 so the repo carries a single docs engine.
(The internal *engineering* docs are a separate Starlight app, `apps/operator-docs`.)

This is a standalone static site. It is not yet wired into any deploy or
into the operator — `astro build` emits static HTML to `dist/` and that's it.

## Verify after editing

| Edit touches | Run |
| --- | --- |
| `src/content/docs/**` markdown | `npm run build` — Astro fails the build on broken MDX / frontmatter |
| `astro.config.mjs` / sidebar | `npm run dev`, open `http://localhost:4321/docs`, eyeball nav |
| Anything visible to users | `npm run build && npm run preview`, then a `verdict` smoke against the preview URL |

## Not covered

- In-content link integrity — no automated checker yet. In-content links are
  written `/docs/<slug>`; they resolve because `astro.config.mjs` sets
  `base: '/docs'`.
- Search index quality (Pagefind) — verified manually.
