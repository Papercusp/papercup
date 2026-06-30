/**
 * datatype-frontier-placement.integration.test — the P-001 placement OPT-IN against real PG
 * (reflexive-platform-extensibility-datatypes-2026-06-24). Proves `frontierPlacementKindClause`:
 * built-in feature-family kinds always pass; a generic-kind datatype's kind passes ONLY when it
 * carries the `hive-placement` tag; an untagged generic-kind is excluded (visible ≠ placeable).
 *
 * Drives the clause against a small VALUES(item_kind) table — it filters on `item_kind` + a
 * subquery over `datatype_registry`, so no `harness_features_consolidated` insert is needed; the
 * registry rows (created via upsertDatatype) supply the opt-in signal. Mirrors the
 * datatype-registry integration fixture: apply 421, use the RLS-bypass admin client.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrgTestDb } from '../test/_org-test-db';
import { upsertDatatype } from './datatype-registry-store';
import { frontierPlacementKindClause, HIVE_PLACEMENT_TAG } from './datatype-frontier-placement';

const { createOrgTestDb } = await import('../test/_org-test-db');
const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');

/** Run the frontier clause over a synthetic set of candidate kinds; return those it admits. */
async function placeableKinds(db: OrgTestDb, ws: string, kinds: string[]): Promise<string[]> {
  const rows = await db.adminSql<{ item_kind: string }[]>`
    SELECT item_kind FROM unnest(${kinds}::text[]) AS t(item_kind)
     WHERE ${frontierPlacementKindClause(db.adminSql, ws)}
     ORDER BY item_kind`;
  return rows.map((r) => r.item_kind);
}

describe('frontier placement opt-in (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    await db.adminSql.unsafe(readFileSync(join(SQL_DIR, '421-datatype-registry.sql'), 'utf8'));
    await db.adminSql.unsafe(readFileSync(join(SQL_DIR, '425-datatype-review-status.sql'), 'utf8'));
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('admits built-ins always, a tagged generic-kind, but NOT an untagged generic-kind', async () => {
    const ws = 'ws-frontier';
    // A generic-kind datatype that OPTED IN (carries the hive-placement tag).
    await upsertDatatype(db.adminSql, {
      id: 'bet-analysis',
      workspaceId: ws,
      title: 'Bet analysis',
      description: 'reason about a bet',
      tier: 'generic-kind',
      workItemKind: 'bet-analysis',
      tags: ['oddsmith', HIVE_PLACEMENT_TAG],
    });
    // A generic-kind datatype that did NOT opt in (visible, but not auto-placed).
    await upsertDatatype(db.adminSql, {
      id: 'note',
      workspaceId: ws,
      title: 'Note',
      description: 'a plain note',
      tier: 'generic-kind',
      workItemKind: 'note',
      tags: ['oddsmith'],
    });

    const admitted = await placeableKinds(db, ws, ['feature', 'research-task', 'chunk', 'bet-analysis', 'note', 'bug']);
    // built-ins + the opted-in 'bet-analysis'; NOT 'note' (untagged) and NOT 'bug' (issue-family).
    expect(admitted).toEqual(['bet-analysis', 'chunk', 'feature', 'research-task']);
  });

  it('is workspace-scoped: an opt-in in ws-A does not place ws-B', async () => {
    const wsA = 'ws-fa';
    const wsB = 'ws-fb';
    await upsertDatatype(db.adminSql, {
      id: 'wager',
      workspaceId: wsA,
      title: 'Wager',
      description: 'a wager',
      tier: 'generic-kind',
      workItemKind: 'wager',
      tags: [HIVE_PLACEMENT_TAG],
    });
    expect(await placeableKinds(db, wsA, ['wager'])).toEqual(['wager']);
    expect(await placeableKinds(db, wsB, ['wager'])).toEqual([]); // not opted-in in ws-B
  });

  it('a projection-tier datatype with the tag is still NOT placed (only generic-kind enrols)', async () => {
    const ws = 'ws-proj';
    await upsertDatatype(db.adminSql, {
      id: 'position',
      workspaceId: ws,
      title: 'Position',
      description: 'engine-owned money truth',
      tier: 'projection',
      workItemKind: 'position', // even if a kind is set, projection is engine-written, not bee-placed
      authoritativeWriter: 'engine:oddsmith',
      tags: [HIVE_PLACEMENT_TAG],
    });
    expect(await placeableKinds(db, ws, ['position'])).toEqual([]);
  });
});
