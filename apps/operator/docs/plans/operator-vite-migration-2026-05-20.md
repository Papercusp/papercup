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

**State:** Plan drafted 2026-05-20. Scope: app shell, router, Vite/build, and the `@hono/node-server` host process. Backend endpoint decoupling is being executed in parallel by another agent (the "backend agent") — see [Scope split](#scope-split). The two streams end-state: `npm run dev` in `apps/operator-vite/` is the only thing the desktop loads; the existing `apps/operator/` Next surface is deleted.

**Next:** User reviews. Then Phase 0 pre-flight: lock the boundary contract with the backend agent (one PR adds `_hono/app.ts` exports + `runBootstrap()` discipline that both hosts consume), then start Phase A scaffold.

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
- I will not rewrite `route.ts` handler signatures or `next/server` consumers. If a route.ts isn't migrated to Hono by Phase G, I host both Vite static + the Next sidecar in parallel until the backend agent finishes — Vite serves `/`, Hono catches `/api/*`, anything not yet migrated still goes through Next behind a flag until cutover. ([Phase G](#phase-g--production-host) details the parallel-run mechanism.)
- I will not touch `next/headers` / `cookies()` consumers (6 routes). Backend agent's problem.
- I will not refactor `packages/agent-mcp/**` or `libs/sync/**`. Host-architecture agent owns those.

---

## Inventory (greppable, all under `apps/operator/`)

Measured 2026-05-20:

| What | Count | Source of truth |
|---|---:|---|
| `app/**/page.tsx` (my scope) | **62** | `find app -name 'page.tsx' \| wc -l` |
| `app/**/layout.tsx` (my scope) | **6** | `find app -name 'layout.tsx' \| wc -l` |
| `app/**/route.ts` (backend agent's scope) | **70 remaining** (was 91; 21 batches already migrated to `defineRoute`) | `find app -name 'route.ts' \| wc -l` |
| `app/{loading,error,not-found}.tsx` files (my scope) | **6** | `find app \( -name 'loading.tsx' -o -name 'error.tsx' -o -name 'not-found.tsx' \)` |
| Parallel routes (`@slot`) | **0** | `find app -path '*/@*'` |
| Intercepting routes (`(.)`, `(..)`) | **0** | `find app -type d -name '(*)'` |
| Route groups (`(group)`) | **0** | same |
| `next/server` imports (backend agent) | **295** | `grep -rh "from 'next/server'" \| wc -l` |
| `next/navigation` imports (my scope) | **53** | `grep -rh "from 'next/navigation'"` |
| `next/dynamic` imports (my scope) | **32** | `grep -rh "from 'next/dynamic'"` |
| `next/link` imports (my scope) | **12** | `grep -rh "from 'next/link'"` |
| `next/headers` imports (backend agent) | **6** | `grep -rh "from 'next/headers'"` |

**Implication of zero parallel/intercepting routes + zero route groups:** the App Router → TanStack Router translation is **mechanical**. No bespoke routing patterns to preserve. This is the single biggest factor making this migration tractable.

**Note on count drift:** the page-side `next/*` counts (53/32/12) above were measured 2026-05-20 against `apps/operator/app/`. The backend agent's route migration may have removed a handful of `next/server` imports that were inlined in `route.ts` test fixtures; re-grep these three numbers at Phase 0 start to refresh the baseline. Backend hasn't touched page-side code, so the numbers should be stable, but verify rather than trust.

---

## Architecture decisions

Re-affirmed from the deferred-plan's decision table (those decisions are good; I'm not relitigating them):

| Concern | Choice | Why (tightened) |
|---|---|---|
| **Bundler** | **Vite 8** (Rolldown-Vite once 1.0 is GA-stable in the workspace; default Rollup until then) | TanStack Router has a first-party Vite plugin (`@tanstack/router-plugin/vite`) for file-based route generation; no Rsbuild equivalent. Switching builders later is local to `apps/operator-vite/vite.config.ts`. |
| **Router** | **TanStack Router 1.x**, file-based generator | File-router maps 1:1 onto our `app/**/page.tsx` tree with one mechanical convention swap (see [Phase B](#phase-b--router-translation)). Typed `Link`/`useParams`/`useSearch` close to Next's mental model. `defer`/`loader`/`pendingComponent` cover what `loading.tsx` did. |
| **HTTP host (dev)** | Vite dev server (`vite`) on **:3055** with proxy to Hono on **:3057** | Mirrors the current `next dev -p 3055` port so Tauri/desktop env-var paths don't change. Hono runs in a sibling dev process. |
| **HTTP host (prod)** | **One process** — `@hono/node-server` on **:3055** serves Vite `dist/` static + mounts the Hono app | Collapses `next start` (:3055) + Next standalone (:3070) into one. The `:3070` standalone variant goes away. |
| **State / data layer** | TanStack Query + nuqs + Zero (**unchanged**) | None of these care about the framework. `useSyncQuery` and `transport-adapters` seams already exist; they keep working. |
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

**Goal:** stand up `apps/operator-vite/` as a fresh Vite + React + TanStack Router app, in parallel with the live `apps/operator/`. No translation of pages yet — just the empty shell that builds, dev-runs, and proxies `/api/*` to the existing Next sidecar on :3055 so the dev experience is end-to-end usable from day one.

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
- `@tanstack/react-router@^1`, `@tanstack/react-query` (already in root)
- `react@^19`, `react-dom@^19` (match what `apps/operator` already uses)
- TS: `typescript@^5` (match root)

**No new state libs.** TanStack Query + nuqs + Zero come over from `apps/operator` via the workspace.

### A2. Dev-server proxy (coord-derived)

In `vite.config.ts`, proxy `/api/*` and `/api-ws/*` (if any) to the Hono catch-all that is currently being served by `next dev` on a sibling port. **The split between "go to Next sidecar (un-migrated)" and "go to `@hono/node-server` host (migrated)" is derived from `coord/frontend.jsonl`, not hand-curated** (see [Coordination — coord contract](#coordination-coord-contract)). The backend agent emits one `{kind:"prefix-migrated", prefix:"/api/foo", commit:"<sha>"}` entry per family they port; Vite re-reads the log at dev-start and emits the table:

```ts
// vite.config.ts (illustrative)
import { defineConfig } from 'vite';
import { deriveProxyFromCoord } from './scripts/derive-vite-proxy.mjs';

export default defineConfig({
  server: {
    port: 3055,
    host: process.env.PAPERCUSP_BIND_HOST ?? '127.0.0.1',
    // deriveProxyFromCoord reads ../../coord/frontend.jsonl and emits:
    //   { '/api/migrated-prefix-1': { target: 'http://127.0.0.1:3057', ... },
    //     '/api/migrated-prefix-N': { target: 'http://127.0.0.1:3057', ... },
    //     '/api':                   { target: 'http://127.0.0.1:3056', ws: true, ... },  // fallback to Next sidecar
    //     '/internal/docs':         { target: 'http://127.0.0.1:3057', ... } }
    proxy: deriveProxyFromCoord({ honoHost: 3057, nextSidecar: 3056 }),
  },
  plugins: [
    TanStackRouterVite({ routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts' }),
    react(),
  ],
});
```

`apps/operator-vite/scripts/derive-vite-proxy.mjs` is a ~40-line script that:
1. Reads `coord/frontend.jsonl` for all `prefix-migrated` entries.
2. De-duplicates (latest entry per prefix wins).
3. Returns the Vite proxy object literal.

This way, when the backend agent ports a new family, **one line in `coord/frontend.jsonl` automatically updates the Vite dev proxy on the next dev restart** — no manual mirror, no drift.

The Next sidecar runs on a *new* port (`:3056`) during the migration so Vite can own `:3055` (which is what Tauri / `PAPERCUSP_BIND_HOST`-aware scripts expect). One sed pass in `apps/operator/package.json`: `next dev -p 3055` → `next dev -p 3056`. The desktop's env config gets one update (or is gated on a `PAPERCUSP_USE_VITE=1` flag for the bring-up window) — see [Coordination](#coordination).

### A3. Root route + providers

`src/routes/__root.tsx` renders:
- `<QueryClientProvider>` (TanStack Query)
- `<RootSyncProvider>` (the Phase-1-shipped IPC/HTTP sync substrate — `apps/operator/app/_components/RootSyncProvider.tsx`, which I import as-is from the existing app via the workspace package alias)
- `<NuqsAdapter>` (or whatever the current root layout uses — translated 1:1 from `apps/operator/app/layout.tsx`)
- `<Outlet/>` for nested routes
- `notFoundComponent` that renders the existing `apps/operator/app/not-found.tsx` content

**The IPC polyfill mount point matters.** Host-architecture Phase 1 installs `window.EventSource = IpcEventSource` / `window.fetch = ipcFetch` before any data-layer code mounts. That must remain the first thing rendered. In TSR, that's the body of `__root.tsx`'s component before `<Outlet/>`. I document this as an invariant in the file's top comment so future edits don't reorder.

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

And a `bin/dev-vite.sh` (or `bin/overmind`-style entry) that starts both Vite (:3055) and the Next sidecar (:3056) in parallel during the migration window. The exact mechanism lives in the desktop dev launcher; I'll wire it into whichever already-existing orchestrator script the desktop uses (TBD on first read of `papercusp-desktop/`).

### A acceptance (greppable)

```
test -f apps/operator-vite/vite.config.ts
test -f apps/operator-vite/src/routes/__root.tsx
test -f apps/operator-vite/src/routes/index.tsx
(cd apps/operator-vite && npm run build) && test -f apps/operator-vite/dist/index.html
# Live: Vite on :3055 serves the hello page; /api/healthz proxies through to Next on :3056 and returns 200.
curl -sf http://127.0.0.1:3055/ | grep -q 'operator-vite'
curl -sf http://127.0.0.1:3055/api/healthz   # 200
```

### A NOT shipping

- Zero page translations from `app/`.
- No deletions from `apps/operator/`.
- No Hono-host process — the Next sidecar still owns the API in this phase.

### A rollback

`rm -rf apps/operator-vite` and revert the one-line `next dev -p 3056` change.

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

I'll land Phase B in batches by top-level route to keep each PR small and reviewable. From the existing directory listing:

| Batch | Top-level | Pages |
|---|---|---:|
| B-1 | `/` (root), `/login`, `/signup`, `/setup`, `/not-found` | 5 |
| B-2 | `/admin` | ~6 |
| B-3 | `/harness` (the big one — nested by slug) | ~15 |
| B-4 | `/settings` | ~8 |
| B-5 | `/dev`, `/drizzle-studio`, `/editor-demo`, `/el-min`, `/operator-mock` | ~6 |
| B-6 | `/marketplace`, `/installed`, `/wiki`, `/snapshots`, `/support`, `/design`, `/coord`, `/pi`, `/project-docs` | ~9 |

(Exact per-batch counts will fall out of the inventory; the split is "ship a coherent surface per PR".)

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

The top-of-page navigation progress bar uses `@bprogress/next`, which hooks `next/navigation`'s router events. Replacement is `@bprogress/react` (same author) wired into TSR's `useRouterState`. The adapter:

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

**Goal:** stand up a standalone Node process that hosts the existing `_hono/app.ts` directly via `@hono/node-server`, with no Next involvement. Runs alongside the existing Next sidecar until enough of the backend agent's migration has landed to make it the primary. By the end of this phase the API can be served two ways (Next sidecar or `@hono/node-server`); they're interchangeable from the client's perspective.

### C1. Host process

Create `apps/operator/bin/hono-host.ts` (or `apps/operator-vite/server/host.ts` — see [Phase G](#phase-g--production-host) for the final home):

```ts
// hono-host.ts (illustrative)
import { serve } from '@hono/node-server';
import { app } from '../app/api/_hono/app';
import { runBootstrap } from '../app/api/_hono/bootstrap';

runBootstrap(); // idempotent — safe in HMR + standalone
const port = Number(process.env.PAPERCUSP_HONO_PORT ?? 3057);
const host = process.env.PAPERCUSP_BIND_HOST ?? '127.0.0.1';

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`[hono-host] listening on http://${info.address}:${info.port}`);
});
```

This is ~15 lines. It works **today** for every Hono route already mounted in `_hono/app.ts`. Routes that are still `app/**/route.ts` files (not yet migrated by the backend agent) **continue to live in the Next sidecar** during this phase. The Vite dev-proxy splits between the two:

```ts
// vite.config.ts (illustrative, during Phase C → Phase H)
proxy: {
  // Routes the backend agent has migrated → Hono host on :3057.
  '/api/healthz': { target: 'http://127.0.0.1:3057' },
  '/api/agent-tools': { target: 'http://127.0.0.1:3057' },
  // ... (list grows as backend agent migrates more)
  // Everything else still goes to the Next sidecar on :3056.
  '/api': { target: 'http://127.0.0.1:3056' },
}
```

The backend agent's coord-channel entries announce which path prefixes have moved; I update the Vite proxy table accordingly. The map ends up empty when only the Hono path remains; then the `/api` entry becomes `:3057` and the Next sidecar can be killed.

### C2. Static asset serving (dev)

In dev, Vite serves static assets (from `apps/operator-vite/public/`, which symlinks to `apps/operator/public/`). No Hono involvement needed for static serving in dev.

### C3. Dev launcher integration

Update the dev-launcher (`bin/dev-vite.sh` from Phase A, or whichever orchestrator the desktop uses) to start three processes during the migration window:
1. Vite (`:3055`) — owns the page tree
2. Next sidecar (`:3056`) — owns un-migrated `route.ts` files + the Hono catch-all (until [Phase G](#phase-g--production-host))
3. `hono-host` (`:3057`) — owns the directly-mounted Hono routes

This is temporary scaffolding; collapses to one process at cutover.

### C acceptance (greppable)

```
# The Hono host boots and serves the catch-all.
PAPERCUSP_HONO_PORT=3057 tsx apps/operator/bin/hono-host.ts &
sleep 2
curl -sf http://127.0.0.1:3057/api/healthz   # 200 (assumes backend agent migrated this)
# The Vite proxy routes API calls correctly.
curl -sf http://127.0.0.1:3055/api/healthz   # 200, same body as direct
# Both hosts can run side-by-side.
ss -tnpl | grep -E ':3055|:3056|:3057' | wc -l  # → 3
```

### C NOT shipping

- No deletion of the Next route catch-all (`app/api/[[...route]]/route.ts`).
- No production deploy of the Hono host yet.
- No collapsing of Next + Hono into one process.

### C rollback

Stop the Hono host process; Vite proxy falls back to `:3056` for everything. Nothing else changed.

**Estimate:** 2–3 days.

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
| `transpilePackages: [...]` (workspace packages) | Vite's `server.fs.allow` + workspace symlinks handle source TS automatically — **but not workspace packages that ship JSX from `node_modules`**. `@papercusp/agent-mcp` exports JSX from a few tool-return files; Vite's default esbuild loader doesn't transform JSX in `node_modules` even via symlink unless explicitly told. Add `optimizeDeps.include: ['@papercusp/agent-mcp', ...other-JSX-shipping-packages]` to `vite.config.ts`, plus `ssr.noExternal` defensively (no-op for SPA but cheap insurance). ~5 lines. Per-package verify during Phase A smoke. |
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

Already partially specified in [A2](#a2-dev-server-proxy) and [C1](#c1-host-process). Final shape during the migration window:
```
:3055 (vite)   → owns pages + static
  proxy /api/<migrated-path> → :3057 (hono-host)
  proxy /api                  → :3056 (next sidecar)
  proxy /internal/docs        → :3057 (hono-host serves static + middleware)
```

After Phase H this collapses to a single backend on `:3057`.

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

- No deletion of `next.config.js` / `proxy.ts` yet — they're still active for the Next sidecar.
- No production deployment.

### E rollback

Each setting's port is independently reversible (kill the middleware / proxy entry).

**Estimate:** 3–4 days.

---

## Phase F — Tauri shell

**Goal:** the desktop's Tauri webview loads the Vite app instead of the Next app. Dev loads the Vite dev server URL; prod loads bundled static files.

### F1. Dev URL

Tauri's `tauri.conf.json` has a `build.devUrl` (or older `build.devPath`) pointing at the operator's dev server. Currently `http://127.0.0.1:3055` (Next). Vite is on the same port → **no Tauri-side change** for dev once Phase A's Vite server owns `:3055`.

The desktop's dev orchestrator (whichever `bin/` script starts the operator + waits for it to be reachable) needs to wait on Vite instead of Next. Mechanically identical — both serve a 200 on `/` once warm. The "is the operator ready" probe (a `curl -fs http://127.0.0.1:3055/` in a loop) doesn't care which server answered.

### F2. Prod load target

Today: Tauri prod loads from the `next start` (or standalone) sidecar — a separate Node process the desktop spawns.

After this migration: Tauri prod loads from `http://127.0.0.1:3057` served by `bin/hono-host.ts` (the single-process backend from Phase G). The host serves `dist/index.html` + SPA assets via `serveStatic`, plus the `_hono/app.ts` mounts at `/api/*` and `/internal/docs/*` middleware. **One Node process replaces two.**

Tauri's `tauri.conf.json` `build.frontendDist` (or the older `distDir`) points at where the static SPA lives. Two options:
- **(a) Point Tauri at `apps/operator-vite/dist/`** — Tauri loads files directly; `:3057` only serves `/api/*`. Simpler in theory but breaks the `/internal/docs/*` rewrite (Tauri's static loader has no middleware).
- **(b) Keep loading from `http://127.0.0.1:3057`** — Hono host serves both static + API + docs middleware uniformly. **Recommended.** Matches today's "Next standalone serves the app" model; one fewer special case.

I'll go with **(b)**. Tauri config change: `frontendDist` → `http://127.0.0.1:3057` (URL form, not path form). Same shape as today.

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
PAPERCUSP_HONO_PORT=3057 ./bin/hono-host &
sleep 2
curl -sf http://127.0.0.1:3057/ | grep -q 'operator-vite'   # static SPA shell
curl -sf http://127.0.0.1:3057/api/healthz                  # 200
curl -sf http://127.0.0.1:3057/internal/docs/agent-policies # 200
```

### F NOT shipping

- No Tauri-side dev URL change (it's already `:3055`).
- No desktop release.yml or Actions wiring — releases stay local per existing memory.

### F rollback

Tauri config revert + release script revert. Both single-line / single-file changes.

**Estimate:** 2 days, of which most is verifying the release path end-to-end against a real desktop install.

---

## Phase G — Production single-process host

**Goal:** collapse the three-process dev model (Vite + Next sidecar + Hono host) into the production target of **one process**. After this phase, prod is `node hono-host.js`; dev is `vite` + `hono-host` (two processes; Next sidecar is gone).

This phase **cannot start** until the backend agent has finished migrating all `route.ts` files to Hono routes in `_hono/app.ts` (i.e. the Next sidecar has nothing left to serve). Phase G is gated on a coord-channel signal from the backend agent saying "no route.ts files remain".

### G1. Verify the gate

```
find apps/operator/app -name 'route.ts' -not -path '*/[[...route]]*' | wc -l   # → 0
```

(The catch-all `[[...route]]/route.ts` is the Next-side shim; **backend agent deletes it as part of their final-batch close-out, not me.** All other `route.ts` must be gone before Phase G can start.)

**Backend agent ETA at plan-edit time (2026-05-20):** 70 remaining out of 91, grinding ~14 per turn → realistically a few days of focused work for them to hit zero. **Phase G start date in [Effort](#effort-estimate) is therefore pinned to "max(Phase E complete, backend at zero) + ~1 day buffer".**

### G2. Drop the Next sidecar from the dev launcher

Update `bin/dev-vite.sh` (or whatever orchestrator) to start two processes:
1. Vite (`:3055`) — pages
2. `hono-host` (`:3057`) — API + docs + static (for non-Tauri smoke)

Vite proxy table collapses to a single entry: `/api → :3057`.

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
curl -sf http://127.0.0.1:3057/                              # SPA → 200
curl -sf http://127.0.0.1:3057/login                         # SPA → 200 (client routes)
curl -sf http://127.0.0.1:3057/api/healthz                   # API → 200
curl -sf http://127.0.0.1:3057/internal/docs/agent-policies  # Docs → 200
curl -sI http://127.0.0.1:3057/nonexistent | head -1         # 200 (SPA shell — client router handles 404)
```

### G NOT shipping

- No deletion of `apps/operator/app/` yet.
- No removal of Next deps from `package.json` yet.
- No deletion of `next.config.js` / `proxy.ts` yet.

### G rollback

Re-enable the Next sidecar in the launcher; flip the Vite proxy table back to the per-path split. No code changes need reverting — the sidecar files still exist (deleted in Phase H).

**Estimate:** 2 days, blocked on backend agent's completion. Realistically gated on whenever they finish their 91-route migration.

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
- Edit `apps/operator-vite/package.json` (new home of what was `@papercusp/web`): remove `next`, `@bprogress/next`, `eslint-config-next`, `@storybook/nextjs`, `@types/next` if present.
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

Frozen 2026-05-20. Two structured event kinds the streams emit on `coord/frontend.jsonl` so the other side's tooling can react mechanically. (Anything else stays free-form prose under `kind: "checkpoint"` / `"note"`.)

**Backend agent emits, one per migrated path family:**
```json
{"ts":"<ISO>","agent":"backend","kind":"prefix-migrated","prefix":"/api/foo","commit":"<sha>"}
```
- `prefix` is the path prefix that has moved from a Next `route.ts` to a `defineRoute` mount in `_hono/app.ts`. Examples: `/api/projects`, `/api/agent-mcp/operator-scan`, `/api/healthz`.
- One entry per family. If a family is migrated in pieces, emit once when the whole family is on the Hono side.
- `commit` is the SHA that landed it (so I can revert mentally if the line lies).

**My `bin/derive-vite-proxy.mjs` reads these** to build the Vite dev-proxy table at dev-start (see [A2](#a2-dev-server-proxy-coord-derived)). No manual mirror.

**Backend agent also emits, exactly once, at the end:**
```json
{"ts":"<ISO>","agent":"backend","kind":"route-ts-zero","commit":"<sha>","notes":"catch-all shim deleted in this commit"}
```
This is the Phase G start-gate signal. My tooling watches for it; I start Phase G's work the same day.

**I emit, on each completed Phase B batch:**
```json
{"ts":"<ISO>","agent":"frontend","kind":"batch-shipped","batch":"B-3","slugs":["/harness","/harness/[slug]",...],"commit":"<sha>"}
```
- `slugs` enumerates the routes that now live in `apps/operator-vite/src/routes/`.
- Backend agent uses this to know which page-side surfaces are real (not just translated) — useful when their route migration touches a page's data layer.

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
| **Storybook (`storybook dev -p 6009`)** | **Real migration: `@storybook/nextjs` → `@storybook/react-vite`.** Story files (`.stories.tsx`) don't change. Preset, decorators, and any `next/image` / `next/link` / `next/navigation` mocks need rework. Budget 1-2 days in Phase F. |
| **Lost-pixel visual regression tests** | Same — they don't depend on Next; verify in Phase F. |

---

## Effort estimate

Refreshed 2026-05-20 after review (#9 Storybook +1-2d in F; #5 testing budget reshaped within B; #13 H expanded for the move-PR; #15 G gate pinned).

| Phase | Duration | Gating |
|---|---:|---|
| 0 — pre-flight & boundary (`BOUNDARY.md` only; export already shipped) | 0.5 days | backend-agent ack |
| A — scaffold | 2–3 days | — |
| B — router translation (6 batches, includes B6 `@bprogress` adapter + 6 Playwright smokes @ ~1d each) | 4–6 weeks | per-batch review |
| C — `@hono/node-server` host | 2–3 days | A complete |
| D — page-side next/* audit | 1 day (rolled into B) | B complete |
| E — config replication | 3–4 days | C complete |
| F — Tauri shell + Storybook `@storybook/nextjs` → `@storybook/react-vite` | 3–4 days | E complete |
| G — single-process production | 2 days | **max(E complete, backend at 0 route.ts) + ~1d buffer** |
| H — cutover + move + import-path sweep + deps drop | 2–3 days | G complete; backend agent has already deleted catch-all shim + ported `openapi.json` |
| **Total (mine, single-agent)** | **~7–9 weeks** | — |

If batches B-1..B-6 are parallelized across multiple worker-agents (per the deferred plan's "if revisited" note), total drops to ~4–5 weeks.

---

## Open questions

These need user input. None block Phase 0/A start.

1. **Production port.** Today's two ports (`:3055` dev, `:3070` standalone) collapse to one. Should that one be `:3055` (matches dev) or `:3070` (matches today's prod)? **Recommendation: `:3055` everywhere.**
2. **Webapp deploy.** The deferred plan called out webapp deploy (host-architecture Track A) as a separate concern. This plan keeps the operator desktop-shipped. Confirm webapp is still out-of-scope for this stream, even though the Vite app would in principle be deployable to any static host + the Hono host on a server.
3. **`apps/papercup/` Next removal.** That app is still on Next (de-fumadocs'd but not de-Next'd). Out of scope for this plan; flagging that it's the next domino if you want zero Next anywhere.
4. **Server Actions / `'use server'`.** I haven't grepped for these (backend agent's surface). If they exist, the backend agent's plan covers them. Flagging only because their replacement (Hono routes + `useMutation`) is described in the deferred plan and the same pattern applies here.

**Resolved during review (no longer open):**
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
