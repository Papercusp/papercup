/**
 * claim-spec-revisions.test.ts — the READ path over migration 810's history table
 * (EI-18677010014746233 gap 2).
 *
 * Migration 810's own guarantees are pinned by claim-spec-revision-history.integration.test.ts
 * against a real Postgres. This file covers what that one cannot: the BOUNDING and REPORTING
 * decisions this module makes on top of the rows — the parts where a wrong answer still looks
 * like a well-formed one.
 *
 * The sql seam is a fake rather than a mock of claim-spec-store: 19 test files already
 * vi.mock that module with enumerated factories, and each new export there strands them all
 * (EI-19992501422428824). Nothing mocks this module, and nothing needs to.
 */
import { describe, it, expect } from 'vitest';
import {
  readClaimSpecRevisions,
  claimSpecHistoryElsewhereHint,
  CLAIM_SPEC_HISTORY_MAX,
} from './claim-spec-revisions';
import type { OrgSql } from '../work-items';

type Row = {
  revision: number;
  spec: unknown;
  cause: string;
  superseded_at: string | Date;
  updated_by: string | null;
  harness_slug: string | null;
  id_only: boolean | null;
};

const row = (revision: number, over: Partial<Row> = {}): Row => ({
  revision,
  spec: { note: `v${revision}` },
  cause: 'update',
  superseded_at: '2026-07-26T12:00:00.000Z',
  updated_by: 'the-author',
  harness_slug: 'papercusp',
  id_only: false,
  ...over,
});

/** Captures the interpolated values so the LIMIT actually sent can be asserted. */
function fakeSql(rows: Row[]) {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(rows);
  }) as unknown as OrgSql;
  return { sql, calls };
}

describe('readClaimSpecRevisions — bounding', () => {
  it('reports `more` as a MEASURED fact, not inferred from a full window', async () => {
    // The window lands flush on the last row: 3 rows exist, 3 requested. `returned === limit`
    // would infer more:true here and invent history that does not exist.
    const { sql } = fakeSql([row(8), row(7), row(6)]);
    const w = await readClaimSpecRevisions({ cupId: 'fleet:f', limit: 3 }, sql);
    expect(w.returned).toBe(3);
    expect(w.more).toBe(false);
    expect(w.revisions).toHaveLength(3);
  });

  it('fetches limit+1 and does not leak the probe row into the result', async () => {
    const { sql, calls } = fakeSql([row(8), row(7), row(6), row(5)]);
    const w = await readClaimSpecRevisions({ cupId: 'fleet:f', limit: 3 }, sql);
    expect(calls[0]!.values).toContain(4); // limit + 1
    expect(w.more).toBe(true);
    expect(w.returned).toBe(3);
    expect(w.revisions.map((r) => r.revision)).toEqual([8, 7, 6]);
  });

  it('clamps a caller limit to the module ceiling and to at least one', async () => {
    const big = fakeSql([]);
    await readClaimSpecRevisions({ cupId: 'b', limit: 9999 }, big.sql);
    expect(big.calls[0]!.values).toContain(CLAIM_SPEC_HISTORY_MAX + 1);

    const zero = fakeSql([]);
    await readClaimSpecRevisions({ cupId: 'b', limit: 0 }, zero.sql);
    expect(zero.calls[0]!.values).toContain(2); // clamped to 1, +1 probe
  });

  it('orders by superseded_at DESC with an id DESC tiebreak', async () => {
    // superseded_at is now(), i.e. the TRANSACTION timestamp — the DELETE and INSERT halves
    // of a scope-change re-home share it exactly. Without the id tiebreak, "the version
    // before the last write" can resolve to the wrong half of one re-home.
    const { sql, calls } = fakeSql([]);
    await readClaimSpecRevisions({ cupId: 'b' }, sql);
    expect(calls[0]!.text).toMatch(/ORDER BY\s+superseded_at DESC,\s*id DESC/);
  });

  it('scopes the read to the workspace partition and the addressed bee', async () => {
    const { sql, calls } = fakeSql([]);
    await readClaimSpecRevisions({ cupId: 'fleet:f', workspaceId: 'ws-1' }, sql);
    expect(calls[0]!.values).toContain('ws-1');
    expect(calls[0]!.values).toContain('fleet:f');
  });
});

describe('readClaimSpecRevisions — mapping', () => {
  it('carries enough of the prior row to REBUILD the lane, not just read it', async () => {
    const { sql } = fakeSql([
      row(6, { spec: { note: 'AUTHORED-LANE', not: ['p2p/*'] }, updated_by: 'the-author' }),
    ]);
    const [r] = (await readClaimSpecRevisions({ cupId: 'fleet:f' }, sql)).revisions;
    expect(r).toMatchObject({
      revision: 6,
      spec: { note: 'AUTHORED-LANE', not: ['p2p/*'] },
      updatedBy: 'the-author',
      harnessSlug: 'papercusp',
      idOnly: false,
    });
  });

  it('normalises a Date supersededAt to ISO so the field has one shape', async () => {
    const { sql } = fakeSql([row(6, { superseded_at: new Date('2026-07-26T12:00:00.000Z') })]);
    const [r] = (await readClaimSpecRevisions({ cupId: 'b' }, sql)).revisions;
    expect(r!.supersededAt).toBe('2026-07-26T12:00:00.000Z');
  });

  it('keeps `cause` to the two values the trigger can write', async () => {
    const { sql } = fakeSql([row(6, { cause: 'delete' }), row(5, { cause: 'update' })]);
    const w = await readClaimSpecRevisions({ cupId: 'b' }, sql);
    expect(w.revisions.map((r) => r.cause)).toEqual(['delete', 'update']);
  });

  it('names the subject so an empty window is only "no history" for THAT lane', async () => {
    const { sql } = fakeSql([]);
    const w = await readClaimSpecRevisions({ cupId: 'su-cup-9' }, sql);
    expect(w).toMatchObject({ subject: 'su-cup-9', returned: 0, more: false, revisions: [] });
  });
});

describe('claimSpecHistoryElsewhereHint', () => {
  const base = { returned: 0, source: 'fleet' as const, fleetSlug: 'f-1', addressedFleet: false, limit: 5 };

  it('disambiguates an empty window on an INHERITED spec', () => {
    const hint = claimSpecHistoryElsewhereHint(base);
    expect(hint).toContain("fleet: 'f-1'");
    expect(hint).toContain('history: 5');
    expect(hint).toMatch(/INHERITED/);
  });

  it('stays silent when the window actually returned rows', () => {
    expect(claimSpecHistoryElsewhereHint({ ...base, returned: 1 })).toBeUndefined();
  });

  it('stays silent for a direct fleet read — the fleet lane IS the subject', () => {
    expect(claimSpecHistoryElsewhereHint({ ...base, addressedFleet: true })).toBeUndefined();
  });

  it('stays silent when the cup has its OWN spec — an empty window is unambiguous', () => {
    expect(claimSpecHistoryElsewhereHint({ ...base, source: 'cup' })).toBeUndefined();
  });

  it('stays silent on a default record with no fleet to point at', () => {
    expect(
      claimSpecHistoryElsewhereHint({ ...base, source: 'default', fleetSlug: undefined }),
    ).toBeUndefined();
  });
});
