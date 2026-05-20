# Cookbook
URL: /internal/docs/data-sync/cookbook

Copy-paste recipes for the most common panel-building tasks.

## Recipe 1: New panel reading from an existing Zero table

The 80% case. You want to render an existing per-harness table as a new
panel.

```tsx
'use client';

import { useMemo } from 'react';
import { useQuery } from '@rocicorp/zero/react';
import { RichGrid, type ColumnDef } from '@restart/grid-core';
import type { SnapshotConsolidatedRow } from '@restart/zero-harness';
import { useSyncQuery } from '@restart/sync';

interface Props {
  slug: string;
  onSelect?: (id: string) => void;
}

export default function MySnapshotsPanel({ slug, onSelect }: Props) {
  const { data: rows } = useSyncQuery<SnapshotConsolidatedRow>({
    queryName: 'snapshotsConsolidated.bySlug',
    args: [slug],
  });

  const columns = useMemo<ColumnDef<SnapshotRow>[]>(() => [
    {
      key: 'when', header: 'When', width: 1.3,
      sortKey: 'ts', defaultSortDir: 'desc',
      render: ({ row }) => new Date(Number(row.ts)).toLocaleString(),
    },
    {
      key: 'iter', header: 'Iter', width: 0.4, align: 'right',
      sortKey: 'iterNum',
      render: ({ row }) => row.iterNum,
    },
  ], []);

  return (
    <RichGrid<SnapshotRow>
      rows={rows}
      columns={columns}
      getRowId={(r) => r.snapshotId}
      onRowClick={(r) => onSelect?.(r.snapshotId)}
      inline
    />
  );
}
```

## Recipe 2: Migrating an existing `.map()` list to RichGrid

Source pattern (anti-pattern in this codebase):

```tsx
{items.map((item) => (
  <div key={item.id} className="row">
    <span>{item.id}</span>
    <span>{item.name}</span>
    <span>{item.status}</span>
  </div>
))}
```

Migration:

```tsx
import { useMemo } from 'react';
import { RichGrid, type ColumnDef } from '@restart/grid-core';

const columns = useMemo<ColumnDef<Item>[]>(() => [
  { key: 'id', header: 'ID', width: 1, sortKey: 'id',
    render: ({ row }) => row.id },
  { key: 'name', header: 'Name', width: 3, sortKey: 'name',
    render: ({ row }) => row.name },
  { key: 'status', header: 'Status', width: 1, sortKey: 'status',
    render: ({ row }) => row.status },
], []);

return (
  <RichGrid<Item>
    rows={items}
    columns={columns}
    getRowId={(i) => i.id}
    inline
  />
);
```

Steps in order:

1. Add `import { RichGrid, type ColumnDef } from '@restart/grid-core'`.
2. Build a `columns` array, one entry per visible field. Wrap in
   `useMemo`.
3. Replace the `.map()` block with `<RichGrid …>`.
4. Move per-row click handler from each row to `onRowClick`.
5. Drop the manual loading + error CSS (RichGrid renders its own header
   even when rows is empty; provide a sibling empty-state component if
   you need a friendlier message).

## Recipe 3: Adding a new column to an existing Zero-synced table

```sql
ALTER TABLE harness_<slug>.harness_<table>
  ADD COLUMN new_col text;
```

For each existing harness, repeat. Then:

1. Update `bin/scaffold-harness-schema.sh` so future harnesses get it.
2. Update `libs/zero-harness/src/schema.ts` — add `new_col: string()`
   (or the right type — beware TIMESTAMPTZ).
3. Bump `schemaVersion` in `schema.ts`.
4. The publication already includes the table; the new column flows
   automatically.
5. Restart `zero-cache-harness`.
6. Update consumers (`useQuery` results now include `new_col`).

## Recipe 4: Adding a new table to all harnesses

Bigger lift. Steps:

1. Add `CREATE TABLE` DDL to `bin/scaffold-harness-schema.sh`.
2. Run scaffold against every existing harness:
   ```bash
   for slug in $(psql -tAc "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'harness\_%'" | sed 's/^harness_//'); do
     bin/scaffold-harness-schema.sh "$slug"
   done
   ```
3. Add the table to `libs/zero-harness/src/schema.ts`.
4. Add a query factory to `queries.ts`.
5. Add a `slugToXxxKey` helper to `queries.ts`.
6. Bump `schemaVersion`.
7. Restart `zero-cache-harness`.

## Recipe 5: Cross-harness consolidated table

When you need to render data across all harnesses (e.g. global feature
list).

1. Create a new base table in `harness_shared`:
   ```sql
   CREATE TABLE harness_shared.harness_<name>_consolidated (
     harness_slug text,
     <column>     <type>,
     -- …
     PRIMARY KEY (harness_slug, <pk>)
   );
   ```

2. For each per-harness source table, add an `AFTER INSERT/UPDATE/DELETE`
   trigger that maintains the consolidated table.

3. Add the consolidated table to the `zero_harness` publication.

4. Register a no-arg named query:
   ```ts
   <name>Consolidated: () => z.query.<name>Consolidated,
   ```

5. Bump schema version, restart zero-cache.

`harness_features_consolidated` is the working example to copy.

## Recipe 6: Mutations that update Zero panels

You want a button that inserts a row and have every connected client see
it appear.

```tsx
async function addNote() {
  const res = await fetch('/api/harness/<slug>/notes', {
    method: 'POST',
    body: JSON.stringify({ text: 'hello' }),
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok) {
    toast.error('add note failed');
    return;
  }
  // No reload, no refetch. Zero will broadcast the new row in <100ms.
}
```

The API route writes to PG. Zero broadcasts. `useQuery` re-renders. Done.

If you want optimistic UI before the round-trip, hold the new row in
component state and clear it when the Zero query result reflects the
real one. Don't try to write through Zero — that's not how this stack
works.

## Recipe 7: Per-row action buttons

Buttons inside a column cell that need to **not** trigger the row's
`onRowClick`:

```tsx
{
  key: 'action',
  header: '',
  width: 0.6,
  align: 'right',
  render: ({ row }) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        handleDelete(row.id);
      }}
    >
      delete
    </button>
  ),
}
```

The `e.stopPropagation()` is required.

## Recipe 8: Selected-row highlight

```tsx
const [selectedId, setSelectedId] = useState<string | null>(null);

const getRowBg = (row: Row) =>
  row.id === selectedId ? '#1f2937' : 'transparent';

<RichGrid
  rows={rows}
  columns={columns}
  getRowId={(r) => r.id}
  onRowClick={(r) => setSelectedId(r.id)}
  getRowBg={getRowBg}
  inline
/>
```

`SnapshotsPanel.tsx` is the canonical example of this pattern.

## Recipe 9: PG-mirrored filesystem store

Use this when a filesystem JSON file must remain authoritative — e.g. an
external CLI writes it, or a runtime loader reads it by path — but you
also want cross-harness queries and Zero subscriptions over the same
data.

The pattern in three parts:

**1. The PG table** is a derived index of the JSON. Same schema, plus
`updated_at`. Add to the `zero_harness` publication.

```sql
CREATE TABLE harness_shared.plugin_enables (
  harness_slug   text NOT NULL,
  plugin_slug    text NOT NULL,
  version        text NOT NULL,
  config_hash    text NOT NULL DEFAULT '',
  enabled_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (harness_slug, plugin_slug)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.plugin_enables TO harness_app;
GRANT SELECT ON harness_shared.plugin_enables TO harness_zero;
ALTER PUBLICATION zero_harness ADD TABLE harness_shared.plugin_enables;
```

**2. A mirror helper.** Reads the JSON for one harness/scope, upserts
matching rows, deletes orphans. This is the function every writer calls.

```ts
// apps/operator/lib/plugin-enables-pg.ts
import { getOrgPg } from '@restart/db-org';

export async function mirrorHarness(harness: string): Promise<void> {
  const file = await readEnabled(harness);                  // read JSON
  const enabled = file?.enabled ?? {};
  const { sql } = getOrgPg();
  for (const [pluginSlug, meta] of Object.entries(enabled)) {
    await sql`
      INSERT INTO harness_shared.plugin_enables
        (harness_slug, plugin_slug, version, config_hash, enabled_at, updated_at)
      VALUES (${harness}, ${pluginSlug}, ${meta.version}, ${meta.configHash},
              ${meta.enabledAt}, now())
      ON CONFLICT (harness_slug, plugin_slug) DO UPDATE
        SET version = EXCLUDED.version,
            config_hash = EXCLUDED.config_hash,
            updated_at = now()
    `;
  }
  // Delete rows for plugins removed from the JSON
  const slugs = Object.keys(enabled);
  if (slugs.length === 0) {
    await sql`DELETE FROM harness_shared.plugin_enables WHERE harness_slug = ${harness}`;
  } else {
    await sql`
      DELETE FROM harness_shared.plugin_enables
      WHERE harness_slug = ${harness} AND plugin_slug NOT IN ${sql(slugs)}
    `;
  }
}
```

**3. Hook every writer.** After each successful JSON write — direct or
via subprocess — call the mirror. Best-effort: a mirror failure logs but
does not fail the API call.

```ts
// in the API route that calls the CLI
const r = await spawn(PAPERCUSP_BIN, ['plugin', 'enable', slug, '--harness', h]);
if (r.code === 0) {
  try { await mirrorHarness(h); } catch (e) {
    console.warn('[plugins/enable] PG mirror failed for', h, e);
  }
}
```

**4. Backfill + drift recovery.** Provide a script that reads ALL JSONs
and re-syncs PG. It runs on a fresh checkout, after a direct CLI run
that bypassed the operator API, or whenever you suspect drift.

```js
// scripts/backfill-plugin-enables.mjs
// Same logic as mirrorHarness, run for every harness directory.
// Idempotent: re-running on already-synced data is a no-op.
```

### When to pick this pattern over PG-canonical

| Pick PG-canonical (Recipe 1-2) when | Pick PG-mirror (this) when                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| You own every writer                | A third-party process or runtime path writes the JSON and you can't change it |
| The data has no on-disk consumer    | A loader reads the JSON file at runtime by path                               |
| Atomicity of write matters          | The JSON is the operational source of truth and PG is a query-side index      |

Reference implementations:

* `apps/operator/lib/plugin-enables-pg.ts` (papercusp CLI is the writer)
* `apps/operator/lib/plugin-configs-pg.ts` (substrate plugin loader reads JSON at runtime)

## Recipe 10: Where to put a new panel

| Panel scope                                                  | Location                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Tabular data for one harness, shown in the harness dashboard | `apps/operator/app/harness/<Name>Panel.tsx`                                                                          |
| Department-level dashboard panel                             | `apps/operator/app/harness/DepartmentHarnessDashboard.tsx` (extend the existing file rather than creating a new one) |
| Cross-harness panel (global view)                            | `apps/operator/app/<route>/<Name>Panel.tsx`                                                                          |
| Papercup-app panel (org/projects/messages)                   | `apps/papercup/app/<route>/<Name>.tsx`                                                                               |

Wire it into the dashboard's tab switcher in `HarnessDashboard.tsx` or
`DepartmentHarnessDashboard.tsx`.

## Reference panels

When in doubt, copy the structure from one of these — they exercise the
full stack and are kept up to date:

* `apps/operator/app/harness/SnapshotsPanel.tsx` — small, single
  per-harness table, sortable + per-row delete.
* `apps/operator/app/harness/issues/IssuesList.tsx` — Zero-synced,
  RichGrid, multi-state row, with `rowProps` legacy-class workaround.
* `apps/operator/app/harness/ProposalsPanel.tsx` — Zero-synced with
  inline mutation actions.
* `apps/operator/app/harness/DepartmentHarnessDashboard.tsx` →
  `MemoryEntriesGrid` — RichGrid embedded in a larger dashboard panel.
