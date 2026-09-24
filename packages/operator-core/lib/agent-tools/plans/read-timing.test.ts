import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ clock: 0, queryMs: 7, rows: [] as unknown[], workspaces: [] as string[] }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  withWorkspace: async (workspace: string, fn: (tx: unknown) => Promise<unknown>) => {
    state.workspaces.push(workspace);
    state.clock += 100; // acquisition + BEGIN + workspace setup
    const result = await fn(() => ({
      // postgres templates are lazy: nested fragments do not execute a query.
      then(resolve: (rows: unknown[]) => unknown) {
        state.clock += state.queryMs;
        return Promise.resolve(resolve(state.rows));
      },
    }));
    state.clock += 3; // transaction finalization
    return result;
  },
}));
vi.mock('./parser', async (original) => {
  const real = await original<typeof import('./parser')>();
  return { ...real, parsePlan: (...args: Parameters<typeof real.parsePlan>) => {
    state.clock += 11;
    return real.parsePlan(...args);
  } };
});

import { readPlanBySlug } from './source';
import { readActiveAcceptanceRubrics } from './plan-lifecycle-derivation';

beforeEach(() => {
  state.clock = 0;
  state.queryMs = 7;
  state.workspaces = [];
  vi.spyOn(performance, 'now').mockImplementation(() => state.clock);
});
afterEach(() => vi.restoreAllMocks());

describe('plan read phase attribution', () => {
  it.each([7, 250])('separates %i ms query time from setup, commit and parsing', async (queryMs) => {
    state.queryMs = queryMs;
    state.rows = [{ workspace_id: 'timing-ws', harness_slug: 'papercusp', plan_slug: 'timing',
      content: '---\nslug: timing\ntitle: Timing\nstatus: ready\n---\n\n## Now\n\nReady.\n',
      content_hash: 'hash', version: 1, archived: false }];
    const timings: Record<string, number> = {};
    const result = await readPlanBySlug('timing', { workspaceId: 'timing-ws' }, timings);
    expect(result?.row.planSlug).toBe('timing');
    expect(state.workspaces).toEqual(['timing-ws']);
    expect(timings).toEqual({ 'source.resolveScope': 0, 'source.acquireAndSetup': 100,
      'source.query': queryMs, 'source.finishTransaction': 3, 'source.row': 0, 'source.parse': 11 });
    expect(JSON.stringify(result)).not.toContain('acquireAndSetup');
  });

  it('separates lifecycle query time and retains its workspace and result', async () => {
    state.rows = [{ plan_slug: 'acceptance-timing', subject_plan: 'timing' }];
    const timings: Record<string, number> = {};
    const result = await readActiveAcceptanceRubrics({ workspaceId: 'timing-ws', planSlugs: ['timing'], timings });
    expect(result).toEqual(new Map([['timing', 'acceptance-timing']]));
    expect(state.workspaces).toEqual(['timing-ws']);
    expect(timings).toEqual({ 'lifecycle.loadReader': 0, 'lifecycle.acquireAndSetup': 100,
      'lifecycle.query': 7, 'lifecycle.finishTransaction': 3 });
  });
});
