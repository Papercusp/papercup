/**
 * hold_open.test.ts — work_items:hold_open handler.
 *
 * EI-18672701535825889: before this fix, `clear` only consulted
 * readWorkItemHeldOpenBy (the `held_open_by` LEASE convention) to decide whether a
 * non-holder needed `force:true`. A row held ONLY via the sibling `claim_hold_by`
 * DURABLE-PARK convention (release{claimHold:true}) read as having no prior holder
 * at all, so ANY agent could clear it — no ownership check, no force required. These
 * tests pin both the closed gap (durable-park clears now need force, same as a
 * lease) and the new policy-gate override (force:true alone must not lift a hold
 * whose reason names a deliberate policy-tier gate).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me', workspaceId: 'ws-1' as string | null }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId }),
}));

// D-009: keep the REAL pure planner + fingerprint (the CAS semantics under test), mock only
// the two database seams. The real-store path is pinned by hold_open.integration.test.ts.
const readDurableParkControlRow = vi.fn();
const runWorkItemDurableParkReconciliation = vi.fn();
vi.mock('../../work-items-durable-park-audit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readDurableParkControlRow: (...a: unknown[]) => readDurableParkControlRow(...a),
  runWorkItemDurableParkReconciliation: (...a: unknown[]) => runWorkItemDurableParkReconciliation(...a),
}));

const getWorkItem = vi.fn();
const setWorkItemClaimHold = vi.fn();
vi.mock('../../work-items', async (importOriginal) => ({
  // Keep the REAL readWorkItemClaimHoldProvenance (+ its readers) — it's a pure
  // payload reader and is exactly the unified-read fix this suite exercises.
  ...(await importOriginal<object>()),
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  setWorkItemClaimHold: (...a: unknown[]) => setWorkItemClaimHold(...a),
}));

const sendMessage = vi.fn();
vi.mock('../coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));

const holdOpen = (await import('./hold_open')).default;

const parse = (x: unknown) => (holdOpen.args as { parse: (x: unknown) => unknown }).parse(x);
const call = async (x: unknown, ctx: unknown = {}) => {
  const res = (await holdOpen.handler(parse(x) as never, ctx as never)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0].text);
};

function itemWith(payload: Record<string, unknown> | null) {
  return { id: 'WI-9', harness: 'papercup', payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  identity.workspaceId = 'ws-1';
  sendMessage.mockResolvedValue(undefined);
  setWorkItemClaimHold.mockResolvedValue({ id: 'WI-9', harness: 'papercup', hold: false, applicable: true });
});

describe('work_items:hold_open clear — claim-hold ownership gate', () => {
  it('clears your OWN held_open lease without force', async () => {
    getWorkItem.mockResolvedValue(itemWith({ _claimHold: true, held_open_by: 'me', held_open_reason: 'verifying' }));
    const out = await call({ id: 'WI-9', clear: true });
    expect(out).toMatchObject({ ok: true, held: false, clearedFrom: 'me' });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith('WI-9', false, { harness: 'papercup' });
  });

  it('WI-6746: an unreadable item reports a READ FAILURE, never "not found"', async () => {
    // A caller placing or clearing a HOLD who is told "not found" re-files or re-creates
    // the item; one told the read failed retries. Same null, opposite correct action.
    getWorkItem.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const out = await call({ id: 'WI-9', clear: true });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('work_item_unreadable');
    expect(out.error).not.toMatch(/not found/i);
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('refuses to clear a PEER\'s held_open lease without force (pre-existing behavior)', async () => {
    getWorkItem.mockResolvedValue(itemWith({ _claimHold: true, held_open_by: 'peer', held_open_reason: 'reviewing' }));
    const out = await call({ id: 'WI-9', clear: true });
    expect(out).toMatchObject({ ok: false, error: 'not_holder', heldBy: 'peer' });
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('EI-18672701535825889 (the fix): refuses to clear a PEER\'s durable claim_hold PARK without force — previously silently succeeded', async () => {
    getWorkItem.mockResolvedValue(itemWith({ _claimHold: true, claim_hold_by: 'peer', claim_hold_reason: 'do not re-pick-up' }));
    const out = await call({ id: 'WI-9', clear: true });
    expect(out).toMatchObject({ ok: false, error: 'not_holder', heldBy: 'peer', convention: 'claim_hold (durable park)' });
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('clears a peer\'s durable park WITH force:true (ordinary, non-policy reason)', async () => {
    getWorkItem.mockResolvedValue(itemWith({ _claimHold: true, claim_hold_by: 'peer', claim_hold_reason: 'do not re-pick-up' }));
    const out = await call({ id: 'WI-9', clear: true, force: true });
    expect(out).toMatchObject({ ok: true, held: false, clearedFrom: 'peer' });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith('WI-9', false, { harness: 'papercup' });
  });

  it('EI-18672701535825889 suggestion #5: force:true ALONE is refused on a policy-tier gate (D-NNN reason)', async () => {
    getWorkItem.mockResolvedValue(
      itemWith({ _claimHold: true, claim_hold_by: 'peer', claim_hold_reason: 'Explicit policy-tier human gate (D-003): git-sync' }),
    );
    const out = await call({ id: 'WI-9', clear: true, force: true });
    expect(out).toMatchObject({ ok: false, error: 'policy_gate_requires_owner_override', heldBy: 'peer' });
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('policy-tier gate lifts only with BOTH force:true and ownerOverride:true', async () => {
    getWorkItem.mockResolvedValue(
      itemWith({ _claimHold: true, claim_hold_by: 'peer', claim_hold_reason: 'triageDecision:"gate" — security review' }),
    );
    const out = await call({ id: 'WI-9', clear: true, force: true, ownerOverride: true });
    expect(out).toMatchObject({ ok: true, held: false, clearedFrom: 'peer' });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith('WI-9', false, { harness: 'papercup' });
  });

  it('self-clearing your OWN policy-gate hold needs neither force nor ownerOverride', async () => {
    getWorkItem.mockResolvedValue(
      itemWith({ _claimHold: true, claim_hold_by: 'me', claim_hold_reason: 'D-003 policy-tier gate' }),
    );
    const out = await call({ id: 'WI-9', clear: true });
    expect(out).toMatchObject({ ok: true, held: false, clearedFrom: 'me' });
  });

  it('a row with NEITHER convention (genuinely unattributed) clears freely, as before', async () => {
    getWorkItem.mockResolvedValue(itemWith({ _claimHold: true }));
    const out = await call({ id: 'WI-9', clear: true });
    expect(out).toMatchObject({ ok: true, held: false, clearedFrom: null });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith('WI-9', false, { harness: 'papercup' });
  });
});

/**
 * EI-20710656847511624 — the hold RESPONSE must disclose that the hold expires.
 *
 * Three agents in a row fenced the same owner-gated live-money items with hold_open
 * intending "permanent" and each got "until I die": the dead-owner sweeps match
 * `held_open_by = <dead owner>` and lift the hold + `_claimHold`. Every one of them had
 * verified the hold APPLIED and stopped there, because `{ ok:true, held:true }` reads as
 * a completed fence. These pin the disclosure so a refactor cannot quietly drop it.
 */
describe('work_items:hold_open hold — lease-expiry disclosure', () => {
  beforeEach(() => {
    setWorkItemClaimHold.mockResolvedValue({ id: 'WI-9', harness: 'papercup', hold: true, applicable: true });
    getWorkItem.mockResolvedValue(itemWith(null));
  });

  it('an ordinary hold discloses that it is a LEASE and names the durable alternative', async () => {
    const out = await call({ id: 'WI-9', reason: 'verifying the fix before anyone closes it' });
    expect(out).toMatchObject({ ok: true, held: true, heldBy: 'me' });
    expect(out.durability).toBe('lease (expires when you do)');
    // The two things a caller must be told: it expires, and what to use instead.
    expect(out.leaseNote).toMatch(/LEASE, NOT a permanent fence/);
    expect(out.leaseNote).toMatch(/release \{ claimHold:true \}/);
  });

  it('a POLICY-TIER reason is reported exempt, but still warns the exemption keys off wording', async () => {
    const out = await call({ id: 'WI-9', reason: 'Explicit policy-tier human gate (D-003): owner sign-off' });
    expect(out.durability).toBe('lease (policy-tier exempt from reaping)');
    expect(out.leaseNote).toMatch(/exempt/);
    expect(out.leaseNote).toMatch(/WORDING, not intent/);
    expect(out.leaseNote).toMatch(/release \{ claimHold:true \}/);
  });

  it('the disclosure is UNCONDITIONAL — a terse reason still gets it', async () => {
    // The failure mode was a caller concluding "fenced" from { ok:true, held:true } alone,
    // so the warning must not depend on how the reason happens to be phrased.
    const out = await call({ id: 'WI-9', reason: 'gate' });
    expect(out.leaseNote).toBeTruthy();
    expect(out.durability).toMatch(/^lease/);
  });

  it('re-stamping a peer\'s hold keeps BOTH the re-stamp note and the lease disclosure', async () => {
    getWorkItem.mockResolvedValue(itemWith({ _claimHold: true, held_open_by: 'peer', held_open_reason: 'theirs' }));
    const out = await call({ id: 'WI-9', reason: 'taking over the gate' });
    expect(out.note).toMatch(/re-stamped \(was held by peer\)/);
    expect(out.leaseNote).toMatch(/LEASE/);
  });
});
