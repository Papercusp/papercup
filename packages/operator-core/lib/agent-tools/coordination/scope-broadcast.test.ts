import { describe, it, expect } from 'vitest';
import { scopeBroadcastAudience } from './scope-broadcast';

describe('scopeBroadcastAudience', () => {
  it('rewrites a fleeted sender\'s bare * to @fleet:<slug> and reports the rewrite', () => {
    const r = scopeBroadcastAudience({ to: ['*'], senderFleet: 'ops' });
    expect(r.to).toEqual(['@fleet:ops']);
    expect(r.scoped).toBeTruthy();
    expect(r.scoped!.from).toBe('*');
    expect(r.scoped!.to).toBe('@fleet:ops');
    expect(r.scoped!.reason).toContain('allHive:true');
    expect(r.allHive).toBeUndefined();
  });

  it('leaves a non-fleeted sender\'s * untouched (no cohort to scope to)', () => {
    for (const senderFleet of [null, undefined, '']) {
      const r = scopeBroadcastAudience({ to: ['*'], senderFleet });
      expect(r.to).toEqual(['*']);
      expect(r.scoped).toBeUndefined();
    }
  });

  it('honors * verbatim when the sender consciously claims allHive, and flags it', () => {
    const r = scopeBroadcastAudience({ to: ['*'], senderFleet: 'ops', allHive: true });
    expect(r.to).toEqual(['*']);
    expect(r.scoped).toBeUndefined();
    expect(r.allHive).toBe(true);
  });

  it('does not flag allHive when there was no wildcard to broadcast', () => {
    const r = scopeBroadcastAudience({ to: ['su-123'], senderFleet: 'ops', allHive: true });
    expect(r.to).toEqual(['su-123']);
    expect(r.allHive).toBeUndefined();
  });

  it('leaves a directed send (no wildcard) untouched even for a fleeted sender', () => {
    const r = scopeBroadcastAudience({ to: ['su-123', '@plan:p'], senderFleet: 'ops' });
    expect(r.to).toEqual(['su-123', '@plan:p']);
    expect(r.scoped).toBeUndefined();
  });

  it('preserves other concrete recipients alongside a scoped wildcard, de-duping the selector', () => {
    const r = scopeBroadcastAudience({ to: ['*', 'su-9', '@fleet:ops'], senderFleet: 'ops' });
    // the '*' collapses to @fleet:ops, which is already present → not duplicated
    expect(r.to).toEqual(['@fleet:ops', 'su-9']);
    expect(r.scoped!.to).toBe('@fleet:ops');
  });

  it('does not touch a human-surfaced message', () => {
    const r = scopeBroadcastAudience({ to: ['human'], senderFleet: 'ops' });
    expect(r.to).toEqual(['human']);
    expect(r.scoped).toBeUndefined();
  });
});
