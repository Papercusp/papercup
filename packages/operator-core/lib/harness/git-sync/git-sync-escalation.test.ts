import { describe, it, expect } from 'vitest';
import { classifyGitSyncFailingLeg, decideGitSyncEscalation, oversizedKey, PUSH_FAILURE_ESCALATION_TICKS } from './git-sync-escalation';
import type { ScopedOversized } from './run-git-sync';

const big: ScopedOversized = { scope: 'superproject', path: 'apps/tui/target/huge.rlib', sizeBytes: 200 * 1048576 };

const base = {
  installSlug: 'papercusp',
  status: 'synced' as const,
  consecutiveErrorTicks: 0,
  errors: [],
  oversized: [],
  prevOversizedKeys: [],
};

describe('decideGitSyncEscalation (EI-18)', () => {
  it('clean synced pass → clear, no escalation, no broadcast', () => {
    const d = decideGitSyncEscalation(base);
    expect(d).toEqual({ escalate: false, reasons: [], clear: true, broadcast: null });
  });

  it('clean "nothing" pass → clear too', () => {
    const d = decideGitSyncEscalation({ ...base, status: 'nothing' });
    expect(d.clear).toBe(true);
    expect(d.escalate).toBe(false);
  });

  it('errors BELOW the threshold → no escalation, no broadcast, no clear (condition may still be brewing)', () => {
    for (const ticks of [1, PUSH_FAILURE_ESCALATION_TICKS - 1]) {
      const d = decideGitSyncEscalation({
        ...base,
        status: 'error',
        consecutiveErrorTicks: ticks,
        errors: [{ scope: 'superproject', message: 'push failed: HTTP 500' }],
      });
      expect(d.escalate).toBe(false);
      expect(d.broadcast).toBeNull();
      expect(d.clear).toBe(false);
    }
  });

  it('errors AT the threshold → escalate + broadcast naming the failure', () => {
    const d = decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS,
      errors: [{ scope: 'superproject', message: 'push failed: HTTP 500\nsend-pack: disconnect' }],
    });
    expect(d.escalate).toBe(true);
    expect(d.reasons).toEqual(['push-failure']);
    expect(d.broadcast).toContain(`FAILED ${PUSH_FAILURE_ESCALATION_TICKS} consecutive ticks`);
    expect(d.broadcast).toContain('git-sync on papercusp');
    expect(d.broadcast).toContain('HTTP 500');
    expect(d.broadcast).not.toContain('send-pack'); // first line only
  });

  it('errors ABOVE the threshold → still escalates (row refresh) but broadcast only fired at the transition', () => {
    const d = decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS + 2,
      errors: [{ scope: 'superproject', message: 'push failed: HTTP 500' }],
    });
    expect(d.escalate).toBe(true);
    expect(d.broadcast).toBeNull();
  });

  it('a NEW oversized file → escalate + broadcast listing it', () => {
    const d = decideGitSyncEscalation({ ...base, oversized: [big] });
    expect(d.escalate).toBe(true);
    expect(d.reasons).toEqual(['oversized-blobs']);
    expect(d.clear).toBe(false); // the unpushable file still sits in the tree
    expect(d.broadcast).toContain('git-sync on papercusp');
    expect(d.broadcast).toContain('apps/tui/target/huge.rlib');
    expect(d.broadcast).toContain('200.0MB');
  });

  it('a PERSISTING oversized file (same key as last tick) → escalate, but NO repeat broadcast', () => {
    const d = decideGitSyncEscalation({ ...base, oversized: [big], prevOversizedKeys: [oversizedKey(big)] });
    expect(d.escalate).toBe(true);
    expect(d.broadcast).toBeNull();
  });

  it('threshold + new oversized together → both reasons, one combined broadcast', () => {
    const d = decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS,
      errors: [{ scope: 'superproject', message: 'push failed: HTTP 500' }],
      oversized: [big],
    });
    expect(d.reasons).toEqual(['push-failure', 'oversized-blobs']);
    expect(d.broadcast).toContain('consecutive ticks');
    expect(d.broadcast).toContain('huge.rlib');
  });

  it('a conflict tick neither escalates the error kind nor clears it (the conflict path owns that tick)', () => {
    const d = decideGitSyncEscalation({ ...base, status: 'conflict' });
    expect(d.escalate).toBe(false);
    expect(d.clear).toBe(false);
  });

  it('a skipped-locked tick neither escalates nor clears a prior error', () => {
    const d = decideGitSyncEscalation({ ...base, status: 'skipped-locked' });
    expect(d.escalate).toBe(false);
    expect(d.clear).toBe(false);
    expect(d.broadcast).toBeNull();
  });

  it('oversizedKey is scope-qualified (same path in two repos = two keys)', () => {
    expect(oversizedKey(big)).toBe('superproject:apps/tui/target/huge.rlib');
    expect(oversizedKey({ ...big, scope: 'libs/sub' })).not.toBe(oversizedKey(big));
  });
});

/**
 * EI-19275994927087666 — both the escalation broadcast and the /admin/git deploy
 * panel called EVERY git-sync failure a PUSH failure. For 32h the fleet inbox read
 * "PUSH FAILING … commits NOT reaching origin" while origin/staging was byte-identical
 * to local HEAD and 18 of 19 routines sat at 0 error ticks. The single offender was an
 * abandoned scratch pot whose corrupt git object broke the COMMIT leg — it never
 * reached the network at all.
 */
describe('classifyGitSyncFailingLeg (EI-19275994927087666)', () => {
  it('classifies the REAL incident error as a commit failure, not a push failure', () => {
    const actual =
      "superproject: commit failed: error: invalid object 100644 d75c463ae71a1031fc95c9ba48982924e195320b for '.papercusp/blueprint.yaml'";
    expect(classifyGitSyncFailingLeg(actual, 'push')).toBe('commit');
  });

  it('does not let push_mode override an explicit commit failure', () => {
    // The real offender's push_mode was 'push', so push_mode alone could never have
    // caught this — the recorded error text has to be the load-bearing signal.
    expect(classifyGitSyncFailingLeg('commit failed: bad object', 'push')).toBe('commit');
  });

  it('classifies a genuine push failure as push', () => {
    expect(classifyGitSyncFailingLeg('failed to push some refs to origin', 'push')).toBe('push');
  });

  it('classifies a conflict as conflict, even though the text also mentions commit', () => {
    expect(classifyGitSyncFailingLeg('merge conflict in lib/x.ts; commit aborted', 'push')).toBe('conflict');
  });

  it('EI-20347384139844425: classifies submodule config-lock contention by its local cause', () => {
    const actual =
      'submodule-config: canonical submodule URL sync failed: error: could not lock config file /repo/.git/config: File exists';
    expect(classifyGitSyncFailingLeg(actual, 'push')).toBe('config-lock');

    const decision = decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS,
      errors: [{ scope: 'submodule-config', message: actual }],
    });
    expect(decision.broadcast).toContain('submodule config-lock contention');
    expect(decision.broadcast).toContain('origin is unaffected');
    expect(decision.broadcast).not.toContain('cause unclassified');
  });

  it('infers commit for a commit-only member when the error text is unusable', () => {
    // A commit-only:* member never pushes, so its failure cannot be a push failure.
    expect(classifyGitSyncFailingLeg(null, 'commit-only:bridged')).toBe('commit');
    expect(classifyGitSyncFailingLeg('', 'commit-only:config')).toBe('commit');
  });

  it('returns unknown rather than guessing "push" when nothing is decidable', () => {
    expect(classifyGitSyncFailingLeg(null, null)).toBe('unknown');
    expect(classifyGitSyncFailingLeg('something weird happened', 'push')).toBe('unknown');
  });
});
