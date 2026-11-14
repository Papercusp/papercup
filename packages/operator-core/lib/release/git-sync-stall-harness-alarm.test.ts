/**
 * WI-6554700010048637 — the git-sync stall alarm is ONE per harness, not one per install.
 *
 * A superproject freeze stalls every submodule install at once. Before this change each install
 * paged and broadcast under its own `git-sync-stall:<install>` key, so one stall reached the
 * condition bridge as N conditions. These tests drive the claim/release helpers the watchdog
 * calls against an in-memory routines table, and pin the catalog entry that turns the
 * per-harness broadcast into exactly one incident.
 */
import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import {
  claimGitSyncStallAlarm,
  releaseGitSyncStallAlarm,
  gitSyncStallRecoveryKeys,
} from './git-sync-stall-watchdog';
import { gitSyncStallConditionKey } from './pipeline-stall-incidents';
import { isActionableConditionKey, isLifecycleOwnedBySource } from '../coord/actionable-conditions';
import { resolveConditionHarness } from '../coord/condition-bridge';

interface RoutineRow { alerted: boolean; active: boolean }

/**
 * A fake `sql` that understands exactly the four statements the helpers issue. Any other
 * statement throws, so a helper that starts issuing a new query fails here instead of
 * silently reading an empty result.
 */
function fakeRoutines(rows: Record<string, RoutineRow>): { sql: Sql; lockKeys: string[] } {
  const lockKeys: string[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('pg_advisory_xact_lock')) {
      lockKeys.push(String(values[0]));
      return [];
    }
    if (text.includes('"watchdog_alerted":true')) {
      const row = rows[String(values[0])];
      if (!row || row.alerted) return Object.assign([], { count: 0 });
      row.alerted = true;
      return Object.assign([], { count: 1 });
    }
    if (text.includes('"watchdog_alerted":false')) {
      const row = rows[String(values[0])];
      if (!row) return Object.assign([], { count: 0 });
      row.alerted = false;
      return Object.assign([], { count: 1 });
    }
    if (text.includes('split_part(install_slug')) {
      const [harness, self] = values.map(String);
      return Object.entries(rows)
        .filter(([slug, r]) => slug.split('/')[0] === harness && slug !== self && r.active && r.alerted)
        .slice(0, 1)
        .map(() => ({ '?column?': 1 }));
    }
    throw new Error(`unexpected statement: ${text}`);
  };
  const sql = Object.assign(tag, {
    begin: async (run: (tx: typeof tag) => Promise<unknown>) => run(tag),
  });
  return { sql: sql as unknown as Sql, lockKeys };
}

const installs = (...slugs: string[]): Record<string, RoutineRow> =>
  Object.fromEntries(slugs.map((s) => [s, { alerted: false, active: true }]));

describe('claimGitSyncStallAlarm — one page per harness', () => {
  it('N stalled installs of one harness: every install flips, exactly ONE pages', async () => {
    const rows = installs('papercusp', 'papercusp/libs/generic/search', 'papercusp/libs/papercusp', 'papercusp/apps/x');
    const { sql } = fakeRoutines(rows);
    const claims = [];
    for (const slug of Object.keys(rows)) claims.push(await claimGitSyncStallAlarm(sql, slug));
    expect(claims.every((c) => c.flipped)).toBe(true);
    expect(claims.filter((c) => c.firstForHarness)).toHaveLength(1);
    expect(Object.values(rows).every((r) => r.alerted)).toBe(true);
  });

  it('the first claim pages whichever install of the harness is swept first', async () => {
    const rows = installs('papercusp', 'papercusp/libs/generic/search');
    const { sql } = fakeRoutines(rows);
    expect(await claimGitSyncStallAlarm(sql, 'papercusp/libs/generic/search')).toEqual({ flipped: true, firstForHarness: true });
    expect(await claimGitSyncStallAlarm(sql, 'papercusp')).toEqual({ flipped: true, firstForHarness: false });
  });

  it('an install already alerted does not flip again (one-shot until recovery)', async () => {
    const rows = installs('papercusp');
    const { sql } = fakeRoutines(rows);
    await claimGitSyncStallAlarm(sql, 'papercusp');
    expect(await claimGitSyncStallAlarm(sql, 'papercusp')).toEqual({ flipped: false, firstForHarness: false });
  });

  it('a different harness pages on its own', async () => {
    const rows = installs('papercusp', 'papercusp/libs/papercusp', 'portal');
    const { sql } = fakeRoutines(rows);
    await claimGitSyncStallAlarm(sql, 'papercusp');
    await claimGitSyncStallAlarm(sql, 'papercusp/libs/papercusp');
    expect((await claimGitSyncStallAlarm(sql, 'portal')).firstForHarness).toBe(true);
  });

  it('a harness-name prefix is not a sibling (papercusp vs papercusp-desktop)', async () => {
    const rows = installs('papercusp', 'papercusp-desktop');
    const { sql } = fakeRoutines(rows);
    await claimGitSyncStallAlarm(sql, 'papercusp');
    expect((await claimGitSyncStallAlarm(sql, 'papercusp-desktop')).firstForHarness).toBe(true);
  });

  it('an INACTIVE install with a stale alerted flag never suppresses the page', async () => {
    const rows: Record<string, RoutineRow> = {
      papercusp: { alerted: false, active: true },
      'papercusp/libs/retired': { alerted: true, active: false },
    };
    const { sql } = fakeRoutines(rows);
    expect((await claimGitSyncStallAlarm(sql, 'papercusp')).firstForHarness).toBe(true);
  });

  it('serializes on the HARNESS key, so two hosts sweeping sibling installs take the same lock', async () => {
    const rows = installs('papercusp', 'papercusp/libs/papercusp');
    const { sql, lockKeys } = fakeRoutines(rows);
    await claimGitSyncStallAlarm(sql, 'papercusp');
    await claimGitSyncStallAlarm(sql, 'papercusp/libs/papercusp');
    expect(lockKeys).toEqual(['git-sync-stall:papercusp', 'git-sync-stall:papercusp']);
  });
});

describe('releaseGitSyncStallAlarm — the harness resolves only when every install has recovered', () => {
  it('harnessClear only on the LAST install of the harness to recover', async () => {
    const rows = installs('papercusp', 'papercusp/libs/generic/search', 'papercusp/libs/papercusp');
    const { sql } = fakeRoutines(rows);
    for (const slug of Object.keys(rows)) await claimGitSyncStallAlarm(sql, slug);
    expect(await releaseGitSyncStallAlarm(sql, 'papercusp/libs/generic/search')).toEqual({ harnessClear: false });
    expect(await releaseGitSyncStallAlarm(sql, 'papercusp')).toEqual({ harnessClear: false });
    expect(await releaseGitSyncStallAlarm(sql, 'papercusp/libs/papercusp')).toEqual({ harnessClear: true });
    expect(Object.values(rows).every((r) => !r.alerted)).toBe(true);
  });

  it('after a full recovery the next stall pages again', async () => {
    const rows = installs('papercusp', 'papercusp/libs/papercusp');
    const { sql } = fakeRoutines(rows);
    await claimGitSyncStallAlarm(sql, 'papercusp');
    await releaseGitSyncStallAlarm(sql, 'papercusp');
    expect((await claimGitSyncStallAlarm(sql, 'papercusp/libs/papercusp')).firstForHarness).toBe(true);
  });
});

describe('gitSyncStallRecoveryKeys', () => {
  it('a top-level install resolves the harness key only once the harness is clear', () => {
    expect(gitSyncStallRecoveryKeys('papercusp', false)).toEqual([]);
    expect(gitSyncStallRecoveryKeys('papercusp', true)).toEqual(['git-sync-stall:papercusp']);
  });

  it('a submodule install always resolves its legacy per-install key, and the harness key when clear', () => {
    expect(gitSyncStallRecoveryKeys('papercusp/libs/papercusp', false)).toEqual(['git-sync-stall:papercusp/libs/papercusp']);
    expect(gitSyncStallRecoveryKeys('papercusp/libs/papercusp', true)).toEqual([
      'git-sync-stall:papercusp/libs/papercusp',
      'git-sync-stall:papercusp',
    ]);
  });
});

describe('condition bridge: the per-harness alarm mints one incident under the right harness', () => {
  it('git-sync-stall:<harness> is actionable and resolves to that harness', () => {
    const key = gitSyncStallConditionKey('papercusp/libs/generic/search');
    expect(key).toBe('git-sync-stall:papercusp');
    expect(isActionableConditionKey(key)).toBe(true);
    expect(resolveConditionHarness(key)).toBe('papercusp');
  });

  it('every install of one harness yields the SAME condition key, so the bridge coalesces them', () => {
    const keys = new Set(['papercusp', 'papercusp/libs/papercusp', 'papercusp/apps/x'].map(gitSyncStallConditionKey));
    expect(keys.size).toBe(1);
  });

  it('a legacy per-install submodule key never mints under a "<harness>/<path>" harness', () => {
    expect(resolveConditionHarness('git-sync-stall:papercusp/libs/papercusp')).toBeNull();
  });

  it('its lifecycle is owned by the recomputing watchdog, not by the emitting process', () => {
    expect(isLifecycleOwnedBySource('git-sync-stall:papercusp')).toBe(true);
  });
});
