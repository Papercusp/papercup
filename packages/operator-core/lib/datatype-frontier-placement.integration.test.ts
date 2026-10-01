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
import type { OrgTestDb } from '../test/_org-test-db';
import { upsertDatatype } from './datatype-registry-store';
import { frontierPlacementKindClause, HIVE_PLACEMENT_TAG } from './datatype-frontier-placement';

const { createOrgTestDb } = await import('../test/_org-test-db');

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
    // createOrgTestDb applies the FULL migration set (incl. 421/425 and the D-007
    // pot-rename 506/523) — replaying 421/425 verbatim here is redundant AND re-runs
    // their old hive_slug index against the post-523 schema, 42703-ing "column
    // hive_slug does not exist". See datatype-registry.integration.test.ts.
    db = await createOrgTestDb();
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
      nature: 'work',
      audience: 'agent',
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
      nature: 'work',
      audience: 'agent',
      workItemKind: 'note',
      tags: ['oddsmith'],
    });

    const admitted = await placeableKinds(db, ws, ['feature', 'chunk', 'bet-analysis', 'note', 'bug']);
    // built-ins + the opted-in 'bet-analysis'; NOT 'note' (untagged) and NOT 'bug' (issue-family).
    expect(admitted).toEqual(['bet-analysis', 'chunk', 'feature']);
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
      nature: 'record', // D-007: a wager is a record of a position taken, not work
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
      nature: 'record',
      workItemKind: 'position', // even if a kind is set, projection is engine-written, not bee-placed
      authoritativeWriter: 'engine:oddsmith',
      tags: [HIVE_PLACEMENT_TAG],
    });
    expect(await placeableKinds(db, ws, ['position'])).toEqual([]);
  });
});
