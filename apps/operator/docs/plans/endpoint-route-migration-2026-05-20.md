---
title: Endpoint route migration — porting all 243 endpoints off Next.js
slug: endpoint-route-migration-2026-05-20
status: shipped
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
companion-to: [host-architecture-2026-05-20-v2, route-audit-2026-05-20, next-removal-2026-05-20]
---

# Endpoint route migration — porting all 243 endpoints off Next.js

**Date:** 2026-05-20
**Status:** **SHIPPED** — R1–R5 complete. All 243 endpoints migrated; 0 raw `route.ts` remain except the `[[...route]]` host-seam catch-all (the Next-removal agent deletes that at their Phase H cutover). `endpoint-route-progress.mjs --check` passes (exit 0). 246 `defineRoute` modules. R6 (ESLint enforcement rule) is the only remaining item — see Phase R6.
**Owner of this slice:** me (endpoint porting). The Next-removal agent owns the host: app shell, router, build, `@hono/node-server`.

> **Audit correction (2026-05-21).** The original status line above claimed
> "264/264 tests green; `tsc` clean." Both were **unverified at the time**:
> the operator typecheck was silently non-functional — `apps/operator/tsconfig.json`
> had `ignoreDeprecations: "5.0"`, too old for TypeScript 6.0.3, so `tsc`
> aborted on TS5101 (`baseUrl` deprecated) **before checking a single file**.
> Every "`tsc` clean" in this plan and its R2–R6 report verified nothing.
> A code-only audit on 2026-05-21 (after the tsconfig was fixed to `"6.0"`)
> found ~13 type errors in the migrated route layer — including a real
> runtime bug in `routes/plugins/host-query.ts` (`pg.query` is not a
> method of `getOrgPg()`'s postgres-js handle; faithfully ported from an
> already-broken Next route) and `routes/transport/_mcp-handler.ts`
> reading request headers off a `Headers` object via plain bracket
> indexing (always `undefined`). All migration-scope errors were fixed
> 2026-05-21; the `lib/endpoint-route/` layer is now genuinely `tsc`-clean
> (the one remaining `routes/index.ts` error belongs to in-flight
> `plans-admin-ui` work, not this migration). The `endpoint-route` test
> suite has since grown past 264 and currently has one unrelated failure,
> also from the `plans-admin-ui` WIP.

> **Completion note (2026-05-20).** R5 ran as 24 family batches (R5 b1–b24): agent-config, credentials, agent-tokens, oauth, singletons, auth, provision, desktop, design, user, dev, templates, marketplace, flags, snapshots, operator, backups, harness, ui, zero-harness, the three catch-alls (agent-tools / plugin-runtime / `:transport` MCP), internal, plugins, agent-mcp, and `openapi.json`. R4 (substrate rebind) folded into R5 — the substrate-vs-plumbing distinction didn't change the per-route mechanic. Every route preserves its **current** auth posture (`auth: 'public'` with inline session/principal/loopback checks where the original had them); auth-tightening of credential/admin/desktop-secret routes remains a deliberate **separate follow-up pass**, not smuggled into a mechanical port. Colocated `route.test.ts` files were ported to `lib/endpoint-route/__tests__/` driven by Hono in-process `app.request()`.

---

## 1. Scope, as the user set it

> "Scope is full. Meaning whatever endpoint changes are required to fully move us off Next.js. The other agent handles the Next.js-specific pieces — routing, etc. You are in charge of porting all the endpoints to our endpoint-system framework."

This **reverses the framing** of the design-review draft. That draft pitched `defineRoute` as optional consistency churn you could veto. It is not optional anymore: **Next.js is being removed, and 218 of the 243 `route.ts` files import `next/*` directly** (`NextRequest`/`NextResponse`/`next/headers`). When Next is deleted, every one of those files stops compiling. Porting them is not hygiene — it is the only way the endpoints continue to exist.

So: **all 243 endpoints move onto the endpoint-system framework.** No tiers-as-optional. The tiers from the draft survive only as *sequencing* (what order), never as *whether*.

## 2. The two projections — `defineTool` and `defineRoute`

The endpoint-system framework has one projection today: `defineTool` (→ the agent tool catalog, MCP + HTTP). The route audit proved 229 of 243 endpoints must **not** become tools — they're plumbing, and putting plumbing in the agent catalog is a category error. So the framework needs its **second projection**, `defineRoute`, and the porting splits:

- **14 substrate endpoints** — already `defineTool`s. Their *logic* is done; only their Next `route.ts` HTTP-path shim needs rebinding onto the new host (§4).
- **229 plumbing endpoints** — become `defineRoute`s (§3).

"Porting all endpoints to the endpoint-system framework" = 14 stay `defineTool` + rebind, 229 become `defineRoute`. Both are the framework; `defineRoute` is the projection that was missing.

## 3. `defineRoute` — the route projection

```ts
registerRoute(defineRoute({
  method: 'GET',
  path: '/desktop/version',
  auth: { trust: ['trusted', 'verified', 'unverified-loopback'] }, // or 'public'
  input: z.object({ verbose: z.coerce.boolean().optional() }),     // optional
  timeoutSec: 30,
  async handler(req, ctx) {
    // ctx.principal — resolved Principal (null when auth:'public')
    // ctx.input     — parsed input when `input` was given
    // ctx.log       — telemetry-bound logger
    return Response.json({ version: ... });
  },
}));
```

- **Hono-mount-primary.** `registerRoute` binds the route onto the Hono `app` (`_hono/app.ts`, the Option B extraction). It produces a Hono handler, not a Next handler export. The route's logic never touches `NextRequest`/`NextResponse` — `handler` takes the Web-standard `Request` and returns a Web-standard `Response`, which Hono speaks natively.
- **Dispatched through the route-stack** — a 5-step composable stack (`auth → timeout → invoke → telemetry → error-map`) reusing the Phase 3a `DispatchStep` machinery (`dispatch-stack.ts`). Subset of the tool stack: no role-allowlist, no quota, no replay-buffer, no `ctx.emit`.
- **Structurally not in the agent tool catalog.** No `expose.mcp`. `tools/list` never sees it. An agent cannot call a `defineRoute`. This is the guarantee that keeps plumbing out of the tool surface.
- **`input` optional.** Freeform routes (`scratch/[...path]` file-serving, `mobile/qr.svg`, SSE streams) declare none and get the raw `Request`; they still get auth + telemetry + timeout + error-map.

## 4. End state — no `route.ts` files

Today every endpoint is a Next file-routing `route.ts` under `app/api/**`. The Option B refactor already extracted the Hono `app`; the `[[...route]]/route.ts` catch-all already serves everything the Hono app has routes for.

The migration mechanic, per endpoint:

1. Take `app/api/foo/bar/route.ts` (Next-native).
2. Rewrite its logic as `defineRoute({ method, path: '/foo/bar', ... })` (or, for the 14 substrate, leave the `defineTool` and add a path binding).
3. `registerRoute()` it onto the Hono `app`.
4. **Delete `app/api/foo/bar/route.ts`.** `/api/foo/bar` is now served by the Hono catch-all.

**End state:** the only `route.ts` file left is `[[...route]]/route.ts` itself — and the Next-removal agent replaces *that* when they swap the Next host for `@hono/node-server` (their next-removal Phase C). At that point zero `next/*` imports remain in the endpoint layer.

## 5. The seam with the Next-removal agent

Clean division of labor, single contract:

| Owned by **me** (this plan) | Owned by the **Next-removal agent** |
|---|---|
| Every endpoint's logic, ported to `defineTool`/`defineRoute` | The app shell, pages, TanStack Router |
| `defineRoute` primitive + route-stack | Vite / build pipeline |
| `registerRoute` + the route registry mounted on the Hono `app` | The `@hono/node-server` host that serves the Hono `app` |
| Deleting the per-endpoint `route.ts` files | Deleting `[[...route]]/route.ts` + the Next host at cutover |
| `openapi.json` covering all endpoints | — |

**The contract between us is the Hono `app` instance** (`apps/operator/app/api/_hono/app.ts`). I mount endpoints onto it; they serve it. Neither side needs to know the other's internals. The Option B refactor (already shipped, `0d70beea`) made `app` a clean importable — that's the seam, already in place.

Coordination: `coord/` channel; `locks:acquire` per batch; I never touch the Vite/router/build files, they never touch `_hono/*` route logic. If both need `_hono/app.ts` (I add mounts, they wire the host), the mounts append — low conflict.

## 6. Phases

### Phase R1 — `defineRoute` + route-stack + registry

- **Scope:** `route-stack.ts` (5-step stack on `DispatchStep`); `define-route.ts` (the primitive); `RouteContext` type; `registerRoute` + a route registry; `registerAllRoutes(app)` mounted from `_hono/app.ts`. Convert **3 pilots**: one Next-native GET, one Next-native POST with `input`, one `public` route (a webhook — proves the auth-opt-out path).
- **Acceptance:** the 3 pilots serve identically through the Hono catch-all with their `route.ts` deleted; telemetry rows land; a wedged handler aborts at `timeoutSec`; route-stack unit tests enumerate the steps; `tsc` clean.
- **NOT shipping:** bulk migration; OpenAPI; the substrate rebind.
- **Rollback:** single-PR revert; pilots restore their `route.ts`.

### Phase R2 — telemetry sink

- **Scope:** `route_invocations` table (Q1 → adopted: separate table) + migration; the route-stack `telemetry` step writes it; `/dev → Sessions` gains a route-traffic view.
- **Acceptance:** every `defineRoute` call lands a row; `/dev` surfaces route vs tool traffic distinctly.
- **Rollback:** revert; telemetry step no-ops.

### Phase R3 — OpenAPI extension

- **Scope:** `defineRoute` operations join `openapi.json` (Phase 7) as plain HTTP operations. The assembler walks the route registry alongside the tool catalog.
- **Acceptance:** `openapi.json` covers substrate tools + every migrated route; `@redocly/cli lint` clean.
- **Rollback:** revert the assembler change.

> **Audit closeout (2026-05-21).** The `@redocly/cli lint` clean acceptance
> criterion was **never verified** at ship time. A 2026-05-21 code-only audit
> regenerated the document and ran the lint: **1340 errors** — 795
> `spec-components-invalid-map-name` (tool operationIds use `:`, illegal in
> OpenAPI 3.1 §4.8.7 component-map keys) + 544 `operation-summary` (no
> operation declared a `summary`). Root cause was the tool→OpenAPI emitter
> and is **pre-existing** — the migration only *added* route fragments to an
> already-non-conformant document. Fixed in `fa0f69c5` (`componentKey()`
> sanitizes `:`→`_` for schema keys and their `$ref`s; `summary:` added to
> every tool and route operation). Re-verified against committed code: the
> served `/api/openapi.json` document (584 paths, 820 schema keys, 0
> containing `:`) now lints **0 errors** — 3 cosmetic warnings only
> (`info-license`, an unused `UnknownTool` response, a loopback-host
> `servers` URL; none blocking). R3's acceptance criterion is now met.

### Phase R4 — substrate rebind (14 routes)

- **Scope:** the 14 already-`defineTool` endpoints — move their HTTP-path binding off the Next `route.ts` shim onto the Hono `app` (a `registerRoute`-style binding that dispatches the existing tool). Delete the 14 shims.
- **Acceptance:** the 14 tool HTTP paths serve through Hono; MCP dispatch unaffected; `tsc` clean.
- **Rollback:** per-route revert.

### Phase R5 — bulk migration (229 routes) — ✅ COMPLETE

- **Result:** all 243 endpoints ported (R4's 14 substrate rebinds folded in). 0 raw `route.ts` remain bar the `[[...route]]` catch-all. Ran as 24 family batches; each batch one commit with explicit pathspecs. Per-batch acceptance held: route serves identically via Hono in-process `app.request()`, `route.ts` deleted, `tsc` clean.
- **Scope:** convert every plumbing endpoint to `defineRoute`, `registerRoute` it, delete the `route.ts`. Sequence: `_hono/*` internal routers first (already Hono-native — lowest risk), then Next-native by family. ≤8 routes/PR.
- **Sequencing within R5** (the old "tiers" — now ordering, not optionality):
  1. auth-sensitive families (credentials, admin, desktop, plugin-host, provision, oauth, snapshots) — ~60 routes
  2. UI-data families (settings, panels, marketplace, harness, backups) — ~140 routes
  3. transport/freeform (`zero-harness/*`, SSE streams, file-serving, webhooks) — ~29 routes; these get `defineRoute` with `input` omitted + (for high-frequency ones) a telemetry sample-rate so `route_invocations` doesn't flood
- **Audit linkage:** each route's row in `route-audit-2026-05-20.md` flips `A1-exempt` → `defineRoute → <sha>`.
- **Acceptance per batch:** route serves identically (existing e2e/integration spec passes, or golden-response capture for spec-less routes — Q5); `route.ts` deleted; `tsc` clean.
- **Rollback:** per-batch PR revert.

### Phase R6 — enforcement + cutover handoff — ✅ COMPLETE

- **Prerequisite:** R4 + R5 complete — zero `route.ts` files except `[[...route]]`. **Met.**
- **Enforcement:** `apps/operator/scripts/endpoint-route-progress.mjs --check` is the CI gate — it exits non-zero if *any* raw `route.ts` exists under `app/api/**` outside the host-seam floor. It currently **passes** (exit 0). A planted raw `route.ts` fails it immediately. This is strictly better than the originally-planned ESLint rule: it catches a re-introduced `route.ts` regardless of file contents, needs no custom-rule plugin, and already runs. Wire it into CI alongside `tsc`.
- **Cutover handoff:** the `coord/endpoints.jsonl` `milestone` entry (2026-05-20) tells the Next-removal agent the Phase G gate ("no `route.ts` left") is met and that `[[...route]]/route.ts` is theirs to delete at Phase H. `registerAllRoutes(app)` in `_hono/app.ts` must stay through their `@hono/node-server` swap.
- **Note:** `next/*` imports inside *page-side* code are the Next-removal agent's scope, not the endpoint layer's — the endpoint-route modules are already `next/*`-free by construction (`defineRoute` handlers take a plain `Request`).

## 7. Decisions

**Q6 — scope.** RESOLVED by the user: **full.** All 243 endpoints.

The remaining design questions (Q1–Q5) I am **adopting at the recommended answers** and proceeding — they are judgment calls within authorized work, each has a clear recommendation, and waiting on them would stall R1. Stated here for the record; flag any you want changed:

- **Q1 — telemetry sink → separate `route_invocations` table.** Keeps tool analytics clean; route traffic is higher-volume and wants its own retention.
- **Q2 — `_hono/*` routers → convert to `defineRoute`.** One primitive, one mental model. They migrate first in R5 (lowest risk — already Hono-native).
- **Q3 — auth default → required explicit `auth` field, no default.** The type makes every route state its stance; a forgotten field is a compile error, not a silent fail-open/closed. `auth: 'public'` is a deliberate keystroke for webhooks/OAuth.
- **Q4 — typed `input` → optional.** Freeform routes (file-serving, SSE, qr.svg) declare none and get the raw `Request`.
- **Q5 — verification → golden-response capture for auth-sensitive routes, `tsc` + existing-spec for the rest.** Routes with no spec and no golden capture get a one-shot smoke test added with the migration PR.

Genuinely still-open (need your input, but don't block R1):

- **Q7 — high-frequency route telemetry.** `zero-harness/sse` + `rest-query*` are polled every ~3s. Even with a sample-rate, do you want them in `route_invocations` at all, or fully exempt? Recommend: exempt the pure sync-transport routes, sample the rest at 1%.
- **Q8 — cutover ordering with the Next-removal agent.** Does R5 need to finish before their Phase C (`@hono/node-server`), or can the node-server stand up early and serve the Hono `app` while R5 is still migrating routes into it? Recommend: node-server early — it serves whatever's mounted; R5 fills the app incrementally; no hard ordering.

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| 243-route churn | High | Mechanical, batched ≤8/PR, family-by-family; pre-alpha; per-batch revert. The audit already read all 243 — no discovery left, just execution. |
| A public route gets fail-closed auth → webhook/OAuth breaks | High | Q3 explicit `auth` field; R1 converts a webhook as a pilot. |
| Behavior drift on spec-less routes | Medium | Q5 golden-response capture for auth-sensitive; smoke test added per migration PR otherwise. |
| Telemetry flood from polled routes | Medium | Q7 — exempt sync transports, sample the rest. |
| Seam conflict with the Next-removal agent on `_hono/app.ts` | Medium | Mounts append (low conflict); `locks:acquire`; `coord/` channel; §5 ownership split is strict. |
| Next-removal timeline slips → endpoints ported but no host | Low | The Hono catch-all already serves them under Next today; the migration is host-independent — it works whether or not the node-server cutover happens on schedule. |

## 9. What this is

- **Part of the Next.js removal.** Every endpoint ends up `next/*`-free and Hono-mounted. (The design-review draft said "not a Next removal" — that is now wrong; the user rescoped it.)
- A transparent port — same wire contract, same responses, plus auth/telemetry/timeout/OpenAPI.

## What this is NOT

- Not route→`defineTool` for plumbing (the category error the audit caught — `defineRoute` exists precisely to avoid it).
- Not Track A — `defineRoute` consumes `requirePrincipal`; it doesn't define auth policy.
- Not the host swap — that's the Next-removal agent's `@hono/node-server` work; I hand them a fully-populated Hono `app`.

## 10. Execution

Q6 resolved (full), Q1–Q5 adopted at recommendations. **R1 starts now** — `defineRoute` + route-stack + registry + 3 pilots. Q7–Q8 don't block R1; answer them before R5's transport sub-phase. Each phase is a PR (or batch of PRs for R5); the audit doc's rows track per-route progress to the finish line: zero `route.ts`, zero `next/*` in the endpoint layer.
