# Pitfalls
URL: /internal/docs/data-sync/pitfalls

Specific failure modes that have silently broken every panel in a schema. Read before debugging.

These are catalogued because each one cost real time. If a panel is
behaving wrong, work down this list before you start changing code.

## 1. `render: (row) =>` instead of `render: ({ row }) =>`

**Symptom**: every cell in the column renders blank or shows
`[object Object]`.

**Why**: `ColumnDef.render` is called with a context object
`{ row, index }`, not the row itself. TypeScript accepts both
signatures because the context structurally satisfies many row shapes.

**Fix**: destructure `{ row }` from the argument.

```ts
render: ({ row }) => row.name,   // ✓
render: (row) => row.name,       // ✗ row is the ctx; row.name is undefined
```

## 2. PG `TIMESTAMPTZ` declared as `string()` in Zero schema

**Symptom**: `SchemaVersionNotSupported` in `zero-cache` logs.
WebSocket dies. **Every panel using that schema goes blank.** Reload
doesn't help.

**Why**: Zero deserializes `TIMESTAMPTZ` as epoch-ms `number`. If the
schema declares it as `string()`, validation fails for every row and
the cache disconnects.

**Fix**: declare as `number()`.

```ts
ts: number(),   // ✓
ts: string(),   // ✗ — kills the WS for the whole schema
```

This has bitten us at least three times. **Always check the column type
before declaring a TIMESTAMPTZ field.**

## 3. Two copies of `@rocicorp/zero` in the dep tree

**Symptom**: `Query does not implement QueryInternals` thrown from
every `useQuery` call.

**Why**: a sub-app declared `@rocicorp/zero` directly in its
`package.json` and npm hoisted it into `apps/<name>/node_modules`. The
panel's import resolves to the local copy; Zero's runtime resolves to
the workspace root copy. Two distinct module instances → instanceof
fails → `QueryInternals` mismatch.

**Fix**: symlink the inner copy to the workspace root.

```bash
cd apps/papercusp
rm -rf node_modules/@rocicorp/zero
ln -s ../../../node_modules/@rocicorp/zero node_modules/@rocicorp/zero
```

Then preferably remove the direct dep from the sub-app's
`package.json` so the next `npm install` doesn't reintroduce it.

## 4. Legacy class with `display: grid` in `rowProps`

**Symptom**: cells render on top of each other; the whole grid looks
collapsed.

**Why**: `RichGrid` uses CSS Grid for its cell layout. If `rowProps`
returns a `className` that has its own `display: grid`, the two
grids fight.

**Fix**: override with inline `style: { display: 'block' }`.

```tsx
rowProps={(row) => ({
  className: 'h-issue',
  style: { display: 'block' },
})}
```

## 5. Forgot to bump `schemaVersion`

**Symptom**: you changed `schema.ts` (added a column, renamed one,
changed a type), restarted `zero-cache`, and clients still see the old
shape — or worse, throw `SchemaVersionNotSupported`.

**Why**: clients cache the schema. Without a version bump they reuse
the old cached schema even though the server sent a new one.

**Fix**: bump the `schemaVersion` constant in
`libs/zero-harness/src/schema.ts`. Every change is a bump.

## 6. Forgot to add the table to the Postgres publication

**Symptom**: the named query returns `[]` always, even though
`SELECT * FROM harness_<slug>.harness_<table>` shows rows.

**Why**: the table isn't in the `zero_harness` publication, so logical
replication isn't broadcasting it.

**Fix**:

```sql
ALTER PUBLICATION zero_harness ADD TABLE harness_<slug>.harness_<table>;
```

…then restart `zero-cache-harness` so it re-reads the publication
membership.

## 7. zero-cache port collisions

**Symptom**: zero-cache logs "address already in use" on `:4849` or
`:4850`.

**Why**: the shop zero-cache (different DB, different config) defaults
its change-streamer port to `ZERO_PORT + 1 = 4849`, which collides with
the harness zero-cache main port.

**Fix**: set `ZERO_CHANGE_STREAMER_PORT=4847` on the shop zero-cache
unit. The current allocation is:

| Port | Service                         |
| ---- | ------------------------------- |
| 4849 | harness zero-cache main         |
| 4850 | harness change-streamer         |
| 4847 | shop change-streamer (override) |

## 8. `useQuery` outside the provider

**Symptom**: SSR error: "useZero must be within a ZeroProvider."

**Why**: a server-component or a client-component rendered above the
`HarnessZeroProvider` wrapper is calling `useQuery`.

**Fix**: ensure your panel is a client component (`'use client'`) and is
mounted inside the provider tree. Check
`apps/operator/app/harness/layout.tsx` for the wrapping.

If you need a query outside the harness layout's tree, mount a separate
provider — but prefer keeping data-fetching panels inside the harness
layout.

## 9. JSON ledger out of sync with PG

**Symptom**: `loadProjects()` returns rows that don't match what the UI
shows (or vice versa).

**Why**: prior to the JSON-ledger retirement, both PG and JSON were
sources of truth. Some old code paths wrote to one and not the other.

**Fix**: PG is canonical. The JSON file is now a derived snapshot
(`derivedFromPg: true`). If you find code writing to the JSON
directly, route it through `loadProjects()`/`saveProjects()` (PG-backed
with in-memory cache + bulk upsert).

## 10. dev:web vs dev:operator confusion

> **Retired (2026-05-30).** `apps/web` (the `@papercup/web` public site) was moved to
> `_retired/papercup/` and dropped from the workspace; the `dev:web` script no longer
> exists. Kept for reference. The operator (`:3055`) is the **Vite** SPA — see the **Fix** note.

**Symptom**: edits to `apps/web/...` don't take effect after restart.

**Why**: `dev:web` serves `apps/web/.next/standalone/server.js`, **not**
a dev server. To see source changes you need `npm run build` (full
rebuild — never `npx next build`, which skips the static-asset copy).

**Fix**: rebuild apps/web. The operator (`:3055`) uses the **Vite** dev
server (`@papercusp/operator-vite`) and picks up source changes via HMR;
only the legacy `apps/web` Next standalone is the static-build outlier.

## 11. Replication slot stuck after DB rename

**Symptom**: `zero-cache-harness` won't start; logs show "replication
slot in use."

**Fix**:

```sql
SELECT pid, application_name FROM pg_stat_replication
  WHERE slot_name = 'zero_harness';
SELECT pg_terminate_backend(<pid>);
```

If `postgres_app` is the holder, restart it.
