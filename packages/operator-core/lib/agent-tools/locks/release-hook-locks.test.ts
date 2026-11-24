/**
 * Recurrence guard for EI-21878494442396728 — a carry-respawn must not strand the
 * automatic `PreToolUse:*` edit locks it took, because git-sync then silently skips
 * exactly the files the agent just wrote.
 *
 * Two independent things can regress, so both are asserted:
 *
 *  1. CLASSIFICATION — hook locks are released, deliberate acquires are not. Getting
 *     this backwards in either direction is a real defect: release too little and the
 *     original starvation returns; release too much and a multi-file change the agent
 *     was told to hold across a commit is dropped mid-flight.
 *  2. WIRING — the release is actually CALLED at the carry-respawn point. The pure
 *     function can stay perfect while the call site is deleted or moved, and that
 *     regression is invisible to any test of the function alone. This is the "pin"
 *     rung of the derived-truth ladder, the same technique ./hook-intent-label.ts uses
 *     to pin a cross-process contract that nothing else links.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ActiveLockRow } from './su-lock-store';
import { HOOK_LOCK_INTENT_PREFIX, isHookLockIntent, partitionHookLocks } from './release-hook-locks';

const OWNER = 'su-062dd71e-fd88-4a36-a90d-3ba5963c9bb4';
const OTHER = 'su-93714fb3-0004-410c-8b4c-0933527741e4';

function row(over: Partial<ActiveLockRow>): ActiveLockRow {
  return {
    lock_id: 'lock-1',
    path: 'packages/operator-core/lib/x.ts',
    owner: OWNER,
    owner_label: null,
    intent: `${HOOK_LOCK_INTENT_PREFIX}Edit`,
    goal_ref: null,
    acquired_ts: new Date('2026-08-30T11:29:13Z'),
    expires_ts: new Date('2026-08-30T11:49:13Z'),
    coordination_domain: '/home/dev/papercupai-workspace/papercup',
    ...over,
  };
}

describe('isHookLockIntent', () => {
  it('recognizes every intent the edit hook actually sends', () => {
    // The hook interpolates the tool name: f'PreToolUse:{tool_name}'. These three are
    // the labels observed live in the incident and its siblings.
    for (const tool of ['Edit', 'Write', 'apply_patch']) {
      expect(isHookLockIntent(`${HOOK_LOCK_INTENT_PREFIX}${tool}`)).toBe(true);
    }
  });

  it('does NOT claim a deliberate acquire, however it is worded', () => {
    for (const intent of [
      'refactoring the release gate across 5 files',
      'holding for the commit',
      'pre-tool-use', // near-miss wording must not match
      '',
    ]) {
      expect(isHookLockIntent(intent)).toBe(false);
    }
    expect(isHookLockIntent(null)).toBe(false);
    expect(isHookLockIntent(undefined)).toBe(false);
  });
});

describe('partitionHookLocks', () => {
  it('selects this owner\'s hook locks and preserves deliberate ones', () => {
    const rows = [
      row({ lock_id: 'a', path: 'scripts/test-files.mjs' }),
      row({ lock_id: 'b', path: 'lib/new.test.ts', intent: `${HOOK_LOCK_INTENT_PREFIX}Write` }),
      row({ lock_id: 'c', path: 'lib/big-refactor.ts', intent: 'multi-file refactor, held across commit' }),
    ];

    const { hookLocks, preservedDeliberate } = partitionHookLocks(rows, OWNER);

    expect(hookLocks.map((r) => r.lock_id)).toEqual(['a', 'b']);
    expect(preservedDeliberate).toBe(1);
  });

  it('never touches another owner\'s locks, hook-acquired or not', () => {
    const rows = [
      row({ lock_id: 'mine' }),
      row({ lock_id: 'peer-hook', owner: OTHER }),
      row({ lock_id: 'peer-manual', owner: OTHER, intent: 'peer refactor' }),
    ];

    const { hookLocks, preservedDeliberate } = partitionHookLocks(rows, OWNER);

    expect(hookLocks.map((r) => r.lock_id)).toEqual(['mine']);
    // The peer's locks are not "preserved deliberate" either — they are not ours to count.
    expect(preservedDeliberate).toBe(0);
  });

  it('returns an empty selection when the owner holds nothing (a correct no-op)', () => {
    expect(partitionHookLocks([], OWNER)).toEqual({ hookLocks: [], preservedDeliberate: 0 });
  });
});

describe('carry-respawn wiring (EI-21878494442396728)', () => {
  const source = readFileSync(
    join(__dirname, '..', 'session', 'request-compaction.ts'),
    'utf8',
  );

  it('calls the hook-lock release at the respawn point', () => {
    expect(source).toContain('releaseOwnerHookFileLocks');
    // Positive control: if this literal ever stops appearing, the assertion above is
    // measuring a file that no longer marks the respawn, not a healthy call site.
    expect(source).toContain('markRespawnExpected');
  });

  it('releases only AFTER the respawn is genuinely queued, and never blocks the cut', () => {
    const markIdx = source.indexOf('markRespawnExpected(identity.ownerId)');
    const releaseIdx = source.indexOf('releaseOwnerHookFileLocks(');
    expect(markIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeGreaterThan(markIdx);

    // The call must sit inside a try/catch: a lock-plane fault must degrade to the
    // 20-minute lease, never fail the compaction the agent asked for. The block also
    // reports what it held and freed, so its `catch` is further down than the call.
    expect(source.slice(releaseIdx - 120, releaseIdx)).toMatch(/try \{/);
    const after = source.slice(releaseIdx, releaseIdx + 1200);
    expect(after).toMatch(/\} catch \(error\) \{/);
    // A failed release is reported, never swallowed: swallowing it is how the release went
    // unnoticed while it threw on every call (release-hook-locks.release.test.ts).
    expect(after).toMatch(/hook file locks NOT released/);
  });
});
