/**
 * RB-009 — the operator pause-observer surfaces a governor pause transition to coord + the
 * toast stream exactly once per bucket per throttle window. Collaborators (org PG, coord
 * sendMessage, SSE invalidate) are mocked; the governor + registry emitter are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above module-scope consts, so the spies must be too.
const { sendMessage, insertValues, notifySyncInvalidate } = vi.hoisted(() => ({
  // Typed args so `sendMessage.mock.calls[0]` destructures as [identity, opts] under tsc.
  sendMessage: vi.fn(async (_identity: unknown, _opts: { to: string[]; summary: string }) => ({})),
  insertValues: vi.fn(async () => {}),
  notifySyncInvalidate: vi.fn(async () => {}),
}));

vi.mock('./agent-tools/coordination/messages', () => ({ sendMessage }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate }));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    db: {
      insert: () => ({ values: insertValues }),
      select: () => ({ from: () => ({ orderBy: () => ({ offset: async () => [] }) }) }),
      delete: () => ({ where: async () => {} }),
    },
  }),
  generated: { toastLogInHarnessShared: { id: 'id', createdAt: 'createdAt' } },
}));

import {
  initAgentGovernorObserver,
  _resetAgentGovernorObserver,
  GOVERNOR_ESCALATION_MIN_PAUSE_MS,
} from './agent-governor-observer';
import { getGovernor, resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  resetGovernorRegistry();
  _resetAgentGovernorObserver();
});

describe('agent-governor-observer (RB-009)', () => {
  it('surfaces a pause to coord (broadcast) + toast on the first transition', async () => {
    initAgentGovernorObserver();
    getGovernor('anthropic', 'opus').penalize({ retryAfterMs: 60_000 });
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, opts] = sendMessage.mock.calls[0];
    expect(opts.to).toEqual(['*']);
    expect(opts.summary).toMatch(/paused until/i);
    expect(opts.summary).toContain('anthropic:opus');
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(notifySyncInvalidate).toHaveBeenCalledWith('toastLog.recent', undefined);
  });

  it('throttles repeated pauses on the SAME bucket within the window', async () => {
    initAgentGovernorObserver();
    const g = getGovernor('anthropic', 'opus');
    g.penalize({ retryAfterMs: 60_000 }); // surfaces
    g.penalize({ retryAfterMs: 120_000 }); // extends → onPause fires, but throttled
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('surfaces DIFFERENT buckets independently (throttle is per-bucket)', async () => {
    initAgentGovernorObserver();
    getGovernor('anthropic', 'opus').penalize({ retryAfterMs: 60_000 });
    getGovernor('openai', 'default').penalize({ retryAfterMs: 60_000 });
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('escalates only a sustained pause on the shared attention rail', async () => {
    const escalate = vi.fn(async (_t: { title: string; body: string }) => {});
    initAgentGovernorObserver({ escalate, recentlyEscalated: async () => false });
    getGovernor('anthropic', 'opus').penalize({ retryAfterMs: GOVERNOR_ESCALATION_MIN_PAUSE_MS + 1 });
    await flush();
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Agent rate-limit pause sustained' }),
    );
  });

  it('init is idempotent (no double-surfacing from a second init)', async () => {
    initAgentGovernorObserver();
    initAgentGovernorObserver();
    getGovernor('anthropic', 'opus').penalize({ retryAfterMs: 60_000 });
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('reset removes the old listener before a reinitialization (injected policy stays current)', async () => {
    const oldEscalate = vi.fn(async () => {});
    const currentEscalate = vi.fn(async () => {});

    initAgentGovernorObserver({
      escalate: oldEscalate,
      recentlyEscalated: async () => false,
    });
    _resetAgentGovernorObserver();
    initAgentGovernorObserver({
      escalate: currentEscalate,
      recentlyEscalated: async () => false,
    });

    getGovernor('anthropic', 'opus').penalize({
      retryAfterMs: GOVERNOR_ESCALATION_MIN_PAUSE_MS + 1,
    });
    await flush();
    await flush();

    expect(oldEscalate).not.toHaveBeenCalled();
    expect(currentEscalate).toHaveBeenCalledTimes(1);
  });
});
