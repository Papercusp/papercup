import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UnifiedToolContext } from '@papercusp/agent-mcp';

import { directedImplementerConfinement } from './session-confinement';
import {
  checkSessionConfinement,
  hasSessionConfinementResolver,
  setSessionConfinementResolver,
} from './session-confinement-port';

const CONFINEMENT = directedImplementerConfinement({
  directorSid: 'su-director-1',
  workItemId: 'WI-1234',
});

/** A ctx at maximum privilege — the case every other rail exempts. */
const SUPERUSER_CTX = {
  isSuperuser: true,
  isPowerUser: true,
  role: 'cup',
} as unknown as UnifiedToolContext;

const PLAIN_CTX = { isSuperuser: false } as unknown as UnifiedToolContext;

afterEach(() => setSessionConfinementResolver(undefined));

describe('session-confinement port — inertness when nothing is declared', () => {
  it('is null with no resolver installed', () => {
    expect(hasSessionConfinementResolver()).toBe(false);
    expect(checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX })).toBeNull();
  });

  it('is null when the resolver reports an unconfined session', () => {
    setSessionConfinementResolver(() => null);
    expect(checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX })).toBeNull();
  });

  it('is null for a permitted tool in a confined session', () => {
    setSessionConfinementResolver(() => CONFINEMENT);
    expect(checkSessionConfinement({ toolName: 'work_items:checkpoint', ctx: PLAIN_CTX })).toBeNull();
  });
});

describe('session-confinement port — the deny', () => {
  it('returns a deny verdict the dispatcher can short-circuit on', () => {
    setSessionConfinementResolver(() => CONFINEMENT);
    const v = checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX });
    expect(v).not.toBeNull();
    expect(v?.decision).toBe('deny');
    expect(v?.posture).toBe('rejected');
    expect(v?.applied).toBe(true);
    expect(v?.reason).toContain('su-director-1');
  });

  // ── THE POINT OF THE WHOLE EXERCISE ─────────────────────────────────────────
  // evaluateCapabilityEnvelope returns { applied:false } on isSuperuser||isPowerUser
  // BEFORE it reads the role, which is why ROLE_ENVELOPES cannot bind a directed
  // implementer (D-015 ¶2). If this test ever goes green-by-exemption, the rail is
  // theatre again and P-003 has silently regressed.
  it('DENIES a full superuser + power-user session — privilege does not exempt', () => {
    setSessionConfinementResolver(() => CONFINEMENT);
    const v = checkSessionConfinement({ toolName: 'work_items:complete', ctx: SUPERUSER_CTX });
    expect(v?.decision).toBe('deny');
  });

  it('denies the mangled MCP spelling at maximum privilege too', () => {
    setSessionConfinementResolver(() => CONFINEMENT);
    const v = checkSessionConfinement({
      toolName: 'mcp__papercusp-su__work_items_complete',
      ctx: SUPERUSER_CTX,
    });
    expect(v?.decision).toBe('deny');
  });

  it('passes the ctx to the resolver so it can key on the calling session', () => {
    const resolver = vi.fn(() => CONFINEMENT);
    setSessionConfinementResolver(resolver);
    checkSessionConfinement({ toolName: 'work_items:complete', ctx: SUPERUSER_CTX });
    expect(resolver).toHaveBeenCalledWith(SUPERUSER_CTX);
  });
});

describe('session-confinement port — a broken resolver', () => {
  it('does not take down dispatch, and says so loudly rather than silently', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setSessionConfinementResolver(() => {
      throw new Error('resolver exploded');
    });
    expect(() =>
      checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX }),
    ).not.toThrow();
    expect(checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX })).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
