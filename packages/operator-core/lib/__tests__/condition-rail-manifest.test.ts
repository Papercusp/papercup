import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestProblems } from '../../../../scripts/lib/condition-rail-inventory.mjs';
import { runInventory } from '../../../../scripts/condition-rail-inventory.mjs';
import { RAIL_MIGRATION_COMPLETE_ITEMS } from '../degradation/rail-migration-cases';

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../docs/evidence/condition-rail-inventory-seed-2026-10-11.json', import.meta.url)), 'utf8'));

describe('condition-rail immutable audit manifest (P-017)', () => {
  it('pins the original row set and retains reasoned dispositions and routes', () => {
    const pinnedHash = 'a2fdb5475a100101ea8dafb6019d75045cb38e53ef1a5e4870c6670d5abb77e4';
    expect(createHash('sha256').update(JSON.stringify(manifest.rows)).digest('hex')).toBe(pinnedHash);
    expect(manifest.rowsSha256).toBe(pinnedHash);
    expect(manifest.rows).toHaveLength(307);
    expect(manifest.rows.filter((row: { disposition: string }) => row.disposition === 'migrate')).toHaveLength(243);
    expect(manifest.rows.filter((row: { disposition: string }) => row.disposition === 'not-applicable')).toHaveLength(64);
    expect(manifestProblems(manifest, runInventory(), { completedItems: RAIL_MIGRATION_COMPLETE_ITEMS })).toEqual([]);
  }, 120_000);

  const row = { id: 'owner-only-alarm|x.ts|check|1', disposition: 'migrate', item: 'P-007', route: 'condition' };
  const fixture = { rows: [row], amendments: [] };
  const live = { sites: [{ id: row.id, onRail: false }], rows: [{ id: row.id, disposition: { disposition: 'migrate', item: 'P-007' } }] };

  it('fails deletion, unreviewed relabelling, and an unfinished completed migration', () => {
    expect(manifestProblems(fixture, { sites: [], rows: [] }).join()).toMatch(/absent/);
    expect(manifestProblems(fixture, { ...live, rows: [{ id: row.id, disposition: { disposition: 'not-applicable', reason: 'silently waived' } }] }).join()).toMatch(/changed without amendment/);
    expect(manifestProblems(fixture, live, { completedItems: ['P-007'] }).join()).toMatch(/still bypasses/);
    expect(manifestProblems(fixture, live, { requireAllMigrated: true }).join()).toMatch(/still bypasses/);
  });

  it('requires an independent reviewed amendment and refuses amendments to unknown IDs', () => {
    const amendment = { rowId: row.id, change: { disposition: 'removed' }, reason: 'Reviewed removal of retired code', author: 'su-author', reviewerRef: 'thread-post:123' };
    expect(manifestProblems({ rows: [row], amendments: [amendment] }, { sites: [], rows: [] })).toEqual([]);
    for (const change of [{ reason: '' }, { reviewerRef: '' }, { reviewerRef: 'su-author' }, { rowId: 'unknown' }]) {
      expect(manifestProblems({ rows: [row], amendments: [{ ...amendment, ...change }] }, live).length).toBeGreaterThan(0);
    }
  });
});
