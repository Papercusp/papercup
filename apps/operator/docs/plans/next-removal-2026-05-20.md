---
title: Next.js Removal Plan
slug: next-removal-2026-05-20
status: active
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
---

## Now

**State:** **Date:** 2026-05-20 **Author:** frontend-removal agent (coord/frontend.jsonl) **Status: DEFERRED (Q0 = 3) — revisit ~2027-05** **Companion to:** `host-architecture-2026-05-20-v2.md` (host-architecture agent) **Supersedes:** prior draft of this filename written earlier today **Spin-off (still executable):** [`fumadocs-to-starlight-2026-05-20.md`](./fumadocs-to-starlight-2026-05-20.md) — Phase F is doable on its own merits

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Next.js Removal Plan

**Date:** 2026-05-20
**Author:** frontend-removal agent (coord/frontend.jsonl)
**Status: DEFERRED (Q0 = 3) — revisit ~2027-05**
**Companion to:** `host-architecture-2026-05-20-v2.md` (host-architecture agent)
**Supersedes:** prior draft of this filename written earlier today
**Spin-off (still executable):** [`fumadocs-to-starlight-2026-05-20.md`](./fumadocs-to-starlight-2026-05-20.md) — Phase F is doable on its own merits

---

## Deferral header (2026-05-20)

This plan is **deferred**, not executing. Reasoning, from the host-architecture agent's review + my agreement:

1. **Host-architecture v2 Phase 1 + Phase 4 IPC polyfill shipped 2026-05-20.** The original "popover/SSE connection-pool starvation" firefighting motivator for Next removal is gone — substrate fix is live (`IpcEventSource`, `ipcFetch`, `desktop-bootstrap.ts`, wired through `RootSyncProvider`, 84/84 tests).
2. **Cost-of-doing-nothing baseline** (omitted from original draft, this was the gap): ~1 PR/year for Next major upgrades + occasional middleware tweaks ≈ ~2 weeks/year sustaining cost. Migration cost: 14–16 weeks single-agent. Payback period: ~7 years. Doesn't clear the bar.
3. Host-architecture v2 delivers ~80% of the architectural benefit (host-clean core, webapp-ready, IPC substrate) in 6–8 weeks. After it lands we'll know whether the remaining 20% (no SSR mental tax, one process down in prod, single bundler) is worth chasing.

**If revisited (~2027-05 or sooner):** the work should be **parallelized across 3–4 worker agents against the page inventory**, not single-agent translation. With a mature host-clean substrate by then, batches can land independently; that math changes from 14–16 weeks → ~5–7 weeks. The original plan's pacing assumed single-agent; preserve the structure but split D + E across agents.

**What's still useful in this doc:**
- **Appendix A file inventory** (agent-surface updates) — reusable verbatim.
- **Option B Hono refactor description** — happening anyway under host-architecture Phase 2 (architect agent claiming via coord, not me).
- **Phase F** — extracted to a standalone executable plan: see [`fumadocs-to-starlight-2026-05-20.md`](./fumadocs-to-starlight-2026-05-20.md).

**Sharpening applied below from review feedback (so future-revisit doesn't redo this thinking):**
- Cost-of-doing-nothing baseline added (above).
- Q3 removed from user questions (it's a coord-channel decision; host-architecture agent claims via Phase 2).
- Phase 4 IPC polyfill marked **shipped 2026-05-20** in coordination section.
- SSR-loss tradeoffs named explicitly (cold-paint flash, Server Actions → Hono routes + useMutation, explicit Suspense boundaries).
- Phase D estimate widened to ±50% bands; buffer week → 2 weeks; "mechanical" caveats explicit.
- Plugin SDK contract — pre-Phase-A sub-task added (first-party only? deprecation window?).
- paperclip-pause policy chosen for Phase E (was undecided).
- Intercepting routes audit added alongside parallel-routes audit.
- F4 content-negotiation decision frozen as F4b (Hono middleware + Accept).
- Phase H cutover — H.0 hard-coded path checklist added (real grep targets).
- `apps/papercup/` scope decided (drops Next at cutover; same Vite + Hono stack).

---

## Q0 — Strategic gate (read this first)

The host-architecture v2 plan **explicitly rejects** dropping Next.js (its Q1, answer "no"). Its position: extract a host-clean core, ship reliability fixes, leave Next as a transport choice that webapp deploys can also use. That plan delivers most of the architectural payoff (host-clean lib, webapp-ready, IPC bridge) **without any of the work below.**

This plan does the opposite: rip Next out entirely, replace with Vite + TanStack Router + Hono node server + Starlight, leave zero Next code in the repo.

Numbers honestly:

- **845** files importing from `next/*` (`grep -r "from 'next/" apps/operator/`)
- **240** Next API routes (`route.ts`)
- **63** Next pages (`page.tsx`)
- **2** fumadocs setups (`apps/operator/`, `apps/papercup/`)
- **6** agent prompt files referencing docs/fumadocs surface
- **40+** `.mdx` docs files with cross-links to preserve

Effort: **~14–16 weeks** realistic (~3.5–4 months), single-agent, plus coordination overhead with the host-architecture stream that's editing many of the same surfaces.

### Decision needed before any Phase A work

Pick one:

1. **Proceed with Next removal.** Accept the ~14–16 week scope. The host-architecture plan still ships in parallel (its Phases 1–6a are non-conflicting). Net end state: zero Next in the repo, single SPA app shell, host-clean core, IPC bridge, Starlight docs.
2. **Keep Next, do host-architecture v2 only.** Get ~80% of the architectural benefit (host-clean core, webapp-ready, reliability fix, IPC bridge) in ~6–8 weeks. Operator stays on Next App Router. fumadocs stays. We revisit removal in 6 months once the host-clean refactor has landed and we know whether the layering payoff was sufficient.
3. **Hybrid: do host-architecture v2 now, defer Next-removal explicitly.** Same as option 2 but the user makes the deferral explicit so this plan doesn't keep getting raised.

**If you pick (2) or (3), this plan halts. The rest is conditional on (1).**

My recommendation: **(3) explicit defer** (was previously hedged as "(2) or (3)" — sharpened after review). The architectural smell ("Next is leaking into agent code") is fixed by the host-architecture plan, and as of 2026-05-20 Phase 1 + IPC polyfill have shipped. Removing the framework itself is a separate question — mostly aesthetic + "no SSR mental tax" + "one fewer transport," not load-bearing. 14 weeks is a lot of tax for that delta. Cost-of-doing-nothing is ~2 weeks/year sustaining; payback period ~7 years. Doesn't clear the bar.

**Cost-of-doing-nothing baseline (the math):**
- Next major upgrade: ~1 PR/year × ~2 days = ~2 days/year.
- Middleware/route shape tweaks across Next majors: ~1 PR/year × ~2 days = ~2 days/year.
- Occasional Next-specific debugging: ~1 day/year average.
- Total sustaining cost: ~5 days/year ≈ 1 working week/year.
- Migration cost: 14–16 weeks single-agent (or ~5–7 weeks if parallelized post host-architecture).
- Payback period (single-agent): ~14 years. (Parallel: ~5–7 years.) Either way, not a defensible investment unless the framework actively blocks something concrete.

**SSR loss is real (was undersold in original draft):**
- Cold-paint UX: blank → flash on slow cold-cache loads. Tauri caches aggressively so this matters less inside the desktop app; matters for any webapp deploy.
- Server Actions → Hono routes + `useMutation` migration. Not bookkeeping; real refactor per page.
- Suspense boundaries become explicit, not implicit. Less invisible streaming behavior.
- For an internal Tauri app the SPA tradeoff still favors removal-conceptually, but it's not free.

---

## Summary of architecture decisions (conditional on Q0 = proceed)

| Concern | Choice | Alternative considered | Why |
|---|---|---|---|
| **Bundler** | Vite 8 | Rsbuild 2 (Rust) | Vite has bigger React/TanStack ecosystem and Rolldown-Vite closes prod-build speed gap (Rolldown 1.0 shipped today). Rsbuild is a defensible swap; decision can defer to Phase A. |
| **Router** | TanStack Router 1.170 | React Router v7, Waku, Wouter | Closest mental model to Next App Router. File-based, nested layouts, dynamic params, typed `Link`/`useSearch`. Official "migrate from Next App Router" skill in their docs. |
| **HTTP host** | Hono on `@hono/node-server` | Express, Fastify, raw `node:http` | Already in the codebase (`apps/operator/app/_hono/`). Survives Next-removal unchanged at the route level. |
| **Hono app refactor** | Option B (three-file split) | A (export-as-is), C (re-mount), D (extract package) | Smallest change that pays off for both me and host-architecture agent. See Hono section below. |
| **Docs site** | Starlight (Astro) | VitePress, Docusaurus, fumadocs-sidecar | React-friendly islands, native MDX, first-party autogen sidebar, static HTML output (no second Node process), tiny issue backlog. |
| **Docs agent surface** | `starlight-llms-txt` | Build custom routes | Maintained by Starlight core; produces `/llms.txt`, `/llms-full.txt`, per-page `.md` twins — same URL contract agents already use. |
| **Tauri WebView** | Loads from Vite dev server in dev; static `dist/` in prod | Embedded HTTP server | Same model Next uses today; one less moving piece. |
| **State** | TanStack Query + nuqs + Zero (unchanged) | — | Already in the codebase. None of these care about Next. |
| **SSR** | None — SPA | RSC via Waku | Operator is an app shell, not content. SPA simplifies — but the tradeoff isn't free: cold-paint flash, Server Actions → routes+`useMutation`, explicit Suspense. Tauri's aggressive caching mitigates cold-paint inside desktop; webapp deploy gets it raw. |

---

## Hono app refactor — Option B

Before the migration starts, `apps/operator/app/api/[[...route]]/route.ts` (~155 lines) is split into three files:

### Files

```
apps/operator/app/_hono/
  app.ts          ← creates Hono app, mounts all register*() routers, exports { app }
  bootstrap.ts    ← exports runBootstrap() with all the start*/ensure*() side effects

apps/operator/app/api/[[...route]]/route.ts  (shrinks to ~10 lines)
  import { app } from '../../_hono/app';
  import { runBootstrap } from '../../_hono/bootstrap';
  runBootstrap();
  export const GET = handle(app);
  export const POST = handle(app);
  export const DELETE = handle(app);
  export const PATCH = handle(app);
  export const PUT = handle(app);
  export const OPTIONS = handle(app);
```

### Why Option B (vs A, C, D)

Tradeoffs documented in conversation (TL;DR):

- **A (just `export { app }`)** — side-effects-on-import become a footgun for tests and operator-vite.
- **B (chosen)** — clean separation, small change, pays off for both streams, sets up host-architecture Phase 4 audit naturally.
- **C (re-mount in operator-vite)** — drift risk over 14 weeks; two sources of truth for route surface.
- **D (extract `packages/operator-api/`)** — gets deleted at cutover anyway; over-engineering for a transient state.

### Who owns it

Coordinated via `coord/`. Either:

- **Host-architecture agent's Phase 1** (preferred) — they're already touching this surface for the IPC bridge; 1–2 extra hours.
- **Or me, as Phase C's first PR** — if they'd rather not, I'll land it.

First to claim via `locks:acquire` on `apps/operator/app/api/[[...route]]/route.ts` + `apps/operator/app/_hono/app.ts` + `apps/operator/app/_hono/bootstrap.ts` does it.

### Acceptance

- `apps/operator` boots and serves all existing routes unchanged.
- All e2e specs still pass.
- `import { app } from '@/_hono/app'` works from a fresh file.
- `runBootstrap()` is idempotent (guard against double-start of FS watchers).


## Phases overview

```
A. Bootstrap operator-vite           ~1 week
B. Chrome + auth + first page        ~1.5 weeks
C. API host (Hono via node-server)   ~1 week
D. Page migration: standalone routes ~4–6 weeks
E. Page migration: nested layouts    ~3 weeks
F. Docs: fumadocs → Starlight        ~1.5 weeks
G. Tauri integration                 ~1 week
H. Cutover + delete Next             ~1 week
I. Post-cutover cleanup              ~1 week
─────────────────────────────────────
Total                                ~14–16 weeks
```

Phases A–C are mostly sequential. Phases D–F can run in parallel once C is done. G and H are sequential at the end.

---

## Phase 0 — Pre-flight decisions (~2 days, must complete before Phase A)

Sharpened post-review. These were originally hand-waved as "audit during" — moved up so they're answered before Phase A claims any code.

### 0.1 — Plugin SDK contract: first-party-only or third-party-shipping?

Decide and document: does any plugin in `plugins/` or external (marketplace) ship a Next-shaped `route.ts` that the plugin-host loads?

- **If first-party only** (likely — all current plugins are in-tree): commit to editing them in lockstep with Phase C. No deprecation window needed.
- **If third-party shipping**: contract migration plan with deprecation window (1 release cycle = unknown; depends on marketplace adoption).

Output: `apps/operator/docs/decisions/plugin-sdk-host-shape-2026-XX-XX.md` answering yes/no + migration approach.

### 0.2 — Intercepting routes audit (`(.)foo`)

Grep `apps/operator/app/` for `(.)`-prefixed directories (Next intercepting routes used for modal-from-list patterns). For each:
- Document the page that uses it.
- Decide TanStack Router equivalent (most map to `<Modal>` pattern + nuqs `?modal=...` state).

Output: count + per-usage plan in `apps/operator/docs/decisions/intercepting-routes-2026-XX-XX.md`. Without this, Phase E risk is unbounded.

### 0.3 — Hard-coded `apps/operator/` path audit

Pre-flight for Phase H cutover. `git grep -l 'apps/operator'` produces the list; verify each location handles the rename or accepts a sed sweep:

- `package.json` workspaces array
- `turbo.json` pipeline configs
- `tsconfig.base.json` paths
- `apps/operator/e2e/playwright.config.ts` (basePath, testDir)
- `papercusp-desktop/src-tauri/tauri.conf.json` (devUrl, beforeDevCommand, frontendDist, beforeBuildCommand)
- `bin/release-local.sh`
- `bin/install-standalone-mcp.sh` (BEGIN/END source-of-truth path)
- `apps/operator/prompts/*.tools.md` (path references)
- `apps/operator/scripts/**`
- `apps/operator/content/internal-docs/**/*.mdx` (cross-section links, code-reference paths)
- `.github/workflows/*.yml` (if any operator-scoped jobs)
- `papercusp-desktop/src-tauri/src/dev_bridge.rs` (sidecar config paths)

Output: checklist in `apps/operator/docs/decisions/cutover-path-audit-2026-XX-XX.md`. Verified empty grep = passed Phase H pre-flight.

### 0.4 — papercup scope decision: DECIDED — papercup also drops Next at cutover

`apps/papercup/` is the second Next app (marketing site + docs renderer). Two options were on the table:

- Drop Next from papercup at cutover (same Vite + Hono SPA stack). **Chosen.**
- Leave papercup on Next.

Reasoning: scope-symmetric ("no Next in the repo"), small surface, runs the same docs adapter, drops the second `source.config.ts`. Adds ~0.5 week to Phase H. Codified as part of cutover deliverable, not a separate phase.

If 0.4 turns out to have hidden complexity discovered in pre-flight (e.g. papercup uses Next features we don't), this decision flips back to "leave on Next" with note.

---

## Phase A — Bootstrap operator-vite (~1 week)

### Goal

Create `apps/operator-vite/` that boots an empty React shell on a Vite dev server, served via Tauri WebView in dev mode. Nothing else.

### Scope

Create:

```
apps/operator-vite/
  package.json                  # vite, react, typescript, tanstack-router, tanstack-query, nuqs
  tsconfig.json                 # extends root, references apps/operator/tsconfig.json for shared lib reuse
  vite.config.ts                # plugins: @vitejs/plugin-react, @tanstack/router-plugin
  index.html
  src/
    main.tsx                    # createRoot, RouterProvider
    __root.tsx                  # TanStack Router root route + RootSyncProvider mount point
    routes/
      index.tsx                 # placeholder "operator-vite alive"
  server/
    index.ts                    # @hono/node-server stub (Phase C fleshes this out)
```

Decisions deferred to this phase:

- **Final bundler choice (Vite vs Rsbuild).** If picked Rsbuild instead, `vite.config.ts` becomes `rsbuild.config.ts` and only that file differs. Rest of plan unchanged.
- **Final directory name.** `apps/operator-vite/` is the working name. Possibly `apps/operator-next/` (yes, confusingly) at cutover when it *becomes* the operator.

### Tasks

1. `npm create vite@latest apps/operator-vite/ -- --template react-ts`
2. Install: `@tanstack/react-router @tanstack/router-plugin @tanstack/react-query nuqs @hono/node-server`
3. Configure path aliases to import from `apps/operator/lib/`, `apps/operator/app/_components/`, `apps/operator/app/_hono/` where files are host-clean.
4. Wire monorepo workspace entry so root `npm install` picks it up.
5. Add `dev` and `build` npm scripts.
6. Verify Tauri can point at `http://localhost:<vite-port>` in dev via `papercusp-desktop/src-tauri/tauri.conf.json` (a dev-only `devUrl` field — does **not** affect prod yet).
7. Update `coord/frontend.jsonl` with status.

### Acceptance

- `cd apps/operator-vite && npm run dev` serves a blank page at the configured port.
- Tauri dev mode opens that page in WebView (verify with screenshot via verdict skill).
- `npm run build` produces a `dist/` with hashed bundles.
- TypeScript compiles cleanly importing one symbol from `apps/operator/lib/`.

### Risks

- **Monorepo workspace conflicts** (turbo, tsconfig paths, vitest config). Mitigated by reading existing `package.json` workspace setup first.
- **Tauri dev URL switching.** Both Next and Vite can't claim the same WebView dev URL simultaneously. Tauri config gets an env-gated switch (`PAPERCUSP_FRONTEND=next|vite`), default `next` until cutover.

---

## Phase B — Chrome + auth + first page (~1.5 weeks)

### Goal

Reproduce the operator's top-level chrome (sidebar, top bar, command palette) and migrate **one** representative page end-to-end so the patterns are proven.

### Scope

Picked first page: **`/harness`** (the harness list). Reasons: high-traffic, exercises auth + Zero sync + SSE + nuqs filters + nested layouts. If it works, the rest are mechanical.

### Tasks

1. Port `apps/operator/app/_components/` chrome components (sidebar, top bar, modal stack, toast host) into `apps/operator-vite/src/_components/`. Most are host-clean already; flag any Next-coupled ones (`next/link`, `next/navigation`) and rewrite to TanStack equivalents.
2. Wire `RootSyncProvider` (the polyfill mount point from the host-architecture plan) into `__root.tsx`. This is the early-mounting slot for `IpcEventSource`/`ipcFetch` — coordinated with host-architecture agent's Phase 4.
3. Set up auth flow against the existing `/api/auth/*` Hono routes. Cookie-based session continues to work because Hono reads from standard `Cookie` header; the migration is from `next/headers` cookies() → `getCookie(c)`. Coordinated with host-architecture Phase 5.
4. Create `/harness` route in TanStack Router. Port the page tree from `apps/operator/app/(operator)/harness/` to `apps/operator-vite/src/routes/harness/`.
   - `app/(operator)/harness/page.tsx` → `src/routes/harness/index.tsx`
   - `app/(operator)/harness/[slug]/page.tsx` → `src/routes/harness/$slug/index.tsx`
   - `app/(operator)/harness/[slug]/layout.tsx` → `src/routes/harness/$slug/route.tsx`
5. Set up TanStack Query providers, devtools, Zero client mount.
6. Configure dev proxy: Vite proxies `/api/*` to the existing Next operator (still running on `:3070`). This lets us migrate pages without migrating the API yet. The API migration is Phase C.
7. Verify the harness list page works end-to-end in Tauri dev: sidebar nav, login redirect, harness list loads, filters via nuqs, opens a harness detail page.

### Acceptance

- Login flow works (cookies set, persist).
- `/harness` loads, lists harnesses (from existing Next API via proxy).
- nuqs filters URL-sync correctly.
- Zero sync delivers a row update visible in the page.
- Tauri WebView shows the page without console errors (verdict skill screenshot + console-log check).
- TanStack Router devtools render the route tree.

### Risks

- **Cookies through the Vite proxy.** Verify `Cookie` headers flow through Vite's proxy correctly to the upstream Next API. If not, configure `proxy.cookieDomainRewrite`.
- **Module-resolution friction** importing from `apps/operator/lib/` — some files may transitively import `next/headers`. Mitigated by host-architecture agent's Phase 5 (host-clean auth).
- **Component-library compatibility.** Any `next/image`, `next/link`, `next/font` usage gets replaced. Audit and codemod.


---

## Phase C — API host: Hono via @hono/node-server (~1 week)

### Goal

Stand up an independent Hono node server in `apps/operator-vite/server/` that mounts the same `app` instance built in `apps/operator/app/_hono/app.ts` (Option B refactor). Vite dev mode points the proxy at it; Tauri prod loads from it.

### Prerequisites

- **Option B refactor done** (`apps/operator/app/_hono/app.ts` + `bootstrap.ts` exist). Either host-architecture agent did it in Phase 1 or this phase's first PR does it. Coordinated via `coord/`.

### Tasks

1. Implement `apps/operator-vite/server/index.ts`:

   ```ts
   import { serve } from '@hono/node-server';
   import { app } from '@papercusp/operator/_hono/app';
   import { runBootstrap } from '@papercusp/operator/_hono/bootstrap';

   const port = Number(process.env.PAPERCUSP_API_PORT ?? 3070);

   runBootstrap();
   serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
   ```

2. Add static-asset middleware to serve operator-vite's `dist/` from the same Hono app (so prod is single-process):

   ```ts
   import { serveStatic } from '@hono/node-server/serve-static';
   app.use('/*', serveStatic({ root: './apps/operator-vite/dist' }));
   ```

   (The `/api/*` routes are already mounted via `basePath('/api')` so they take precedence over the static fallback.)

3. WebSocket migration. Two consumers: **PTY** (`/api/pty/ws`) and **mobile voice** (`/api/mobile/voice/ws`). Hono node-server supports WS via `@hono/node-ws`. Migrate both, smoke-test with existing clients.

4. Update Tauri config: prod mode loads from `http://127.0.0.1:<API_PORT>/` (the same Hono server serving static dist + API). Drops the Next prod server entirely from the desktop bundle.

5. Switch operator-vite dev proxy target from `:3070` (Next) to `:3071` (new Hono node-server). Both can run simultaneously during migration since Next still owns `:3070`.

6. Migrate `next/headers` consumers to `getCookie(c)`. Coordinated with host-architecture Phase 5.

7. Smoke-test every API surface: auth, harness, plugins, oracle, agent-chats, mobile, PTY, voice WS, plugin-host hot-reload.

### Acceptance

- Hono node-server boots on a separate port, serves all routes (compare with existing `:3070` via `curl` diff).
- PTY WS + mobile voice WS work end-to-end.
- Cookie-bearing auth (`/api/auth/me`) works against the new server.
- Plugin-host hot-reload still works (`PAPERCUSP_DEV_PLUGIN_WATCH=1`).
- All existing e2e specs pass when pointed at the new server.
- Tauri prod-mode build loads page from the new server.

### Risks

- **Next-only middleware.** Any middleware that depends on `NextRequest` shape needs rewriting. Audit during Option B refactor; should be minimal since Next API routes already pass through to Hono.
- **Plugin-host runtime** (`plugin-host/runtime.ts`) may have Next assumptions. Audit + fix.
- **`route.ts` files** in plugin-mounted routes — if any plugin ships a Next-shaped `route.ts`, that breaks. Plugin SDK contract review needed.

---

## Phase D — Page migration: standalone routes (~4–6 weeks, ±50% band: 4–9 weeks)

**Pacing caveat (sharpened post-review):** "1–2 pages/day mechanical" is the happy path. Any page using RSC streaming, parallel-route fan-out, or a Server Action that shares state with a sibling burns a day. Real estimate is 4–6 weeks **best case**, 9 weeks **realistic worst case** if RSC/Server-Action density turns out to be heavy. Buffer week extended to 2 weeks (was 1).


### Goal

Migrate every Next `page.tsx` that's a leaf route (no nested children) to a TanStack Router `index.tsx`.

### Scope

Estimated **~50 leaf pages**. Mechanical translation; no logic changes.

### Per-page checklist

1. Identify source file (e.g. `apps/operator/app/(operator)/settings/billing/page.tsx`).
2. Create target file (e.g. `apps/operator-vite/src/routes/settings/billing/index.tsx`).
3. Rewrite the top of the file:
   - Remove `"use client"` (every TanStack route is client-side in SPA).
   - Replace `next/link` → `@tanstack/react-router` `<Link>`.
   - Replace `next/navigation` `useRouter`, `usePathname`, `useSearchParams` → TanStack `useRouter`, `useLocation`, `useSearch`.
   - Replace `next/image` → plain `<img>` (operator is internal; no SEO/perf-budget concern).
   - Replace `next/font` references → CSS-imported fonts (one-time setup in `__root.tsx`).
4. If the page has a `loading.tsx` sibling, add `pendingComponent` to the route definition.
5. If the page has a `not-found.tsx` sibling, add `notFoundComponent`.
6. If the page has `generateMetadata`, add `head: () => ({ meta: [...] })`.
7. Smoke-test in Tauri dev: page loads, all interactive elements work.

### Cadence

Batch by feature area (settings, harness, marketplace, dev tools, etc.). Each batch is one PR.

- Settings (~10 pages) — week 1
- Marketplace (~8 pages) — week 2
- Dev tools (~12 pages) — weeks 2–3
- Mobile pair UI (~6 pages) — week 3
- Backup/snapshots (~6 pages) — week 4
- Misc (~10 pages) — weeks 4–5

Buffer week for surprises.

### Acceptance per batch

- Every page loads in Tauri dev with no console errors.
- Existing e2e specs covering each page pass.
- Visual regression check (verdict screenshot diff) shows no unintended change.

### Risks

- **Server Components.** Any page using RSC (`async function Page()` with server-side data fetching) needs the data fetch hoisted to a TanStack Query `loader` or `useQuery`. Audit at batch start.
- **Server Actions.** Any `"use server"` function called from a client component → convert to a Hono route + `useMutation`. Coordinated with host-architecture Phase 4 (which is moving toward `defineTool` for the same migration). Where possible, do **both** at once.
- **`Suspense` + RSC streaming patterns.** Replace with TanStack Query suspense or pendingComponent.


---

## Phase E — Page migration: nested layouts (~3 weeks)

**paperclip coordination policy (decided post-review):** paperclip rewrites `app/harness/*` files autonomously. Race-over-pause works for single-edit collisions but does **not** scale to ~7 weeks of sustained harness-tree sweep. **Policy for Phase E: pause paperclip for the duration.** Phase E gets uninterrupted access to `app/harness/*`. Coordinated via `coord/` claim posted at Phase E start; user notified before pause; paperclip resumes immediately at Phase E end. Alternative (race-over-pause across 7 weeks) was rejected — too lossy, too exhausting.


### Goal

Migrate every Next `layout.tsx` that wraps child routes to a TanStack Router `route.tsx`.

### Scope

Estimated **~13 nested-layout trees** (harness, harness-by-slug, settings, dev, marketplace publish, mobile pair, etc.).

### Per-tree checklist

Each tree is a unit of work. For tree rooted at `apps/operator/app/(operator)/harness/[slug]/`:

1. Create the parent route file: `apps/operator-vite/src/routes/harness/$slug/route.tsx`.
2. Port the layout component body. The layout renders `<Outlet />` (same as Next).
3. Port the `loading.tsx`, `error.tsx`, `not-found.tsx` siblings to route options.
4. Migrate every child page under it (already done in Phase D for leaf pages; this phase wires them under the new parent).
5. Migrate any **parallel routes** (`@panel/page.tsx`) and **intercepting routes** (`(.)foo/page.tsx`) — these have no direct TanStack equivalent. Audit each: most can be replaced with conditional rendering inside the layout (the operator uses parallel routes for command palette + modal stack; both can be plain conditional components since they're not navigation-tied).
6. Smoke-test the whole tree.

### Acceptance per tree

- Tree navigates correctly (parent→child transitions don't unmount the layout).
- Loading states render correctly.
- Error boundaries catch errors.
- Browser back/forward works.
- Deep links work (paste a URL, page loads at the right level).

### Risks

- **Parallel routes** are the only Next App Router primitive without a TanStack analog. The operator uses them for ~2 things (command palette overlay, possibly a panel system). Audit before this phase to confirm replacement strategy.
- **Route groups `(folder)`.** TanStack uses `_pathlessLayout` files instead — mechanical rename.
- **Middleware-based redirects.** Next middleware doesn't exist in operator-vite; redirects become route-level `beforeLoad` guards.

---

## Phase F — Docs: fumadocs → Starlight (~1.5 weeks)

**Status:** **EXTRACTED to standalone plan.** This phase has been lifted out of the Next-removal arc and is now [`fumadocs-to-starlight-2026-05-20.md`](./fumadocs-to-starlight-2026-05-20.md), executable on its own merits regardless of Q0. The detail below remains here as historical context for the original arc; the executable copy is the standalone plan.

**F4 decision FROZEN: F4b (Accept-header negotiation via Hono middleware).** Original draft listed both options; reviewer was correct that just deciding is cheaper. Hono middleware reads `Accept: text/markdown`, serves the per-page `.md` twin from `starlight-llms-txt`. ~15 lines. Preserves agent contract.


### Goal

Replace fumadocs (both `apps/operator/` and `apps/papercup/` setups) with a single Starlight app at `apps/operator-docs/`. Preserve URL surface, agent surface, and content. Update all agent prompts and CLAUDE.md.

### Tasks

#### F1. Bootstrap Starlight

1. `npm create astro@latest apps/operator-docs/ -- --template starlight`
2. Install `@astrojs/react` (for React components in MDX), `starlight-llms-txt`, optionally `starlight-llm-tools`.
3. Configure `astro.config.mjs`:

   ```js
   import { defineConfig } from 'astro/config';
   import starlight from '@astrojs/starlight';
   import react from '@astrojs/react';
   import starlightLlmsTxt from 'starlight-llms-txt';

   export default defineConfig({
     base: '/internal/docs',
     integrations: [
       react(),
       starlight({
         title: 'Papercusp',
         plugins: [starlightLlmsTxt()],
         // ...
       }),
     ],
   });
   ```

#### F2. Migrate content

1. `cp -r apps/operator/content/internal-docs apps/operator-docs/src/content/docs/`
2. Convert each section's `meta.json` to Starlight `sidebar` frontmatter or `astro.config.mjs` sidebar config. Write a small script — mechanical transformation.
3. Replace fumadocs-ui imports inside MDX:
   - `Callout` → Starlight's `Aside`
   - `Card` / `Cards` → Starlight's `Card` / `CardGrid`
   - `Tabs` → Starlight's `Tabs` / `TabItem`
   - Code blocks → unchanged (Astro / Starlight both use Shiki)
   - Steps → Starlight's `Steps`
4. For any custom component without a Starlight equivalent, import it as a React component via Astro islands.
5. Verify all cross-links (`[X](/internal/docs/<section>/<slug>)`) resolve correctly with `base: '/internal/docs'`.

#### F3. MCP tool surface

Rewrite the docs adapter in `packages/docs-engine/`:

- New `starlightContentAdapter` reads Astro content collections (the filesystem at `apps/operator-docs/src/content/docs/`).
- MCP tool surfaces (`docs:outline`, `docs:get`, `docs:search`) keep their existing JSON shapes — agents see no change on the wire.
- `remark-mdx-to-markdown.ts` stays (still need MDX-JSX stripping for tool output).
- Delete `lib/source.ts` (fumadocs source loader).

Files to rewrite:

```
packages/docs-engine/src/adapters/fumadocs.ts → packages/docs-engine/src/adapters/starlight.ts
packages/docs-engine/src/index.ts (export swap)
apps/operator/lib/agent-tools/docs/outline.ts (import swap)
apps/operator/lib/agent-tools/docs/get.ts
apps/operator/lib/agent-tools/docs/search.ts
apps/operator/lib/agent-tools/cross_harness/docs_outline.ts
apps/operator/lib/agent-tools/cross_harness/docs_get.ts
apps/operator/lib/agent-tools/cross_harness/docs_search.ts
apps/operator/lib/source.ts (delete)
```

#### F4. URL surface (agent contract preservation)

`starlight-llms-txt` produces:

- `/llms.txt` (sitemap, same shape as fumadocs)
- `/llms-full.txt` (full concatenated content)
- `/llms-small.txt` (abridged — bonus)
- Per-page `.md` twins

Routes are produced by Astro at build time; Hono serves them as static files. No content-negotiation middleware needed (Starlight ships separate URLs for HTML vs markdown; that's a divergence from the current fumadocs setup, which used `Accept: text/markdown` content negotiation).

**Decision point:** preserve `Accept: text/markdown` content negotiation? Two options:

- **F4a — Accept Starlight defaults.** Agents fetch `<slug>.md` instead of `<slug>` with Accept header. Update CLAUDE.md and prompts accordingly.
- **F4b — Add Hono middleware** that intercepts requests with `Accept: text/markdown` and rewrites to the `.md` twin. Keeps existing agent contract intact.

Recommend **F4b** — content negotiation is a one-shot middleware, ~15 lines of Hono code, preserves the contract agents already use, and doesn't bind us to Starlight's URL scheme forever.

#### F5. Prompt + CLAUDE.md updates

Update these 7 files with `fumadocs` → `Starlight` and path swap (`content/internal-docs/` → `apps/operator-docs/src/content/docs/`):

```
apps/operator/prompts/papercusp-su.tools.md
apps/operator/prompts/debugger.tools.md
apps/operator/prompts/reviewer.tools.md
apps/operator/prompts/scoper.tools.md
apps/operator/prompts/validator.tools.md
apps/operator/prompts/architect.tools.md
/home/marsh-office/.claude/CLAUDE.md (global; rewrite "Write / update documentation" section)
```

Re-run `apps/operator/scripts/install-standalone-mcp.sh` after the global CLAUDE.md changes (the script regenerates the playbook block from `papercusp-su.tools.md`).

#### F6. Serve from Hono

Build outputs static HTML to `apps/operator-docs/dist/`. Hono in operator-vite serves it at `/internal/docs/*`:

```ts
app.use('/internal/docs/*', serveStatic({ root: './apps/operator-docs/dist', rewriteRequestPath: (p) => p.replace(/^\/internal\/docs/, '') }));
```

No second Node process. Build pipeline: Starlight builds → output to dist → Hono serves.

#### F7. Delete fumadocs

After Phase F is verified:

```
apps/operator/content/internal-docs/         (now moved to apps/operator-docs/src/content/docs/)
apps/operator/source.config.ts
apps/papercup/source.config.ts
apps/papercup/app/(docs)/                   (entire tree)
apps/papercup/app/api/search/route.ts       (fumadocs search)
packages/docs-engine/src/adapters/fumadocs.ts
apps/operator/lib/source.ts
```

Delete `fumadocs-*` from `package.json` dependencies in both apps.

### Acceptance

- All MDX content renders correctly at `/internal/docs/<section>/<slug>` (visual diff vs current site).
- All cross-links resolve.
- `curl http://127.0.0.1:<port>/llms.txt` returns the same shape as current.
- `curl -H 'Accept: text/markdown' http://127.0.0.1:<port>/internal/docs/agent-policies` returns markdown (F4b).
- `docs:outline`, `docs:get`, `docs:search` MCP tools return the same JSON shape (regression-test against current outputs).
- `apps/operator/e2e/docs-routes.spec.ts` passes against the new server.
- Agent prompts no longer reference fumadocs.

### Risks

- **Custom MDX components.** Some fumadocs-ui components don't map 1:1 (e.g. `Files` for tree views, custom callout variants). Each needs a Starlight equivalent or a React fallback via islands.
- **Search index.** fumadocs ships a built-in search route; Starlight uses Pagefind. Different mental model but equivalent UX. Need to verify the search MCP tool still produces the same JSON.
- **Build time.** Astro static builds the whole site each time. For 200+ pages, expect ~30s. Cache aggressively in CI.


---

## Phase G — Tauri integration (~1 week)

### Goal

Switch `papercusp-desktop` from loading the Next dev/prod server to loading operator-vite. End-to-end smoke test the full desktop bundle.

### Tasks

1. **Tauri config switch:**
   - `papercusp-desktop/src-tauri/tauri.conf.json`:
     - `build.beforeDevCommand`: `cd ../apps/operator-vite && npm run dev`
     - `build.devUrl`: `http://localhost:5173` (or whatever Vite uses)
     - `build.beforeBuildCommand`: `cd ../apps/operator-vite && npm run build`
     - `build.frontendDist`: `../apps/operator-vite/dist` — **note:** in production, the Tauri webview loads from the Hono node-server at `127.0.0.1:<API_PORT>` (which serves `dist/`), not from `frontendDist` directly. This field is for the Tauri build pipeline to know where to find assets for the installer.
2. **Verify the IPC bridge (`sys:http`)** works against the Hono server, not the Next dev server. Coordinated with host-architecture Phase 4 (`IpcEventSource`/`ipcFetch` polyfill).
3. **DevTools-enabled prod build** for the first few releases so we can debug.
4. **Auto-update flow.** `bin/release-local.sh` is the current build entry — verify it works with the new frontend layout.
5. **Sidecar verification.** Tauri sidecars (embedded PG, code-server proxy, etc.) need to start before the Hono node-server (they already do, but verify the order didn't break).

### Acceptance

- `cd papercusp-desktop && npm run dev` opens a window loading operator-vite via the Hono server.
- All major flows work in the Tauri window: login, harness list, harness detail, settings, marketplace, docs.
- `bin/release-local.sh` produces a working .deb / .dmg / .msi.
- Embedded PG + code-server proxy + other sidecars start in correct order.
- IPC bridge works (verified via test that triggers `sys:http` from the polyfill).

### Risks

- **WebView WASM/SAB requirements** — Vite's dev server uses ESM in dev which needs cross-origin headers in some browsers. WebKit (Linux/Tauri) is generally permissive; verify on macOS + Windows builds too.
- **Vite HMR over WebKit** — historically flaky. Mitigate by running Vite with `server.hmr.protocol: 'ws'` explicitly.
- **Tauri capability scope.** Vite may load assets from different origins than Next did; update `tauri.conf.json` capability lists.

---

## Phase H — Cutover + delete Next (~1 week)

**H.0 — Pre-flight (must pass before any rename PR opens):** The hard-coded path checklist from Phase 0.3 must be re-grepped fresh; new lines added during D/E/F/G get covered. Concretely run `git grep -l 'apps/operator/'` and confirm every hit is one of: (a) the app being renamed (handled), (b) docs/historical (acceptable), (c) the new-name target (already on operator-vite). Any other hit blocks H.0 until decided.


### Goal

This is the irreversible step. After this PR lands, Next is gone from the repo.

### Pre-cutover checklist

Before opening the cutover PR:

- [ ] Every Next route is migrated and verified (Phases D, E).
- [ ] Every Next page is migrated and verified.
- [ ] Docs are on Starlight (Phase F).
- [ ] Tauri loads operator-vite end-to-end (Phase G).
- [ ] All e2e specs pass against the new stack.
- [ ] Host-architecture v2 plan's Phase 5 (`apps/operator-platform/`) is complete — no remaining `next/*` imports in `lib/` or `app/_hono/`.
- [ ] CI green on a branch that has the new stack only.

### Cutover steps

1. **Rename:**
   - `apps/operator/` → `apps/operator-next-legacy/` (kept temporarily as reference).
   - `apps/operator-vite/` → `apps/operator/`.
2. **Update workspace references:**
   - `package.json` workspaces array, `turbo.json` pipeline configs, root-level scripts.
3. **Update Tauri config:**
   - `papercusp-desktop/src-tauri/tauri.conf.json` paths.
   - `bin/release-local.sh` paths.
4. **Update prompt files** (the 6 prompt files in `apps/operator/prompts/` referencing fumadocs / paths — final sweep, mechanical find-replace).
5. **Update `/home/marsh-office/.claude/CLAUDE.md`** — the global playbook section. Rewrite the "Write / update documentation" section for Starlight. The "Read documentation" section needs only path updates; URL surfaces are preserved.
6. **Run** `bin/install-standalone-mcp.sh` (refreshes CLAUDE.md block from canonical source).
7. **Delete `apps/operator-next-legacy/`** in a follow-up PR after 1 week of validation.

### Acceptance

- `git grep "from 'next/"` returns zero results in `apps/operator/` (= the new operator-vite).
- `git grep "from 'next/"` returns zero results in `libs/` and `packages/`.
- `git grep "fumadocs"` returns zero results outside of the deleted-legacy folder.
- Desktop app boots and works end-to-end.
- All MCP `docs:*` tools work.
- Webapp deploy (per host-architecture v2 plan) still works — operator-vite + Hono node-server is also the deployment target.
- `agent-insights/` references work; docs links from external Claude sessions still resolve.

### Rollback plan

If something catastrophic surfaces post-cutover: revert the rename PR. The legacy folder still exists for ~1 week, so the previous stack is one git operation away.

---

## Phase I — Post-cutover cleanup (~1 week)

### Goal

Remove transitional code, delete legacy folder, update docs, write agent insight.

### Tasks

1. **Delete `apps/operator-next-legacy/`** (after 1 week of validation).
2. **Delete unused deps** from root `package.json`: `next`, `eslint-config-next`, `@types/next`, fumadocs packages.
3. **Update `apps/operator/content/internal-docs/index.mdx`** if it references Next.
4. **Write `apps/operator/content/internal-docs/agent-insights/next-removal-2026-XX-XX.mdx`** — capture what went wrong, what surprised us, what the next agent should know.
5. **Update the host-architecture plan's status** — the "Q1: keep Next?" answer is now historical context, not a live decision.
6. **Sweep `docs/plans/`** for stale references to Next-specific paths; add `**superseded**` headers where needed.
7. **Performance regression check.** Compare:
   - Cold-start time (Tauri window open → first interactive page).
   - Hot-reload time in dev (touch a file → page updated).
   - Production build size.
   - API latency (some routes were Next-handled directly; now everything goes through Hono).
8. **`MEMORY.md` update** (auto-memory) — reflect the new layout.

### Acceptance

- Repo has no Next references anywhere.
- Agent insight written.
- Performance numbers documented in the insight (regression or improvement either way).
- CLAUDE.md + prompt files reflect Starlight + operator-vite.


---

## Coordination with the host-architecture stream

The host-architecture v2 plan and this plan operate on overlapping surfaces. Strategy: **the host-architecture work lands first and unblocks this plan.** Almost everything in the host-architecture plan is a prerequisite or accelerator for Next-removal:

| Host-architecture phase | Effect on this plan |
|---|---|
| **Phase 1** — Hono `app` extraction (Option B refactor) | **Hard prerequisite for Phase C.** Either they do it (preferred) or I do it as Phase C PR 1. |
| **Phase 2** — `libs/host-platform/` abstractions | Helps Phase B/C — `apps/operator/lib/` becomes import-safe from operator-vite. |
| **Phase 3** — Reliability fix (TanStack Query cache) | Independent. Lands whenever. |
| **Phase 4** — IPC transport + polyfill | **SHIPPED 2026-05-20.** `IpcEventSource` / `ipcFetch` / `desktop-bootstrap.ts` live; wired through `RootSyncProvider`; 84/84 tests pass. If/when removal revisited, operator-vite's `__root.tsx` reuses the same module-eval-time install pattern from `desktop-bootstrap.ts`. |
| **Phase 5** — `apps/operator-platform/` (host-clean `lib/`) | **Hard prerequisite for Phase H cutover.** `next/headers`, `cookies()`, etc. must be gone from `lib/` before Next can be deleted. |
| **Phase 6a** — tsconfig project references | **Lands immediately, no conflict.** Help speed up monorepo TS perf for both apps. |
| **Phase 6b** — Remaining audit work | Independent. |

### What I commit to:

1. **Daily** `coord/frontend.jsonl` append at end of session.
2. **`locks:acquire`** on every file I edit (PreToolUse hook is automatic; I verify).
3. **Read all `coord/*.jsonl`** at session start, especially `coord/architect.jsonl` (host-architecture agent's channel).
4. **No edits to `apps/operator/app/_hono/*`** without checking host-architecture's recent activity first.
5. **No edits to `lib/`** during their Phase 5 active period; coordinate which files I need access to.
6. **Pause Phase D batches** if they need a quiet window for a `lib/` sweep.

### What I ask of them:

1. **Phase 1 Option B refactor** done by them ideally — saves me re-implementing.
2. **Phase 4 polyfill API contract** documented before they ship it, so I can build operator-vite's `__root.tsx` mount to match.
3. **Phase 5 host-clean migration** ideally done before my Phase D starts on settings/auth pages — saves a round of "now also rewrite this `next/headers` consumer."
4. **Heads up** if they want to absorb the Option B refactor into Phase 2 (i.e. do the `app.ts`/`bootstrap.ts` split as part of `libs/host-platform/`). Either is fine; I just need to know the file path so my imports point to the right place.

### Conflict resolution

If both of us need to touch the same file simultaneously:

- **Their work wins by default** during their Phase 1, 2, 4, 5 active periods (they're closer to the core).
- I pivot to docs (Phase F) or to pages whose `lib/` deps are already host-clean.
- We surface to user only if blocked for >1 day.

---

## Risks (cross-cutting)

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| **Plugin SDK contract changes.** Any plugin that ships a Next-shaped `route.ts` breaks. | High | High | **Mitigation moved to Phase 0.1 pre-flight (decision before Phase A claims code).** Output: yes/no + migration approach in a decisions doc. First-party only → edit in lockstep. Third-party shipping → deprecation window. |
| **paperclip agent collisions during Phase E (~7 weeks of harness-tree sweep).** | High during E | High | **Policy: pause paperclip for Phase E duration.** Race-over-pause doesn't scale across weeks of sustained editing — chosen over the alternative (accept ~30% re-application overhead). Coord'd via `coord/` at Phase E start. |
| **Hot-reload regressions** in Vite + WebKit. | Medium | Medium | Phase A acceptance includes HMR check. Fall back to manual reload if WS HMR is unreliable; we ship anyway. |
| **MDX component compatibility** in Starlight migration. | Medium | Low | One-time effort; document any non-1:1 mappings as an insight. |
| **Performance regression** post-cutover. | Low | Medium | Phase I includes explicit benchmark step. Compared as numbers, not vibes. |
| **CI time inflation** running two app builds in parallel during migration. | Medium | Low | Skip Next build for PRs that don't touch `apps/operator/`. Skip Vite build for docs-only PRs. |
| **Webapp deploy regression.** Host-architecture v2 plan promises webapp-ready; if Next removal accidentally breaks webapp, that's a regression. | Low | High | Acceptance test for Phase H includes webapp build + deploy smoke. |
| **MCP `tools/list` breakage.** The `papercusp-su` MCP server is itself hosted in Hono. Migration of API host must not break it mid-flight. | Low | High | Run MCP integration smoke (a real Claude session) at the end of Phase C. |
| **Schedule slip.** 14–16 weeks is the honest estimate, but big migrations slip. Could easily become 20+ weeks. | High | High | Q0 gate exists *because* of this. If user picks Q0 (1), they accept the slip risk. |

---

## Open questions back to user (Q1–Q6)

These are decisions I want explicit input on before starting:

### Q1 — Final directory name for the new app

Options:
- `apps/operator-vite/` during migration, rename to `apps/operator/` at cutover.
- `apps/operator-next/` (confusing name but means "next operator," not Next.js operator) during migration, rename at cutover.
- `apps/operator-v2/`.

I'll use `apps/operator-vite/` by default. Confirm or override.

### Q2 — Bundler decision (Vite vs Rsbuild) — defer or pick now?

Defer to Phase A's first day. Both have the same plan shape; only `vite.config.ts` vs `rsbuild.config.ts` differs. I lean Vite (bigger React/TanStack ecosystem); Rsbuild is defensible if you want Rust speed + webpack-plugin compatibility. **OK to defer?**

### ~~Q3 — Who does the Option B refactor?~~ — RESOLVED via coord

Removed from user questions post-review. This is a coord-channel decision between agents, not a user question. **Resolution: host-architecture agent claims Option B refactor as part of their Phase 2 (platform-adapter interface needs host-clean `app` export regardless).** Watch `coord/architect.jsonl` for the lock claim.

### Q4 — Should webapp deploy continue to use Next, or switch to operator-vite at cutover?

The host-architecture v2 plan says "webapp-ready" via the host abstractions. After Next removal, the webapp deploy *has* to use operator-vite + Hono node-server (Next is gone). That's a deployment-pipeline change. **Confirm intent: webapp deploy also moves to operator-vite at Phase H?**

### Q5 — Keep `apps/operator-next-legacy/` for how long after cutover?

Default: 1 week. Long enough to catch immediate bugs, short enough to avoid drift. Can be longer (4 weeks?) if you want more cushion. **Confirm or override.**

### Q6 — Communicate the Q0 decision how?

If you pick Q0 = (1), I need to know whether to:
- Just start (`coord/frontend.jsonl` claim + start Phase A).
- Wait for an explicit "go" message.
- Wait for the host-architecture v2 plan to formally update its Q1 answer ("no" → "yes, removal proceeding").

Default: I wait for explicit "go" message from you, then claim in `coord/`. **Confirm.**


---

## Appendix A — Full file inventory of agent-surface updates

Every location that points agents at fumadocs or the current docs structure:

### A.1 Agent prompts (6 files)

```
apps/operator/prompts/papercusp-su.tools.md      → mirrors into ~/.claude/CLAUDE.md via install-standalone-mcp.sh
apps/operator/prompts/architect.tools.md
apps/operator/prompts/debugger.tools.md
apps/operator/prompts/reviewer.tools.md
apps/operator/prompts/scoper.tools.md
apps/operator/prompts/validator.tools.md
```

Change shape:
- `apps/operator/content/internal-docs/<section>/<slug>.mdx` → `apps/operator-docs/src/content/docs/<section>/<slug>.mdx`
- URL `/internal/docs/<section>/<slug>` preserved (Starlight base config).
- "fumadocs" → "Starlight"
- "fumadocs-ui components" → "Starlight components"

### A.2 MCP tool sources (7 files)

```
apps/operator/lib/agent-tools/docs/outline.ts
apps/operator/lib/agent-tools/docs/get.ts
apps/operator/lib/agent-tools/docs/search.ts
apps/operator/lib/agent-tools/cross_harness/docs_outline.ts
apps/operator/lib/agent-tools/cross_harness/docs_get.ts
apps/operator/lib/agent-tools/cross_harness/docs_search.ts
packages/docs-engine/src/remark-mdx-to-markdown.ts
```

Change shape:
- Adapter swap: `fumadocsAdapter` → `starlightContentAdapter` in `packages/docs-engine/`.
- Tool JSON shapes preserved (regression-test).
- Source loader: `lib/source.ts` replaced with Astro content collection reader.

### A.3 HTTP routes (1 file, deleted)

```
apps/operator/proxy.ts        ← deleted at Phase H
```

The Accept-header negotiation moves to either Starlight's per-page `.md` twins (preferred) or Hono middleware in `apps/operator-vite/server/`.

### A.4 E2E tests (1 file)

```
apps/operator/e2e/docs-routes.spec.ts
```

URL contract preserved. Spec runs unchanged against new stack as acceptance.

### A.5 Renderer code (deleted at cutover)

```
apps/operator/source.config.ts
apps/operator/app/(operator)/docs/**             ← if exists
apps/papercup/source.config.ts
apps/papercup/app/(docs)/**
```

Both fumadocs setups (operator + papercup) collapse into one Starlight app.

### A.6 Global agent playbook (1 file, user's machine)

```
~/.claude/CLAUDE.md
```

Two sections need rewriting:
- "Read documentation" — URL surfaces preserved, only path references update.
- "Write / update documentation" — rewritten end-to-end for Starlight.

Tooling: `apps/operator/scripts/install-standalone-mcp.sh` re-syncs the canonical block from `apps/operator/prompts/papercusp-su.tools.md`. Run after the prompts file updates.

### A.7 Content cross-links (no change required)

The ~40 `.mdx` files in `content/internal-docs/` link each other via `/internal/docs/<section>/<slug>` URLs. Starlight preserves the URL shape via `base: '/internal/docs'`. No content rewrites needed.

### A.8 Plan / historical docs (no change required)

```
apps/operator/docs/plans/agent-plan-tracking-2026-05-20.md
apps/operator/docs/plans/inventory-2026-05-20.md
apps/operator/docs/plans/host-architecture-2026-05-20-v2.md
```

These freeze state at the time. Leave them; their references to fumadocs are historical.

---

## Appendix B — Resources and library versions (May 2026)

- **Vite 8.0.13** (with Rolldown 1.0 as new prod bundler) — https://vite.dev
- **Rsbuild 2.0.6** (alternative, on Rspack) — https://rsbuild.dev
- **TanStack Router 1.170.5** — https://tanstack.com/router
- **Hono** (`@hono/node-server`, `@hono/node-ws`) — https://hono.dev
- **Starlight 0.39.2** (on Astro 6) — https://starlight.astro.build
- **starlight-llms-txt** (delucis) — https://github.com/delucis/starlight-llms-txt — peer deps: `@astrojs/starlight >=0.38.0`, `astro ^6.0.0`
- **nuqs 2.x** — unchanged
- **TanStack Query 5.x** — unchanged

All current as of plan-write date. Pin specific versions during Phase A.

---

## Appendix C — Migration delta summary

After all phases complete:

| Surface | Before | After |
|---|---|---|
| Operator app | `apps/operator/` (Next 15) | `apps/operator/` (was operator-vite) — Vite + TanStack Router + Hono node-server SPA |
| Operator API | Next route handlers wrapping Hono | Pure Hono via `@hono/node-server` |
| Docs site | fumadocs in 2 apps | One Starlight app at `apps/operator-docs/` |
| Docs URL surface | `/internal/docs/*`, `/llms.txt`, `/llms-full.txt`, Accept-negotiation | Same URLs (`starlight-llms-txt` + Hono static serve) |
| Tauri load target (dev) | Next dev server | Vite dev server |
| Tauri load target (prod) | Next prod server | Hono node-server (also serves API) |
| Process count (prod) | Next server + plugin host + PG + code-server | Hono node-server + plugin host + PG + code-server (one process down) |
| Server-side rendering | RSC + Server Actions | None (SPA) |
| Cookie-bearing auth | `next/headers` `cookies()` | Hono `getCookie(c)` (host-architecture Phase 5) |
| MCP `docs:*` tools | fumadocs-source adapter | Astro content collection adapter |
| Agent CLAUDE.md references | "fumadocs", `content/internal-docs/` | "Starlight", `apps/operator-docs/src/content/docs/` |
| Total Next files in repo | 845 importing + 240 routes + 63 pages | 0 |

---

## Document lifecycle

- **Today (2026-05-20):** draft for user review, Q0 gate not yet decided.
- **On Q0 = (2) or (3):** plan halts. Document marked **superseded** and archived.
- **On Q0 = (1):** plan enters execution. Each phase's PR references this doc. Phase completions update a **Status** section at the top.
- **At Phase I:** plan moves from active to historical. Final state captured in agent-insights doc.

