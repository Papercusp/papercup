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
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';

const scopeState = vi.hoisted(() => ({ scope: null as any, quarantinedIds: [] as string[], windingDown: false, pauseReason: null as string | null }));
const getNextM = vi.hoisted(() => vi.fn());
// EI-15777: the paused-miss branch cancels the caller's own standing
// `work-item:claimable` await(s) — mock the store call so these unit tests never
// touch real PG, and so tests below can assert it was invoked (self-scoped, by ownerId).
const cancelClaimableAwaitsM = vi.hoisted(() => vi.fn(async () => 0));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-member', workspaceId: 'ws-1' }),
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
  fleetScopedMiss: (
    scope: any,
    quarantinedIds: string[],
    opts?: { pausedReason?: string | null; cooldownDiag?: { cooldownExcluded: number; earliestExpiryMs: number | null } | null },
  ) => ({
    ok: false,
    error:
      opts?.pausedReason !== undefined
        ? `paused: ${opts.pausedReason ?? ''}`
        : opts?.cooldownDiag
          ? `cooldown-only miss; ${opts.cooldownDiag.cooldownExcluded} excluded`
          : 'scoped miss; no generic fallback',
    fleetScope: { fleet: scope.fleetSlug, source: scope.record.source },
    quarantinedIds,
    windDown: true,
    ...(opts?.pausedReason !== undefined ? { paused: true } : {}),
    ...(opts?.cooldownDiag ? { cooldownOnly: true } : {}),
  }),
}));

import getNextTool from './get_next';
import claimNextTool from '../work_items/claim_next';
import { CLAIM_STATES_ALLOWLIST } from '../../work-items';

const TOOLS: Array<{ name: string; args: ZodTypeAny }> = [
  { name: 'scheduler:get_next', args: (getNextTool as { args: ZodTypeAny }).args },
  { name: 'work_items:claim_next', args: (claimNextTool as { args: ZodTypeAny }).args },
];

describe('pull-tool `states` arg is clamped to the claimable allowlist (WI-1912)', () => {
  it('exposes the expected allowlist (todo/open/failing — floors + terminals excluded)', () => {
    expect([...CLAIM_STATES_ALLOWLIST]).toEqual(['todo', 'open', 'failing']);
  });

  it('accepts every allowlisted state', () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp', states: [...CLAIM_STATES_ALLOWLIST] });
      expect(r.success, `${name} should accept states:${JSON.stringify(CLAIM_STATES_ALLOWLIST)}`).toBe(true);
    }
  });

  it('accepts an omitted `states` (the ["todo"] default)', () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp' });
      expect(r.success, `${name} should accept omitted states`).toBe(true);
    }
  });

  it('REJECTS floor-protected and terminal states — the WI-1912 widening', () => {
    for (const { name, args } of TOOLS) {
      for (const bad of ['blocked', 'cursed', 'in_progress', 'passed', 'resolved', 'closed', 'deprecated', 'needs-human']) {
        const r = args.safeParse({ harness: 'papercusp', states: ['todo', bad] });
        expect(r.success, `${name} must reject states:['todo','${bad}']`).toBe(false);
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
  });
});
