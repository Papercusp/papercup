/**
 * WI-6680 D3 (option (b)) — unit tests for `ensureWorkIntakeRoutineInactive`,
 * the packaged-host seed path.
 *
 * The load-bearing behavior here is the EXISTS CHECK, and it is not incidental:
 * `upsertRoutine` does `ON CONFLICT DO UPDATE SET active = EXCLUDED.active,
 * trigger_config = EXCLUDED.trigger_config`, and this function is called from a
 * BOOT hook that runs on every start. Without the check, every reboot of a
 * packaged host would silently re-disable a routine the owner had activated and
 * wipe any `sourceRepoPath` they had supplied. These tests pin that down.
 *
 * `sql` is injected (the function takes it as a parameter), so no real PG is
 * needed — mirrors the injected-fake-sql pattern in telemetry-retention-action.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsertRoutineMock = vi.fn(async () => ({ id: 'rt_papercusp_p2p_work_intake' }));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: {} }),
  upsertRoutine: (...args: unknown[]) => upsertRoutineMock(...(args as [])),
}));
vi.mock('./system-actions', () => ({
  registerSystemAction: () => undefined,
}));
vi.mock('./cron', () => ({
  computeNextFireAt: () => new Date('2026-08-01T00:00:00Z'),
}));
vi.mock('../../p2p/work-intake-tick', () => ({
  runWorkIntakeTick: vi.fn(),
}));

import {
  ensureWorkIntakeRoutineInactive,
  WORK_INTAKE_ROUTINE_NAME,
  type PartialWorkIntakeHostIdentity,
} from './work-intake-action';

/** Minimal postgres.js tagged-template stand-in returning a canned row set. */
function fakeSql(rows: Array<Record<string, unknown>>) {
  const fn = vi.fn(async () => rows);
  return fn as unknown as Parameters<typeof ensureWorkIntakeRoutineInactive>[1];
}

const HOST: PartialWorkIntakeHostIdentity = {
  hostRef: 'fake-machine',
  responderGithubUserId: 42,
  responderDevicePubkey: 'PUBKEY==',
  executorDevice: 'PUBKEY==',
  foreignWorkRoot: '/papercusp/p2p/foreign-work',
  workspaceRoot: '/host/trees',
};

const REASON = 'no registered project dir — needs the containment tier before activation';

describe('ensureWorkIntakeRoutineInactive (WI-6680 D3)', () => {
  beforeEach(() => {
    upsertRoutineMock.mockClear().mockResolvedValue({ id: 'rt_papercusp_p2p_work_intake' });
  });

  it('seeds the routine INACTIVE when no row exists yet', async () => {
    const row = await ensureWorkIntakeRoutineInactive(
      { workspaceId: 'ws-1', installSlug: 'papercusp', host: HOST, inactiveReason: REASON },
      fakeSql([]),
    );

    expect(row).not.toBeNull();
    expect(upsertRoutineMock).toHaveBeenCalledTimes(1);
    const input = (upsertRoutineMock.mock.calls[0] as unknown[])[1] as {
      active: boolean;
      name: string;
      triggerConfig: Record<string, unknown>;
    };
    // The whole point: it must land OFF.
    expect(input.active).toBe(false);
    expect(input.name).toBe(WORK_INTAKE_ROUTINE_NAME);
    // The off state carries its own explanation, so it reads as a decision
    // rather than a broken routine.
    expect(input.triggerConfig.inactiveReason).toBe(REASON);
    // The identity that DOES resolve is carried through...
    expect(input.triggerConfig).toMatchObject({
      hostRef: 'fake-machine',
      responderGithubUserId: 42,
      executorDevice: 'PUBKEY==',
      foreignWorkRoot: '/papercusp/p2p/foreign-work',
    });
    // ...and the two fields a packaged host cannot resolve are never invented.
    expect(input.triggerConfig.sourceRepoPath).toBeUndefined();
    expect(input.triggerConfig.canonicalTree).toBeUndefined();
  });

  it('leaves an EXISTING row completely untouched (never re-disables an activated routine)', async () => {
    const row = await ensureWorkIntakeRoutineInactive(
      { workspaceId: 'ws-1', installSlug: 'papercusp', host: HOST, inactiveReason: REASON },
      fakeSql([{ one: 1 }]),
    );

    expect(row).toBeNull();
    // No upsert at all — this is what stops a boot hook from clobbering an
    // owner's activation and their supplied sourceRepoPath on every restart.
    expect(upsertRoutineMock).not.toHaveBeenCalled();
  });
});
