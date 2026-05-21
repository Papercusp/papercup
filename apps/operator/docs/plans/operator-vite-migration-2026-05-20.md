---
title: Operator Vite migration — frontend/host scope
slug: operator-vite-migration-2026-05-20
status: active
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
companion: host-architecture-2026-05-20-v2.md
supersedes_for_my_scope: [next-removal-2026-05-20]
---

## Now

**State:** Phase 0 in progress (2026-05-20). Scope: app shell, router, Vite/build, and the `@hono/node-server` host process. **The backend endpoint-decoupling stream has SHIPPED** — see the status banner below. This migration is now **single-stream**: there is no parallel race, no coordination window, no Next sidecar.

**Next:** Finish Phase 0 (`BOUNDARY.md` written; coord entry pending), then Phase A scaffold of `apps/operator-vite/`.

---

## Status banner — backend stream shipped (2026-05-20)

The v1/v2 plan was written assuming two parallel streams racing toward a cutover. **That assumption is now stale, in our favor.** As of 2026-05-20:

- `endpoint-route-migration-2026-05-20.md` has `status: shipped`. Git log: `endpoint-route migration SHIPPED — R1-R6 complete`, `coord(endpoints): R5 complete milestone — 0 raw route.ts remain`, `feat(endpoint-route): port openapi.json — R5 COMPLETE`.
- **0 API `route.ts` files remain.** All of `/api/*` is served by `_hono/app.ts` mounts. The only `route.ts` files left are the catch-all shim + the two page-namespace handlers (`/wiki`, `/drizzle-studio`) — see [Inventory](#inventory-greppable-all-under-appsoperatorapp).
- `openapi.json` was ported to a Hono route (review item #16 — done by the backend agent, as offered).
- `export { app }` is at `app/api/_hono/app.ts:111`.

**What this collapses:**

| v2 plan assumed | Now |
|---|---|
| 70+ `route.ts` still to migrate; Phase G gated on backend finishing | Backend done. Phase G's gate is **already met**. |
| Migration window needs a Next sidecar on `:3056` for un-migrated `/api/*` | **No Next sidecar.** The Hono host serves 100% of `/api/*` from Phase C day one. Dev = Vite `:3055` + Hono host `:3070`, two processes, no third. |
| `derive-vite-proxy.mjs` + `prefix-migrated` coord events to track the moving `/api` split | **Dropped.** The split never exists. Vite dev-proxy is a static one-liner: all `/api/*` → `:3070`. |
| Page-side `next/*` surface ≈ 97 sites (53/32/12) | **40 sites** (21/16/3) — the 53/32/12 were `.next`-artifact-inflated. |

**Net effect:** the plan's hardest risk (two agents editing overlapping surfaces, a moving cutover target) is gone. The phases below keep their letters for continuity, but C is simpler and G is nearly free. Effort drops — see [Effort estimate](#effort-estimate).

---

# Operator Vite migration — frontend/host scope

**Date:** 2026-05-20
**Status:** Ready for review.
**Companion:** `host-architecture-2026-05-20-v2.md` (separate stream; non-conflicting except where called out).
**Supersedes (for my scope only):** `next-removal-2026-05-20.md` (which was deferred — this plan re-activates the portion the user has now authorized, narrowed to frontend/host).

---

## Scope split

The user has split this migration across two agents. This plan covers **only my side**.

| Stream | Owner | What it does |
|---|---|---|
| **Frontend / host** | This plan | App shell, router, Vite build, `@hono/node-server` host process, Tauri load target, `next.config.js` rewrites/redirects/headers replication, `proxy.ts` (middleware) replication, page-side `next/*` API replacement (`next/navigation`, `next/dynamic`, `next/link`), production single-process host, deletion of `apps/operator/{app,proxy.ts,next.config.js,.next*}`, Next deps drop. |
| **Backend / endpoints** | Other agent | Decoupling backend endpoints from Next handler signatures: `route.ts` files (**70 remaining as of 2026-05-20** — backend agent has already ported 21 batches / 171 `defineRoute` modules and is grinding ~14/turn), `next/server` (NextRequest/NextResponse, ~295 uses), `next/headers` (cookies/headers, 6 uses), Server Actions, and any `'use server'` boundaries. End state: Hono routes mounted in `_hono/app.ts` for everything that today lives in `app/**/route.ts`. |
| **Joint boundary** | Both | `apps/operator/app/api/_hono/app.ts` + `apps/operator/app/api/_hono/bootstrap.ts` — already extracted (see `app/api/[[...route]]/route.ts:6-12`, comment explicitly names "operator-vite Phase C via `@hono/node-server`"). Both agents import these; both must preserve their public shape. See [Coordination](#coordination). |

**My non-goals (explicit):**
- I will not rewrite `route.ts` handler signatures or `next/server` consumers. That work is done — the backend stream shipped (see [status banner](#status-banner--backend-stream-shipped-2026-05-20)). The Hono host serves all of `/api/*` directly; there is no Next process in the migration at any point.
- I will not touch `next/headers` / `cookies()` consumers (6 routes). Backend agent's problem.
- I will not refactor `packages/agent-mcp/**` or `libs/sync/**`. Host-architecture agent owns those.

---

## Inventory (greppable, all under `apps/operator/app/`)

**Re-measured 2026-05-20 at Phase 0 start** — the originally-drafted page-side counts (53/32/12) were inflated by `.next` / `.next-prod` build artifacts; the grep ran against `.` instead of `app/`. The `.next*` dirs alone held 119 phantom `next/navigation` hits. These are the **verified** numbers, grepped against `app/` only:

| What | Count | Source of truth |
|---|---:|---|
| `app/**/page.tsx` (my scope) | **62** | `find app -name 'page.tsx' \| wc -l` |
| `app/**/layout.tsx` (my scope) | **6** | `find app -name 'layout.tsx' \| wc -l` |
| `app/**/route.ts` | **3** | `find app -name 'route.ts'` — see breakdown below |
| `app/{loading,error,not-found}.tsx` files (my scope) | **6** | `find app \( -name 'loading.tsx' -o -name 'error.tsx' -o -name 'not-found.tsx' \)` |
| Parallel routes (`@slot`) | **0** | `find app -path '*/@*'` |
| Intercepting routes (`(.)`, `(..)`) | **0** | `find app -type d -name '(*)'` |
| Route groups (`(group)`) | **0** | same |
| `next/navigation` imports (my scope) | **21** | `grep -rh "from ['\"]next/navigation" app/` |
| `next/dynamic` imports (my scope) | **16** | `grep -rh "from ['\"]next/dynamic" app/` |
| `next/link` imports (my scope) | **3** | `grep -rh "from ['\"]next/link" app/` |

**The three `route.ts` files:**
- `app/api/[[...route]]/route.ts` — the Hono catch-all shim. Backend agent deletes it at Phase H.
- `app/wiki/route.ts` — page-namespace handler: resolves `[[wiki-link]]` targets, 302-redirects into `/harness/...`. **My scope** — ports to a Hono host route in Phase C (~50 lines).
- `app/drizzle-studio/route.ts` — page-namespace handler: fetches the Drizzle Studio SPA HTML and injects `<base href>`. **My scope** — ports to a Hono host route in Phase C (~60 lines).

**Implication of zero parallel/intercepting routes + zero route groups:** the App Router → TanStack Router translation is **mechanical**. No bespoke routing patterns to preserve. This is the single biggest factor making this migration tractable. And with the page-side `next/*` surface now known to be **21 + 16 + 3 = 40 import sites** (not the feared 97), the translation is roughly *half* the size the v2 plan budgeted.

---

## Architecture decisions

Re-affirmed from the deferred-plan's decision table (those decisions are good; I'm not relitigating them):

| Concern | Choice | Why (tightened) |
|---|---|---|
| **Bundler** | **Vite 8** (Rolldown-Vite once 1.0 is GA-stable in the workspace; default Rollup until then) | TanStack Router has a first-party Vite plugin (`@tanstack/router-plugin/vite`) for file-based route generation; no Rsbuild equivalent. Switching builders later is local to `apps/operator-vite/vite.config.ts`. |
| **Router** | **TanStack Router 1.x**, file-based generator | File-router maps 1:1 onto our `app/**/page.tsx` tree with one mechanical convention swap (see [Phase B](#phase-b--router-translation)). Typed `Link`/`useParams`/`useSearch` close to Next's mental model. `defer`/`loader`/`pendingComponent` cover what `loading.tsx` did. |
| **HTTP host (dev)** | Vite dev server (`vite`) on **:3055**; `@hono/node-server` Hono host on **:3070**, sibling process | The Vite stack **takes over the two Next ports directly** — `:3055` was `next dev`, `:3070` was the Next standalone. Next is being retired, so Vite claims both from the start; no Tauri/desktop env-var path changes. **No Next process at any point in the migration** — the backend stream shipped, so the Hono host serves all `/api/*` from day one. |
| **HTTP host (prod)** | **One process** — `@hono/node-server` on **:3070** serves the built `dist/` static + the Hono app + `/internal/docs/*` | `:3070` is "the operator host" in both dev and prod (no Vite dev server in prod — the static `dist/` is served by the Hono host). Replaces `next start` + the Next standalone; one process where there were two. |
| **State / data layer** | nuqs + Zero + the `libs/sync` sync layer (**unchanged**) | None care about the framework. `useSyncQuery` (exported from `libs/sync`) and `apps/operator/lib/transport-adapters/` are the seams — both verified present, both keep working. react-query is **not** the operator's app-level data layer (no app-wide `QueryClientProvider`); it's a `libs/sync` internal plus two leaf-component uses. |
| **SSR** | **None** — SPA | Operator is an app shell, not content. Cold-paint flash is real but mitigated by Tauri's webview cache; webapp deploy is not in scope of this plan (Track A in host-arch). |
| **Tauri load target** | Dev: `http://127.0.0.1:3055` (Vite). Prod: bundled static `dist/` | Same model Next used; zero Tauri-side change in dev. Prod path changes from "Next standalone server" to "static files served by `@hono/node-server`". |
| **Docs** | Starlight (**already shipped**) | `apps/operator-docs/` builds `dist/` → mirrored into the operator's `public/internal/docs/`. Migration didn't touch docs; this plan preserves the existing rewrite path. |

---

## Phase 0 — Pre-flight & coordination boundary

**Goal:** lock the boundary contract with the backend agent before scaffolding anything. The boundary is two files: `apps/operator/app/api/_hono/app.ts` (the Hono app instance with all current mounts) and `apps/operator/app/api/_hono/bootstrap.ts` (side-effects: FS watchers, sweepers, voice WS, plugin-route population, idempotent).

These already exist — see `app/api/[[...route]]/route.ts:6-7`:
```ts
import { app } from '../_hono/app';
import { runBootstrap } from '../_hono/bootstrap';
```
The Next route is a 25-line `handle(app)` shim. The comment at the top of that file even names this plan ("operator-vite Phase C via `@hono/node-server`"). **And `export { app };` is already at `apps/operator/app/api/_hono/app.ts:111`** (shipped by the backend agent in commit `0d70beea` during their Phase 2 Option B refactor — verified 2026-05-20). So the boundary is **already done both in shape and in exports**; Phase 0 is just documenting + freezing it.

### P0 deliverables

1. **One coordination commit** (mine) adding **`apps/operator/app/api/_hono/BOUNDARY.md`** — single file, ~30 lines. Content: "this directory's `app.ts` `export { app }` and `bootstrap.ts` `export function runBootstrap()` are the integration surface for both the Next handler (current shim at `app/api/[[...route]]/route.ts`) and `@hono/node-server` (future host in `bin/hono-host.ts`). Neither file may be moved, renamed, or have its public exports' signatures changed without a `coord/frontend.jsonl` entry naming the change and a one-acknowledgment from the other side."
2. **One `coord/frontend.jsonl` entry** announcing intent, naming the boundary files, and listing the file-paths I will own during the migration (see [Coordination](#coordination)).
3. **A "freeze" agreement** with the backend agent: between Phase A scaffold-start and Phase H cutover, neither side moves `_hono/app.ts` / `_hono/bootstrap.ts` to a different directory. Net-new Hono routes still land in `_hono/` as usual; structural moves block.

### P0 acceptance (greppable)

```
test -f apps/operator/app/api/_hono/BOUNDARY.md                          # → exit 0
grep -c 'export { app }' apps/operator/app/api/_hono/app.ts             # → ≥1 (already shipped — sanity-check only)
tail -5 coord/frontend.jsonl | grep -c 'operator-vite-migration'         # → ≥1
```

### P0 NOT shipping

- No Vite scaffold yet.
- No `apps/operator-vite/` directory creation.
- No deps changes to root `package.json`.

### P0 rollback

`git revert` the single coord commit. Nothing else touched.

**Estimate:** half a day, gated only on the backend agent acknowledging the boundary contract.

---

## Phase A — Parallel app scaffold

**Goal:** stand up `apps/operator-vite/` as a fresh Vite + React + TanStack Router app, in parallel with the live `apps/operator/`. No translation of pages yet — just the empty shell that builds, dev-runs, and proxies `/api/*` to the Hono host on `:3070` ([Phase C](#phase-c--hononode-server-host)) so the dev experience is end-to-end usable from day one.

### Why parallel, not in-place

In-place would mean editing `apps/operator/package.json` to swap `next dev` for `vite`, leaving the `app/` tree untouched during partial migration. That's brittle: every commit during the migration risks breaking the live operator. Parallel gives us:
- A clean baseline that builds the whole time.
- A trivial rollback (`rm -rf apps/operator-vite`) up until cutover.
- The ability to ship a `coord/frontend.jsonl` "operator-vite-dev-target ready" announcement to the desktop agent without coupling it to the migration finishing.

### A1. Scaffold

Create `apps/operator-vite/` with:

```
apps/operator-vite/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── src/
│   ├── main.tsx
│   ├── routes/
│   │   └── __root.tsx       # <Outlet/> + global providers + not-found
│   └── styles/              # symlink or copy of apps/operator/app/globals.css
└── public/                  # symlink → apps/operator/public/ (docs, icons, etc.)
```

**Deps (Vite + TSR + minimal):**
- `vite@^8`, `@vitejs/plugin-react`, `@tanstack/router-plugin` (Vite plugin, generates the route tree)
- `@tanstack/react-router@^1`
- `react@^19`, `react-dom@^19` (match what `apps/operator` already uses)
- `hono` + `@hono/node-server` — **must be declared explicitly** (see Gap-E note below); the Phase C host imports both.
- `@tanstack/react-query` — needed because two leaf components (`harness/ArchitectInbox.tsx`, `design/[slug]/SketchPane.tsx`) use `QueryClient` directly. **Not** an app-wide provider — see [A3](#a3-root-route--providers).
- TS: `typescript@^5` (match root)

**Gap-E — `hono` / `@hono/node-server` are currently undeclared.** `apps/operator` uses `hono` but declares it nowhere (it resolves via workspace hoisting — only `apps/papercusp-publish` declares it). `@hono/node-server` is declared by **no** workspace `package.json` at all — it's a pure transitive dep sitting in `node_modules/`. Building the Phase C host on either via hoisting is fragile; `apps/operator-vite/package.json` declares both explicitly from the scaffold.

**State / data layer.** nuqs + Zero + the `libs/sync` sync layer come over from `apps/operator` via the workspace, unchanged. react-query is **not** the operator's app-level data layer — it's a `libs/sync` internal plus the two leaf-component uses above.

### A2. Dev-server proxy (static — single target)

The backend stream shipped (see [status banner](#status-banner--backend-stream-shipped-2026-05-20)), so there is no un-migrated `/api/*` surface and no Next sidecar to split traffic with. The Vite dev proxy is a **static one-liner** — everything non-page goes to the Hono host on `:3070`:

```ts
// vite.config.ts (illustrative)
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3055,
    host: process.env.PAPERCUSP_BIND_HOST ?? '127.0.0.1',
    proxy: {
      '/api':           { target: 'http://127.0.0.1:3070', ws: true, changeOrigin: true },
      '/internal/docs': { target: 'http://127.0.0.1:3070', changeOrigin: true },
    },
  },
  plugins: [
    TanStackRouterVite({ routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts' }),
    react(),
  ],
});
```

`:3070` is the `@hono/node-server` host (stood up in [Phase C](#phase-c--hononode-server-host)). **No `next dev`, no `:3056` sidecar, no `derive-vite-proxy.mjs`** — all of that was scaffolding for a gradual cutover that the backend stream's completion made unnecessary.

**Ordering note:** because the Hono host is now trivial (~15 lines, and it works *today* — all routes are already mounted in `_hono/app.ts`), [Phase C](#phase-c--hononode-server-host) can run **before or alongside** Phase A rather than after it. Stand the host up first; Phase A's Vite proxy then has a live `:3070` to point at from its first boot. The phase letters are kept for continuity but A and C are effectively concurrent.

### A3. Root route + providers

`src/routes/__root.tsx` translates the **verified** provider stack from `apps/operator/app/layout.tsx` — 1:1, same nesting order. The actual stack (read from `layout.tsx` 2026-05-20):

```
Tooltip.Provider (delayDuration 150)
  └ RootSyncProvider          # IPC/HTTP sync substrate; brings the sync layer (libs/sync)
    └ RouteProgressProvider   # the @bprogress integration — see B6, becomes the TSR adapter
      └ NuqsAdapter           # nuqs/adapters/next/app → swap to the TSR/SPA adapter
        └ UiPresenceProvider  # inside NuqsAdapter (mirrors tab URL ↔ agent UI intents)
          └ RouteTransitionProvider
            └ OperatorConversationProvider
              └ PostHogProvider
                └ <Outlet/>   # nested routes
        PerfObserverProvider  # sibling, admin/testing
```

- **There is no `QueryClientProvider`.** The v2 plan said to add one — that was wrong. `apps/operator/app/layout.tsx` mounts none; `@tanstack/react-query` is a `libs/sync` internal (+ two leaf components), not an app-wide provider. Do **not** add a root `QueryClientProvider`.
- `<NuqsAdapter>` currently imports from `nuqs/adapters/next/app` — that's Next-coupled; swap to the nuqs SPA/React-Router adapter (nuqs ships adapters per-router).
- `RouteProgressProvider` is the `@bprogress` integration — it gets reworked into the TSR adapter ([B6](#b6-bprogressnext--tsr-adapter-30-60-loc)).
- `notFoundComponent` renders the existing `apps/operator/app/not-found.tsx` content.
- Import `RootSyncProvider`, `UiPresenceProvider`, `OperatorConversationProvider`, etc. as-is from `apps/operator/app/_components/*` via the workspace path during the migration window ([B5](#b5-translate-appcomponents)).

**The IPC polyfill mount point matters.** Host-architecture Phase 1 installs `window.EventSource = IpcEventSource` / `window.fetch = ipcFetch` before any data-layer code mounts. That must remain the first thing rendered — before `RootSyncProvider`. In TSR, that's the body of `__root.tsx`'s component before the provider tree. I document this as an invariant in the file's top comment so future edits don't reorder.

### A4. Hello-world page

`src/routes/index.tsx` renders a placeholder "operator-vite scaffold" page so we can verify the proxy + IPC polyfill + Query + Zero all initialize against the live `apps/operator` backend.

### A5. Dev-launch script

`apps/operator-vite/package.json`:
```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }
}
```

And a `bin/dev-vite.sh` (or `bin/overmind`-style entry) that starts **two** processes: Vite (`:3055`) and the Hono host (`:3070`, from [Phase C](#phase-c--hononode-server-host)). No Next process. The exact mechanism lives in the desktop dev launcher — note that **`papercusp-desktop/` is a sibling repo, not part of `papercup/`** (verified path: `papercupai-workspace/papercusp-desktop/`, alongside `papercupai-workspace/papercup/`). The launcher script lives there; wiring it is a separate-repo change — see [Phase F](#phase-f--tauri-shell) for the repo-boundary handling.

### A acceptance (greppable)

```
test -f apps/operator-vite/vite.config.ts
test -f apps/operator-vite/src/routes/__root.tsx
test -f apps/operator-vite/src/routes/index.tsx
(cd apps/operator-vite && npm run build) && test -f apps/operator-vite/dist/index.html
# Live: Vite on :3055 serves the hello page; /api/health proxies to the Hono host on :3070 and returns 200.
curl -sf http://127.0.0.1:3055/ | grep -q 'operator-vite'
curl -sf http://127.0.0.1:3055/api/health   # 200
```

### A NOT shipping

- Zero page translations from `app/`.
- No deletions from `apps/operator/`.

### A rollback

`rm -rf apps/operator-vite`. Nothing else touched — `apps/operator/` is untouched in this phase.

**Estimate:** 2–3 days.

---

## Phase B — Router translation

**Goal:** translate all 62 `page.tsx` + 6 `layout.tsx` files from `apps/operator/app/` into TanStack Router file-based routes under `apps/operator-vite/src/routes/`. Translate the 6 `loading.tsx`/`not-found.tsx` files. After this phase, every page reachable in the live operator is reachable in the Vite app at the same URL.

### Convention mapping

| Next App Router | TSR file-based |
|---|---|
| `app/page.tsx` | `src/routes/index.tsx` |
| `app/foo/page.tsx` | `src/routes/foo/index.tsx` (or flat `routes/foo.tsx`) |
| `app/foo/[id]/page.tsx` | `src/routes/foo/$id.tsx` |
| `app/foo/[...slug]/page.tsx` | `src/routes/foo/$.tsx` (catch-all) |
| `app/layout.tsx` | `src/routes/__root.tsx` |
| `app/foo/layout.tsx` | `src/routes/foo.tsx` (parent, with `<Outlet/>`); children go in `routes/foo/*` |
| `app/loading.tsx` | route option `pendingComponent` on `__root.tsx` (or a sub-route) |
| `app/not-found.tsx` | `__root.tsx` `notFoundComponent` |
| `useRouter().push(x)` | `useNavigate()({ to: x })` |
| `usePathname()` | `useRouterState({ select: s => s.location.pathname })` |
| `useParams()` (Next) | `Route.useParams()` (TSR, typed per-route) |
| `useSearchParams()` (Next) | nuqs (we already use it everywhere durable) or `Route.useSearch()` for un-encoded values |

This is the meat of the 53 `next/navigation` import sites. **All 53 are in `apps/operator/app/`** (page-side code, my scope) — not in `route.ts` (backend agent's scope). Verified by `grep -l "from 'next/navigation'" app/**/*.{ts,tsx}`.

### B1. Build the route tree mechanically

For each `app/**/page.tsx`:
1. Map the path to TSR file path (table above).
2. Wrap the default export in `createFileRoute('<path>')({ component: PageComponent })`.
3. Replace `next/navigation` calls with TSR equivalents (table above).
4. Replace `next/link` `<Link href="x">` with `import { Link } from '@tanstack/react-router'; <Link to="x">`.
5. Replace `next/dynamic(() => import('./Foo'))` with `React.lazy(() => import('./Foo'))` and add a `<Suspense fallback={...}>` boundary. **Audit each of the 32 sites for `loading: <Component>`** — `next/dynamic`'s `loading` option provides a synchronous loading component without a Suspense boundary; `React.lazy` always requires one. At minimum the harness-builds, marketplace-install, and (TBD via grep) surfaces have non-trivial `loading:` UI — port that UI into the Suspense `fallback` so the loading state visually survives. (TSR's `pendingComponent`/`defer` can supersede many of these — judge per-route.)
6. Leave all `'use client'` directives in place during translation (see B4 for the audit-not-sed cleanup pass).
7. Leave all `route.ts` files in `apps/operator/app/` **untouched** — backend agent's scope.

Each layout (`app/layout.tsx` is one; the other 5 are nested like `app/harness/layout.tsx`) becomes a TSR parent file:
- `app/harness/layout.tsx` → `src/routes/harness.tsx` with the wrapper component + `<Outlet/>`.
- Its children `app/harness/[slug]/page.tsx` etc. become `src/routes/harness/$slug/index.tsx` underneath.

### B2. Batches (greppable surfaces)

I'll land Phase B in batches by top-level route to keep each PR small and reviewable. **Counts below are verified** — `find app -name 'page.tsx'` grouped by top-level dir, 2026-05-20 (total **62**):

| Batch | Top-level | `page.tsx` count |
|---|---|---:|
| B-1 | `/` (root), `/login`, `/signup`, `/setup` | 4 |
| B-2 | `/admin` | 5 |
| B-3 | `/harness` (nested by `$slug`) | 6 |
| B-4a | `/settings` (first half) | 10 |
| B-4b | `/settings` (second half) | 10 |
| B-5 | `/marketplace` (5) + `/installed` (7) | 12 |
| B-6 | `/dev` (3), `/editor-demo`, `/el-min`, `/operator-mock`, `/snapshots` (2), `/design` (2) | 10 |
| B-7 | `/wiki`, `/support`, `/project-docs`, `/pi`, `/coord` | 5 |
| | **Total** | **62** |

Two corrections from the v2 draft, both caught by the Phase-0-style audit: `/settings` is the **largest** surface (20 pages, not the estimated 8) — split into B-4a/B-4b; `/harness` is **6** pages, not the estimated 15. `/drizzle-studio` is *not* in any batch — it has no `page.tsx`, only a `route.ts` (ported to the Hono host in [Phase C](#phase-c--hononode-server-host)). `not-found` is `not-found.tsx`, not a `page.tsx` — it becomes `__root.tsx`'s `notFoundComponent` ([B1](#b1-build-the-route-tree-mechanically)), not a B-1 entry.

Each batch acceptance: that surface's URLs render the right components and don't console-error, **verified by a strategy proportional to surface-stakes:**

- **Smoke-tested in Playwright (mandatory): 6 highest-stakes surfaces.** `harness/[slug]`, `login`, `settings/*`, `marketplace/installed/[slug]` (the install flow), `editor-demo`, `harness/[slug]` "brainstorm" tab. Each gets one fresh Playwright smoke (~30-50 lines, ~1 day per to write + stabilize). **These tests do not exist today**; writing them is part of the batch's effort, not assumed coverage.
- **Manual click-through (acceptable): the other ~56 pages.** Confirm via headless WebKit per `feedback_browser_e2e_verify_ui_fixes` — render, navigate sub-links, hit primary CTAs, watch for console errors.

The plan does not pretend automated coverage exists for pages where it doesn't.

### B3. Translate the 53 `next/navigation` + 32 `next/dynamic` + 12 `next/link` sites

These are dispersed across the page tree, so they fall out batch-by-batch. **Acceptance: zero `from 'next/navigation'|next/dynamic|next/link'` imports anywhere under `apps/operator-vite/src/`.**

### B4. `'use client'` directives — per-file audit, not sed

Vite/SPA doesn't distinguish server vs client components — `'use client'` is almost always a harmless no-op. **But not always.** A file that today carries `'use client'` *and* calls hooks at module-load (rare but real for context providers like `OperatorConversationProvider`, `RootSyncProvider`, `UiPresenceProvider`) may rely on Next's RSC boundary to defer evaluation. Under Vite + React 19 SPA those files evaluate eagerly at import; if any hook call runs at module scope (vs. inside the component body), it'll crash.

So: **per-file audit during translation, not a single sed pass at the end.** For each `'use client'` file in a batch, grep its top-level for `use[A-Z]` calls outside function bodies. If clean, drop the directive; if not, refactor the hook into a render-time call. Backend agent owns equivalent cleanup on `route.ts` consumers.

### B5. Translate `app/_components/*`

`apps/operator/app/_components/` is shared component code (not routes). Where TSR or Vite-specific changes are needed (e.g. `next/link` → TSR `Link`), edit in place inside `apps/operator/app/_components/` so both apps import the same components during the migration window. This works because the Vite app imports from `../operator/app/_components/*` via workspace path. After cutover, those files migrate to `apps/operator-vite/src/components/` in one move-only PR.

### B6. `@bprogress/next` → TSR adapter (~30-60 LOC)

The existing integration is **`apps/operator/app/_components/RouteProgressProvider.tsx`** (verified — it's in the `layout.tsx` provider stack, see [A3](#a3-root-route--providers)), which uses `@bprogress/next` to hook `next/navigation`'s router events. Replacement is `@bprogress/react` (same author) wired into TSR's `useRouterState` — i.e. `RouteProgressProvider` is rewritten as the adapter below (keep the name, or rename to `NavigationProgress`; either way it occupies the same slot in `__root.tsx`):

```tsx
// apps/operator-vite/src/components/NavigationProgress.tsx (illustrative)
import { useRouterState } from '@tanstack/react-router';
import { useProgress } from '@bprogress/react';
import { useEffect } from 'react';

export function NavigationProgress() {
  const status = useRouterState({ select: s => s.status }); // 'idle' | 'pending'
  const { start, stop } = useProgress();
  useEffect(() => { status === 'pending' ? start() : stop(); }, [status]);
  return null;
}
```

Mount once in `__root.tsx`. **This is real work, not config** — ~30-60 lines including the CSS port. Drop `@bprogress/next` from `package.json` at Phase H.

### B acceptance (greppable)

```
# Every Next page has a TSR counterpart.
diff <(find apps/operator/app -name 'page.tsx' | sed 's|^apps/operator/app/||; s|/page.tsx$||; s|^/?$|index|' | sort) \
     <(find apps/operator-vite/src/routes -name '*.tsx' -not -name '__root.tsx' | sed 's|^apps/operator-vite/src/routes/||; s|\.tsx$||' | sort)
# Zero next/* page-side imports in the Vite app.
! grep -rE "from ['\"]next/(navigation|dynamic|link|server|headers)" apps/operator-vite/src/
# Build is clean.
(cd apps/operator-vite && npm run build)
# Playwright suite passes against the Vite dev server.
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3055 (cd apps/operator && npx playwright test)
```

### B NOT shipping

- No deletion of `apps/operator/app/page.tsx` etc. — both stacks coexist until [Phase H](#phase-h--cutover--deletion).
- No `next.config.js` changes.
- No backend changes (`route.ts` untouched).

### B rollback

Per-batch revert. Each batch is one PR; reverting it leaves the other batches intact.

**Estimate:** 3–5 weeks for all batches, dominated by per-page testing (not translation — TSR is mechanical here).

---

## Phase C — `@hono/node-server` host

**Goal:** stand up a standalone Node process that hosts the existing `_hono/app.ts` directly via `@hono/node-server`, with no Next involvement. Because the backend stream shipped, this host serves the **entire** API surface from the moment it boots — there is no "interchangeable with the Next sidecar" interim state; the Hono host *is* the API host. This phase can run before or alongside Phase A.

### C1. Host process

**Dependency prerequisite (Gap E) — as built:** the host lives in `apps/operator/bin/` and runs in `apps/operator`'s **CJS** module-resolution context — it imports `_hono/app.ts` and `@/`-aliased operator code, and importing that from `operator-vite`'s `type: module` package hits an ESM/CJS named-export boundary. So `hono` and `@hono/node-server` are declared in **`apps/operator/package.json`** (not `operator-vite`) — both were previously only hoisted (`hono` from `apps/papercusp-publish`) or purely transitive (`@hono/node-server`). The host must not be built on an undeclared dep.

As built, the host is **two files** — an entrypoint plus a side-effect-free handler, so tests / the C1 smoke can import the composed handler without booting a server or running `runBootstrap()`:

```ts
// bin/host-handler.ts — side-effect-free composed handler.
import { app } from '../app/api/_hono/app';
import { pageRoutes } from './page-routes';

export async function handler(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === '/wiki' || pathname === '/drizzle-studio' ||
      pathname.startsWith('/drizzle-studio/')) {
    return pageRoutes.fetch(req);   // page-namespace handlers (C2)
  }
  return app.fetch(req);            // everything else → the /api/* app
}

// bin/hono-host.ts — entrypoint: bootstrap + serve.
import { serve } from '@hono/node-server';
import { runBootstrap } from '../app/api/_hono/bootstrap';
import { handler } from './host-handler';

runBootstrap();                     // idempotent — globalThis guard
serve({ fetch: handler,
        port: Number(process.env.PAPERCUSP_HONO_PORT ?? 3070),
        hostname: process.env.PAPERCUSP_BIND_HOST ?? '127.0.0.1' });
```

It works **today** — every operator API route is already mounted in `_hono/app.ts` (the backend stream shipped). The Hono host serves 100% of `/api/*` the moment it boots; there is no split, no per-prefix proxy, no Next process. The Vite dev-proxy is the static one-liner from [A2](#a2-dev-server-proxy-static--single-target).

### C2. The two page-namespace route handlers (`/wiki`, `/drizzle-studio`)

The endpoint-route migration covered `/api/*`. It did **not** cover the two `route.ts` files that live at *page* paths — `app/wiki/route.ts` and `app/drizzle-studio/route.ts`. These are mine. Once `next dev` is gone, nothing serves them, so Phase C ports both onto the Hono host as plain routes:

- **`/wiki`** — `app.get('/wiki', ...)`: resolves the `?target=` query against registered projects, returns a 302. Pure `node:fs` + redirect logic; lifts out of `next/server` (`NextResponse.redirect` → `c.redirect`) in ~50 lines.
- **`/drizzle-studio`** — `app.get('/drizzle-studio', ...)`: fetches the Drizzle Studio SPA HTML, injects `<base href="/drizzle-studio/">`, returns it. The companion `/drizzle-studio/:path*` CDN proxy (today a `next.config.js` rewrite) becomes a Hono route too — folded into [Phase E](#phase-e--config-replication)'s rewrite port.

Mount both in the Hono host (not `_hono/app.ts` — they're page-namespace, not `/api/*`; same tier as the docs middleware).

### C3. Static asset serving (dev)

In dev, Vite serves static assets (from `apps/operator-vite/public/`, which symlinks to `apps/operator/public/`). No Hono involvement needed for static serving in dev.

### C4. Dev launcher integration

Update the dev-launcher (`bin/dev-vite.sh` from Phase A, or whichever orchestrator the desktop uses) to start **two** processes — no Next:
1. Vite (`:3055`) — owns the page tree
2. `hono-host` (`:3070`) — owns `/api/*`, `/internal/docs/*`, `/wiki`, `/drizzle-studio`

### C acceptance (greppable)

```
# The Hono host boots and serves the whole API surface.
PAPERCUSP_HONO_PORT=3070 tsx apps/operator/bin/hono-host.ts &
sleep 2
curl -sf http://127.0.0.1:3070/api/health       # 200
curl -sI http://127.0.0.1:3070/wiki?target=x | head -1   # 302
curl -sf http://127.0.0.1:3070/drizzle-studio | grep -q '<base href="/drizzle-studio/"'
# The Vite proxy routes API calls correctly.
curl -sf http://127.0.0.1:3055/api/health       # 200, same body as direct
# Exactly two processes — Vite + Hono host, no Next.
ss -tnpl | grep -E ':3055|:3070' | wc -l         # → 2
pgrep -af 'next dev' | wc -l                     # → 0
```

### C NOT shipping

- No deletion of the Next route catch-all (`app/api/[[...route]]/route.ts`) — that's Phase H, backend agent's.
- No production deploy of the Hono host yet (Phase G).

### C rollback

Stop the Hono host process. `apps/operator/` is untouched; revert the `/wiki` + `/drizzle-studio` port commits if needed.

**Estimate:** 2–3 days (the two page-handler ports add ~half a day over the original estimate).

---

## Phase D — `next/*` API replacement (page-side only)

**Goal:** zero page-side `next/*` imports remain in `apps/operator-vite/src/`. This is mostly a byproduct of Phase B (the per-batch translation does it page-by-page), but Phase D is the audit + cleanup pass that proves it's complete.

### D1. The page-side `next/*` surface I own

| Module | Count | Replacement |
|---|---:|---|
| `next/navigation` | 53 | `@tanstack/react-router`: `useNavigate`, `useRouterState`, `Route.useParams`, `Route.useSearch` |
| `next/dynamic` | 32 | `React.lazy` + `<Suspense>`, or TSR `defer` / `pendingComponent` |
| `next/link` | 12 | `@tanstack/react-router`'s `Link` |

### D2. The backend-side `next/*` surface I do NOT own

| Module | Count | Owner |
|---|---:|---|
| `next/server` (NextRequest, NextResponse) | 295 | Backend agent |
| `next/headers` (cookies/headers) | 6 | Backend agent |
| `next/server.js`, `next/types.js`, internal `next/dist/...` | 12 | Backend agent |

I will not touch any file matching `app/**/route.ts` or any file that today imports from `next/server` / `next/headers`. If a page (`page.tsx`) happens to import from `next/server` (rare but possible — e.g. for a type), I'll coordinate with the backend agent on a shared type-shim location rather than duplicate.

### D3. `proxy.ts` (middleware) → Hono middleware

`apps/operator/proxy.ts` does three things (see file's top comment):
1. `/api/*` exact-origin credentialed CORS for local desktop/mobile shells.
2. `/internal/docs/*` loopback-only gate.
3. `/internal/docs/<slug>` slug → `<slug>.html` rewrite + `Accept: text/markdown` → `<slug>.md` negotiation.

In the Vite + Hono world:
- (1) becomes Hono `cors()` middleware mounted in `_hono/app.ts` (already partially there — see "credentialed API CORS" comment in `next.config.js`).
- (2) + (3) move to **`@hono/node-server`-host middleware** in `bin/hono-host.ts`, because the Hono host is what serves `/internal/docs/*` static files in production (via `serveStatic` from `@hono/node-server/serve-static`). The logic ports cleanly from `proxy.ts` (it's already framework-agnostic — uses `node:fs`, `node:path`, and reads `Host`/`Accept` from request headers).

Code-wise this is ~80 lines moved + adapted. I'll port it in Phase E (where the rest of the config replication lives), since the middleware and the host config are co-located.

### D acceptance (greppable)

```
# Zero page-side next/* imports remaining.
! grep -rE "from ['\"]next/(navigation|dynamic|link)" apps/operator-vite/src/
# No remaining proxy.ts logic outstanding in my scope.
grep -c 'isLoopbackHost\|PUBLIC_DOCS_ROOT' apps/operator/bin/hono-host.ts  # → ≥2
```

### D NOT shipping

- No `next/server` rewrites. Backend agent's job.
- No `next/headers` rewrites. Backend agent's job.

### D rollback

Per-file revert (the actual changes live inside Phase B PRs).

**Estimate:** rolled into Phase B; standalone audit pass is ~1 day.

---

## Phase E — Config replication

**Goal:** every behavior expressed in `apps/operator/next.config.js` (110 lines) and `apps/operator/proxy.ts` (180 lines) is replicated under the Vite + Hono stack. Nothing silently drops.

### E1. `next.config.js` line-by-line

| `next.config.js` setting | Replication |
|---|---|
| `output: 'standalone'`, `distDir`, two-build-target split | Replaced by `vite build` → `apps/operator-vite/dist/`. The "standalone" Next build (`.next-prod`) goes away — Phase G is one process, no separate standalone target. |
| `compress: true` | Hono compression middleware with **content negotiation** (decision frozen 2026-05-20): brotli when `Accept-Encoding: br` is present, gzip otherwise. Next's `compress: true` was gzip-by-default; defaulting the new stack to brotli-only would silently bypass compression for any CLI/curl consumer that doesn't advertise `br`. Match Next's permissive shape, don't narrow it. |
| `outputFileTracingRoot`, `outputFileTracingIncludes` (node-pty prebuilds, scanner.md) | Replaced by an explicit copy step in the host's build script: `bin/hono-host-build.sh` copies `node_modules/@lydell/node-pty-*/prebuilds/**` and `libs/papercusp/packages/harness/prompts/scanner.md` into the bundled output. No tracer involved — we just enumerate. |
| `typescript: { ignoreBuildErrors: true }` | Vite doesn't typecheck during `vite build` by default — same behavior. `tsc --noEmit` runs in a separate CI step (already does). |
| `images: { unoptimized: true }` | Vite serves images as-is. No-op. |
| `allowedDevOrigins` (Next 16 HMR origin allowlist) | Vite has `server.cors` + `server.host`; HMR origin checking is more permissive by default. Set `server.host: '0.0.0.0'` + `server.cors: true` in dev. |
| `experimental.turbopackFileSystemCacheForDev: false` | Turbopack-specific; deleted with Next. |
| `transpilePackages: [...]` (workspace packages) | Vite resolves workspace-symlinked packages and esbuild-transforms their TS/TSX automatically — no per-package config needed for source-TS workspace deps. The v2 plan claimed `@papercusp/agent-mcp` ships JSX needing `optimizeDeps.include`; **that was wrong** — `packages/agent-mcp` has 0 `.tsx` files, 0 `react` imports, 0 `createElement`/`jsx()` calls, and it's a `serverExternalPackages` entry (server-only, never in the client bundle) — not a `transpilePackages` entry at all. The only real risk here is a workspace dep that ships **pre-compiled CJS** Vite's ESM resolver chokes on; if one surfaces during the Phase A smoke, add it to `optimizeDeps.include` then — don't pre-emptively list packages. |
| `serverExternalPackages: [...]` (node-pty, agent-mcp, drizzle-kit, mem0ai, ollama, @huggingface/transformers) | Vite/Hono have no analogous concept for the **dev-time client bundle** because these are server-only packages. They live in the `hono-host` process, which is plain Node — no bundler involved at runtime. The `node-pty` `.node` binding trick that drove the Next include list works automatically. **Verify per-package during Phase G smoke.** |
| `headers()` callback (`Connection: close` in dev) | Vite dev-server middleware (`server.middlewares.use(...)`) — 5 lines. |
| `redirects()` (`/settings → /settings/profile`) | Either (a) a TSR `beforeLoad` redirect on `routes/settings.tsx`, or (b) Hono-host middleware. **Choice: (a)** because it's the SPA's concern, not the API's. |
| `rewrites().beforeFiles` (Rust opt-in via `?backend=rust`) | Hono-host middleware. The logic is path-aware and gated on a query param — straight port. |
| `rewrites().afterFiles` (cross-app: `/api/org/*` → :3061 Papercup demo, `/api/admin-sidebar/*` → :3001 Restart admin, `/drizzle-studio/*` → drizzle local URL) | Hono-host middleware using Hono's built-in proxy/`fetch` re-issue. ~20 lines. |
| **REMOVED:** `/internal/docs/<slug> → <slug>.html` rewrite (already handled by `proxy.ts`) | Stays in middleware (E2). |

### E2. `proxy.ts` (middleware) line-by-line

Already described in [D3](#d3-proxyts-middleware--hono-middleware). The full port lives in `apps/operator/bin/hono-host.ts` (or wherever Phase G lands it):

| `proxy.ts` concern | Replication |
|---|---|
| `LOCAL_API_CORS_HEADERS` block (exact-origin credentialed CORS for `/api/*`) | Hono `cors()` middleware mounted in `_hono/app.ts`. Origin allowlist is the same `LOCAL_API_ORIGIN_HOSTS` set, same `LOCAL_API_ORIGIN_PROTOCOLS`. |
| `isLoopbackHost()` + `/internal/docs` gate (loopback-only unless `PAPERCUSP_INTERNAL_DOCS_BYPASS=1`) | Hono middleware on the host (runs before `serveStatic`). Same logic. |
| Slug → `<slug>.html` resolve via `fs.existsSync` | Hono middleware; uses `node:fs`/`node:path` same as today. |
| Per-page `Accept: text/markdown` → `<slug>.md` | Same middleware; checks `Accept` header before falling through to `serveStatic` for the `.html`. |
| `export const config = { matcher: [...] }` (Next-specific) | Removed — Hono mounts middleware on path patterns directly. |

### E3. Dev-server proxy table (Vite)

Already specified in [A2](#a2-dev-server-proxy-static--single-target) — it's a static two-entry table, unchanged for the whole migration:
```
:3055 (vite)   → owns pages + static
  proxy /api            → :3070 (hono-host)
  proxy /internal/docs  → :3070 (hono-host serves static + middleware)
```

After Phase H, prod is the single `:3070` Hono host serving the built `dist/` directly — no Vite dev server, no proxy.

### E acceptance (greppable)

```
# Every behavior from next.config.js has a target file in the new stack.
test -f apps/operator-vite/vite.config.ts          # dev-server proxy + plugins
test -f apps/operator/bin/hono-host.ts             # rewrites + middleware + serveStatic
# Cross-app routes still work.
curl -sf 'http://127.0.0.1:3055/api/org/healthz' | grep -q 'ok'      # → 0 (proxies to :3061)
curl -sf 'http://127.0.0.1:3055/api/admin-sidebar/healthz'           # 200 (proxies to :3001)
# /internal/docs gate behavior.
curl -sI -H 'Host: api.papercupai.com' http://127.0.0.1:3055/internal/docs/agent-policies | head -1  # 403
curl -sf http://127.0.0.1:3055/internal/docs/agent-policies | head -1                                # 200
# Slug-to-html still resolves.
curl -sf http://127.0.0.1:3055/internal/docs/agent-policies | grep -q '<html'                        # → 0
# Accept: text/markdown still negotiates.
curl -sf -H 'Accept: text/markdown' http://127.0.0.1:3055/internal/docs/agent-policies | head -1     # markdown, not HTML
```

### E NOT shipping

- No deletion of `next.config.js` / `proxy.ts` yet — they're deleted in Phase H. (They're inert once the Hono host owns serving, but the deletion is batched into the cutover PR.)
- No production deployment.

### E rollback

Each setting's port is independently reversible (kill the middleware / proxy entry).

**Estimate:** 3–4 days.

---

## Phase F — Tauri shell

**Goal:** the desktop's Tauri webview loads the Vite app instead of the Next app. Dev loads the Vite dev server URL; prod loads bundled static files.

> **Repo-boundary note.** Everything in Phase F lives in **`papercusp-desktop/` — a sibling repo, not `papercup/`.** Verified: `tauri.conf.json` is at `papercupai-workspace/papercusp-desktop/src-tauri/tauri.conf.json`, and `papercusp-desktop/` sits *alongside* `papercup/`, not inside it. So Phase F's edits (`tauri.conf.json`, the desktop dev launcher, `bin/release-local.sh`) are commits in a **different git repo** — the "stage only my `papercup/` paths" discipline doesn't apply there; they're staged and committed in `papercusp-desktop/` separately. If a desktop-owning agent exists, coordinate via that repo's channel. Phases A–E and G–H are entirely within `papercup/`; only F crosses the boundary.

### F1. Dev URL

Tauri's `tauri.conf.json` has a `build.devUrl` (or older `build.devPath`) pointing at the operator's dev server. Currently `http://127.0.0.1:3055` (Next). Vite is on the same port → **no Tauri-side change** for dev once Phase A's Vite server owns `:3055`.

The desktop's dev orchestrator (whichever `bin/` script starts the operator + waits for it to be reachable) needs to wait on Vite instead of Next. Mechanically identical — both serve a 200 on `/` once warm. The "is the operator ready" probe (a `curl -fs http://127.0.0.1:3055/` in a loop) doesn't care which server answered.

### F2. Prod load target

Today: Tauri prod loads from the `next start` (or standalone) sidecar — a separate Node process the desktop spawns.

After this migration: Tauri prod loads from `http://127.0.0.1:3070` served by `bin/hono-host.ts` (the single-process backend from Phase G). The host serves `dist/index.html` + SPA assets via `serveStatic`, plus the `_hono/app.ts` mounts at `/api/*` and `/internal/docs/*` middleware. **One Node process replaces two.**

Tauri's `tauri.conf.json` `build.frontendDist` (or the older `distDir`) points at where the static SPA lives. Two options:
- **(a) Point Tauri at `apps/operator-vite/dist/`** — Tauri loads files directly; `:3070` only serves `/api/*`. Simpler in theory but breaks the `/internal/docs/*` rewrite (Tauri's static loader has no middleware).
- **(b) Keep loading from `http://127.0.0.1:3070`** — Hono host serves both static + API + docs middleware uniformly. **Recommended.** Matches today's "Next standalone serves the app" model; one fewer special case.

I'll go with **(b)**. Tauri config change: `frontendDist` → `http://127.0.0.1:3070` (URL form, not path form). Same shape as today.

### F3. Desktop release script

The release script (`bin/release-local.sh` per memory) needs to:
1. Build `apps/operator-vite` (`npm --workspace @papercusp/operator-vite run build`).
2. Build the host (`tsx --build` or `esbuild` `bin/hono-host.ts` into a single CommonJS file).
3. Copy `node_modules/@lydell/node-pty-*/prebuilds/**` (the only native binding) into the desktop bundle.
4. Copy `apps/operator-vite/dist/` next to the host binary.
5. Wrap as the Tauri sidecar.

No `next build`, no Next standalone tracer, no `.next-prod` directory. The release artifact is: one host binary + one `dist/` + one prebuild dir. **Smaller than today.**

### F acceptance (greppable + manual)

```
# Dev: Tauri webview reaches the Vite-served app and renders it.
# (manual smoke — start the desktop dev workflow and verify the operator loads)
# Prod: built sidecar serves the SPA at /, the API at /api/*, the docs at /internal/docs/*.
PAPERCUSP_HONO_PORT=3070 ./bin/hono-host &
sleep 2
curl -sf http://127.0.0.1:3070/ | grep -q 'operator-vite'   # static SPA shell
curl -sf http://127.0.0.1:3070/api/health                  # 200
curl -sf http://127.0.0.1:3070/internal/docs/agent-policies # 200
```

### F NOT shipping

- No Tauri-side dev URL change (it's already `:3055`).
- No desktop release.yml or Actions wiring — releases stay local per existing memory.

### F rollback

Tauri config revert + release script revert. Both single-line / single-file changes.

**Estimate:** 2 days, of which most is verifying the release path end-to-end against a real desktop install.

---

## Phase G — Production single-process host

**Goal:** make the production target **one process** — `node hono-host.js` serves the built SPA + `/api/*` + `/internal/docs/*` + the two page-namespace handlers. Dev is already two processes (`vite` + `hono-host`) from Phase C; this phase is about the *production* collapse, not the dev one.

**Gate — already met.** The v2 plan gated Phase G on the backend agent finishing the `route.ts` migration. That happened (see [status banner](#status-banner--backend-stream-shipped-2026-05-20)): `endpoint-route-migration-2026-05-20.md` is `status: shipped`, 0 API `route.ts` remain. The gate verification is now a one-line sanity check, not a wait:

```
find apps/operator/app -name 'route.ts' -not -path '*/[[...route]]*' | wc -l   # → 2 — only /wiki + /drizzle-studio, both ported to the Hono host in Phase C
```

(The catch-all `[[...route]]/route.ts` is the Next-side shim; **backend agent deletes it as part of Phase H, not me.**)

### G2. Dev launcher (already correct from Phase C)

Phase C already set the dev launcher to two processes — Vite (`:3055`) + `hono-host` (`:3070`). Nothing to drop here; there was never a Next sidecar. This sub-step is a no-op carried from the v2 plan's assumptions.

### G3. Single-process production — middleware order without changing the boundary

The host serves three URL spaces in one process:
- `/api/*` — owned by `app.fetch` (the existing `_hono/app.ts`).
- `/internal/docs/*` — owned by host middleware (gate + `serveStatic`, ported from `proxy.ts` in Phase E).
- everything else — SPA shell from `dist/index.html`.

These URL spaces don't overlap, so the sequencing is **host pre-routing → app.fetch → host fallback**, not an interleave:

```ts
serve({
  port,
  hostname: host,
  fetch: async (req) => {
    const url = new URL(req.url);
    // 1. Host pre-routing: docs gate owns /internal/docs/*
    if (url.pathname.startsWith('/internal/docs')) {
      return docsGate(req); // returns 200 / 403 / 404 (Starlight branded)
    }
    // 2. Delegate /api/* and anything else _hono/app.ts has mounted
    const r = await app.fetch(req);
    if (r.status !== 404) return r;
    // 3. SPA fallback: serve dist/index.html for client-router-owned paths
    return serveStatic({ root: '../operator-vite/dist' })({ ...req, path: '/index.html' });
  },
});
```

**This intentionally does NOT add a `mount(extraRoutes)` export to `_hono/app.ts`.** The boundary contract stays minimal (`export { app }, runBootstrap`). If a future need to interleave middleware *between* two of app's own mounts surfaces, we add the seam *then*, with a coord-channel entry. YAGNI for now.

### G4. Drop `next start` from the desktop sidecar launcher

Desktop ships **one binary** now. The launcher script that today does `next start -p 3070 -H 127.0.0.1` becomes `node hono-host.js` (or the bundled binary equivalent).

### G acceptance (greppable + live)

```
# One process serves everything.
pgrep -af 'hono-host' | wc -l                                # → 1
pgrep -af 'next start' | wc -l                               # → 0
pgrep -af 'next dev'   | wc -l                               # → 0  (dev too, after launcher update)
# Every URL bucket works.
curl -sf http://127.0.0.1:3070/                              # SPA → 200
curl -sf http://127.0.0.1:3070/login                         # SPA → 200 (client routes)
curl -sf http://127.0.0.1:3070/api/health                   # API → 200
curl -sf http://127.0.0.1:3070/internal/docs/agent-policies  # Docs → 200
curl -sI http://127.0.0.1:3070/nonexistent | head -1         # 200 (SPA shell — client router handles 404)
```

### G NOT shipping

- No deletion of `apps/operator/app/` yet.
- No removal of Next deps from `package.json` yet.
- No deletion of `next.config.js` / `proxy.ts` yet.

### G rollback

Revert the production-host commit; the desktop launcher falls back to `next start` (the Next standalone files still exist until Phase H). Dev is unaffected — it was already Vite + Hono host from Phase C.

**Estimate:** 2 days. Gate already met (backend stream shipped), so no external blocking.

---

## Phase H — Cutover & Next deletion

**Goal:** every Next-related artifact deleted from the repo. Verifiably zero Next dependencies, zero Next imports, zero Next config.

### H1. Final pre-flight

```
# No next/* imports anywhere in source (excluding the to-be-deleted apps/operator/{app,proxy.ts,next.config.js}).
grep -rE "from ['\"]next/" apps/operator-vite/ packages/ libs/ apps/papercup/ | wc -l  # → 0
# No more route.ts files outside the about-to-be-deleted catch-all.
find apps/operator/app -name 'route.ts' | wc -l   # → 1 (only the catch-all shim)
# The Vite app builds cleanly.
(cd apps/operator-vite && npm run build) && (cd apps/operator-vite && npm run preview &)
sleep 2
curl -sf http://127.0.0.1:4173/ | grep -q '<html'
```

### H2. The deletion + move PR (option (b): merge into `apps/operator-vite/`)

**Decision frozen 2026-05-20 (was Open Q1):** after H, there is no `apps/operator/` directory. Everything that remains after the Next surface is removed gets moved under `apps/operator-vite/server/`. This is a bigger PR than "rm -rf app/" — re-budgeted from 1d → 2-3d to cover the import-path sweep.

H2 is one PR with two halves:

**(a) Move what stays:**
```
git mv apps/operator/app/api/_hono       apps/operator-vite/server/_hono
git mv apps/operator/bin/hono-host.ts    apps/operator-vite/server/host.ts
git mv apps/operator/lib                 apps/operator-vite/server/lib
git mv apps/operator/prompts             apps/operator-vite/server/prompts
git mv apps/operator/scripts             apps/operator-vite/scripts
git mv apps/operator/__tests__           apps/operator-vite/__tests__
git mv apps/operator/e2e                 apps/operator-vite/e2e
git mv apps/operator/public              apps/operator-vite/public   # (if not already symlinked there)
```

**(b) Delete what's gone:**
```
rm -rf apps/operator/app/         # everything left after _hono moved out
rm     apps/operator/proxy.ts
rm     apps/operator/next.config.js
rm     apps/operator/next-env.d.ts
rm -rf apps/operator/.next apps/operator/.next-prod
rm -rf apps/operator/              # the whole dir is gone
```

**Then the import-path sweep:**
```
# Update every @papercusp/web → @papercusp/operator-vite reference.
grep -rl "@papercusp/web" apps/ packages/ libs/ bin/ | xargs sed -i 's|@papercusp/web|@papercusp/operator-vite|g'
# Fix relative imports that broke from the moves (e.g. lib/ paths from prompts/).
# Run tsc --noEmit; fix what flags.
```

**Then the deps drop:**
- Edit `apps/operator-vite/package.json` (new home of what was `@papercusp/web`): remove `next`, `@bprogress/next`, `eslint-config-next`, `@types/next` if present. (No `@storybook/nextjs` — Storybook is already on `@storybook/react-vite`.)
- Rename: `"name": "@papercusp/web"` → `"name": "@papercusp/operator-vite"`.
- Run `npm install --legacy-peer-deps` from repo root.

**Catch-all shim deletion is the backend agent's:** `apps/operator/app/api/[[...route]]/route.ts` (the 25-line `handle(app)` shim) is theirs to delete as part of their final-batch close-out, *before* H2 runs. The H1 gate-check accounts for this — by the time H starts, that file is already gone.

**`apps/operator/app/api/openapi.json/route.ts` is also the backend agent's:** they confirmed they'll port it to `defineRoute` in their last batch (10-min change, runtime endpoint that needs the route registry at request-time). Removes the only escape-hatch that would otherwise force a Next dependency to survive Phase H.

### H3. Cross-repo sweep

```
# next-related comments / scripts / hardcoded ports.
grep -rE 'next dev|next build|next start|\.next/|next\.config' apps/ packages/ libs/ bin/ \
  | grep -v 'apps/operator-docs' | grep -v 'apps/papercusp-docs'
# Should be empty (modulo migration-history comments in plans/insights).
```

`apps/papercup/` was de-fumadocs'd in audit #4 but **is still a Next app** (uses Next for the marketing/demo surface). Its scope is *out of this plan* — see deferred-plan note that calls it out as a separate stream. I will not touch it.

### H4. Documentation + memory

- Update `MEMORY.md` index entries: rename `feedback_webapp_retired_use_tauri_dev` → reflect that the dev path is now `cd apps/operator-vite && npm run dev` (or whatever the final desktop dev script does).
- Add an insight at `apps/operator-docs/src/content/docs/agent-insights/operator-vite-migration-2026-05-20.mdx` capturing the conventions chosen (TSR file-router, `$id` not `[id]`, IPC polyfill invariant in `__root.tsx`, single-process production host).
- Mark this plan `status: shipped` in its frontmatter.

### H acceptance (greppable, the final scorecard)

```
# Zero Next deps.
grep -c '"next"' apps/operator/package.json   # → 0
grep -c '"next"' package.json                  # → 0
# Zero Next imports.
grep -rE "from ['\"]next/" apps/operator/ apps/operator-vite/ packages/ libs/ | wc -l   # → 0
# Zero Next configs.
test ! -e apps/operator/next.config.js
test ! -e apps/operator/proxy.ts
test ! -d apps/operator/app
# One process in production.
pgrep -af 'next' | wc -l   # → 0
# All Playwright smokes still pass.
(cd apps/operator-vite && npx playwright test) 
```

### H NOT shipping

- `apps/papercup/` Next removal (separate stream, separate plan).
- Webapp deploy of `apps/operator-vite/` (the operator is still desktop-shipped; webapp deploy is host-architecture Track A).

### H rollback

Single revert of the deletion PR. Because every change up through Phase G was additive (the Vite app, the host, the docs migration), reverting H by itself restores the Next stack. Everything else stays in place.

**Estimate:** 1 day.

---

## Coordination

### What I share with the backend agent

| Surface | Owner | Discipline |
|---|---|---|
| `apps/operator/app/api/_hono/app.ts` | Backend agent (writes routes), me (consumes `app` export) | I add `export { app }` once (P0). Backend agent owns mounts. No structural moves during the migration. |
| `apps/operator/app/api/_hono/bootstrap.ts` | Backend agent | I call `runBootstrap()` from `bin/hono-host.ts`. They preserve its idempotent contract. |
| `apps/operator/app/_components/*` | Shared during migration; mine after Phase B | Both apps import. I prefer in-place edits during the migration window. |
| `apps/operator/lib/*` | Shared | Library code; touched by both as needed. Coord-channel announce on big refactors. |
| `apps/operator/package.json` deps section | Shared | Coord-channel before adding/removing deps. |

### Paperclip-pause policy

Per `feedback_paperclip_collision_race.md`: I do **not** SIGSTOP paperclip during this migration. On a stomp, re-apply the edit + commit fast. Harness UI files are mostly not in scope for this migration (they're under `app/harness/` — page-side surface I'll port batch-by-batch; once a page is in `apps/operator-vite/src/routes/harness/`, paperclip's edits to `app/harness/page.tsx` are irrelevant to the Vite app's correctness). If a paperclip-edited page in `app/harness/` collides with my in-progress Vite port, I take their edits as the source of truth and re-port.

### Cadence

- **Daily** `coord/frontend.jsonl` append: what I'm working on, which file-paths I'm holding, which `/api/*` path prefixes have moved into the Hono host (if relevant).
- **Pre-edit** of any shared file (`_hono/*`, `_components/*`, `lib/*`): `git log --since="48h ago" --name-only -- <path>` to see what the backend agent touched.
- **Pre-merge** of any PR that changes `apps/operator/package.json`: ping coord channel.

### Coord contract

Frozen 2026-05-20, then trimmed when the backend stream shipped. The v2 plan defined three event kinds for tracking a live two-stream race (`prefix-migrated`, `route-ts-zero`, `batch-shipped`). The first two are **obsolete** — the backend stream finished, so there is no moving `/api` split to track and no route-ts-zero gate to wait for. One event kind remains:

**I emit, on each completed Phase B batch:**
```json
{"ts":"<ISO>","agent":"frontend","kind":"batch-shipped","batch":"B-3","slugs":["/harness","/harness/$slug",...],"commit":"<sha>"}
```
- `slugs` enumerates the routes that now live in `apps/operator-vite/src/routes/`.
- Lets anyone touching a page's data layer know which page surfaces are real (translated + verified), not just stubbed.

Everything else stays free-form prose under `kind: "checkpoint"` / `"note"`.

### Files the backend agent must NOT structurally move

- `apps/operator/app/api/_hono/app.ts`
- `apps/operator/app/api/_hono/bootstrap.ts`

(They can add routes to these and split them internally. They cannot move them to a different directory until Phase H is shipped.)

---

## Overall scorecard (the eight greppable checks)

After Phase H:

```
1. grep -rE "from ['\"]next/" apps/operator/ apps/operator-vite/ packages/ libs/ | wc -l   # → 0
2. grep -c '"next"' apps/operator/package.json package.json                                # → 0 (both lines)
3. test ! -e apps/operator/next.config.js apps/operator/proxy.ts                            # → exit 0
4. test ! -d apps/operator/app                                                              # → exit 0
5. pgrep -af 'next (dev|start|build)' | wc -l                                              # → 0
6. find apps/operator-vite/src/routes -name 'page.tsx' | wc -l                              # → 0 (TSR uses different names)
7. (cd apps/operator-vite && npm run build) && curl -sf http://127.0.0.1:4173/ | grep -q '<html'
8. (cd apps/operator-vite && npx playwright test)                                           # → all pass
```

If all eight pass, the migration is done.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Per-page UI regressions during translation** | Each batch has Playwright smokes. I drive headless WebKit against the Vite app and compare to the same page on the Next app. (Per memory: never claim a UI fix done off unit tests / curl — `feedback_browser_e2e_verify_ui_fixes`.) |
| **`useSyncQuery` / Zero / IPC polyfill subtly broken under the new providers** | Phase A's hello page exercises Query + Zero + IPC before any page translation. If it doesn't work, the migration stops until it does. |
| **`node-pty` native binding lost in the bundled host** | Explicit copy step in `bin/hono-host-build.sh` (the only native dep). Verified per-platform in Phase F. |
| **SSR loss (cold-paint flash)** | Tauri webview caches aggressively; on the desktop the flash is one-time per webview cold start. Acceptable per existing decision. |
| **The backend agent finishes Phase 4-equivalent later than I finish Phases A–F** | Fine — Phase G is gated on their completion. Phase H follows G. The two streams run independently up to G. |
| **A page imports `next/server` (rare; types only)** | Coord with backend agent on a shared type-shim (e.g. `import type { NextRequest }` becomes `import type { Request } from '@hono/node-server'` or similar). |
| **`next/dynamic` had Next-specific SSR=false semantics** | Vite/SPA is SSR=false by default. Direct `React.lazy` matches. |
| **CSS imports / globals collisions** | `apps/operator/app/globals.css` becomes `apps/operator-vite/src/styles/globals.css` (or symlink). One import in `main.tsx`. |
| **Storybook (`storybook dev -p 6009`)** | **No migration needed — verified.** `package.json` declares `@storybook/react-vite` (`^10.3.6`) and `.storybook/main` already has `framework: { name: '@storybook/react-vite' }`. Storybook is already on Vite and framework-independent of Next. The only Phase H touch: confirm it still resolves after the `apps/operator` → `apps/operator-vite` move (import-path sweep covers it). The v2 plan claimed a `@storybook/nextjs` → `@storybook/react-vite` migration; that was wrong — there is no `@storybook/nextjs` in the repo. |
| **Lost-pixel visual regression tests** | Same — they don't depend on Next; verify in Phase F. |

---

## Effort estimate

Refreshed 2026-05-20 after the Phase-0 re-grep: the backend stream shipped (Phase G de-gated), the page-side `next/*` surface is **40 sites not 97** (Phase B shrinks), and there's no Next sidecar to wire (Phase A/C simpler).

| Phase | Duration | Gating |
|---|---:|---|
| 0 — pre-flight & boundary (`BOUNDARY.md` + coord entry; export already shipped) | 0.5 days | none — done this turn |
| A — scaffold | 2–3 days | — (can overlap C) |
| B — router translation (62 pages, 40 `next/*` sites, B6 `@bprogress` adapter, 6 Playwright smokes @ ~1d) | **3–4 weeks** | per-batch review |
| C — `@hono/node-server` host + `/wiki` + `/drizzle-studio` ports | 2–3 days | — (can run before/with A) |
| D — page-side next/* audit | 1 day (rolled into B) | B complete |
| E — config replication | 3–4 days | C complete |
| F — Tauri shell (sibling repo `../papercusp-desktop/`) | 2 days | E complete |
| G — single-process production | 2 days | E complete (backend gate already met) |
| H — cutover + move + import-path sweep + deps drop | 2–3 days | G complete |
| **Total (mine, single-agent)** | **~5–6 weeks** | — |

Down from the v2 estimate of ~7–9 weeks: Phase B shrank (40 import sites, not 97), Phase G de-gated (no waiting on the backend stream), and the Next-sidecar scaffolding is gone. If batches B-1..B-6 parallelize across worker-agents, total drops to ~3 weeks.

---

## Open questions

These need user input. None block Phase 0/A start.

1. **Webapp deploy.** The deferred plan called out webapp deploy (host-architecture Track A) as a separate concern. This plan keeps the operator desktop-shipped. Confirm webapp is still out-of-scope for this stream, even though the Vite app would in principle be deployable to any static host + the Hono host on a server.
2. **`apps/papercup/` Next removal.** That app is still on Next (de-fumadocs'd but not de-Next'd). Out of scope for this plan; flagging that it's the next domino if you want zero Next anywhere.
3. **Server Actions / `'use server'`.** I haven't grepped for these (backend agent's surface). If they exist, the backend agent's plan covers them. Flagging only because their replacement (Hono routes + `useMutation`) is described in the deferred plan and the same pattern applies here.

**Resolved during review (no longer open):**
- ~~Production port~~ — decided 2026-05-20: the Vite stack takes over the two Next ports directly — **`:3055` for the Vite dev server, `:3070` for the production Hono host**. Next is being retired, so there's no collision; Vite claims both from day one. No third port — there is no Next sidecar (backend stream shipped).
- ~~Final directory layout~~ — decided 2026-05-20: option (b), merge into `apps/operator-vite/`. See [Phase H](#h2-the-deletion--move-pr-option-b-merge-into-appsoperator-vite).
- ~~`@bprogress/next` replacement~~ — moved to [Phase B6](#b6-bprogressnext--tsr-adapter-30-60-loc) as a concrete ~30-60 LOC sub-task, not config.

---

## NOT in scope (explicit)

- Backend route migration (`route.ts` → Hono routes). Other agent.
- `apps/papercup/` Next removal. Future.
- `apps/papercusp-docs` / `apps/operator-docs`. Already migrated to Starlight.
- Webapp deploy / Track A. Host-architecture stream.
- SSR / RSC adoption. Decided: SPA.
- Auth changes. Loopback-only stays; webapp auth is Track A.
- `libs/papercusp/**` rust-port submodule. Has its own discipline.
- `packages/agent-mcp/**`. Host-architecture agent.
- `libs/sync/**`. Host-architecture agent.
- IPC bridge / EventSource polyfill. Already shipped (host-arch Phase 1).

---
