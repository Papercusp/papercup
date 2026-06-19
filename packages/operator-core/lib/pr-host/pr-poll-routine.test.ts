/**
 * pr-poll-routine tests (PR-1 / P-042). The routine CRUD wraps db-org's primitives
 * (mocked), so these focus on the pure pieces: the jittered 60s cron, remote
 * normalization, and that the seed/upsert pass the right shape through.
 */
import { describe, it, expect, vi } from 'vitest';

const upsertRoutine = vi.fn(async (_sql: unknown, input: unknown) => ({ input }));
const setRoutineActive = vi.fn(async () => true);
const deleteRoutine = vi.fn(async () => true);

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: Object.assign(() => Promise.resolve([]), { unsafe: vi.fn() }) }),
  upsertRoutine: (...a: unknown[]) => upsertRoutine(a[0], a[1]),
  setRoutineActive: (...a: unknown[]) => setRoutineActive(...(a as [])),
  deleteRoutine: (...a: unknown[]) => deleteRoutine(...(a as [])),
}));

import {
  PR_POLL_ROUTINE_NAME,
  PR_POLL_TARGET,
  prPollCronForKey,
  normalizeRemote,
  upsertPrPollRoutine,
  seedPrPollRoutineForHarness,
} from './pr-poll-routine';

describe('constants', () => {
  it('targets system:pr-poll', () => {
    expect(PR_POLL_TARGET).toBe('system:pr-poll');
    expect(PR_POLL_ROUTINE_NAME).toBe('pr-poll');
  });
});

describe('prPollCronForKey', () => {
  it('is a 6-field per-minute crontab at a 0..59 second offset', () => {
    const cron = prPollCronForKey('papercup');
    const fields = cron.split(' ');
    expect(fields).toHaveLength(6);
    const sec = Number(fields[0]);
    expect(Number.isInteger(sec)).toBe(true);
    expect(sec).toBeGreaterThanOrEqual(0);
    expect(sec).toBeLessThan(60);
    expect(fields.slice(1)).toEqual(['*', '*', '*', '*', '*']); // every minute
  });
  it('is deterministic per slug', () => {
    expect(prPollCronForKey('papercup')).toBe(prPollCronForKey('papercup'));
  });
  it('spreads different slugs across seconds (jitter)', () => {
    const a = prPollCronForKey('alpha');
    const b = prPollCronForKey('bravo-harness');
    // Not a hard guarantee, but these two distinct slugs must land on different seconds.
    expect(a).not.toBe(b);
  });
});

describe('normalizeRemote', () => {
  it('normalizes an HTTPS clone URL', () => {
    expect(normalizeRemote('https://github.com/owner/repo.git')).toBe('github.com/owner/repo');
    expect(normalizeRemote('https://github.com/owner/repo')).toBe('github.com/owner/repo');
  });
  it('normalizes an SSH remote', () => {
    expect(normalizeRemote('git@github.com:owner/repo.git')).toBe('github.com/owner/repo');
  });
  it('normalizes the bare completion_ref form (no protocol)', () => {
    expect(normalizeRemote('github.com/owner/repo')).toBe('github.com/owner/repo');
  });
  it('returns null for non-GitHub / empty', () => {
    expect(normalizeRemote('')).toBeNull();
    expect(normalizeRemote(null)).toBeNull();
    expect(normalizeRemote(undefined)).toBeNull();
    expect(normalizeRemote('https://gitlab.com/owner/repo')).toBeNull();
  });
});

describe('upsertPrPollRoutine', () => {
  it('passes the pr-poll shape (target, cron, remote in trigger_config) to upsertRoutine', async () => {
    upsertRoutine.mockClear();
    await upsertPrPollRoutine({} as never, {
      workspaceId: 'ws1',
      installSlug: 'papercup',
      remote: 'github.com/owner/repo',
      active: true,
    });
    expect(upsertRoutine).toHaveBeenCalledTimes(1);
    const input = upsertRoutine.mock.calls[0][1] as {
      name: string;
      targetRole: string;
      triggerKind: string;
      active: boolean;
      triggerConfig: { remote: string; cron: string };
    };
    expect(input.name).toBe('pr-poll');
    expect(input.targetRole).toBe('system:pr-poll');
    expect(input.triggerKind).toBe('cron');
    expect(input.active).toBe(true);
    expect(input.triggerConfig.remote).toBe('github.com/owner/repo');
    expect(input.triggerConfig.cron).toBe(prPollCronForKey('papercup'));
  });
});

describe('seedPrPollRoutineForHarness', () => {
  it('resolves the remote, normalizes it, and seeds active', async () => {
    upsertRoutine.mockClear();
    const out = await seedPrPollRoutineForHarness(
      { workspaceId: 'ws1', installSlug: 'papercup' },
      {
        sql: {} as never,
        resolveRemote: async () => 'https://github.com/owner/repo.git',
        upsert: upsertPrPollRoutine,
      },
    );
    expect(out).toMatchObject({ seeded: true, active: true, remote: 'github.com/owner/repo' });
    expect(upsertRoutine).toHaveBeenCalledTimes(1);
  });

  it('reports no_remote when nothing resolves (registered from a local path)', async () => {
    const out = await seedPrPollRoutineForHarness(
      { workspaceId: 'ws1', installSlug: 'localonly' },
      { sql: {} as never, resolveRemote: async () => null },
    );
    expect(out).toEqual({ seeded: false, reason: 'no_remote' });
  });

  it('never throws — folds a failure into an error outcome', async () => {
    const out = await seedPrPollRoutineForHarness(
      { workspaceId: 'ws1', installSlug: 'papercup', remote: 'github.com/owner/repo' },
      {
        sql: {} as never,
        upsert: (async () => {
          throw new Error('PG down');
        }) as never,
      },
    );
    expect(out).toEqual({ seeded: false, reason: 'error', message: 'PG down' });
  });
});
