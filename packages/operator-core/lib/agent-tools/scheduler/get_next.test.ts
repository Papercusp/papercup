/**
 * WI-1912: the `states` arg on the pull tools (scheduler:get_next /
 * work_items:claim_next) must not widen past the resolver-owned floors.
 *
 * A backlog-clearance fleet member passed states:['todo','open','blocked'] and
 * get_next surfaced WI-1591 — a `blocked`, leader-triage-only item — into their
 * pull loop. The claim-spec validator rejects a `blocked` filter TERM precisely
 * so a spec can never un-floor itself (D-002), but the sibling free-string
 * `states` arg re-opened the identical hole at the tool boundary. These tests
 * pin the clamp: `states` accepts only CLAIM_STATES_ALLOWLIST members.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';

const scopeState = vi.hoisted(() => ({ scope: null as any, quarantinedIds: [] as string[], windingDown: false, pauseReason: null as string | null }));
const getNextM = vi.hoisted(() => vi.fn());
// EI-16057: registry contents the harness-existence gate checks against — 'papercusp'
// is the only registered slug by default so every pre-existing test (which all pass
// `harness: 'papercusp'`) keeps resolving; the dedicated describe block below swaps
// this to exercise the harness_not_found path.
const registryState = vi.hoisted(() => ({ projects: [{ slug: 'papercusp' }] as Array<{ slug: string }> }));
const loadHarnessRegistryM = vi.hoisted(() => vi.fn(async () => ({ projects: registryState.projects })));
// EI-15777: the paused-miss branch cancels the caller's own standing
// `work-item:claimable` await(s) — mock the store call so these unit tests never
// touch real PG, and so tests below can assert it was invoked (self-scoped, by ownerId).
const cancelClaimableAwaitsM = vi.hoisted(() => vi.fn(async () => 0));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-member', workspaceId: 'ws-1' }),
}));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadHarnessRegistry: loadHarnessRegistryM,
}));
vi.mock('../../events/await/store', () => ({
  cancelClaimableAwaits: cancelClaimableAwaitsM,
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: vi.fn(async () => true),
}));
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scheduler/claim-spec-store')>();
  return { ...actual, getNextForBee: getNextM };
});
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  reconcileFleetScopeClaims: vi.fn(async () => ({ scope: scopeState.scope, quarantinedIds: scopeState.quarantinedIds })),
  readFleetPauseState: vi.fn(async () => ({ windingDown: scopeState.windingDown, reason: scopeState.pauseReason })),
  // EI-13520: real fn returns null (no cooldown-diagnosis signal) by default — these tests
  // don't exercise the cooldown-attribution path, only fleetScopedMiss's existing shapes.
  diagnoseFleetScopeCooldownMiss: vi.fn(async () => null),
  // WI-5561: real fn returns null (no issue-floor-breakdown signal) by default — these tests
  // don't exercise the issue-floor-breakdown path, only fleetScopedMiss's existing shapes.
  diagnoseFleetScopeIssueFloorMiss: vi.fn(async () => null),
  fleetScopedMiss: (
    scope: any,
    quarantinedIds: string[],
    opts?: {
      pausedReason?: string | null;
      cooldownDiag?: { cooldownExcluded: number; earliestExpiryMs: number | null } | null;
      claimableAwaitsCancelled?: number;
      issueBreakdown?: unknown;
    },
  ) => ({
    ok: false,
    error:
      opts?.pausedReason !== undefined
        ? `paused: ${opts.pausedReason ?? ''}`
        : opts?.cooldownDiag
          ? `cooldown-only miss; ${opts.cooldownDiag.cooldownExcluded} excluded`
          : opts?.issueBreakdown
            ? 'floor-gated miss (WI-5561); see excludedBreakdownSummary'
            : 'scoped miss; no generic fallback',
    fleetScope: { fleet: scope.fleetSlug, source: scope.record.source },
    quarantinedIds,
    windDown: true,
    ...(opts?.pausedReason !== undefined ? { paused: true } : {}),
    ...(opts?.pausedReason !== undefined ? { claimableAwaitsCancelled: opts?.claimableAwaitsCancelled ?? 0 } : {}),
    ...(opts?.cooldownDiag ? { cooldownOnly: true } : {}),
    ...(opts?.issueBreakdown ? { excludedBreakdown: opts.issueBreakdown } : {}),
  }),
}));

import getNextTool, { GET_NEXT_BUDGET_MS } from './get_next';
import claimNextTool from '../work_items/claim_next';
import { CLAIM_STATES_ALLOWLIST } from '../../work-items';

const TOOLS: Array<{ name: string; args: ZodTypeAny }> = [
  { name: 'scheduler:get_next', args: (getNextTool as { args: ZodTypeAny }).args },
  { name: 'work_items:claim_next', args: (claimNextTool as { args: ZodTypeAny }).args },
];

describe('pull-tool `states` arg is clamped to the claimable allowlist (WI-1912)', () => {
  it('exposes the expected allowlist (open/failing — feature `todo` retired, floors + terminals excluded)', () => {
    expect([...CLAIM_STATES_ALLOWLIST]).toEqual(['open', 'failing']);
  });

  it('accepts every allowlisted state', () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp', states: [...CLAIM_STATES_ALLOWLIST] });
      expect(r.success, `${name} should accept states:${JSON.stringify(CLAIM_STATES_ALLOWLIST)}`).toBe(true);
    }
  });

  it('accepts an omitted `states` (the ["open"] default)', () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp' });
      expect(r.success, `${name} should accept omitted states`).toBe(true);
    }
  });

  it('REJECTS floor-protected and terminal states — the WI-1912 widening', () => {
    for (const { name, args } of TOOLS) {
      for (const bad of ['blocked', 'cursed', 'in_progress', 'passed', 'resolved', 'closed', 'deprecated', 'needs-human', 'todo']) {
        const r = args.safeParse({ harness: 'papercusp', states: ['open', bad] });
        expect(r.success, `${name} must reject states:['open','${bad}']`).toBe(false);
      }
    }
  });

  it("REJECTS the exact observed widening args (states:['todo','open','blocked'])", () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp', states: ['todo', 'open', 'blocked'] });
      expect(r.success, `${name} must reject the WI-1912 repro args`).toBe(false);
    }
  });
});

describe('scheduler:get_next hard fleet boundary (P-016)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getNextM.mockResolvedValue(null);
  });

  it('refuses a member with no explicit/inherited spec before generic selection', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'default', spec: { specId: 'default', revision: 0 } },
    };
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as { content: Array<{ text: string }> };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({ ok: false, windDown: true, fleetScope: { fleet: 'bugs', source: 'default' } });
    expect(getNextM).not.toHaveBeenCalled();
  });

  it('returns a scoped wind-down verdict on miss, including the one-pass quarantine result', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    scopeState.quarantinedIds = ['WI-out'];
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as { content: Array<{ text: string }> };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({ ok: false, windDown: true, quarantinedIds: ['WI-out'] });
    expect(getNextM).toHaveBeenCalledOnce();
  });

  // EI-12832: a member woken during a fleet pause (control_state='winding-down')
  // must stand down — the self-select path floors BEFORE it pulls, whatever the spec matches.
  it('EI-12832: a winding-down fleet floors self-select — paused miss, no pull', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    scopeState.windingDown = true;
    scopeState.pauseReason = 'owner pause';
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as { content: Array<{ text: string }> };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({ ok: false, windDown: true, paused: true });
    expect(getNextM).not.toHaveBeenCalled();
    // EI-15777: the paused-miss branch must cancel the caller's OWN standing
    // work-item:claimable await(s) (self-scoped by ownerId) so a compliant peer
    // stand-down doesn't keep re-waking this member on a pull it's forbidden to make.
    expect(cancelClaimableAwaitsM).toHaveBeenCalledWith('su-member');
  });
});

// EI-16057: an unresolvable `harness` (e.g. a workspace id passed where a slug
// belongs) used to match zero rows in the claim query and render as `windDown:true`
// — indistinguishable from a genuinely drained fleet-scoped lane, so a member would
// stand its loop down and report a false all-clear. It must instead fail loud as a
// plain invalid_input, before any fleet-scope reconciliation runs, and NEVER set
// windDown.
describe('scheduler:get_next harness-existence gate (EI-16057)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getNextM.mockResolvedValue(null);
  });

  it('an unregistered harness (e.g. a workspace id) returns invalid_input, never windDown', async () => {
    const out = (await getNextTool.handler({ harness: 'papercusp-workspace' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({
      ok: false,
      error: 'invalid_input',
      reason: 'harness_not_found',
      passedHarness: 'papercusp-workspace',
      knownHarnesses: ['papercusp'],
    });
    expect(b.windDown).toBeUndefined();
    // The real claim query still runs (harness validity is checked only on the miss it
    // produces, so a correct pull never pays the extra read) — it's the WINDOWN-BEARING
    // fleetScopedMiss branch below it that must never fire for this cause.
    expect(getNextM).toHaveBeenCalledOnce();
  });

  it('a registered harness slug is unaffected — passes through to the normal claim path', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({ ok: false, windDown: true });
    expect(getNextM).toHaveBeenCalledOnce();
  });

  it('a registry-read failure fails OPEN — never blocks a legitimate claim on a read hiccup', async () => {
    loadHarnessRegistryM.mockImplementation(async () => {
      throw new Error('transient PG hiccup');
    });
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b.error).not.toBe('invalid_input');
    expect(getNextM).toHaveBeenCalledOnce();
  });
});

// EI-18167154191955470: a routine scheduler:get_next hung with ZERO response/progress for the
// full 300s MCP idle timeout (the signature of PG pool contention — a query stuck waiting on a
// pool connection blocks silently, no error) and was aborted by the client; an immediate retry
// succeeded in ~2s. The DB path (chiefly the atomic claim) is now bounded so such a stall returns
// a FAST, clean, retryable error WELL under the idle abort. These pin the two behaviors: fail
// FAST (never a silent hang) and fail LOUD (a real error is never swallowed into a false miss).
describe('scheduler:get_next bounds the claim path against a silent hang (EI-18167154191955470)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a fast retryable timeout miss when the claim exceeds the budget, not a 300s hang', async () => {
    vi.useFakeTimers();
    // Simulate the pool-contention stall: the atomic claim never resolves within the budget.
    getNextM.mockImplementation(() => new Promise(() => {}));
    const p = getNextTool.handler({ harness: 'papercusp' } as never, {} as never) as Promise<{
      content: Array<{ text: string }>;
    }>;
    // Advance past the internal budget so the bounded-timeout deadline fires; without the bound
    // this promise would never settle (the hang the bug reported).
    await vi.advanceTimersByTimeAsync(GET_NEXT_BUDGET_MS + 100);
    const out = await p;
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
      budgetMs: GET_NEXT_BUDGET_MS,
    });
    expect(typeof b.message).toBe('string');
    // The message must point the caller at the real failure (idle-timeout abort) + the retry.
    expect(b.message).toContain('300s');
    // A transient timeout is NOT a drained lane — windDown must never be set for it.
    expect(b.windDown).toBeUndefined();
  });

  it('re-surfaces a genuine underlying claim error loudly — never swallowed as a silent miss', async () => {
    getNextM.mockRejectedValue(new Error('pool exhausted: boom'));
    await expect(
      getNextTool.handler({ harness: 'papercusp' } as never, {} as never),
    ).rejects.toThrow(/pool exhausted: boom/);
  });
});
