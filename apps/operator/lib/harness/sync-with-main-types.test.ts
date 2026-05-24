import { describe, expect, it } from 'vitest';
import {
  AUTO_REBASE_ON_PUSH_DEFAULT,
  ESCALATION_KIND_REBASE_CONFLICT,
  MANUAL_CONFLICT_ACTIONS,
  REBASE_OUTCOMES,
  SYNC_POLL_ERROR_MAX,
  SYNC_POLL_INTERVAL_MS,
  SYNC_STATUSES,
  buildRebaseConflictEscalation,
  composeStashBranchRef,
  isRebaseConflictEscalation,
  isStatusStale,
  resolveAutoRebaseOnPush,
  shouldShowBehindBadge,
  snapshotFromBehindCount,
  snapshotFromPollError,
  type SyncStatusSnapshot,
} from './sync-with-main-types';

describe('constants', () => {
  it('SYNC_STATUSES has 3 values', () => {
    expect([...SYNC_STATUSES]).toEqual(['up_to_date', 'behind', 'unknown']);
  });

  it('REBASE_OUTCOMES has 3 values', () => {
    expect([...REBASE_OUTCOMES]).toEqual(['clean', 'conflict', 'fetch_failed']);
  });

  it('SYNC_POLL_INTERVAL_MS is 60s per §16.1', () => {
    expect(SYNC_POLL_INTERVAL_MS).toBe(60 * 1000);
  });

  it('SYNC_POLL_ERROR_MAX is 200', () => {
    expect(SYNC_POLL_ERROR_MAX).toBe(200);
  });

  it('AUTO_REBASE_ON_PUSH_DEFAULT is true per §16.3', () => {
    expect(AUTO_REBASE_ON_PUSH_DEFAULT).toBe(true);
  });

  it('ESCALATION_KIND_REBASE_CONFLICT is rebase_conflict', () => {
    expect(ESCALATION_KIND_REBASE_CONFLICT).toBe('rebase_conflict');
  });

  it('MANUAL_CONFLICT_ACTIONS has 3 values', () => {
    expect([...MANUAL_CONFLICT_ACTIONS]).toEqual(['open_editor', 'mark_resolved', 'abort_rebase']);
  });
});

describe('snapshotFromBehindCount', () => {
  it('returns up_to_date when behind_count=0', () => {
    const s = snapshotFromBehindCount({
      harness_slug: 'papercup',
      github_user_id: 12345,
      behind_count: 0,
      now: 1,
    });
    expect(s.status).toBe('up_to_date');
    expect(s.behind_count).toBe(0);
  });

  it('returns behind when behind_count>0', () => {
    const s = snapshotFromBehindCount({
      harness_slug: 'papercup',
      github_user_id: 12345,
      behind_count: 3,
      now: 1,
    });
    expect(s.status).toBe('behind');
    expect(s.behind_count).toBe(3);
  });

  it('rejects negative or non-integer behind_count', () => {
    const base = { harness_slug: 'x', github_user_id: 1, now: 1 };
    expect(() => snapshotFromBehindCount({ ...base, behind_count: -1 })).toThrow(TypeError);
    expect(() => snapshotFromBehindCount({ ...base, behind_count: 1.5 })).toThrow(TypeError);
  });
});

describe('snapshotFromPollError', () => {
  it('returns unknown + truncated error_message', () => {
    const s = snapshotFromPollError({
      harness_slug: 'x',
      github_user_id: 1,
      error_message: 'a'.repeat(SYNC_POLL_ERROR_MAX + 50),
      now: 1,
    });
    expect(s.status).toBe('unknown');
    expect(s.behind_count).toBeNull();
    expect(s.poll_error?.length).toBe(SYNC_POLL_ERROR_MAX);
  });

  it('preserves short error messages', () => {
    const s = snapshotFromPollError({
      harness_slug: 'x',
      github_user_id: 1,
      error_message: 'short',
      now: 1,
    });
    expect(s.poll_error).toBe('short');
  });
});

describe('shouldShowBehindBadge', () => {
  it('true for behind > 0', () => {
    expect(
      shouldShowBehindBadge({
        harness_slug: 'x',
        github_user_id: 1,
        status: 'behind',
        behind_count: 3,
        polled_at: 1,
      }),
    ).toBe(true);
  });

  it('false for up_to_date / unknown', () => {
    expect(
      shouldShowBehindBadge({
        harness_slug: 'x',
        github_user_id: 1,
        status: 'up_to_date',
        behind_count: 0,
        polled_at: 1,
      }),
    ).toBe(false);
    expect(
      shouldShowBehindBadge({
        harness_slug: 'x',
        github_user_id: 1,
        status: 'unknown',
        behind_count: null,
        polled_at: 1,
      }),
    ).toBe(false);
  });
});

describe('isStatusStale', () => {
  const NOW = 1716_000_100_000;
  const fresh: SyncStatusSnapshot = {
    harness_slug: 'x',
    github_user_id: 1,
    status: 'up_to_date',
    behind_count: 0,
    polled_at: NOW - 1000,
  };

  it('false when polled within interval', () => {
    expect(isStatusStale(fresh, NOW)).toBe(false);
  });

  it('true when older than interval', () => {
    expect(isStatusStale({ ...fresh, polled_at: NOW - SYNC_POLL_INTERVAL_MS - 1 }, NOW)).toBe(true);
  });

  it('respects custom interval', () => {
    expect(isStatusStale(fresh, NOW, 500)).toBe(true);
  });
});

describe('composeStashBranchRef', () => {
  it('builds wip/conflict-F-<id>-<ts>', () => {
    expect(composeStashBranchRef('F-001', 1716_000_000_000)).toBe(
      'wip/conflict-F-001-1716000000000',
    );
  });

  it('strips F- prefix idempotently', () => {
    expect(composeStashBranchRef('001', 1716_000_000_000)).toBe(
      'wip/conflict-F-001-1716000000000',
    );
  });

  it('rejects empty feature_id', () => {
    expect(() => composeStashBranchRef('', 1)).toThrow(TypeError);
  });

  it('rejects non-positive ts', () => {
    expect(() => composeStashBranchRef('F-1', 0)).toThrow(TypeError);
    expect(() => composeStashBranchRef('F-1', -1)).toThrow(TypeError);
    expect(() => composeStashBranchRef('F-1', 1.5)).toThrow(TypeError);
  });
});

describe('buildRebaseConflictEscalation', () => {
  it('builds a well-formed row', () => {
    const e = buildRebaseConflictEscalation({
      harness_slug: 'papercup',
      feature_id: 'F-042',
      conflicted_files: ['src/a.ts', 'src/b.ts'],
      now: 1716_000_000_000,
    });
    expect(e.kind).toBe('rebase_conflict');
    expect(e.harness_slug).toBe('papercup');
    expect(e.feature_id).toBe('F-042');
    expect(e.conflicted_files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(e.stash_ref).toBe('wip/conflict-F-042-1716000000000');
    expect(e.emitted_at).toBe(1716_000_000_000);
  });

  it('defensive-copies conflicted_files', () => {
    const files = ['x.ts'];
    const e = buildRebaseConflictEscalation({
      harness_slug: 'h',
      feature_id: 'F-1',
      conflicted_files: files,
      now: 1,
    });
    files.push('y.ts');
    expect(e.conflicted_files).toHaveLength(1);
  });

  it('rejects empty conflicted_files', () => {
    expect(() =>
      buildRebaseConflictEscalation({
        harness_slug: 'h',
        feature_id: 'F-1',
        conflicted_files: [],
        now: 1,
      }),
    ).toThrow(TypeError);
  });

  it('rejects empty harness/feature', () => {
    expect(() =>
      buildRebaseConflictEscalation({
        harness_slug: '',
        feature_id: 'F-1',
        conflicted_files: ['x'],
        now: 1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildRebaseConflictEscalation({
        harness_slug: 'h',
        feature_id: '',
        conflicted_files: ['x'],
        now: 1,
      }),
    ).toThrow(TypeError);
  });

  it('round-trips through isRebaseConflictEscalation', () => {
    const e = buildRebaseConflictEscalation({
      harness_slug: 'h',
      feature_id: 'F-1',
      conflicted_files: ['x'],
      now: 1,
    });
    expect(isRebaseConflictEscalation(e)).toBe(true);
  });
});

describe('isRebaseConflictEscalation', () => {
  it('rejects wrong kind', () => {
    expect(
      isRebaseConflictEscalation({
        kind: 'other',
        harness_slug: 'h',
        feature_id: 'F-1',
        conflicted_files: ['x'],
        stash_ref: 'wip/conflict-F-1-1',
        emitted_at: 1,
      }),
    ).toBe(false);
  });

  it('rejects bad stash_ref prefix', () => {
    expect(
      isRebaseConflictEscalation({
        kind: 'rebase_conflict',
        harness_slug: 'h',
        feature_id: 'F-1',
        conflicted_files: ['x'],
        stash_ref: 'bad-prefix',
        emitted_at: 1,
      }),
    ).toBe(false);
  });

  it('rejects empty conflicted_files', () => {
    expect(
      isRebaseConflictEscalation({
        kind: 'rebase_conflict',
        harness_slug: 'h',
        feature_id: 'F-1',
        conflicted_files: [],
        stash_ref: 'wip/conflict-F-1-1',
        emitted_at: 1,
      }),
    ).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isRebaseConflictEscalation(null)).toBe(false);
    expect(isRebaseConflictEscalation('x')).toBe(false);
  });
});

describe('resolveAutoRebaseOnPush', () => {
  it('returns default (true) when setting null', () => {
    expect(resolveAutoRebaseOnPush(null)).toBe(true);
  });

  it('returns default when field absent', () => {
    expect(resolveAutoRebaseOnPush({})).toBe(true);
  });

  it('returns default when field not boolean', () => {
    expect(resolveAutoRebaseOnPush({ auto_rebase_on_push: 'yes' as unknown as boolean })).toBe(true);
  });

  it('returns explicit false when set', () => {
    expect(resolveAutoRebaseOnPush({ auto_rebase_on_push: false })).toBe(false);
  });

  it('returns explicit true when set', () => {
    expect(resolveAutoRebaseOnPush({ auto_rebase_on_push: true })).toBe(true);
  });
});
