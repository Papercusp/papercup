/**
 * assignments.test.ts — `reconcileWakeability` (EI-6077): fleet:assignments'
 * `alive` is heartbeat-freshness only, which can diverge from whether
 * coord:dispatch/coord:send can actually REACH the agent (a live
 * `coord:inbox-wake:<id>` standing await). This pins the reconciliation with an
 * INJECTED wakeability fetcher — no PG needed (mirrors dispatch.test.ts's
 * composeDispatch pattern: extract the pure/DI-testable core, mock the IO seam).
 */
import { describe, expect, it } from 'vitest';
import { reconcileWakeability } from './assignments';
import type { AgentAssignment } from '../../fleet/assignments';
import type { SessionState, WakeabilitySignals } from '../coordination/presence-wakeability';

function baseAgent(overrides: Partial<AgentAssignment> = {}): AgentAssignment & {
  sessionState?: SessionState | null;
} {
  return {
    agentId: 'su-agent-1',
    label: null,
    name: null,
    present: true,
    alive: true,
    heartbeatAt: '2026-07-04T00:00:00Z',
    intent: '',
    declaredPlanSlug: null,
    fleetSlug: null,
    fleetRole: null,
    claims: [],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
    ...overrides,
  };
}

const fakeFetch =
  (signals: Record<string, WakeabilitySignals>) =>
  async (ids: string[]): Promise<Map<string, WakeabilitySignals>> =>
    new Map(ids.filter((id) => id in signals).map((id) => [id, signals[id]]));

describe('reconcileWakeability (EI-6077)', () => {
  it('the exact EI-6077 evidence: heartbeat-alive but no live inbox-wake await → sessionState ended, alive downgraded', async () => {
    const agent = baseAgent({ alive: true });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: false, liveTurn: false } });
    const [out] = await reconcileWakeability([agent], fetchFn);
    expect(out.sessionState).toBe('ended');
    expect(out.alive).toBe(false);
  });

  it('heartbeat-alive AND wakeable with a running turn → sessionState live, alive stays true', async () => {
    const agent = baseAgent({ alive: true });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: true } });
    const [out] = await reconcileWakeability([agent], fetchFn);
    expect(out.sessionState).toBe('live');
    expect(out.alive).toBe(true);
  });

  it('heartbeat-alive, wakeable, but idle (no running turn) → sessionState parked, alive stays true', async () => {
    const agent = baseAgent({ alive: true });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: false } });
    const [out] = await reconcileWakeability([agent], fetchFn);
    expect(out.sessionState).toBe('parked');
    expect(out.alive).toBe(true);
  });

  it('no wakeability signal for the agent (e.g. a federated peer) — leaves alive/sessionState untouched', async () => {
    const agent = baseAgent({ alive: true });
    const fetchFn = fakeFetch({});
    const [out] = await reconcileWakeability([agent], fetchFn);
    expect(out.sessionState).toBeUndefined();
    expect(out.alive).toBe(true);
  });

  it('never REVIVES an already-dead (heartbeat-stale) agent', async () => {
    const agent = baseAgent({ alive: false });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: true } });
    const [out] = await reconcileWakeability([agent], fetchFn);
    // stale:true (since !alive) with wakeable+liveTurn still resolves 'parked' per
    // deriveSessionState (liveTurn && !stale is required for 'live') — the point
    // pinned here is it does NOT flip a heartbeat-dead agent back to alive:true.
    expect(out.alive).toBe(false);
  });

  it('empty input is a no-op (never calls the fetcher)', async () => {
    let called = false;
    const fetchFn = async () => {
      called = true;
      return new Map<string, WakeabilitySignals>();
    };
    const out = await reconcileWakeability([], fetchFn);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});
