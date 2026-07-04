/**
 * glance.test.ts — coord:glance assembles the combined fleet glance from its
 * four legs (wake store, pending wakes, nursery, governor snapshot) and runs
 * the tips engine for the caller's audience. Stores are mocked at the module
 * seam; the tips engine runs for real (it's pure).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getDefaultWakeMode = vi.fn<() => Promise<'auto' | 'manual'>>();
const countAllPendingWakes = vi.fn<() => Promise<Map<string, number>>>();
const snapshotGovernors = vi.fn<() => Array<{ key: string; state: { pausedUntil: number } }>>();
const getLoopStatus =
  vi.fn<
    () => Promise<{
      active: boolean;
      intervalSec: number;
      parked: boolean;
      // WI-655: the cheap reachability signals glance derives self.loop.reachable from.
      lastDeliveryOutcome?: string | null;
      stalled?: boolean;
    } | null>
  >();
const sqlCalls: string[] = [];
let beeCount = 0;
let beeWorkingCount = 0;
let activityRows: Array<Record<string, unknown>> = [];
// self.objective legs (session-objective-display-2026-06-22): the caller's
// in-execution work-item title, then the coord_presence intent fallback.
let wipTitleRows: Array<{ title: string }> = [];
let presenceRows: Array<Record<string, unknown>> = [];

vi.mock('../wake-mode', () => ({
  getDefaultWakeMode: () => getDefaultWakeMode(),
}));
vi.mock('../pending-wakes', () => ({
  countAllPendingWakes: () => countAllPendingWakes(),
}));
vi.mock('@papercusp/papercusp-shared/agent', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  snapshotGovernors: () => snapshotGovernors(),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  // Only the pg handle is faked — the generated schema exports must survive
  // (agent-mcp's bootstrap reads them at module load).
  ...(await importOriginal<object>()),
  getOrgPg: () => ({
    sql: (strings: TemplateStringsArray, ..._vals: unknown[]) => {
      const text = strings.join('?');
      sqlCalls.push(text);
      if (text.includes('spawned_agents')) return Promise.resolve([{ n: beeCount, working: beeWorkingCount }]);
      if (text.includes('agent_activity')) return Promise.resolve(activityRows);
      return Promise.resolve([]);
    },
  }),
}));
vi.mock('../../../harness/routines/loop', () => ({
  getLoopStatus: () => getLoopStatus(),
}));

// self.fleets legs (multi-fleet-terminal-identity, WI-1963): the fleets this agent
// LEADS + its single presence member-fleet. resolveFleetScheme + nearestColorSquareEmoji
// stay REAL (pure) so the square each fleet maps to is exercised end-to-end.
const listFleetsLedBy = vi.fn<(ws: string, owner: string) => Promise<unknown[]>>();
const getFleet = vi.fn<(ws: string, slug: string) => Promise<unknown>>();
const fetchPresenceFleet =
  vi.fn<(ids: string[]) => Promise<Map<string, { fleetSlug: string | null; fleetRole: string | null }>>>();
vi.mock('../../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listFleetsLedBy: (ws: string, owner: string) => listFleetsLedBy(ws, owner),
  getFleet: (ws: string, slug: string) => getFleet(ws, slug),
}));
vi.mock('../presence-fleet', () => ({
  fetchPresenceFleet: (ids: string[]) => fetchPresenceFleet(ids),
}));

import glance from './glance';

const ctx = { uiClientId: 'su-self', isSuperuser: true, workspaceId: 'ws' } as never;
const parse = (x: unknown) => glance.args.parse(x) as never;
const out = (res: unknown) =>
  JSON.parse((res as { content: { text: string }[] }).content[0].text);

beforeEach(() => {
  getDefaultWakeMode.mockResolvedValue('auto');
  countAllPendingWakes.mockResolvedValue(new Map());
  snapshotGovernors.mockReturnValue([]);
  beeCount = 0;
  beeWorkingCount = 0;
  activityRows = [];
  getLoopStatus.mockResolvedValue(null);
  listFleetsLedBy.mockResolvedValue([]);
  getFleet.mockResolvedValue(null);
  fetchPresenceFleet.mockResolvedValue(new Map());
  sqlCalls.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe('coord:glance', () => {
  it('quiet fleet → auto mode, zero counts, no tips', async () => {
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.ok).toBe(true);
    expect(g.wake).toEqual({ default: 'auto', stagedTotal: 0, stagedOwners: 0 });
    expect(g.bees.running).toBe(0);
    expect(g.governor.anyPaused).toBe(false);
    expect(g.tips).toEqual([]);
  });

  it('manual mode + staged wakes → totals summed across owners and the wake-mode tip', async () => {
    getDefaultWakeMode.mockResolvedValue('manual');
    countAllPendingWakes.mockResolvedValue(
      new Map([
        ['su-queen', 2],
        ['su-other', 1],
      ]),
    );
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.wake).toEqual({ default: 'manual', stagedTotal: 3, stagedOwners: 2 });
    expect(g.tips[0].id).toBe('wake-mode-manual');
    expect(g.tips[0].command).toBe('/mcp__papercusp-su__tool:coord:wake-mode mode=auto');
    expect(g.tips[0].invoke).toEqual({ tool: 'coord:wake-mode', args: { mode: 'auto' } });
  });

  it('paused governor buckets surface key + until, expired pauses are dropped', async () => {
    snapshotGovernors.mockReturnValue([
      { key: 'anthropic:opus', state: { pausedUntil: Date.now() + 60_000 } },
      { key: 'anthropic:haiku', state: { pausedUntil: Date.now() - 60_000 } },
    ]);
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.governor.anyPaused).toBe(true);
    expect(g.governor.paused.map((p: { key: string }) => p.key)).toEqual(['anthropic:opus']);
    expect(g.tips.map((t: { id: string }) => t.id)).toEqual(['governor-paused']);
  });

  it('audience scopes tips: a bee sees no wake-mode tip', async () => {
    getDefaultWakeMode.mockResolvedValue('manual');
    const g = out(await glance.handler(parse({ audience: 'bee' }), ctx));
    expect(g.wake.default).toBe('manual');
    expect(g.tips).toEqual([]);
  });

  it('activity rows ride along; activity_limit 0 skips the query', async () => {
    activityRows = [{ owner_id: 'su-a', summary: 'edit x.ts', kind: 'tool', created_at: 't' }];
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.activity).toHaveLength(1);

    sqlCalls.length = 0;
    await glance.handler(parse({ activity_limit: 0 }), ctx);
    expect(sqlCalls.some((q) => q.includes('agent_activity'))).toBe(false);
  });

  it('self.loop reflects an active engine loop (loop-status-display); null when not looping', async () => {
    getLoopStatus.mockResolvedValue({ active: true, intervalSec: 120, parked: false });
    let g = out(await glance.handler(parse({}), ctx));
    // WI-655: an active loop with no failing delivery signal reads reachable:true.
    expect(g.self.loop).toEqual({ active: true, intervalSec: 120, parked: false, reachable: true });
    getLoopStatus.mockResolvedValue(null);
    g = out(await glance.handler(parse({}), ctx));
    expect(g.self.loop).toBeNull();
  });

  it('WI-655: a loop whose last fire reached nobody (no-session-now) reads reachable:false', async () => {
    getLoopStatus.mockResolvedValue({
      active: true,
      intervalSec: 120,
      parked: true,
      lastDeliveryOutcome: 'no-session-now',
    });
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.self.loop).toEqual({ active: true, intervalSec: 120, parked: true, reachable: false });
  });

  it('WI-655: a stalled loop (wake turn died) reads reachable:false', async () => {
    getLoopStatus.mockResolvedValue({ active: true, intervalSec: 120, parked: true, stalled: true });
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.self.loop).toEqual({ active: true, intervalSec: 120, parked: true, reachable: false });
  });

  it('bees count rides the fresh-heartbeat nursery query', async () => {
    beeCount = 4;
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.bees.running).toBe(4);
    expect(sqlCalls.some((q) => q.includes('spawned_agents'))).toBe(true);
  });

  it('EI-3226: bees.working is the confirmed-active (fresh last_output_at) subset, distinct from bees.running (heartbeat-only)', async () => {
    // 3 rows heartbeat-fresh (host process alive), only 1 has recently produced
    // output — the other 2 are parked/idle sessions whose process hasn't died.
    beeCount = 3;
    beeWorkingCount = 1;
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.bees).toEqual({ running: 3, working: 1 });
  });

  it('bees.working defaults to 0 when no rows come back (empty nursery)', async () => {
    beeCount = 0;
    beeWorkingCount = 0;
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.bees).toEqual({ running: 0, working: 0 });
  });

  // ── self.fleets — multi-fleet terminal identity (WI-1963) ──
  it('self.fleets = every LED fleet (👑) ∪ the member fleet (👤), each with its scheme colour square', async () => {
    listFleetsLedBy.mockResolvedValue([
      { fleetSlug: 'roman-fleet', title: 'roman', colorScheme: 'royal-purple' },
      { fleetSlug: 'greek-fleet', title: 'greek', colorScheme: 'forest' },
    ]);
    // Keyed by whatever ownerId glance resolves from ctx — robust to the id mapping.
    fetchPresenceFleet.mockImplementation((ids) =>
      Promise.resolve(new Map(ids.map((id) => [id, { fleetSlug: 'blue-fleet', fleetRole: 'member' }]))),
    );
    getFleet.mockResolvedValue({ fleetSlug: 'blue-fleet', title: 'blue', colorScheme: 'midnight-slate' });
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.self.fleets).toEqual([
      { slug: 'roman-fleet', label: 'roman', role: 'leader', square: '🟪' },
      { slug: 'greek-fleet', label: 'greek', role: 'leader', square: '🟩' },
      { slug: 'blue-fleet', label: 'blue', role: 'member', square: '🟦' },
    ]);
  });

  it('a member fleet that is ALSO led is not duplicated', async () => {
    listFleetsLedBy.mockResolvedValue([
      { fleetSlug: 'roman-fleet', title: 'roman', colorScheme: 'royal-purple' },
    ]);
    fetchPresenceFleet.mockImplementation((ids) =>
      Promise.resolve(new Map(ids.map((id) => [id, { fleetSlug: 'roman-fleet', fleetRole: 'leader' }]))),
    );
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.self.fleets).toEqual([
      { slug: 'roman-fleet', label: 'roman', role: 'leader', square: '🟪' },
    ]);
  });

  it('label falls back to the slug when a fleet has no title', async () => {
    listFleetsLedBy.mockResolvedValue([{ fleetSlug: 'nameless-fleet', title: null, colorScheme: 'forest' }]);
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.self.fleets).toEqual([
      { slug: 'nameless-fleet', label: 'nameless-fleet', role: 'leader', square: '🟩' },
    ]);
  });

  it('no fleets → self.fleets is empty', async () => {
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.self.fleets).toEqual([]);
  });

  it('a fleet-store error fails open to empty self.fleets (the render never breaks)', async () => {
    listFleetsLedBy.mockRejectedValue(new Error('pg down'));
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.self.fleets).toEqual([]);
    // and the rest of the glance still assembled
    expect(g.ok).toBe(true);
    expect(g.wake.default).toBe('auto');
  });
});
