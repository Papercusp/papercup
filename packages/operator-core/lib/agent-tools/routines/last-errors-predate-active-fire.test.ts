/**
 * EI-28696436611358092 — `last_errors` on a git-sync routine row is replaced only by a
 * COMPLETED outcome, so during a long in-flight fire it still carries the PREVIOUS fire's
 * failure (measured: a timeout string read as current beside a progressing pass). The
 * writers now stamp `last_errors_at` beside every `last_errors`, and `routines:list`
 * derives `last_errors_predate_active_fire` from it. These tests pin both halves of the
 * reader: the tri-state derivation (null = unmeasured, never "current") and that the
 * health projection actually carries the new keys.
 */
import { describe, it, expect } from 'vitest';
import { healthOf, lastErrorsPredateActiveFire } from './list';

const ERR = ['git-sync action timeout (idle) during read-content-guard-flag'];

describe('lastErrorsPredateActiveFire', () => {
  it('is true when the active fire started after last_errors was written', () => {
    expect(
      lastErrorsPredateActiveFire({
        last_errors: ERR,
        last_errors_at: 1_000,
        git_sync_activity: { active: true, started_at: 2_000 },
      }),
    ).toBe(true);
  });

  it('is false when last_errors was written at or after the active fire started', () => {
    expect(
      lastErrorsPredateActiveFire({
        last_errors: ERR,
        last_errors_at: 2_000,
        git_sync_activity: { active: true, started_at: 2_000 },
      }),
    ).toBe(false);
    expect(
      lastErrorsPredateActiveFire({
        last_errors: ERR,
        last_errors_at: 3_000,
        git_sync_activity: { active: true, started_at: 2_000 },
      }),
    ).toBe(false);
  });

  it('is null (unmeasured) for a legacy row with no last_errors_at', () => {
    expect(
      lastErrorsPredateActiveFire({
        last_errors: ERR,
        git_sync_activity: { active: true, started_at: 2_000 },
      }),
    ).toBeNull();
  });

  it('is null when no fire is active (nothing to be stale relative to)', () => {
    expect(
      lastErrorsPredateActiveFire({
        last_errors: ERR,
        last_errors_at: 1_000,
        git_sync_activity: { active: false, phase: 'complete', started_at: 2_000 },
      }),
    ).toBeNull();
    expect(lastErrorsPredateActiveFire({ last_errors: ERR, last_errors_at: 1_000 })).toBeNull();
  });

  it('is null when there are no errors, or the timestamps are not numbers', () => {
    expect(
      lastErrorsPredateActiveFire({
        last_errors: [],
        last_errors_at: 1_000,
        git_sync_activity: { active: true, started_at: 2_000 },
      }),
    ).toBeNull();
    expect(
      lastErrorsPredateActiveFire({
        last_errors: ERR,
        last_errors_at: '1970-01-01T00:00:01Z',
        git_sync_activity: { active: true, started_at: 2_000 },
      }),
    ).toBeNull();
    expect(
      lastErrorsPredateActiveFire({
        last_errors: ERR,
        last_errors_at: 1_000,
        git_sync_activity: { active: true, started_at: null },
      }),
    ).toBeNull();
  });
});

describe('routines:list health projection (EI-28696436611358092)', () => {
  it('projects last_errors_at, last_timeout and the derived staleness flag', () => {
    const lastTimeout = {
      at: 1_000,
      kind: 'idle',
      phase: 'read-content-guard-flag',
      timeout_ms: 300_000,
      fire_started_at: 500,
      owner: 'papercup',
      owner_pid: 4242,
      workflow_id: 'wf-1',
    };
    const health = healthOf({
      last_errors: ERR,
      last_errors_at: 1_000,
      last_timeout: lastTimeout,
      git_sync_activity: { active: true, phase: 'local-sync', started_at: 2_000 },
    });
    expect(health).not.toBeNull();
    expect(health!.last_errors_at).toBe(1_000);
    expect(health!.last_timeout).toEqual(lastTimeout);
    expect(health!.last_errors_predate_active_fire).toBe(true);
  });

  it('omits the derived flag when it is unmeasured rather than defaulting it', () => {
    const health = healthOf({
      last_errors: ERR,
      git_sync_activity: { active: true, started_at: 2_000 },
    });
    expect(health).not.toBeNull();
    expect('last_errors_predate_active_fire' in health!).toBe(false);
  });
});
