---
title: Endpoint-system route management — the defineRoute primitive
slug: endpoint-route-migration-2026-05-20
status: design-review
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
companion-to: [host-architecture-2026-05-20-v2, route-audit-2026-05-20]
---

# Endpoint-system route management — the `defineRoute` primitive

**Date:** 2026-05-20
**Status:** Design-review. No code lands until the §7 questions are resolved.
**Supersedes the premise of:** host-architecture v2 Phase 4 ("route migration").

---

## 1. Reconciliation — what this project is NOT

The route-audit (`route-audit-2026-05-20.md`) read all 243 routes and proved the **naive** Phase 4 — "turn the API routes into `defineTool`s" — is empty. Zero of 243 routes are agent functions hiding as routes. The 14 substrate routes already *are* the agent-tool surface; the other 229 are plumbing (UI-data, orchestrator IPC, settings CRUD, webhooks, OAuth, sync transports). Turning plumbing into agent tools is a category error.

So this plan does **not** propose route→`defineTool` migration. That project does not exist; pretending otherwise would be dishonest.

## 2. What the audit actually surfaced — the real project

"A1-exempt" was recorded 229 times. It is the correct call against the *tool* question. But it quietly conflated two different things:

- **A1 in the tool sense** — "this should not become a `defineTool`." ✅ True for 229 routes.
- **A1 as "leave it as an unmanaged raw handler forever."** ❌ This does *not* follow, and it's wrong.

The evidence, measured this session:

| Property | A `defineTool` gets it | An A1 `route.ts` gets it |
|---|---|---|
| Unified auth | ✅ dispatcher + principal | ❌ **22 of 243** use `requirePrincipal`; 5 still ad-hoc `isLoopback`; 19 hand-roll cookie/session; **~197 have no auth wrapper at all** |
| Telemetry (`tool_invocations`) | ✅ every call | ❌ **3 of 243** emit anything |
| Timeout / wedged-handler abort | ✅ dispatch-stack | ❌ none |
| Uniform error envelope | ✅ `DispatchProjectedResult` | ❌ each route invents `{ error }` / `{ status }` shapes |
| OpenAPI presence | ✅ Phase 7 emitter | ❌ the 229 plumbing routes are invisible to `openapi.json` |
| One place to add a cross-cutting concern | ✅ a dispatch-stack step | ❌ 243 separate edits |

**The real project:** bring the A1 routes onto the endpoint system's *cross-cutting machinery* — auth, telemetry, timeout, error mapping, contract surface — **without** forcing them into the tool model. The endpoint system today has exactly one projection (`defineTool` → MCP/HTTP tool). It needs a **second**: a route-shaped projection. That is what "route migration" should have meant all along.

This is not invented work. The 21-route `requirePrincipal` consolidation already shipped this session is the first 9% of it, done by hand. The other ~91% is the same kind of consolidation — it just needs a primitive instead of a copy-paste.

## 3. The primitive — `defineRoute`

A second endpoint-system projection. Sibling to `defineTool`, deliberately different:

```ts
export const { GET } = defineRoute({
  method: 'GET',
  // Auth: a PrincipalRequirements object, or 'public' to opt out
  // (webhooks, oauth/callback — routes that MUST accept unauthenticated
  // callers). No default — every route states its stance explicitly.
  auth: { trust: ['trusted', 'verified', 'unverified-loopback'] },
  // Optional Zod input schema. When present: parsed + 400 on failure,
  // and the route's OpenAPI operation carries the requestBody schema.
  // When absent: the handler gets the raw Request — freeform routes
  // (file-serving, qr.svg, SSE) stay freeform.
  input: z.object({ limit: z.number().optional() }),
  // Wall-clock timeout; default 30s. Wedged handlers abort.
  timeoutSec: 30,
  async handler(req, ctx) {
    // ctx.principal — resolved Principal (or null when auth:'public')
    // ctx.input     — parsed input when `input` schema was given
    // ctx.log       — telemetry-bound logger
    return Response.json({ ... });
  },
});
```

What `defineRoute` **is**:
- A declarative wrapper that produces the Next handler exports (`GET`/`POST`/…) the route file re-exports — *and* a Hono-mountable form for the `_hono/*` routers.
- Dispatched through a **route-stack** — a small, composable middleware stack reusing the Phase 3a `DispatchStep` machinery (`dispatch-stack.ts`). The route-stack's steps are a strict subset: `auth` → `timeout` → `invoke` → `telemetry` → `error-map`. No role-allowlist, no quota, no replay-buffer, no `ctx.emit` — those are agent-streaming concerns A1 routes don't have.
- HTTP-native. The handler signature is `(req, ctx) => Response`, not the tool's `(input, ctx) => ToolResult`.

What `defineRoute` is **NOT**:
- **Not in the agent tool catalog.** It has no `expose.mcp`. `tools/list` never sees it. An agent cannot call a `defineRoute`. This is the structural guarantee that keeps plumbing out of the tool surface — the exact category error the audit caught.
- **Not a forced typed contract.** `input` is optional. A genuinely freeform route (`scratch/[...path]` file-serving, `mobile/qr.svg`, the SSE streams) declares no `input` and gets the raw `Request`. It still gets auth + telemetry + timeout + error-map.

## 4. Why a new primitive, not Hono middleware (design fork)

Three ways to give A1 routes the cross-cutting machinery:

| Option | Mechanism | Verdict |
|---|---|---|
| **A — Hono middleware only** | Apply auth/telemetry as Hono `app.use()` middleware | **Rejected.** Covers only the 18 `_hono/*` routers. The **243 Next-native `route.ts` files** don't run through the Hono app — they're independent Next handlers. Misses 93% of the surface. |
| **B — `defineRoute` primitive** | Declarative wrapper → Next exports + Hono form, dispatched through the route-stack | **Recommended.** Covers both host shapes. Declarative → OpenAPI emission falls out. Reuses the Phase 3a composable-stack. One definition surface. |
| **C — Hybrid** | Hono middleware for `_hono/*`, `defineRoute` for Next-native | Rejected — two mechanisms, two places to add a concern, the exact fragmentation we're removing. |

Recommendation: **Option B.** The route-stack is ~5 steps and reuses `DispatchStep`/`runDispatchStack` from `dispatch-stack.ts` — small surface, already tested machinery.

## 5. Scope — which routes, and the honest cost/benefit

**Not all 229 A1 routes need this.** Three tiers:

- **Tier 1 — auth-sensitive (migrate first, ~60 routes).** Anything touching credentials, admin ops, desktop state, plugin host, provisioning, OAuth, snapshots/templates publish. These genuinely benefit from uniform `requirePrincipal` + telemetry. The 21 already swept are a down payment on this tier.
- **Tier 2 — UI-data routes (migrate in bulk, ~140 routes).** Settings reads, panel data, marketplace catalog. Lower auth stakes, but uniform telemetry makes `/dev → Sessions` show the *whole* API surface, and the error envelope + timeout are free wins. Mechanical.
- **Tier 3 — skip (≈30 routes).** High-frequency transport + trivial routes where the machinery is pure overhead: `zero-harness/sse` + `rest-query*` (polled every ~3s — telemetry would flood the table), `runtime-config` (static env echo), the `[[...route]]` Hono entrypoint shim itself. These get an explicit `// endpoint-route: exempt` marker + a doc row, same as A1-exempt in the tool audit.

**Honest cost/benefit.** This is ~200 routes of churn for cross-cutting consistency. The benefits — one auth path, complete telemetry, complete OpenAPI, one edit-point for cross-cutting concerns — are real but are *consistency* benefits, not new features. If you'd rather not spend the churn, the defensible smaller scope is **Tier 1 only** (~60 auth-sensitive routes) — that captures the security-relevant consolidation and leaves the UI-data routes alone. Q6 asks you to pick.

## 6. Phases

### Phase R1 — `defineRoute` + the route-stack

- **Scope:** `route-stack.ts` (the 5-step stack, built on `DispatchStep`); `define-route.ts` (the primitive, producing Next exports + Hono form); the `RouteContext` type (`principal`, `input`, `log`). Convert **one pilot route per host shape** — one Next-native, one `_hono/*` — to prove both.
- **Acceptance:** pilot routes emit a telemetry row; auth flows through `requirePrincipal`; a wedged handler aborts at `timeoutSec`; unit tests enumerate the route-stack in order (mirrors `dispatch-stack.test.ts`).
- **NOT shipping:** bulk migration; OpenAPI emission; the telemetry table decision (R2).
- **Rollback:** single-PR revert; pilots are additive.

### Phase R2 — telemetry unification

- **Scope:** decide `route_invocations` (new table) vs extending `tool_invocations` (Q1). Plumb the route-stack's `telemetry` step into it. `/dev → Sessions` (or a sibling panel) reads it.
- **Acceptance:** every `defineRoute` call lands a row; `/dev` surfaces route traffic distinctly from tool traffic.
- **NOT shipping:** migrating routes (R4) — just the sink.
- **Rollback:** revert; the telemetry step degrades to a no-op.

### Phase R3 — OpenAPI extension

- **Scope:** `defineRoute` operations join `openapi.json` (Phase 7) as plain HTTP operations — `requestBody` from `input` when declared, the standard error responses, **no** `text/event-stream`/tool shape. The assembler walks a route registry alongside the tool catalog.
- **Acceptance:** `openapi.json` covers substrate tools **+** every migrated `defineRoute`; `@redocly/cli lint` clean.
- **NOT shipping:** routes not yet migrated stay absent (expected; the doc tracks coverage).
- **Rollback:** revert the assembler change.

### Phase R4 — bulk migration, by family

- **Scope:** convert A1 routes to `defineRoute`, family by family, Tier 1 before Tier 2. `_hono/*` routers first (18 — already centralized, lowest risk). Then Next-native by family, ≤8 routes per PR.
- **Audit doc linkage:** each migrated route's row in `route-audit-2026-05-20.md` flips from `A1-exempt` to `defineRoute → <sha>`.
- **Acceptance per batch:** every route emits telemetry; auth uniform; the route's existing e2e/integration spec passes unchanged (wire contract preserved); `tsc` clean.
- **NOT shipping:** Tier-3 exempt routes; behavior changes (pure mechanical wrap).
- **Rollback:** per-batch PR revert.

### Phase R5 — enforcement

- **Hard prerequisite:** R4 ≥80% of Tier 1 + Tier 2.
- **Scope:** ESLint rule — a new `route.ts` under `app/api/**` must export from `defineRoute`, not a raw `export function GET`. Tier-3 exempt files carry the marker the rule recognizes.
- **Acceptance:** a planted raw-handler route fails `lint`; the real tree passes.
- **Rollback:** demote to warning.

## 7. Open questions (block implementation)

**Q1 — telemetry sink.** New `route_invocations` table, or extend `tool_invocations` with a `kind: 'tool' | 'route'` column? A separate table avoids polluting tool analytics + lets route rows have a different retention policy (route traffic is higher-volume). Recommend **separate table**.

**Q2 — `_hono/*` routers.** The 18 Hono routers could alternatively keep their current shape and just get Hono middleware (Option A applied *only* to them). Do we convert them to `defineRoute` for uniformity, or leave them Hono-native with middleware? Recommend **convert** — one primitive, one mental model — but it's a real fork.

**Q3 — auth default.** Should `defineRoute` *require* an explicit `auth` field (no default — every route states its stance), or default to fail-closed `requirePrincipal()`? Fail-closed is safer but a forgotten `auth: 'public'` breaks webhooks/OAuth-callback silently. Recommend **required explicit field** — no default, the type makes you choose.

**Q4 — typed input.** `input` optional (freeform routes pass), as drafted? Or push every route toward a Zod contract? Recommend **optional** — forcing a schema onto `scratch/[...path]` file-serving is noise.

**Q5 — verification.** This wraps ~200 live routes. Each batch's acceptance leans on the route's existing e2e/integration spec. Routes *without* a spec — how do we verify the wrap didn't change behavior? Options: (a) require a smoke test per migrated route, (b) accept `tsc` + manual spot-check, (c) golden-response capture before/after. Recommend **(c)** for Tier 1, **(b)** for Tier 2.

**Q6 — scope.** Full (Tier 1 + Tier 2, ~200 routes) or Tier 1 only (~60 auth-sensitive)? Tier 1 captures the security consolidation; Tier 2 is consistency + telemetry completeness. This is the call that sizes the project from ~2 weeks (Tier 1) to ~6–8 weeks (full).

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| ~200-route churn | High | Mechanical, batched ≤8/PR, family-by-family; pre-alpha — breakage is cheap; per-batch revert. |
| A public route gets fail-closed auth → webhook/OAuth breaks | High | Q3: explicit `auth` field, no default; `auth: 'public'` is a deliberate keystroke. R1 converts a webhook as a pilot to prove the path. |
| Telemetry volume from high-frequency routes | Medium | Tier-3 exemption for `zero-harness/*` + polled routes; telemetry step supports a per-route sample rate. |
| Behavior drift on routes with no test | Medium | Q5 — golden-response capture for Tier 1. |
| Coordination — Starlight + Next-removal-deferred agents touch `app/api/**` | Medium | `locks:acquire` per batch; `_hono/*` first (smaller contention surface); coordinate via `coord/`. |
| The whole thing is consistency, not features | Real | Q6 lets you scope to Tier 1 or veto. Stated honestly, not buried. |

## 9. What this is NOT

- Not route→`defineTool`. That project does not exist (route-audit proved it).
- Not a behavior change. `defineRoute` is a transparent wrapper — same wire contract, same responses, plus telemetry/auth/timeout.
- Not a Next removal. `defineRoute` produces Next handler exports; it's orthogonal to the deferred Next-removal plan.
- Not Track A. `defineRoute` *consumes* `requirePrincipal` (Phase 3b); it doesn't define auth policy.

## 10. Recommendation

Proceed with **Option B** (`defineRoute` primitive) at **Q6 = full scope** if you want the complete telemetry + OpenAPI surface, or **Q6 = Tier 1** if you want only the security consolidation. Either way R1–R3 are identical; only R4's length changes. My recommendation: **Tier 1 now, decide on Tier 2 after R1–R3 land** — that way the primitive proves itself on the 60 routes that matter most before committing to the full 200-route churn.
