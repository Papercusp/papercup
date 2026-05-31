/**
 * Coverage for flag-distinct-id.resolveDistinctId — the machine-stable
 * PostHog distinctId (host-prefixed, request-independent for V1).
 */
import { describe, expect, it } from 'vitest';
import { resolveDistinctId } from './flag-distinct-id';

describe('resolveDistinctId', () => {
  it('returns a host-prefixed id', () => {
    expect(resolveDistinctId(new Request('http://localhost/'))).toMatch(/^papercusp-host-/);
  });
  it('is stable + independent of the request', () => {
    const a = resolveDistinctId(new Request('http://localhost/a'));
    const b = resolveDistinctId(new Request('http://localhost/b'));
    expect(a).toBe(b);
  });
});
