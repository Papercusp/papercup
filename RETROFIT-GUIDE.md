# Workspace-scoping retrofit guide

Phase A of the Agent MCP plan adds `workspace_id` + RLS to `harness_shared.*` tables. After migration `010-workspace-scoping-rls.sql` lands, existing code that reads/writes those tables needs to use the `app.workspace_id` GUC contract or it will return zero rows when run through `harness_app` (RLS predicate fails on null GUC).

This guide walks through retrofitting the 14 known files. The mechanical change is small and uniform.

## Files needing retrofit

Routes:
- `apps/operator/app/api/admin/rotate-token/route.ts`
- `apps/operator/app/api/harness/all/kpis/route.ts`
- `apps/operator/app/api/harness/search/route.ts`
- `apps/operator/app/api/_hono/cross-harness.ts`
- `apps/operator/app/api/_hono/harness.ts`
- `apps/operator/app/api/_hono/projects.ts`
- `apps/operator/app/api/plugins/enabled/route.ts`

Lib:
- `apps/operator/lib/autoloop.ts`
- `apps/operator/lib/execute-action.ts`
- `apps/operator/lib/plugin-configs-pg.ts`
- `apps/operator/lib/plugin-enables-pg.ts`
- `apps/operator/lib/plugin-host.ts`
- `apps/operator/lib/pm-dispatch.ts`
- `apps/operator/lib/provision/operator-claims.ts`

## The change

### Pattern A — Next route that does cross-workspace reads

```ts
// Before
import { getOrgPg } from '@restart/db-org';

export async function GET() {
  const { sql } = getOrgPg();
  const rows = await sql`SELECT * FROM harness_shared.projects`;
  return NextResponse.json({ rows });
}

// After
import { routeWithWorkspace } from '@/lib/route-workspace';

export async function GET() {
  const rows = await routeWithWorkspace(async (tx) => {
    return await tx`SELECT * FROM harness_shared.projects`;
  });
  return NextResponse.json({ rows });
}
```

### Pattern B — Hono route

Hono routes get a shared `c` context. Use the same wrapper:

```ts
app.get('/all/kpis', async (c) => {
  const data = await routeWithWorkspace(async (tx) => {
    // ... use tx for every query against harness_shared.* ...
  });
  return c.json(data);
});
```

### Pattern C — lib helper that callers already wrap

Several lib files (e.g. `plugin-enables-pg.ts`) are called from many routes. Two options:

1. **Add `tx` parameter to the helper signature**: every caller passes its current transaction. This is the cleanest but ripples to all call sites.
2. **Wrap inside the helper**: the helper opens its own `withWorkspace`. Simpler, but if the caller is already inside a transaction, you nest — postgres-js supports nested `BEGIN`/`SAVEPOINT` so this is fine for v1.

I recommend (1) for libs called from <5 places and (2) for libs called from many places.

### Pattern D — Per-harness queries via `getHarnessPg(slug)`

These are fine as-is. Per-harness schemas (`harness_<slug>`) are scoped by name; RLS doesn't apply to them.

### Pattern E — `getOrgPg()` is still legitimate for…

- Migrations (`bin/run-migrations.ts` etc.)
- Tooling that intentionally spans workspaces (admin dashboards in a v2 multi-workspace UI)
- The token-resolution path in `@papercusp/agent-mcp/src/auth.ts` (must read across workspaces to determine which workspace a bearer belongs to)

For these, keep `getOrgPg()` and add a code comment noting why the bypass is intentional.

## Lint enforcement

The `papercusp/no-bare-db-in-tx` ESLint rule (defined in `tools/eslint-rules/no-bare-db-in-tx.js`, wired in `eslint.config.mjs`) fires on bare-`db`/`sql` references and `getOrgPg()`/`getHarnessPg()` calls inside a callback whose first parameter is named `tx`. This is the canonical Drizzle/Knex RLS regression and the rule prevents it mechanically.

## Testing the retrofit

After all 14 files are retrofitted:

1. Apply 010-workspace-scoping-rls.sql to the test DB.
2. Run the cross-workspace probe: `vitest packages/agent-mcp/src/__tests__/cross-workspace-probe.test.ts`.
3. The probe authenticates as workspace B and tries to read workspace A's data; assertions check denial.
4. Spot-check a handful of routes manually — open the operator with workspace A active, then switch to workspace B, confirm cross-workspace data doesn't appear.

## Deployment sequence

The retrofit must land BEFORE 010-workspace-scoping-rls.sql is applied to production. Ordering:

1. PR with the 14-file retrofit. Merge.
2. Apply 009 + backfill (still no RLS; existing reads still work via admin).
3. Apply 010 (RLS enabled). Now the retrofit's `withWorkspace` calls become load-bearing.
4. Run the cross-workspace probe in CI on every subsequent PR.
