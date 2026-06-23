// @vitest-environment jsdom
/**
 * usePlan.test.tsx — the read/edit split for the one plan-body hook
 * (data-sync-push-completion P-011).
 *
 * usePlan has TWO consumption modes, chosen by `opts.live`:
 *   - `live: true`  → the read-only consumers (PlanItemPreview): subscribe to
 *     the LIVE `useSyncQuery({ queryName:'plans.get', args:{slug,mode:'full'} })`
 *     so a `plans:*` write pushes a fresh row over SSE. data === row[0].
 *   - `live: false` (default) → PlanDetail's Vditor editor: a guarded ONE-SHOT
 *     `fetchPlan` (REST), with `refresh()` + `setData()` the editor drives
 *     itself. A live re-fire mid-edit would clobber the user's draft, so the
 *     editor MUST NOT subscribe.
 *
 * This pins: (a) the live path subscribes with the right queryName/args and
 * is `enabled`, returns row[0], and exposes NO setData; (b) the default path
 * does NOT subscribe (`enabled:false`) and instead hits the REST fetch, and
 * exposes setData (the optimistic-patch seam the editor uses).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

// Capture every useSyncQuery call so we can assert queryName/args/enabled, and
// drive its returned rows. A disabled query yields no data (mirror real impl).
type SyncCall = { queryName: string; args?: unknown; enabled?: boolean };
const syncCalls: SyncCall[] = [];
let syncRows: unknown[] = [];
const invalidateSpy = vi.fn();
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: SyncCall) => {
    syncCalls.push(opts);
    if (opts.enabled === false) {
      return { data: undefined, loading: false, error: null, fetching: false, invalidate: invalidateSpy };
    }
    return { data: syncRows, loading: false, error: null, fetching: false, invalidate: invalidateSpy };
  },
}));

import { usePlan, type AsyncResult, type PlanGetResult } from './plans-api';

/** Drive the hook from a throwaway component, surfacing its result. */
function HookProbe({
  slug,
  live,
  sink,
}: {
  slug: string | null;
  live?: boolean;
  sink: (r: AsyncResult<PlanGetResult | null>) => void;
}) {
  sink(usePlan(slug, live === undefined ? undefined : { live }));
  return null;
}

describe('usePlan — read-only (live) vs editor (one-shot) split', () => {
  beforeEach(() => {
    syncCalls.length = 0;
    syncRows = [];
    invalidateSpy.mockReset();
    vi.restoreAllMocks();
  });
  afterEach(cleanup);

  it('live:true subscribes to plans.get with {slug,mode:full}, enabled, and returns row[0]', async () => {
    syncRows = [{ slug: 'auth-rework', raw: '# Body', archived: false } as PlanGetResult];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let result: AsyncResult<PlanGetResult | null> | null = null;

    render(<HookProbe slug="auth-rework" live sink={(r) => (result = r)} />);

    const call = syncCalls.find((c) => c.queryName === 'plans.get');
    expect(call).toBeTruthy();
    expect(call?.args).toEqual({ slug: 'auth-rework', mode: 'full' });
    expect(call?.enabled).toBe(true);
    // data is the resolver row array's first element (resolver returns [r]).
    expect((result as unknown as AsyncResult<PlanGetResult | null>)!.data).toEqual({
      slug: 'auth-rework',
      raw: '# Body',
      archived: false,
    });
    // Read-only: no optimistic-patch seam, and no REST round-trip.
    expect((result as unknown as AsyncResult<PlanGetResult | null>)!.setData).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('live path: refresh() maps to the sync invalidate()', () => {
    let result: AsyncResult<PlanGetResult | null> | null = null;
    render(<HookProbe slug="p1" live sink={(r) => (result = r)} />);
    (result as unknown as AsyncResult<PlanGetResult | null>)!.refresh();
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('default (editor) path does NOT subscribe live and hits the REST fetch + exposes setData', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ slug: 'p1', raw: '# X', archived: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    let result: AsyncResult<PlanGetResult | null> | null = null;

    render(<HookProbe slug="p1" sink={(r) => (result = r)} />);

    // The plans.get sync subscription, if mounted at all, is disabled (no live).
    const liveCall = syncCalls.find((c) => c.queryName === 'plans.get');
    expect(liveCall?.enabled).toBe(false);

    // The editor path round-trips REST and exposes the optimistic-patch seam.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const url = String((fetchSpy.mock.calls[0]?.[0] as URL | string) ?? '');
    expect(url).toContain('/api/admin/plans/get');
    expect(url).toContain('mode=full');
    expect(typeof (result as unknown as AsyncResult<PlanGetResult | null>)!.setData).toBe('function');
  });

  it('null slug: live path stays quiet (disabled) and returns null data', () => {
    let result: AsyncResult<PlanGetResult | null> | null = null;
    render(<HookProbe slug={null} live sink={(r) => (result = r)} />);
    const call = syncCalls.find((c) => c.queryName === 'plans.get');
    expect(call?.enabled).toBe(false);
    expect((result as unknown as AsyncResult<PlanGetResult | null>)!.data).toBeNull();
  });
});
