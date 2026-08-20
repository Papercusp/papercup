/**
 * bespoke-active-seeds-check — EI-18746253391734322's recurrence guard. Fake tagged-
 * template sql (mirrors seed-hive-release-routines.test.ts); no PG.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALWAYS_ON_SYSTEM_ROUTINE_NAMES,
  BESPOKE_ACTIVE_SEEDS,
  checkBespokeActiveSeeds,
  isAlwaysOnSystemRoutine,
  isReaffirmed,
  type BespokeActiveSeed,
} from './bespoke-active-seeds-check';

const ENTRIES: BespokeActiveSeed[] = [
  { name: 'foo-routine', seedScript: 'seed-foo-routine.ts' },
  { name: 'bar-routine', seedScript: 'seed-bar-routine.ts' },
  { name: 'baz-routine', seedScript: 'seed-baz-routine.ts' },
];

type FakeRow = { name: string; active: boolean; metadata?: { pause?: Record<string, unknown> } | null };

function fakeSql(rows: FakeRow[]) {
  return (async () => rows) as unknown as Parameters<typeof checkBespokeActiveSeeds>[0]['sql'];
}

function routedFakeSql(rowsByInstallSlug: Record<string, FakeRow[]>, calls: Array<{ installSlug: string; names: string[] }>) {
  return (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ installSlug: String(values[0]), names: (values[2] as string[]) ?? [] });
    return rowsByInstallSlug[String(values[0])] ?? [];
  }) as unknown as Parameters<typeof checkBespokeActiveSeeds>[0]['sql'];
}

const NOW = Date.parse('2026-08-08T20:00:00Z');
const paused = (name: string, pause: Record<string, unknown> | null): FakeRow => ({
  name,
  active: false,
  metadata: pause ? { pause } : null,
});

const ROUTINES_DIR = dirname(fileURLToPath(import.meta.url));
const ACTIVE_BY_DEFAULT = /const\s+active\s*=\s*!process\.argv\.includes\(['"]--inactive['"]\);/;
const INACTIVE_BY_DEFAULT = /const\s+active\s*=\s*process\.argv\.includes\(['"]--active['"]\);/;

function seedSources(): Array<{ file: string; source: string }> {
  return readdirSync(ROUTINES_DIR)
    .filter((file) => /^seed-.*-routine\.ts$/.test(file))
    .sort()
    .map((file) => ({ file, source: readFileSync(resolve(ROUTINES_DIR, file), 'utf8') }));
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

  it('queries each seed in the install scope its writer actually targets', async () => {
    const calls: Array<{ installSlug: string; names: string[] }> = [];
    const res = await checkBespokeActiveSeeds({
      sql: routedFakeSql(
        {
          papercusp: [{ name: 'home-routine', active: true }],
          'hive-canary': [
            { name: 'hive-canary', active: true },
            { name: 'hive-canary-sla', active: true },
          ],
        },
        calls,
      ),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: [
        { name: 'home-routine', seedScript: 'seed-home-routine.ts' },
        { name: 'hive-canary', seedScript: 'seed-hive-canary-routine.ts', scope: 'hive-canary' },
        { name: 'hive-canary-sla', seedScript: 'seed-hive-canary-sla-routine.ts', scope: 'hive-canary' },
      ],
    });

    expect(calls).toEqual([
      { installSlug: 'papercusp', names: ['home-routine'] },
      { installSlug: 'hive-canary', names: ['hive-canary', 'hive-canary-sla'] },
    ]);
    expect(res.ok).toBe(true);
    expect(res.missing).toEqual([]);
    expect(res.inactive).toEqual([]);
  });
});

/**
 * D-007 (silent-halt-detection-and-owner-rails-2026-08-08): `escalatable` is the owner-rail
 * question, split from `ok` so a deliberate, DATED pause can be held without silencing a
 * forgotten one. The measured failure these pin: `unguarded-halt-rescue` paused 2026-07-27,
 * dark 11.9 days, no notice — because every age-based mechanism downstream eventually
 * reclassified it as decommissioned rather than asking whether it was SUPPOSED to be running.
 */
describe('escalatable — which pauses actually warrant waking a human', () => {
  it('a pause with a FUTURE reviewBy is re-affirmed: still inactive, but does NOT escalate', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
        paused('baz-routine', { reason: 'deliberate hold for migration 812', reviewBy: '2026-09-01T00:00:00Z' }),
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
      now: NOW,
    });
    expect(res.ok).toBe(false); // the strict steady-state assertion still fails — the CLI wants that
    expect(res.inactive.map((e) => e.name)).toEqual(['baz-routine']);
    expect(res.inactive[0]?.reviewBy).toBe('2026-09-01T00:00:00Z');
    expect(res.escalatable).toEqual([]); // …but nobody gets paged
  });

  it('a pause whose reviewBy has EXPIRED escalates again — the re-affirmation is dated, not permanent', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
        paused('baz-routine', { reason: 'hold', reviewBy: '2026-08-01T00:00:00Z' }),
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
      now: NOW,
    });
    expect(res.escalatable.map((e) => e.name)).toEqual(['baz-routine']);
  });

  it('a pause with a reason but NO reviewBy escalates — this is the unguarded-halt-rescue shape', async () => {
    // The real row: reason "Paused via the Agents pane", no reviewBy. A populated-but-content-free
    // reason reads as more deliberate than an empty one (D-006), so presence of a reason must not
    // buy silence — only a dated re-affirmation does.
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
        paused('baz-routine', {
          reason: 'Paused via the Agents pane',
          pausedBy: 'loopback',
          pausedAtMs: 1785191563941,
        }),
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
      now: NOW,
    });
    expect(res.escalatable.map((e) => e.name)).toEqual(['baz-routine']);
    expect(res.inactive[0]?.pauseReason).toBe('Paused via the Agents pane');
    expect(res.inactive[0]?.pausedAtMs).toBe(1785191563941);
  });

  it('a pause with NO metadata at all reports pauseReason null — the unaudited-path fingerprint', async () => {
    // EI-18137248342636257 found active=false written with no audit_log row anywhere near it.
    // routines:set REQUIRES a reason, so a null here proves the flip bypassed the tool entirely.
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
        paused('baz-routine', null),
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
      now: NOW,
    });
    expect(res.inactive[0]?.pauseReason).toBeNull();
    expect(res.escalatable.map((e) => e.name)).toEqual(['baz-routine']);
  });

  it('a MISSING row always escalates — there is no row to carry a reviewBy on', async () => {
    const res = await checkBespokeActiveSeeds({
      sql: fakeSql([
        { name: 'foo-routine', active: true },
        { name: 'bar-routine', active: true },
      ]),
      installSlug: 'papercusp',
      workspaceId: 'ws',
      entries: ENTRIES,
      now: NOW,
    });
    expect(res.escalatable.map((e) => e.name)).toEqual(['baz-routine']);
  });
});

describe('isReaffirmed — fails CLOSED, so an unreadable field can never buy silence', () => {
  it('only a parseable FUTURE date re-affirms', () => {
    expect(isReaffirmed('2026-09-01T00:00:00Z', NOW)).toBe(true);
    expect(isReaffirmed('2026-08-01T00:00:00Z', NOW)).toBe(false); // past
    expect(isReaffirmed(null, NOW)).toBe(false); // absent
    expect(isReaffirmed('', NOW)).toBe(false); // empty
    expect(isReaffirmed('whenever we get to it', NOW)).toBe(false); // unparseable
    expect(isReaffirmed('not-a-date', NOW)).toBe(false);
  });

  it('CONTROL: a naive truthiness check would pass the cases above that matter', () => {
    // Calibration for the test above — if isReaffirmed were rewritten as `!!reviewBy` (the
    // obvious shortcut), the two most dangerous inputs would silently start buying silence.
    // This asserts the naive rule really is wrong on them, so the assertions above are load-
    // bearing rather than vacuously true.
    const naive = (v: string | null) => !!v;
    expect(naive('whenever we get to it')).toBe(true); // naive: silenced …
    expect(isReaffirmed('whenever we get to it', NOW)).toBe(false); // … real: escalates ✓
    expect(naive('2026-08-01T00:00:00Z')).toBe(true); // naive: silenced forever …
    expect(isReaffirmed('2026-08-01T00:00:00Z', NOW)).toBe(false); // … real: expired ✓
  });
});

describe('ALWAYS_ON_SYSTEM_ROUTINE_NAMES — derived from the registry, never hand-copied', () => {
  it('contains gc-dead-loops — the registered-without-a-row failure that motivated EI-18752496371939475', () => {
    expect(isAlwaysOnSystemRoutine('gc-dead-loops')).toBe(true);
  });

  it('contains unguarded-halt-rescue — the routine whose 11.9-day silence motivated D-007', () => {
    expect(isAlwaysOnSystemRoutine('unguarded-halt-rescue')).toBe(true);
  });

  it('stays in lockstep with BESPOKE_ACTIVE_SEEDS', () => {
    // The regression this pins is the one D-007 names: RELEASE_CRITICAL_ROUTINE_NAMES (2 names)
    // and ALWAYS_ON_LEARNING_LOOPS (3 names) are both hand-written sets, and a routine whose job
    // is noticing silence was in neither. Deriving the set means adding a seed script to the
    // registry cannot forget to also add it here.
    expect([...ALWAYS_ON_SYSTEM_ROUTINE_NAMES].sort()).toEqual(BESPOKE_ACTIVE_SEEDS.map((s) => s.name).sort());
    expect(ALWAYS_ON_SYSTEM_ROUTINE_NAMES.size).toBe(BESPOKE_ACTIVE_SEEDS.length);
  });

  it('registers every seed script whose executable writer defaults active', () => {
    const sources = seedSources();
    const activeSeedScripts = sources.filter(({ source }) => ACTIVE_BY_DEFAULT.test(source)).map(({ file }) => file);
    const registeredSeedScripts = BESPOKE_ACTIVE_SEEDS.map(({ seedScript }) => seedScript).sort();

    expect(
      registeredSeedScripts,
      'Every seed script whose writer defaults active must be covered by the live missing/inactive-row guard. ' +
        'Add the script and its routine row name to BESPOKE_ACTIVE_SEEDS in bespoke-active-seeds-check.ts.',
    ).toEqual(activeSeedScripts);
  });

  it('makes every bespoke seed writer declare active or inactive as its executable default', () => {
    const unclassified = seedSources()
      .filter(({ source }) => !ACTIVE_BY_DEFAULT.test(source) && !INACTIVE_BY_DEFAULT.test(source))
      .map(({ file }) => file);

    expect(
      unclassified,
      "A bespoke seed must use one explicit default: `!process.argv.includes('--inactive')` for always-on, " +
        "or `process.argv.includes('--active')` for human-gated. This is the source of truth for the live guard.",
    ).toEqual([]);
  });

  it('does not claim a routine that is NOT always-on', () => {
    expect(isAlwaysOnSystemRoutine('green-checkpoint')).toBe(false);
    expect(isAlwaysOnSystemRoutine('some-human-gated-bringup')).toBe(false);
  });
});
