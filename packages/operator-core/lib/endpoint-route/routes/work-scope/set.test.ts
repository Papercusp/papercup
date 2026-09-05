/**
 * /work-scope/set + /work-scope/clear — the /admin/work-scope pane's write doors (WI-2145092).
 *
 * Pins the ONE-mutation-path property: both routes call the shared control helpers with an
 * `admin:<principal>` actor and forward dryRun, and a REVERTED outcome answers ok:false / 502
 * so the pane cannot show success for a policy that did not persist.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ControlOutcome } from '@papercusp/control-mutation';
import type { WorkScopePolicy } from '../../../work-scope-policy';

vi.mock('../../../work-scope-control', async () => {
  // Hermetic: the real module pulls the control harness (db-org) — mock the two mutations
  // and rebuild the body schema locally so the route still validates its input shape.
  const { z } = await import('zod');
  return {
    applyWorkScopeSet: vi.fn(),
    applyWorkScopeClear: vi.fn(),
    workScopeSetSchema: z.object({
      mode: z.enum(['enforce', 'off']).default('enforce'),
      allowHarnesses: z.array(z.string().min(1)).min(1),
      exceptions: z.array(z.object({ harness: z.string().optional(), reason: z.string() })).optional(),
      reason: z.string().min(3),
      dryRun: z.boolean().optional(),
    }),
  };
});

import { applyWorkScopeClear, applyWorkScopeSet } from '../../../work-scope-control';
import routes from './set';

const [setRoute, clearRoute] = routes;

type Outcome = ControlOutcome<WorkScopePolicy | null>;

const STORED: WorkScopePolicy = {
  mode: 'enforce',
  allowHarnesses: ['papercusp'],
  setBy: 'admin:tester',
  reason: 'r',
  ledger: { entries: [], counts: { denied: 0, held: 0, rehomed: 0 } },
};

/** A COMPLETE outcome (every field the harness type declares) with a Partial override seam. */
function outcome(over: Partial<Outcome> = {}): Outcome {
  return {
    action: 'workspace:work_scope',
    subject: 'work-scope',
    dryRun: false,
    applied: true,
    prev: null,
    next: STORED,
    verify: { ok: true },
    auditId: 'gwc-test-1',
    reverted: false,
    preview: null,
    ...over,
  };
}

function ctxFor(input: Record<string, unknown>, slug: string | null = 'tester') {
  return { input, principal: slug ? { slug } : null } as never;
}

async function call(route: (typeof routes)[number], path: string, input: Record<string, unknown>, slug?: string | null) {
  const res = (await route.handler(new Request(`http://127.0.0.1/api${path}`), ctxFor(input, slug))) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.mocked(applyWorkScopeSet).mockReset();
  vi.mocked(applyWorkScopeClear).mockReset();
});

describe('POST /api/work-scope/set', () => {
  it('routes are exported as [set, clear] with the documented paths', () => {
    expect(setRoute.path).toBe('/work-scope/set');
    expect(clearRoute.path).toBe('/work-scope/clear');
    expect(setRoute.method).toBe('POST');
    expect(clearRoute.method).toBe('POST');
  });

  it('runs the shared audited mutation as admin:<principal>, forwards dryRun, and strips the ledger from the echoed policy', async () => {
    vi.mocked(applyWorkScopeSet).mockResolvedValue(outcome({ dryRun: true }));
    const { status, body } = await call(setRoute, '/work-scope/set', {
      mode: 'enforce',
      allowHarnesses: ['papercusp'],
      reason: 'owner: papercusp only',
      dryRun: true,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.auditId).toBe('gwc-test-1');
    expect((body.policy as Record<string, unknown>).ledger).toBeUndefined();
    expect((body.policy as Record<string, unknown>).allowHarnesses).toEqual(['papercusp']);
    expect(vi.mocked(applyWorkScopeSet)).toHaveBeenCalledWith(
      { mode: 'enforce', allowHarnesses: ['papercusp'], exceptions: undefined, reason: 'owner: papercusp only' },
      'admin:tester',
      { dryRun: true },
    );
  });

  it('falls back to admin:operator when the loopback caller carries no principal', async () => {
    vi.mocked(applyWorkScopeSet).mockResolvedValue(outcome());
    await call(setRoute, '/work-scope/set', { mode: 'off', allowHarnesses: ['x'], reason: 'why not' }, null);
    expect(vi.mocked(applyWorkScopeSet).mock.calls[0]![1]).toBe('admin:operator');
  });

  it('answers ok:false / 502 when the harness REVERTED the write — never a green toast for a policy that did not persist', async () => {
    vi.mocked(applyWorkScopeSet).mockResolvedValue(
      outcome({ reverted: true, verify: { ok: false, detail: 'policy did not persist as written' }, next: undefined }),
    );
    const { status, body } = await call(setRoute, '/work-scope/set', { allowHarnesses: ['papercusp'], reason: 'owner' });
    expect(status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('policy did not persist as written');
    expect(body.policy).toBeNull();
  });
});

describe('POST /api/work-scope/clear', () => {
  it('runs the shared audited clear as admin:<principal> and forwards dryRun', async () => {
    vi.mocked(applyWorkScopeClear).mockResolvedValue(outcome({ prev: STORED, next: null }));
    const { status, body } = await call(clearRoute, '/work-scope/clear', { dryRun: false });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, op: 'clear', applied: true, reverted: false, auditId: 'gwc-test-1' });
    expect(vi.mocked(applyWorkScopeClear)).toHaveBeenCalledWith('admin:tester', { dryRun: false });
  });

  it('answers ok:false / 502 on a reverted clear', async () => {
    vi.mocked(applyWorkScopeClear).mockResolvedValue(
      outcome({ prev: STORED, next: STORED, reverted: true, verify: { ok: false, detail: 'policy still present after clear' } }),
    );
    const { status, body } = await call(clearRoute, '/work-scope/clear', {});
    expect(status).toBe(502);
    expect(body.error).toBe('policy still present after clear');
  });
});
