import { describe, expect, it } from 'vitest';
import type { SevereEventBroadcast } from '../../severe-event-broadcast';
import {
  KEPT_STALE_GIT_LOCK_CONDITION_PREFIX,
  keptStaleGitLockConditionKey,
  reportKeptStaleGitLocks,
} from './kept-stale-lock-condition';
import type { KeptStaleGitMetadataLock } from './run-git-sync';

function kept(path: string, ageMs: number, reason: KeptStaleGitMetadataLock['reason']): KeptStaleGitMetadataLock {
  const name = path.slice(path.indexOf('.git/') + '.git/'.length) as KeptStaleGitMetadataLock['name'];
  return { name, path, ageMs, reason };
}

function recorder() {
  const events: SevereEventBroadcast[] = [];
  return { events, broadcast: async (ev: SevereEventBroadcast) => (events.push(ev), true) };
}

describe('reportKeptStaleGitLocks (WI-6554700010049067)', () => {
  it('raises one condition per kept lock path, keyed by slug and full-path hash', async () => {
    const { events, broadcast } = recorder();
    const a = kept('/repo/.git/packed-refs.lock', 2 * 3_600_000, 'nonempty');
    const b = kept('/repo/.git/refs/heads/staging.lock', 3 * 3_600_000, 'unknown-holder');
    await reportKeptStaleGitLocks('papercusp', '/repo', [a, b], broadcast);
    expect(events.map((e) => e.conditionKey)).toEqual([
      keptStaleGitLockConditionKey('papercusp', a.path),
      keptStaleGitLockConditionKey('papercusp', b.path),
    ]);
    expect(new Set(events.map((e) => e.conditionKey)).size).toBe(2);
    for (const e of events) expect(e.conditionKey?.startsWith(`${KEPT_STALE_GIT_LOCK_CONDITION_PREFIX}:papercusp:`)).toBe(true);
    expect(events[0]?.summary).toContain('packed-refs.lock');
    expect(events[0]?.summary).toContain('nonempty');
    expect(events[0]?.body).toContain(a.path);
    expect(events[0]?.data).toMatchObject({ path: a.path, reason: 'nonempty', ageMs: a.ageMs, slug: 'papercusp', repoPath: '/repo' });
  });

  it('keeps the summary age-free so a repeat tick heartbeats the open condition', async () => {
    const { events, broadcast } = recorder();
    const path = '/repo/.git/shallow.lock';
    await reportKeptStaleGitLocks('papercusp', '/repo', [kept(path, 3_600_000, 'open')], broadcast);
    await reportKeptStaleGitLocks('papercusp', '/repo', [kept(path, 5 * 3_600_000, 'open')], broadcast);
    expect(events).toHaveLength(2);
    expect(events[1]?.conditionKey).toBe(events[0]?.conditionKey);
    expect(events[1]?.summary).toBe(events[0]?.summary);
    expect(events[0]?.oneShot).toBeUndefined();
  });

  it('separates the same lock path across installs and distinct paths sharing a prefix', () => {
    const p = '/repo/.git/refs/heads/a.lock';
    expect(keptStaleGitLockConditionKey('one', p)).not.toBe(keptStaleGitLockConditionKey('two', p));
    expect(keptStaleGitLockConditionKey('one', p)).not.toBe(keptStaleGitLockConditionKey('one', `${p}x`));
  });

  it('reports nothing for an empty verdict', async () => {
    const { events, broadcast } = recorder();
    await reportKeptStaleGitLocks('papercusp', '/repo', [], broadcast);
    expect(events).toEqual([]);
  });
});
