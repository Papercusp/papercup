/**
 * datatype-instance-loop.integration.test — the reflexive datatype loop end-to-end against
 * REAL Postgres (reflexive-platform-extensibility-datatypes-2026-06-24). Proves the data-layer
 * path a `work_items:create { kind, payload }` of a declared datatype actually runs:
 *
 *   declare (upsertDatatype, generic-kind + payload_schema + hive-placement tag)
 *     → fetch-by-kind (getGenericKindDatatype — the create gate's lookup)
 *     → VALIDATE the instance payload against the schema (good ⇒ ok, bad ⇒ rejected)
 *     → the kind is FRONTIER-PLACEABLE (it opted in via the tag).
 *
 * This is the closest in-tree proxy for "prove on oddsmith": it exercises the real store
 * functions + the real ajv validator against a schema that round-tripped through JSONB —
 * something unit tests (which hand-build the schema) cannot cover. Mirrors the
 * datatype-registry fixture: createOrgTestDb + apply migration 421.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { upsertDatatype, getGenericKindDatatype } from './datatype-registry-store';
import { validateDatatypePayload } from './datatype-payload-validation';
import { frontierPlacementKindClause, HIVE_PLACEMENT_TAG } from './datatype-frontier-placement';

const { createOrgTestDb } = await import('../test/_org-test-db');

const BET_SCHEMA = {
  type: 'object',
  properties: {
    market: { type: 'string', minLength: 1 },
    edge: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['market', 'edge'],
  additionalProperties: false,
};

describe('reflexive datatype instance loop (real PG)', () => {
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

  it('declare → fetch-by-kind → payload validate → placeable, all wired through PG', async () => {
    const ws = 'ws-loop';

    // 1) Declare a generic-kind `bet` datatype with a payload schema, opted into placement.
    await upsertDatatype(db.adminSql, {
      id: 'bet',
      workspaceId: ws,
      title: 'Bet',
      description: 'a market thesis with an edge',
      tier: 'generic-kind',
      nature: 'record', // D-007: a bet is a record (minted in work_items, tagged non-work per D-011)
      workItemKind: 'bet',
      payloadSchema: BET_SCHEMA,
      selfImprovement: {
        improvements: [{ id: 'tighten-thesis', description: 'sharpen the claim' }],
        scorecard: [{ metric: 'calibration', description: 'brier vs realized' }],
        gym: { signals: ['realized P&L vs forecast'], rubric: 'a win raises calibration without new risk' },
      },
      tags: ['oddsmith', HIVE_PLACEMENT_TAG],
    });

    // 2) The create gate's lookup returns the row + the schema (round-tripped through JSONB).
    const dt = await getGenericKindDatatype(db.adminSql, ws, 'bet');
    expect(dt).not.toBeNull();
    expect(dt!.id).toBe('bet');
    expect(dt!.tier).toBe('generic-kind');
    expect(dt!.payloadSchema).toMatchObject({ type: 'object', required: ['market', 'edge'] });

    // 3) Payload validation against the PG-stored schema — the heart of the "validation" benefit.
    expect(validateDatatypePayload(dt!.payloadSchema, { market: 'BTC>100k EOY', edge: 0.12 }).ok).toBe(true);
    const missing = validateDatatypePayload(dt!.payloadSchema, { market: 'BTC>100k EOY' }); // no edge
    expect(missing.ok).toBe(false);
    expect(validateDatatypePayload(dt!.payloadSchema, { market: 'x', edge: 1.5 }).ok).toBe(false); // out of range
    expect(validateDatatypePayload(dt!.payloadSchema, { market: 'x', edge: 0.2, sneaky: true }).ok).toBe(false); // extra field

    // 4) The kind is frontier-PLACEABLE (it opted in via the hive-placement tag).
    const rows = await db.adminSql<{ item_kind: string }[]>`
      SELECT item_kind FROM unnest(${['bet', 'feature', 'unregistered']}::text[]) AS t(item_kind)
       WHERE ${frontierPlacementKindClause(db.adminSql, ws)}
       ORDER BY item_kind`;
    expect(rows.map((r) => r.item_kind)).toEqual(['bet', 'feature']); // 'unregistered' excluded

    // 5) An unknown kind is not a registered datatype (the create gate's unknown_kind path).
    expect(await getGenericKindDatatype(db.adminSql, ws, 'not-a-datatype')).toBeNull();
  });

  it('a datatype with NO schema imposes no payload constraint (byte-identical to before)', async () => {
    const ws = 'ws-loop-noschema';
    await upsertDatatype(db.adminSql, {
      id: 'note',
      workspaceId: ws,
      title: 'Note',
      description: 'a free-form note',
      tier: 'generic-kind',
      nature: 'work',
      audience: 'agent',
      workItemKind: 'note',
    });
    const dt = await getGenericKindDatatype(db.adminSql, ws, 'note');
    expect(dt!.payloadSchema).toBeNull();
    expect(validateDatatypePayload(dt!.payloadSchema, { anything: 'goes' }).ok).toBe(true);
  });
});
