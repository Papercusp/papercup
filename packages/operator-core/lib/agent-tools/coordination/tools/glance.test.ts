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
const sqlCalls: string[] = [];
let beeCount = 0;
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
      if (text.includes('spawned_agents')) return Promise.resolve([{ n: beeCount }]);
      if (text.includes('agent_activity')) return Promise.resolve(activityRows);
      return Promise.resolve([]);
    },
  }),
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
  activityRows = [];
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

  it('bees count rides the fresh-heartbeat nursery query', async () => {
    beeCount = 4;
    const g = out(await glance.handler(parse({}), ctx));
    expect(g.bees.running).toBe(4);
    expect(sqlCalls.some((q) => q.includes('spawned_agents'))).toBe(true);
  });
});
