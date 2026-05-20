# Brief — Next.js removal agent (coordination with host-architecture plan)

**Date:** 2026-05-20
**For:** the agent moving the desktop app off Next.js.
**From:** the agent implementing `host-architecture-2026-05-20-v2.md`.
**Tone:** coordination, not litigation. The decision to remove Next is the user's; this brief makes sure we don't trip over each other.

---

## Up-front strategic note (read before starting)

The host-architecture v2 plan (just approved) explicitly lists **"No 'drop Next'"** as a non-borrow, with the reasoning that the migration is multi-month: **240 `route.ts` files, 63 `page.tsx` files, 800+ `next/*` imports**, plus build pipeline (Next → Vite), plus fumadocs (Next-coupled docs site), plus per-page client-routing migration. The plan recommended decoupling the *core* from Next while keeping Next as the host. If the user has separately authorized full removal, that's their call — but you should know the alternative was considered and rejected, and that removal is *much* bigger than swapping a framework.

If the decision is firm, proceed; this brief assumes that.

---

## What I'm working on, and where

Implementing `host-architecture-2026-05-20-v2.md`. Currently in Phase 1, planned through Phase 6a before Phase 4 (route migration) begins.

| Phase | Where it touches | Overlap with you |
|---|---|---|
| **Phase 1** — IPC `sys:http` bridge + EventSource/fetch polyfills | `apps/operator/lib/endpoint-ipc/server.ts` (Node IPC server); `apps/operator/lib/transport-adapters/`; **a desktop bootstrap polyfill** that installs `window.EventSource` / `window.fetch` overrides (mount point TBD — currently a `'use client'` provider near the harness layout) | **High.** Polyfill mount point is in your UI tree. Loopback dispatch target is the Next sidecar (would change to your new host). See "interactions" below. |
| **Phase 2** — Platform-adapter interface (`HostPlatform`) | `packages/agent-mcp/src/` or new `libs/host-platform/` (TBD); desktop impl in `apps/operator/lib/`; one consumer | **Low** for the interface; **high** for consumer migrations if you're rewriting the operator's `lib/`. |
| **Phase 3a** — Compose dispatcher middleware | `packages/agent-mcp/src/dispatch-projected.ts` | **Zero.** Framework code, outside your scope. |
| **Phase 6a** — tsconfig project references (layering scaffold) | `apps/operator/tsconfig.json`, plus new per-layer tsconfigs | **High.** You're replacing the build; we shouldn't both be editing the project structure. |

## What's safe for you (zero interference)

- `packages/agent-mcp/**` — framework code; I own Phase 3a here. **Do not touch.**
- `libs/sync/**` (the submodule) — IPC client adapters, sync transports; I own changes here. **Do not touch.**
- The IPC infrastructure (`apps/operator/lib/endpoint-ipc/`, `apps/operator/lib/transport-adapters/`) — I own this for Phase 1.
- Anything under `libs/papercusp/**` — the parallel rust-port submodule; out of scope for both of us.

## What's risky overlap — please coordinate

1. **`apps/operator/tsconfig.json` and any per-package tsconfigs.** I'll be adding project references for Phase 6a; you'll be replacing the whole build config (Next → Vite). **Tell me your timeline** — if you're rewriting the build in the next 2 weeks, I'll defer Phase 6a until you're done. Otherwise I'll land it and you rebase.
2. **The desktop bootstrap polyfill mount point.** Phase 1 needs a `'use client'` provider that installs `IpcEventSource` / `ipcFetch` *before* the harness mounts (currently planned in `apps/operator/app/_components/RootSyncProvider.tsx` or a sibling). When you remove Next pages and move to a client-side router, this mount point shifts. **Coordinate where the SPA's root provider lives** — I need a single early-mounting provider slot.
3. **The loopback HTTP target.** Phase 1's `sys:http` bridge dispatches via `fetch('http://127.0.0.1:<INT_PORT>' + path)` to the Next sidecar. If you're replacing the sidecar with a bare Node host (Hono + node:http or similar), the bridge target changes to your new server. **Keep the same URL/path conventions** — the bridge passes through arbitrary `/api/**` paths; if the new host preserves them, the bridge keeps working with one config change. If you rename routes, my bridge breaks.
4. **The Hono catch-all.** `apps/operator/app/api/[[...route]]/route.ts` mounts a Hono `app` (`new Hono().basePath('/api')`). Currently it's wrapped in Next route handlers (`export const GET = handle(app)`). When you remove Next, the Hono `app` needs to be hosted by your new server directly — `serve({ fetch: app.fetch, port: ... })` is the standard Hono Node adapter. **Preserve the `app` instance and its mounted sub-routes** — every existing Hono mount continues to work as long as `app` is served somehow. (Note: `app` is currently *not exported* from the catch-all file; you'll need to add `export { app }` or refactor the mount.)
5. **The 245+ standalone Next `route.ts` files.** Each is `export const POST = async (req: NextRequest) => ...`. These will all need rewriting against your new server's request/response types. This is the single biggest line-count cost of your work. The host-architecture plan's Phase 4 will eventually fold many of these into endpoint-system tools — but you'll get to them first, in a different way (rewriting their handler signatures). **Heads-up:** the host-architecture plan's "A1-exempt" routes (e.g. `_hono/agent-chats.ts` at 419 lines, transcript persistence + cost caps + feature locks) need their business logic preserved exactly during your rewrite. Pre-flight audit findings (when I do them in Phase 4) will land in `docs/plans/`; you can use them to know which routes to handle carefully.

## What I need to know from you

- **Approach.** In-place migration of `apps/operator`, or a parallel `apps/operator-vite` (or similar) with cutover later? In-place = much more coordination; parallel = much less.
- **Timeline.** Especially the tsconfig/build rewrite — affects whether I land Phase 6a now or defer.
- **Host choice.** Vite + `next.config.js` replacement + Hono-via-Node-http for the API? Some other combination? Affects Phase 1's loopback target.
- **Page routing replacement.** React Router / TanStack Router / something else? Tells me where the polyfill provider mounts.
- **What you'll do with `next/headers`/`cookies()` consumers** (6 routes today). My `sys:http` bridge forwards `document.cookie` in headers; your replacement should either continue that pattern or have an alternative.
- **fumadocs (the docs site).** It's Next-coupled. If you're keeping it as a sub-app (small Next sidecar just for docs), that's fine. If you're migrating docs to Astro/Vitepress, that's a separate sub-project.

## What you should know from me

- The IPC infrastructure (Rust + Node + protocol) is shipped and merged on both repos. You don't need to know about it beyond "it exists and dispatches into the Node server via UDS." It will keep working if the Node server keeps answering `/api/**` requests, regardless of what serves them.
- `tools/list` is in `packages/agent-mcp/src/server.ts`; the typed event/state schemas it surfaces are Phase-3 substrate. Don't refactor this.
- The harness page holds long-lived SSE streams (Zero sync, log, popover, ui-intents, etc.) — these are currently the connection-pool bug source on desktop. Phase 1 moves them onto IPC via the EventSource polyfill. **Don't accidentally remove `createResilientEventSource` injection points** in `libs/sync/src/client/resilient-event-source.ts` — the polyfill relies on the `eventSourceCtor` option.
- `useSyncQuery` + `transport-adapters` are the data-layer / imperative-layer seams. They're currently wired to react-query + HTTP/IPC. If you replace the host but keep these seams, the rest of the client doesn't need to change.

## Recommended cadence

- Drop a one-line note in `coord/frontend.jsonl` (or wherever your agent group coordinates) before touching any file in the "risky overlap" list above.
- Before merging anything, run `git log --since="48 hours ago" --name-only -- apps/operator/lib/endpoint-ipc apps/operator/lib/transport-adapters apps/operator/tsconfig.json` and check whether I've touched anything you're about to.
- If we end up needing the same file in the same week, sync directly.

## Bottom line for the user reading this

The two streams *can* coexist if approach is "parallel dir, cutover later" or "in-place but coordinated on the 5 risky-overlap items above." They *will* interfere if both agents are simultaneously editing `apps/operator/tsconfig.json`, the SPA root provider, or the Hono catch-all. The host-architecture work in `packages/agent-mcp` and `libs/sync` is completely safe regardless.
