/**
 * work_items:claim — the dependency-BLOCKED warning (P-013, work-item-dependency-edges-2026-08-02).
 *
 * WHY THIS EXISTS, so the assertions read as consequences rather than trivia.
 *
 * The plan item that produced this code originally said the opposite of what shipped: "precedent
 * favors ENFORCING [blocking on the by-id path] ... refuse by default with an explicit override
 * arg." D-008 overturned that after reading both by-id doors. Readiness floors (terminal-state,
 * cooldown, claim-hold, needs-human, dependency-blocking) gate SELF-SELECT only; the by-id claim
 * is the deliberate operator override, because taking a blocked item BY NAME is how you take
 * ownership of it in order to unblock it. Enforcing here would have broken EI-8972's tested
 * escape hatch and made blocked work unreopenable.
 *
 * So the defect was never a missing floor — it was a missing SIGNAL. `scheduler:get_next` will
 * not serve a blocked item, yet a by-id claim of one returned a bare ok:true, indistinguishable
 * from claiming ready work. That is precisely the WI-5826 shape (a completed row claimed by id,
 * fixed in the claim TOOL's response, not in the UPDATE), and this is its sibling.
 *
 * The two halves below are ONE invariant and must be asserted together — the claim must keep
 * SUCCEEDING *and* keep WARNING. Asserting either alone lets a future edit satisfy the test while
 * destroying the point: drop the warning and it is a silent regression to the old bug; add a
 * floor and it "passes" while breaking reopen/inherit. (The complementary source-level assertion
 * that `claimWorkItem` never grows the floor lives in
 * lib/scheduler/blocking-floor-single-source.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me', workspaceId: 'ws-1' as string | null }));
const fleetAdmission = vi.hoisted(() => ({
  decision: { allowed: true, scoped: false } as any,
  notify: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId }),
}));
// PARTIAL mock (importOriginal) — never a hand-listed factory. See the long note in
// claim.test.ts: a forgotten export resolves to `undefined`, claim.ts throws on it, and every
// test in the file fails with an assertion naming neither the export nor the mock.
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimWorkItem: vi.fn(),
  classifyClaimFailure: vi.fn(),
  getWorkItem: vi.fn(),
  readUnresolvedDepBlockers: vi.fn(),
}));
vi.mock('./claim-hold-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordClaimHoldBypassAudit: vi.fn(async () => {}),
  notifyClaimHoldBypass: vi.fn(async () => {}),
}));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitWorkItemForFleetTarget: vi.fn(async () => fleetAdmission.decision),
  notifyFleetScopeRefusal: fleetAdmission.notify,
  fleetScopeLeaderRemedy: vi.fn(() => 'remedy: scheduler:set_claim_spec { … }'),
}));
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));

const getClaimTimeCheckpointHint = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getClaimTimeCheckpointHint: (...a: unknown[]) => getClaimTimeCheckpointHint(...a),
}));

import { claimWorkItem, getWorkItem, readUnresolvedDepBlockers } from '../../work-items';
const claimM = vi.mocked(claimWorkItem);
const getWorkItemM = vi.mocked(getWorkItem);
const blockersM = vi.mocked(readUnresolvedDepBlockers);
const mod = await import('./claim');
const tool = mod.default;
const { blockedClaimWarning } = mod;

type Out = { data: any };
const body = async (args: unknown) => ((await tool.handler(args as never, {} as never)) as Out).data;

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  identity.workspaceId = 'ws-1';
  fleetAdmission.decision = { allowed: true, scoped: false };
  claimM.mockImplementation(async (id: string) => ({ id, harness: 'papercup', assignee: 'me' }) as never);
  getWorkItemM.mockResolvedValue(null as never);
  getClaimTimeCheckpointHint.mockResolvedValue(null);
  blockersM.mockResolvedValue([]);
});

describe('blockedClaimWarning (pure)', () => {
  it('returns null when there are no blockers', () => {
    expect(blockedClaimWarning(null)).toBeNull();
    expect(blockedClaimWarning(undefined)).toBeNull();
    expect(blockedClaimWarning([])).toBeNull();
  });

  it('names the blockers and says the claim SUCCEEDED on purpose (D-008)', () => {
    const w = blockedClaimWarning([
      { ref: 'EI-100', kind: 'issue' },
      { ref: 'papercusp#F-7', kind: 'feature' },
    ]);
    expect(w).toBeTruthy();
    // The refs are the actionable part: an agent that cannot see WHICH blockers cannot act.
    expect(w).toContain('EI-100');
    expect(w).toContain('papercusp#F-7');
    expect(w).toContain('2 unresolved dependencies');
    // Without this, the warning reads as a failure and an agent "retries" a claim it already holds.
    expect(w).toMatch(/claim SUCCEEDED/i);
    // The load-bearing consequence: the queue will not hand this item back.
    expect(w).toMatch(/scheduler:get_next/);
  });

  it('uses the singular for exactly one blocker', () => {
    expect(blockedClaimWarning([{ ref: 'EI-1', kind: 'issue' }])).toContain('1 unresolved dependency');
  });

  it('caps the named list but still reports the true total', () => {
    // A 40-blocker dump would be unreadable AND would blow the response budget; a truncated
    // list that also under-reports the COUNT would understate the problem. Do both.
    const many = Array.from({ length: 12 }, (_, i) => ({ ref: `EI-${i + 1}`, kind: 'issue' }));
    const w = blockedClaimWarning(many)!;
    expect(w).toContain('12 unresolved dependencies');
    expect(w).toContain('+4 more');
    expect(w).not.toContain('EI-9,');
  });

  it('returns null rather than an empty warning when every ref is blank', () => {
    // A malformed edge must not produce "BLOCKED by 1 unresolved dependency: " with nothing named.
    expect(blockedClaimWarning([{ ref: '   ', kind: 'issue' }])).toBeNull();
  });
});

describe('work_items:claim — a blocked by-id claim SUCCEEDS and WARNS (P-013 / D-008)', () => {
  it('claims a blocked item successfully AND attaches the warning + the blockers', async () => {
    blockersM.mockResolvedValue([{ ref: 'EI-100', kind: 'issue' }]);
    const b = await body({ id: 'WI-BLOCKED' });
    // HALF ONE — the claim is NOT refused. A floor here would break EI-8972's escape hatch.
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-BLOCKED' });
    expect(b.results[0].error).toBeUndefined();
    // HALF TWO — and it does not look like fresh, ready work.
    expect(b.results[0].blockedWarning).toMatch(/BLOCKED/);
    expect(b.results[0].blockedBy).toEqual([{ ref: 'EI-100', kind: 'issue' }]);
  });

  it('attaches the warning on the CHECKPOINT response shape too, not just the bare one', async () => {
    // claimOne has TWO response-construction sites (with / without an EI-529 checkpoint hint).
    // Every claim-time guard has to be spread onto both, and adding one to a single site is a
    // silent half-fix that no test asserting only the common path would catch.
    getClaimTimeCheckpointHint.mockResolvedValue({ checkpoint: 'did: X', checkpointAgeMs: 1_000 });
    blockersM.mockResolvedValue([{ ref: 'EI-200', kind: 'issue' }]);
    const b = await body({ id: 'WI-BOTH' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-BOTH', checkpoint: 'did: X' });
    expect(b.results[0].blockedWarning).toContain('EI-200');
  });

  it('omits the fields entirely on an unblocked claim', async () => {
    blockersM.mockResolvedValue([]);
    const b = await body({ id: 'WI-READY' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-READY' });
    expect(b.results[0].blockedWarning).toBeUndefined();
    expect(b.results[0].blockedBy).toBeUndefined();
  });

  it('degrades to a normal successful claim when the blocker read throws', async () => {
    // Fail-soft on purpose: an advisory that fires spuriously during a PG blip is worse than
    // silence, and unlike WI-6737's checkpoint case this warning asserts nothing when absent.
    // What must NOT happen is the read failure costing the caller the claim.
    blockersM.mockRejectedValue(new Error('pg down'));
    const b = await body({ id: 'WI-PGDOWN' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-PGDOWN' });
    expect(b.results[0].error).toBeUndefined();
    expect(b.results[0].blockedWarning).toBeUndefined();
  });

  it('evaluates blockers PER ITEM across a batch', async () => {
    blockersM.mockImplementation(async (id: string) =>
      id === 'WI-HOT' ? [{ ref: 'EI-300', kind: 'issue' }] : [],
    );
    const b = await body({ ids: ['WI-COLD', 'WI-HOT'] });
    expect(b.results[0].blockedWarning).toBeUndefined();
    expect(b.results[1]).toMatchObject({ id: 'WI-HOT' });
    expect(b.results[1].blockedWarning).toContain('EI-300');
  });

  it('scopes the blocker read to the claimed item and its harness', async () => {
    blockersM.mockResolvedValue([]);
    await body({ id: 'WI-SCOPE' });
    expect(blockersM).toHaveBeenCalledWith('WI-SCOPE', 'papercup');
  });
});
