/**
 * Unit tests for work_items:checkpoint (bee-context-efficiency P-010·P-011·P-012),
 * now on the bulk keyed-array contract (bulk-endpoint-standardization-2026-06-21).
 * The store (setWorkItemCheckpoint) + getWorkItem are mocked — this exercises the
 * tool's contract: per-item harness keying by the ITEM's own canonical harness
 * (EI-8805 — arg/ctx are only a lookup hint; a harness-null item keys under its own
 * null harness, never the session harness), write-vs-clear, the many form, and clean
 * per-item error surfacing.
 *
 * The single { id } call is now n=1 of the bulk call: it returns the house envelope
 * { ok, results:[{ ok, id, … | error }], counts } — assertions read results[0], not
 * the top level.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const setWorkItemCheckpoint = vi.fn();
const getWorkItemCheckpoint = vi.fn();
const getWorkItem = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  setWorkItemCheckpoint: (...a: unknown[]) => setWorkItemCheckpoint(...a),
  getWorkItemCheckpoint: (...a: unknown[]) => getWorkItemCheckpoint(...a),
}));
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  // checkpoint.ts fire-and-forgets markFeatureProgress + markIssueProgress (last_progress_at
  // bump on the matching family; WI-3006). The mock MUST export BOTH or the `void markX(...)`
  // call throws (undefined is not callable) — the throw lands inside the per-item runBulk fn,
  // AFTER a successful setWorkItemCheckpoint, so every item that actually WRITES fails ok:false
  // (agent-activity-liveness-truth integration). Missing markIssueProgress here red-pinned the
  // 4 write-path tests deterministically (WI-2900 gate triage).
  markFeatureProgress: () => Promise.resolve(true),
  markIssueProgress: () => Promise.resolve(true),
}));
import checkpoint from './checkpoint';

// EI-8824: force activeWorkspaceId()'s deterministic env-pin precedence (workspace-registry.ts
// precedence #2) instead of mocking the workspace-registry module — resolveConcreteWorkspaceId
// and activeWorkspaceId are same-module internal calls, so overriding the module's exports via
// vi.mock does NOT intercept the internal call resolveConcreteWorkspaceId makes to
// activeWorkspaceId(); only an out-of-module signal (the env var) actually steers it.
const PRIOR_WS_ENV = process.env.PAPERCUSP_WORKSPACE_ID;
beforeEach(() => {
  process.env.PAPERCUSP_WORKSPACE_ID = 'resolved-concrete-ws';
});
afterAll(() => {
  if (PRIOR_WS_ENV === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = PRIOR_WS_ENV;
});

const baseCtx = { uiClientId: 'opspawn-bee-1', sigVerifiedSpawn: true, workspaceId: 'default', harnessSlug: 'papercup' } as never;
const noHarnessCtx = { uiClientId: 'opspawn-bee-1', sigVerifiedSpawn: true, workspaceId: 'default' };
const parse = (x: unknown) => (checkpoint.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
/** Parse the full bulk envelope. */
const env = async (x: unknown, ctx: unknown = baseCtx) => {
  const res = (await checkpoint.handler(parse(x) as never, ctx as never)) as Out;
  return (res.data);
};
/** The single-call result is n=1 of the bulk envelope — read results[0]. */
const one = async (x: unknown, ctx: unknown = baseCtx) => (await env(x, ctx)).results[0];

beforeEach(() => {
  setWorkItemCheckpoint.mockReset();
  getWorkItemCheckpoint.mockReset();
  getWorkItem.mockReset();
  // The write now ALWAYS keys by the item's canonical harness (EI-8805), so it looks
  // the item up on every call. Default the lookup to a miss; tests that assert the
  // canonical harness override it. A resolved-null default keeps the `.catch(...)`
  // chain valid (an unmocked vi.fn returns undefined, which has no .catch).
  getWorkItem.mockResolvedValue(null);
  // P-003 verify-read default: the read-back mirrors whatever the store's LAST write
  // resolved to, so every pre-existing write-path test verifies clean without each
  // one re-declaring the round-trip. Verify-failure tests override this per-case.
  getWorkItemCheckpoint.mockImplementation(async () => {
    const last = setWorkItemCheckpoint.mock.results.at(-1);
    return last && last.type === 'return' ? await (last.value as Promise<string | null>) : null;
  });
});

describe('work_items:checkpoint (bulk keyed-array)', () => {
  it('keys the checkpoint by the ITEM\'s harness (looked up), disambiguated by the ctx hint', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue('did step 1; next: step 2');
    const out = await env({ id: 'WI-7', checkpoint: 'did step 1; next: step 2' });
    expect(out).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(getWorkItem).toHaveBeenCalledWith('WI-7', 'papercup');
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' },
      'did step 1; next: step 2',
    );
    expect(out.results[0]).toMatchObject({ ok: true, id: 'WI-7', harness: 'papercup', cleared: false });
    expect(out.results[0].length).toBeGreaterThan(0);
  });

  it('clears the checkpoint when blank/omitted (cleared:true)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue(null);
    const r = await one({ id: 'WI-7' });
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' },
      undefined,
    );
    expect(r).toMatchObject({ ok: true, id: 'WI-7', cleared: true, length: 0, contentHash: null });
  });

  it('EI-8987: returns a contentHash of the STORED text on a real write (same-call round-trip proof)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue('did step 1; next: step 2');
    const r = await one({ id: 'WI-7', checkpoint: 'did step 1; next: step 2' });
    expect(r.contentHash).toEqual(expect.stringMatching(/^[0-9a-f]{12}$/));
    // Deterministic: the same stored text always hashes to the same value.
    setWorkItemCheckpoint.mockResolvedValue('did step 1; next: step 2');
    const r2 = await one({ id: 'WI-7', checkpoint: 'did step 1; next: step 2' });
    expect(r2.contentHash).toBe(r.contentHash);
    // Different stored text hashes differently.
    setWorkItemCheckpoint.mockResolvedValue('a completely different checkpoint body');
    const r3 = await one({ id: 'WI-7', checkpoint: 'a completely different checkpoint body' });
    expect(r3.contentHash).not.toBe(r.contentHash);
  });

  it('EI-8987: contentHash is null when the write clears (nothing stored to hash)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue(null);
    const r = await one({ id: 'WI-7', checkpoint: '' });
    expect(r).toMatchObject({ ok: true, cleared: true, contentHash: null, verified: null, storedHead: null });
  });

  it('P-003: a write is VERIFY-READ via the reader path — verified:true + storedHead on the round-trip', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue('did step 1; next: step 2');
    const r = await one({ id: 'WI-7', checkpoint: 'did step 1; next: step 2' });
    expect(r).toMatchObject({ ok: true, verified: true, storedHead: 'did step 1; next: step 2' });
    // The read-back uses the SAME canonicalized ref as the write (harness + concrete ws).
    expect(getWorkItemCheckpoint).toHaveBeenCalledWith({ harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' });
  });

  it('P-003: a write the reader path CANNOT see fails loudly (checkpoint_verify_failed), never silently', async () => {
    // The WI-3549 class: the store echoes the write but a future read resolves to a
    // different key (or nothing). The tool must fail THIS item at write time.
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue('in-flight state');
    getWorkItemCheckpoint.mockResolvedValue(null); // reader path sees nothing
    const r = await one({ id: 'WI-7', checkpoint: 'in-flight state' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('checkpoint_verify_failed');
    expect(r.error).toContain('read back null');
  });

  it('P-003: a read-back that returns DIFFERENT bytes also fails verification', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue('fresh state');
    getWorkItemCheckpoint.mockResolvedValue('a stale prior checkpoint'); // wrong row wins the read
    const r = await one({ id: 'WI-7', checkpoint: 'fresh state' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('checkpoint_verify_failed');
  });

  it('P-003: storedHead caps at 80 chars', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    const long = 'x'.repeat(300);
    setWorkItemCheckpoint.mockResolvedValue(long);
    const r = await one({ id: 'WI-7', checkpoint: long });
    expect(r.ok).toBe(true);
    expect(r.storedHead).toHaveLength(80);
  });

  it('uses an explicit harness arg as the lookup hint over ctx', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'other-harness' });
    setWorkItemCheckpoint.mockResolvedValue('x');
    await one({ id: 'WI-7', checkpoint: 'x', harness: 'other-harness' });
    expect(getWorkItem).toHaveBeenCalledWith('WI-7', 'other-harness');
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'other-harness' }),
      'x',
    );
  });

  it('resolves the harness via a work-item lookup when neither arg nor ctx has one', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-9', harness: 'looked-up' });
    setWorkItemCheckpoint.mockResolvedValue('y');
    const r = await one({ id: 'WI-9', checkpoint: 'y' }, noHarnessCtx);
    expect(getWorkItem).toHaveBeenCalledWith('WI-9', undefined);
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'looked-up' }),
      'y',
    );
    expect(r.ok).toBe(true);
  });

  it('EI-8805: keys a harness-null item by its OWN (null) harness, not the session harness', async () => {
    // Repro: a harness-null EI (filed from an unscoped su session) checkpointed from a
    // session that HAS a harness. The write must key under the item's null harness (the
    // store canonicalizes it to the wildcard namespace work_items:get reads under) —
    // previously it substituted the session harness ('papercup') and the read silently
    // got null, losing the continuity state.
    getWorkItem.mockResolvedValue({ id: 'EI-8797', harness: null });
    setWorkItemCheckpoint.mockResolvedValue('continuity state');
    const r = await one({ id: 'EI-8797', checkpoint: 'continuity state' }); // baseCtx harnessSlug 'papercup'
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: null, workItemId: 'EI-8797', workspaceId: 'default' },
      'continuity state',
    );
    expect(r).toMatchObject({ ok: true, id: 'EI-8797', harness: null, cleared: false });
  });

  it('EI-8805: an unscoped session (harnessSlug "*") also keys a harness-null item by its null harness', async () => {
    getWorkItem.mockResolvedValue({ id: 'EI-8797', harness: null });
    setWorkItemCheckpoint.mockResolvedValue('state');
    const unscoped = { ...noHarnessCtx, harnessSlug: '*' } as never;
    await one({ id: 'EI-8797', checkpoint: 'state' }, unscoped);
    // '*' is sanitized to no lookup hint, and the item's own null harness wins.
    expect(getWorkItem).toHaveBeenCalledWith('EI-8797', undefined);
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: null, workItemId: 'EI-8797', workspaceId: 'default' },
      'state',
    );
  });

  it('errors cleanly when no harness can be resolved (unknown id, no item, no hint)', async () => {
    getWorkItem.mockResolvedValue(null);
    const r = await one({ id: 'WI-404', checkpoint: 'z' }, noHarnessCtx);
    expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.id).toBe('WI-404');
    expect(r.error).toContain('could not resolve a harness');
  });

  it('EI-8824: an unscoped superuser session (ctx.workspaceId "*") never persists the literal wildcard — resolves to the concrete active workspace instead', async () => {
    // Repro: work_items:checkpoint from a `?superuser=1` session with no chosen
    // workspace passes ctx.workspaceId='*' (the read-scoping sentinel). Previously
    // `c.workspaceId ?? undefined` let the truthy '*' win and stored the checkpoint
    // under a literal workspace_id='*' row that work_items:get's checkpoint read
    // (which resolves via activeWorkspaceId(), and NEVER returns '*') could never see
    // — the checkpoint silently vanished on the next (especially post-compaction) read.
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    setWorkItemCheckpoint.mockResolvedValue('state');
    const superuserCtx = { uiClientId: 'su-1', sigVerifiedSpawn: true, workspaceId: '*', harnessSlug: 'papercup' } as never;
    await one({ id: 'WI-7', checkpoint: 'state' }, superuserCtx);
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'resolved-concrete-ws' },
      'state',
    );
  });

  it('surfaces a store error cleanly via runBulk keyOf (batch survives)', async () => {
    setWorkItemCheckpoint.mockRejectedValue(new Error('pg down'));
    const r = await one({ id: 'WI-7', checkpoint: 'x' });
    expect(r).toEqual({ ok: false, id: 'WI-7', error: 'pg down' });
  });

  it('items:[…] checkpoints many; per-item harness overrides; one bad item fails only itself', async () => {
    // WI-A: ctx harness (papercup), writes. WI-B: per-item harness 'web'. WI-C: no harness anywhere → fails.
    setWorkItemCheckpoint.mockImplementation(async (key: { workItemId: string }) =>
      key.workItemId === 'WI-A' ? 'snap-a' : 'snap-b',
    );
    getWorkItem.mockResolvedValue(null); // WI-C lookup misses
    const out = await env(
      { items: [{ id: 'WI-A', checkpoint: 'a' }, { id: 'WI-B', checkpoint: 'b', harness: 'web' }, { id: 'WI-C', checkpoint: 'c' }] },
      noHarnessCtx, // no ctx harness → WI-A & WI-B rely on per-item/none, WI-C unresolvable
    );
    // WI-A has no per-item harness and noHarnessCtx → also unresolvable; WI-B resolves via 'web'.
    expect(out.ok).toBe(true);
    expect(out.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
      ['WI-A', false],
      ['WI-B', true],
      ['WI-C', false],
    ]);
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ harness: 'web', workItemId: 'WI-B' }), 'b');
    expect(out.counts).toEqual({ ok: 1, failed: 2 });
  });

  it('items:[…] with a batch harness default applies to items that omit one', async () => {
    setWorkItemCheckpoint.mockResolvedValue('s');
    const out = await env({ harness: 'def', items: [{ id: 'WI-1', checkpoint: 'a' }, { id: 'WI-2', checkpoint: 'b', harness: 'web' }] }, noHarnessCtx);
    expect(out.counts).toEqual({ ok: 2, failed: 0 });
    expect(setWorkItemCheckpoint).toHaveBeenNthCalledWith(1, expect.objectContaining({ harness: 'def', workItemId: 'WI-1' }), 'a');
    expect(setWorkItemCheckpoint).toHaveBeenNthCalledWith(2, expect.objectContaining({ harness: 'web', workItemId: 'WI-2' }), 'b');
  });
});
