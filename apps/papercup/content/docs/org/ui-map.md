---
title: UI map
description: Every page in the Papercup web app, what's there, how it connects.
---

Papercup ships as a Next.js app at `apps/web/app/papercup/` and is also rendered, in `readOnly` form, by [`papercupai.com`](https://papercupai.com) (`apps/public-site/`). Both render the same components — drawn from four shared libraries (`libs/papercup-shared`, `libs/git-graph`, `libs/agent-chat`, `libs/ui-primitives`) — so any visible change ships to both.

The 3 newer libs are extracted as **git submodules** under [`github.com/papercupai/`](https://github.com/papercupai); see [Shared component libraries](/docs/architecture/shared-libs).

It's the operator's surface — directors run autonomously, you observe and intervene.

## Top-level routes (admin: `/papercup/...`)

| Route | What's there |
|---|---|
| `/papercup` | 307 redirect → `/papercup/harnesses` |
| `/papercup/documentation` | Redirects to `/docs` — these docs are now embedded directly as the `(docs)` route group in `apps/papercup` (formerly an iframe to a standalone `apps/papercup-docs` Starlight site) |
| `/papercup/harnesses` | Embedded coding/department harness dashboard with project picker |
| `/papercup/organization` | Department reference: 5 dept lanes with mandates + inbox/outbox kind chips |
| `/papercup/directives` | Directive index — list, expand, route, status, summaries, "+ New directive" modal |
| `/papercup/projects` | Project portfolio grouped by vertical — "+ New project" |
| `/papercup/timeline` | Cross-department activity feed with filters |
| `/papercup/briefings` | Investor briefing summaries |

The tab strip lives in `libs/papercup-shared/src/PapercupTabs.tsx`. Tab order is **deliberate**: Documentation first (so new operators learn the model before acting), Harnesses second (the daily-use surface), then reference tabs.

## Public site mirror (`papercupai.com`)

The same tabs exist on the public site mounted with `basePath=""`:

| Route | Notes |
|---|---|
| `/` | Home — directives overview + chat box |
| `/harnesses` | **Embedded admin HarnessDashboard.** Clicks go through a fetch interceptor that rewrites `/api/harness/*` → `https://api.papercupai.com/api/public/papercup/_admin/*` (the sanitized read-only mirror) |
| `/harnesses/:slug` | Same dashboard scoped to one project (department harness or coding harness) |
| `/organization` | Same component as admin, no edit affordances |
| `/directives` / `/projects` / `/timeline` / `/briefings` / `/documentation` | Read-only versions |

The public site **fetches live** from `api.papercupai.com` (a Cloudflare tunnel pointing at the local `:3001` admin app); it does NOT just snapshot to disk. A small inline `<head>` script in `apps/public-site/app/preview/_lib/proxy-script.ts` patches `window.fetch` and `EventSource` to route admin URLs through the sanitized public mirror. Localhost-only fetches (admin's `code-server:8082`, `docs:4325`, etc.) are silently no-op'd by the same script so they don't generate console errors.

### Read-only enforcement

Any non-GET admin fetch from the public site is intercepted before it leaves the browser and turned into a friendly toast — e.g. "Launch run is read-only on the public site". This:

- Prevents the bot mirror from having to explain 405s in JSON to end users.
- Fixes silent-success bugs where admin-side callsites do `await fetch(...)` without checking `res.ok`.

The endpoint→action-label map lives in `proxy-script.ts` `WRITE_LABELS`. Adding a new write endpoint to the harness UI? It'll be blocked + toasted on the public site automatically. Add a regex to `WRITE_LABELS` if you want a more specific message than the generic "Write action".

The toast component is at `apps/public-site/app/_components/ReadOnlyToastListener.tsx` and is mounted globally in the layout.

### Deploy

The public site is a Cloudflare Worker (Workers Static Assets) named `papercup-public-site`. Source is on GitHub at [`papercupai/papercup-public-site`](https://github.com/papercupai/papercup-public-site) (private). Every push to `main` triggers a CF Workers Build that runs `npm run build` (Next.js static export → `apps/public-site/out/`) and `npx wrangler deploy`. End-to-end push-to-live is ~90 seconds.

## Detail pages (deep-linkable)

| Route | What's there |
|---|---|
| `/papercup/directives/:id` | Body, status, metadata, action buttons, linked projects grid, summary log + add form, linked messages |
| `/papercup/projects/:slug` | Multi-section detail: Overview (with sourceDirective linkback + scope + capabilities counts), Timeline, Build (links to harness), Capabilities, Spinouts, Campaigns, Settings (with delete Danger zone) |
| `/papercup/messages/:id` | Single message body, metadata, status, in-response-to, responses, comments + add form |
| `/harness/:slug` | Smart router: opens the **Department Harness Dashboard** for `org-*` slugs, the **coding harness** for everything else |

## The Harnesses page

`/papercup/harnesses` is intentionally minimal — just the embedded `HarnessDashboard` (the live in-browser coding-harness console) with its project dropdown.

The dropdown lists every project registered in `~/.restart-harness-projects.json`:

- **Department harnesses** — `org-business`, `org-rd`, `org-technology`, `org-management`, `org-marketing` (`harness_kind: "department"`)
- **Coding harnesses** — `sheets`, `restart`, etc. (`harness_kind: "coding"`)

Selecting a department slug routes you to its **Department Harness Dashboard**. Selecting a coding-harness slug opens the standard planner/worker/validator console for that project.

The previous incarnation of `/papercup/harnesses` had a top-cockpit (KPI strip, per-dept ops cards with Run-now/Auto-toggle/View-latest-run, Active Runs, Backlog by status, Recent Audit feed) — judged redundant with per-dept controls accessible via the project dropdown. The cockpit code is preserved at `libs/papercup-shared/src/_discarded/HarnessOpsCockpit.tsx` and can be re-exported in one line if reconsidered.

## Department Harness Dashboard (`/harness/org-{dept}`)

When `/harness/org-{dept}` resolves, you see the per-director surface with **8 tabs**:

1. **Inbox** — pending messages with kind badge, status, click to open detail
2. **Outbox** — messages this dept has emitted
3. **Compose** — kind selector (limited to dept's allowed `outboxKinds`), multi-select recipients, project picker (required), subject, body
4. **Decisions** — `decision-log.md` viewer
5. **Charter** — canonical charter markdown (read-only; edit via `PUT /api/org/charter`)
6. **Director notes** — editable textarea + Save (writes `~/org-{dept}/.harness/director-notes.md`)
7. **Memory** — synthesized table of the last N director runs (when / decision keyword / first action / final outcome). The **same synthesized text is injected into every director prompt** so directors notice their own patterns. Limit selector (6/12/24/50). Collapsible "Raw text injected into prompt" inspector.
8. **Director agent** — prompt resolver (role/mode selectors), "▶ Run director" + "Show prompt only", live result panel, recent-runs disclosure with inline expansion, run controls (auto-loop toggle, interval, scheduler countdown, Run-now / Stop, stats strip)

## Organization page

`/papercup/organization` is intentionally a **reference page** — "what does each director do, what messages do they emit and consume." No live operations controls (those live in each dept's Director Agent tab inside the harness console).

It renders just:

- 1-line hero linking to Harnesses for live ops
- The 5 dept lane grid: each card shows mandate text, inbox/outbox kind chips, pending pressure bar, last activity, and links into `/harness/org-{slug}`

Earlier versions had a hero metric grid, pulse cards, workload-matrix table, and handoff-map flow — all stripped because each duplicated information available on other tabs.

## Navigation

- The Restart app's left-side nav (`apps/web/components/Nav.tsx`) includes `Papercup` under the `Agents` group, between Meridian and Harness.
- Inside Papercup, the tab strip from `libs/papercup-shared/src/PapercupTabs.tsx` shows the 8 tabs on every Papercup route.
