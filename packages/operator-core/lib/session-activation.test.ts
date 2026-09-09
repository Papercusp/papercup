import { describe, expect, it } from 'vitest';
import {
  acknowledgeActivation,
  activationIdempotencyKey,
  appliedActivationRevision,
  canApplyActivation,
  contextPolicyForDelivery,
  desiredActivation,
  failActivation,
  prepareActivation,
  requestActivation,
  restartActivation,
} from './session-activation';

const rev = (char: string, state: string) => ({ specificationRevision: char.repeat(64), stateRevision: state });
const attribution = { actorId: 'actor', principalId: 'principal', sessionId: 'session' };

describe('D-030 session activation state machine', () => {
  it('keeps desired, prepared, and applied truth separate', () => {
    const first = desiredActivation(attribution, rev('a', '1'));
    const prepared = prepareActivation(first, rev('a', '1'));
    expect(prepared.status).toBe('prepared');
    expect(prepared.applied).toBeNull();
    const applied = acknowledgeActivation(prepared, rev('a', '1'));
    expect(applied.status).toBe('applied');
    expect(applied.prepared).toBeNull();
    expect(applied.applied).toEqual(rev('a', '1'));
  });

  it('does not let a stale revision authorize or acknowledge a side effect', () => {
    const old = acknowledgeActivation(prepareActivation(desiredActivation(attribution, rev('a', '1')), rev('a', '1')), rev('a', '1'));
    const next = requestActivation(old, rev('b', '2'));
    expect(canApplyActivation(next, rev('a', '1'))).toBe(false);
    expect(() => prepareActivation(next, rev('a', '1'))).toThrow(/stale/);
    expect(() => acknowledgeActivation(next, rev('b', '2'))).toThrow(/prepared/);
    expect(appliedActivationRevision(next)).toEqual(rev('a', '1'));
  });

  it('records render failure without erasing the prior applied revision, then recovers', () => {
    const old = acknowledgeActivation(prepareActivation(desiredActivation(attribution, rev('a', '1')), rev('a', '1')), rev('a', '1'));
    const next = requestActivation(old, rev('b', '2'));
    const failed = failActivation(next, rev('b', '2'), 'render failed');
    expect(failed.status).toBe('failed');
    expect(failed.applied).toEqual(rev('a', '1'));
    const recovered = acknowledgeActivation(prepareActivation(failed, rev('b', '2')), rev('b', '2'));
    expect(recovered.status).toBe('applied');
    expect(recovered.applied).toEqual(rev('b', '2'));
  });

  it('is idempotent under repeated requests and acknowledgements', () => {
    const first = desiredActivation(attribution, rev('a', '1'));
    expect(requestActivation(first, rev('a', '1'))).toBe(first);
    const prepared = prepareActivation(first, rev('a', '1'));
    expect(prepareActivation(prepared, rev('a', '1'))).toBe(prepared);
    const applied = acknowledgeActivation(prepared, rev('a', '1'));
    expect(acknowledgeActivation(applied, rev('a', '1'))).toBe(applied);
    expect(activationIdempotencyKey('session', rev('a', '1'))).toContain('session-activation:session:');
  });

  it('restarts an unchanged revision without claiming it is already applied by the new host', () => {
    const applied = acknowledgeActivation(
      prepareActivation(desiredActivation(attribution, rev('a', '1')), rev('a', '1')),
      rev('a', '1'),
    );
    const restarted = restartActivation(applied);
    expect(restarted).toMatchObject({
      desired: rev('a', '1'),
      prepared: null,
      applied: rev('a', '1'),
      status: 'desired',
    });
    expect(restarted.attribution).toEqual(attribution);
  });

  it('makes soft versus fresh-context and private-memory boundaries explicit', () => {
    expect(contextPolicyForDelivery('inject-now')).toEqual({ delivery: 'soft', carry: 'warm', privateMemory: 'preserve' });
    expect(contextPolicyForDelivery('relaunch-with-carry', { carry: 'cold', privateMemory: 'reset' })).toEqual({
      delivery: 'fresh-context', carry: 'cold', privateMemory: 'reset',
    });
  });
});
