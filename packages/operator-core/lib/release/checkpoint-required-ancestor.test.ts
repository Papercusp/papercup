import { describe, expect, it, vi } from 'vitest';
import { frozenRepairQueueReadTarget } from './checkpoint-required-ancestor';
import { gateVerdictEnv } from './gate-verdict-target';

// WI-10008171: calendar's scheduled green-checkpoint read papercusp's frozen repair queue
// (keyed by the operator HOME harness) and adopted papercusp's repairHead f07043ba — a commit
// absent from calendar's integration root — then crashed on `rev-parse f07043ba^{commit}`.
describe('frozenRepairQueueReadTarget (WI-10008171)', () => {
  const home = { workspaceId: 'papercusp-workspace', installSlug: 'papercusp' };

  it('keys the queue by the GATED install when the runner carries a gate target', () => {
    const homeFn = vi.fn(() => home);
    const env = gateVerdictEnv({ workspaceId: 'papercusp-workspace', installSlug: 'calendar' });

    expect(frozenRepairQueueReadTarget(homeFn, env)).toEqual({
      workspaceId: 'papercusp-workspace',
      installSlug: 'calendar',
    });
    expect(homeFn).not.toHaveBeenCalled();
  });

  it('two installs in one workspace never share a queue key', () => {
    const calendar = frozenRepairQueueReadTarget(
      () => home,
      gateVerdictEnv({ workspaceId: 'papercusp-workspace', installSlug: 'calendar' }),
    );
    const papercusp = frozenRepairQueueReadTarget(
      () => home,
      gateVerdictEnv({ workspaceId: 'papercusp-workspace', installSlug: 'papercusp' }),
    );
    expect(calendar.installSlug).not.toBe(papercusp.installSlug);
  });

  it('falls back to the operator home only when no gate target is present', () => {
    expect(frozenRepairQueueReadTarget(() => home, {})).toEqual(home);
  });

  it('a half-set gate target is not a target: it falls back rather than mixing keys', () => {
    const env = gateVerdictEnv({ workspaceId: 'papercusp-workspace', installSlug: 'calendar' });
    const [workspaceKey] = Object.keys(env);
    expect(frozenRepairQueueReadTarget(() => home, { [workspaceKey]: 'papercusp-workspace' })).toEqual(home);
  });
});
