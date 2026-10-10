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
  scope: 'WI-1234',
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
  it('is null with no resolver installed', async () => {
    // Explicit, not assumed: the port's state is pinned to globalThis (pinModuleState), so it
    // is per-PROCESS, and a sibling test file that imports the store installs a resolver into
    // the same pin. Asserting a clean slate here would make this test pass or fail on file
    // ORDER. The invariant under test is "no resolver ⇒ null", so establish that precondition.
    setSessionConfinementResolver(undefined);
    expect(hasSessionConfinementResolver()).toBe(false);
    await expect(
      checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX }),
    ).resolves.toBeNull();
  });

  it('is null when the resolver reports an unconfined session', async () => {
    setSessionConfinementResolver(() => null);
    await expect(
      checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX }),
    ).resolves.toBeNull();
  });

  it('is null for a permitted tool in a confined session', async () => {
    setSessionConfinementResolver(() => CONFINEMENT);
    await expect(
      checkSessionConfinement({ toolName: 'work_items:checkpoint', ctx: PLAIN_CTX }),
    ).resolves.toBeNull();
  });
});

describe('session-confinement port — the deny', () => {
  it('returns a deny verdict the dispatcher can short-circuit on', async () => {
    setSessionConfinementResolver(() => CONFINEMENT);
    const v = await checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX });
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
  it('DENIES a full superuser + power-user session — privilege does not exempt', async () => {
    setSessionConfinementResolver(() => CONFINEMENT);
    const v = await checkSessionConfinement({ toolName: 'work_items:complete', ctx: SUPERUSER_CTX });
    expect(v?.decision).toBe('deny');
  });

  it('denies the mangled MCP spelling at maximum privilege too', async () => {
    setSessionConfinementResolver(() => CONFINEMENT);
    const v = await checkSessionConfinement({
      toolName: 'mcp__papercusp-su__work_items_complete',
      ctx: SUPERUSER_CTX,
    });
    expect(v?.decision).toBe('deny');
  });

  it('passes the ctx to the resolver so it can key on the calling session', async () => {
    const resolver = vi.fn(() => CONFINEMENT);
    setSessionConfinementResolver(resolver);
    await checkSessionConfinement({ toolName: 'work_items:complete', ctx: SUPERUSER_CTX });
    expect(resolver).toHaveBeenCalledWith(SUPERUSER_CTX);
  });
});

describe('session-confinement port — a broken resolver', () => {
  it('does not take down dispatch, and says so loudly rather than silently', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setSessionConfinementResolver(() => {
      throw new Error('resolver exploded');
    });
    await expect(
      checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX }),
    ).resolves.toMatchObject({ decision: 'deny', posture: 'rejected' });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

// ── The priming hook (D-017 §4) ───────────────────────────────────────────────
// Launch ORDERING closes the cold-cache window for a normal pair launch, but not for an
// operator RESTART with a confined session already live. `ensureReady` is what covers that
// case, so these pin that it actually runs before the verdict — and that a broken one
// degrades to unconfined rather than taking every dispatch on the box down.
describe('session-confinement port — priming', () => {
  it('denies an async authoritative read failure even when no policy was cached', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    setSessionConfinementResolver(async () => { throw new Error('unavailable'); });
    await expect(checkSessionConfinement({ toolName: 'capability:bash', ctx: SUPERUSER_CTX }))
      .resolves.toMatchObject({ decision: 'deny', applied: true });
    log.mockRestore();
  });
  it('denies a cold priming failure before consulting an empty cache', async () => {
    const resolve = vi.fn(() => null);
    setSessionConfinementResolver(resolve, { ensureReady: async () => { throw new Error('unavailable'); } });
    await expect(checkSessionConfinement({ toolName: 'capability:bash', ctx: SUPERUSER_CTX }))
      .resolves.toMatchObject({ decision: 'deny', applied: true });
    expect(resolve).not.toHaveBeenCalled();
  });
  it('awaits ensureReady BEFORE consulting the resolver', async () => {
    const order: string[] = [];
    setSessionConfinementResolver(
      () => {
        order.push('resolve');
        return CONFINEMENT;
      },
      {
        ensureReady: async () => {
          order.push('prime');
        },
      },
    );
    const v = await checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX });
    expect(v?.decision).toBe('deny');
    expect(order).toEqual(['prime', 'resolve']);
  });

  it('still evaluates when priming fails — a broken store must not deny every dispatch', async () => {
    setSessionConfinementResolver(() => CONFINEMENT, {
      ensureReady: async () => {
        throw new Error('pg down');
      },
    });
    const v = await checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX });
    expect(v?.decision).toBe('deny');
  });

  it('clears the priming hook when the resolver is cleared', async () => {
    const ensureReady = vi.fn(async () => {});
    setSessionConfinementResolver(() => CONFINEMENT, { ensureReady });
    await checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX });
    expect(ensureReady).toHaveBeenCalledTimes(1);

    setSessionConfinementResolver(() => CONFINEMENT);
    await checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX });
    expect(ensureReady).toHaveBeenCalledTimes(1);
  });
});
