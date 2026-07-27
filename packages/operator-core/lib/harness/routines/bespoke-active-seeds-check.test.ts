/**
 * bespoke-active-seeds-check — EI-18746253391734322's recurrence guard. Fake tagged-
 * template sql (mirrors seed-hive-release-routines.test.ts); no PG.
 */
import { describe, expect, it } from 'vitest';
import { checkBespokeActiveSeeds, type BespokeActiveSeed } from './bespoke-active-seeds-check';

const ENTRIES: BespokeActiveSeed[] = [
  { name: 'foo-routine', seedScript: 'seed-foo-routine.ts' },
  { name: 'bar-routine', seedScript: 'seed-bar-routine.ts' },
  { name: 'baz-routine', seedScript: 'seed-baz-routine.ts' },
];

function fakeSql(rows: { name: string; active: boolean }[]) {
  return (async () => rows) as unknown as Parameters<typeof checkBespokeActiveSeeds>[0]['sql'];
}

describe('checkBespokeActiveSeeds', () => {
  it('all present + active → ok, nothing missing or inactive', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
        { name: 'baz-routine', active: true },
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
    });
    expect(res.ok).toBe(true);
    expect(res.missing).toEqual([]);
    expect(res.inactive).toEqual([]);
  });

  it('a routine with no row at all is reported MISSING (the EI-18746253391734322 case)', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
        // baz-routine: no row — never seeded.
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
    });
    expect(res.ok).toBe(false);
    expect(res.missing.map((e) => e.name)).toEqual(['baz-routine']);
    expect(res.inactive).toEqual([]);
  });

  it('a routine seeded but active=false is reported INACTIVE, not missing', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: false },
        { name: 'baz-routine', active: true },
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
    });
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual([]);
    expect(res.inactive.map((e) => e.name)).toEqual(['bar-routine']);
  });

  it('reports BOTH missing and inactive together when the DB has a mix', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([{ name: 'foo-routine', active: false }]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
    });
    expect(res.ok).toBe(false);
    expect(res.inactive.map((e) => e.name)).toEqual(['foo-routine']);
    expect(res.missing.map((e) => e.name).sort()).toEqual(['bar-routine', 'baz-routine']);
  });

  it('defaults to the real BESPOKE_ACTIVE_SEEDS registry when entries is omitted', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([]), // nothing seeded
      installSlug: 'papercusp',
      workspaceId: 'ws',
    });
    // Every real registered routine name should show up as missing against an empty DB.
    expect(res.missing.length).toBeGreaterThanOrEqual(6);
    expect(res.missing.map((e) => e.name)).toContain('supervision-reconcile');
  });
});
