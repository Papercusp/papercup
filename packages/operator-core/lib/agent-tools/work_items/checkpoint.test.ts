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
// EI-20004424625703051: bind the cap-eviction guard to the REAL constant, so raising
// the cap re-tunes the test instead of breaking it — the guard is about the note being
// truthful at the boundary, not about the boundary sitting at any particular number.
import { CARRY_NOTE_MAX_CHECKS } from '../../carry-note';

const setWorkItemCheckpoint = vi.fn();
const setWorkItemCheckpointWithPrior = vi.fn();
const getWorkItemCheckpoint = vi.fn();
const getWorkItem = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  setWorkItemCheckpoint: (...a: unknown[]) => setWorkItemCheckpoint(...a),
  setWorkItemCheckpointWithPrior: (...a: unknown[]) => setWorkItemCheckpointWithPrior(...a),
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
  // EI-19395730805289668: same trap, third instance — checkpoint.ts now also imports
  // isClaimHoldParked (for the prose-pause nudge), and an unmocked export is `undefined`,
  // which throws at the call and fails EVERY write-path test ok:false exactly as described
  // above. Re-implemented rather than importActual'd on purpose: the point of this mock is
  // to keep work-items.ts (and its DB dependencies) out of a unit test. Mirrors the real
  // predicate's text-compare, which matches both the boolean and the legacy string form.
  isClaimHoldParked: (payload: unknown) =>
    !!payload && typeof payload === 'object' &&
    String((payload as Record<string, unknown>)._claimHold) === 'true',
}));
import checkpoint from './checkpoint';
// EI-19400299440742193: the guard asserts against the REAL caps, not literals, so a
// future cap change moves the test with the code instead of silently un-pinning it.
import { CARRY_CAP_HARD_MULTIPLE, CARRY_ROW_SOFT_CAPS } from '../../carry-note';
import { readFileSync } from 'node:fs';
// Resolves to the MOCK above (that is the point) — so its keys are the double's real export set.
import * as workItemsMocked from '../../work-items';

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
  setWorkItemCheckpointWithPrior.mockReset();
  getWorkItemCheckpoint.mockReset();
  getWorkItem.mockReset();
  // EI-9325: checkpoint.ts routes every PLAIN replace-on-write (non-append,
  // non-clear) through setWorkItemCheckpointWithPrior instead of setWorkItemCheckpoint
  // now, to get the prior length for free. Default it to delegate straight through to
  // the (still separately mockable) setWorkItemCheckpoint fn with priorLength:0 (no
  // shrink signal) — so every EXISTING test that only configures
  // setWorkItemCheckpoint.mockResolvedValue(...) keeps working unchanged. Tests that
  // specifically exercise the shrinkWarning override this mock directly.
  setWorkItemCheckpointWithPrior.mockImplementation(async (ref: unknown, checkpoint: string | null | undefined) => ({
    stored: await setWorkItemCheckpoint(ref, checkpoint),
    priorLength: 0,
  }));
  // The write now ALWAYS keys by the item's canonical harness (EI-8805), so it looks
  // the item up on every call. Default the lookup to a miss; tests that assert the
  // canonical harness override it. A resolved-null default keeps the `.catch(...)`
  // chain valid (an unmocked vi.fn returns undefined, which has no .catch).
  getWorkItem.mockResolvedValue(null);
  // P-003 verify-read default: the read-back mirrors whatever the store's LAST write
  // resolved to, so every pre-existing write-path test verifies clean without each
  // one re-declaring the round-trip. Verify-failure tests override this per-case.
  //
  // P-007: mirror setWorkItemCheckpointWithPrior — checkpoint.ts now routes EVERY
  // path (replace, append, clear) through it, so keying this off the old
  // setWorkItemCheckpoint made the read-back return null for any test that stubs the
  // WithPrior path directly. The default shim above still delegates to
  // setWorkItemCheckpoint, so tests that stub only that one keep working unchanged.
  getWorkItemCheckpoint.mockImplementation(async () => {
    const last = setWorkItemCheckpointWithPrior.mock.results.at(-1);
    if (!last || last.type !== 'return') return null;
    const resolved = (await last.value) as { stored?: string | null } | null;
    return resolved?.stored ?? null;
  });
});

describe('work_items:checkpoint (bulk keyed-array)', () => {
  it('opts out of the ambient workspace transaction because the handler owns its DB scopes', () => {
    expect((checkpoint as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

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

  describe('EI-9036: append mode (join onto the existing checkpoint instead of replacing it)', () => {
    it('append:true joins the new text onto the existing checkpoint with a --- separator', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      // Only the PRIOR-fetch call is stubbed explicitly; the post-write verify-read
      // falls back to the suite default (echoes the last setWorkItemCheckpoint call).
      getWorkItemCheckpoint.mockResolvedValueOnce('did step 1; next: step 2 (detailed 4-file build record)');
      setWorkItemCheckpoint.mockImplementation(async (_key: unknown, text: string) => text);
      const r = await one({ id: 'WI-7', checkpoint: 'tsc came back clean', append: true });
      expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
        { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' },
        'did step 1; next: step 2 (detailed 4-file build record)\n\n---\ntsc came back clean',
      );
      expect(r).toMatchObject({ ok: true, id: 'WI-7', cleared: false, verified: true });
      // The detailed prior record survives verbatim inside the stored text — the exact
      // failure EI-9036 reported (an addendum call silently wiping it) cannot happen.
      expect(r.storedHead).toContain('detailed 4-file build record');
    });

    it('append:true with NO prior checkpoint just stores the addendum as-is (no leading separator)', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      getWorkItemCheckpoint.mockResolvedValueOnce(null); // nothing stored yet
      setWorkItemCheckpoint.mockImplementation(async (_key: unknown, text: string) => text);
      const r = await one({ id: 'WI-7', checkpoint: 'first note', append: true });
      expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.anything(), 'first note');
      expect(r).toMatchObject({ ok: true, cleared: false });
    });

    it('append:true rejects a blank/omitted checkpoint (append + clear is a contradiction) without touching the store', async () => {
      const r = await one({ id: 'WI-7', checkpoint: '', append: true });
      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(getWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('append:true requires a non-blank');
    });

    it('append:true still rejects an omitted checkpoint when no checks are supplied', async () => {
      const r = await one({ id: 'WI-7', append: true });
      expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('append:true requires a non-blank');
    });

    it('append:true truncates the OLDEST content (front) with a marker when the join would exceed the 32000-char cap', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      const prior = 'P'.repeat(31990);
      const addendum = 'A'.repeat(50);
      getWorkItemCheckpoint.mockResolvedValueOnce(prior);
      setWorkItemCheckpoint.mockImplementation(async (_key: unknown, text: string) => text);
      const r = await one({ id: 'WI-7', checkpoint: addendum, append: true });
      expect(r.ok).toBe(true);
      const [, storedArg] = setWorkItemCheckpoint.mock.calls[0] as [unknown, string];
      expect(storedArg.length).toBeLessThanOrEqual(32000);
      expect(storedArg.startsWith('…[older checkpoint content truncated]…')).toBe(true);
      // The newest addendum — the part the caller just wrote — is never the part cut.
      expect(storedArg.endsWith(addendum)).toBe(true);
    });

    it('EI-18665443723911343: the shorthand `append` accepts the literal string "true"/"false" identically to a real boolean', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      getWorkItemCheckpoint.mockResolvedValueOnce('prior note');
      setWorkItemCheckpoint.mockImplementation(async (_key: unknown, text: string) => text);
      // Previously: "expected boolean, received string" on this exact shorthand shape,
      // even though items:[{ ..., append: true }] accepted the identical value.
      const r = await one({ id: 'WI-7', checkpoint: 'addendum via string append', append: 'true' as unknown as boolean });
      expect(r.ok).toBe(true);
      expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.anything(), 'prior note\n\n---\naddendum via string append');
    });

    it('EI-18665443723911343: the string "false" is NOT truthy-coerced (unlike z.coerce.boolean/Boolean()) — plain replace, no append', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpoint.mockResolvedValue('brand new note');
      const r = await one({ id: 'WI-7', checkpoint: 'brand new note', append: 'false' as unknown as boolean });
      expect(r.ok).toBe(true);
      // append:false behaves as no-append: a plain overwrite, not a join onto a prior
      // checkpoint. (getWorkItemCheckpoint is still called once, for the post-write
      // verify-read every write path goes through — that's unrelated to append mode.)
      expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.anything(), 'brand new note');
    });

    it('EI-18665443723911343: a non-boolean-ish string (not "true"/"false") still fails validation, unchanged', () => {
      expect(() => parse({ id: 'WI-7', checkpoint: 'x', append: 'yes' })).toThrow();
    });

    it('a per-item append:true overrides a batch-level append:false/omitted default, and vice versa', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      getWorkItemCheckpoint.mockResolvedValueOnce('existing');
      setWorkItemCheckpoint.mockImplementation(async (_key: unknown, text: string) => text);
      // Batch default append:true, no per-item override → still appends.
      const out = await env({ append: true, items: [{ id: 'WI-7', checkpoint: 'addendum' }] });
      expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.anything(), 'existing\n\n---\naddendum');
      expect(out.results[0].ok).toBe(true);
    });

    it('plain replace-on-write (no append) is UNCHANGED: never reads the prior checkpoint, always overwrites', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpoint.mockResolvedValue('brand new note');
      const r = await one({ id: 'WI-7', checkpoint: 'brand new note' });
      // The default suite mock for getWorkItemCheckpoint only fires on the verify-read
      // (post-write); confirm no PRE-write read happened by checking call count is
      // exactly the verify-read's one call, not two.
      expect(getWorkItemCheckpoint).toHaveBeenCalledTimes(1);
      expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.anything(), 'brand new note');
      expect(r.ok).toBe(true);
    });
  });

  describe('EI-18132462898750489: ownership guard — no silent overwrite of a peer\'s held item', () => {
    // WI-6746: this ownership guard is derived ENTIRELY from the pre-write read —
    // setWorkItemCheckpoint has no assignee check of its own. While that read was
    // swallowed with `.catch(() => null)`, a PG fault made `item` null, which made the
    // `item && item.assignee && …` guard fall through, which let the write land on a
    // peer's item: precisely the corruption this EI added the guard to prevent, plus the
    // false "my write succeeded, so I must hold this" signal it names as the root cause
    // of a bogus "currently holding" directive surviving into a compaction summary.
    it('FAILS CLOSED when the ownership read THROWS — a PG fault must not bypass not_holder (WI-6746)', async () => {
      getWorkItem.mockRejectedValue(new Error('connection terminated unexpectedly'));
      const r = await one({ id: 'WI-5557', checkpoint: 'write during a PG blip' }, {
        ...(baseCtx as Record<string, unknown>),
        uiClientId: 'su-2e534e59-ceb6-48b5-87b8-3b362f652725',
      });
      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('work_item_unreadable');
      expect(r.error).toMatch(/connection terminated/);
      // Must not masquerade as the harness-resolution error, which sends the agent to
      // pass { harness } — a remedy that cannot fix an unhealthy database.
      expect(r.error).not.toMatch(/could not resolve a harness/);
    });

    it('an unreadable ownership read is refused even when a harness hint WAS supplied (WI-6746)', async () => {
      // The hint used to mask the failure: with `hintHarness` set, a null item skipped the
      // "could not resolve a harness" branch and fell straight through to the write.
      getWorkItem.mockRejectedValue(new Error('statement timeout'));
      const r = await one({ id: 'WI-5557', harness: 'papercup', checkpoint: 'note' });
      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(setWorkItemCheckpointWithPrior).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('work_item_unreadable');
    });

    it('refuses a checkpoint write when the item is assigned to a DIFFERENT agent (not_holder)', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-5557', harness: 'papercup', assignee: 'su-a7d08fd3-ba65-45d3-a07f-a335b9004454' });
      const r = await one({ id: 'WI-5557', checkpoint: 'trying to write on a peer\'s item' }, {
        ...(baseCtx as Record<string, unknown>),
        uiClientId: 'su-2e534e59-ceb6-48b5-87b8-3b362f652725',
      });
      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not_holder');
      expect(r.error).toContain('su-a7d08fd3-ba65-45d3-a07f-a335b9004454');
    });

    it('refuses a CLEAR (blank checkpoint) on an item assigned to someone else too', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-5557', harness: 'papercup', assignee: 'someone-else' });
      const r = await one({ id: 'WI-5557' }, { ...(baseCtx as Record<string, unknown>), uiClientId: 'not-the-holder' });
      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not_holder');
    });

    it('allows the write when the item is assigned to the CALLER itself', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup', assignee: 'opspawn-bee-1' });
      setWorkItemCheckpoint.mockResolvedValue('my own progress');
      const r = await one({ id: 'WI-7', checkpoint: 'my own progress' });
      expect(r.ok).toBe(true);
    });

    it('allows the write when the item is UNASSIGNED (about to be claimed)', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup', assignee: null });
      setWorkItemCheckpoint.mockResolvedValue('note before claiming');
      const r = await one({ id: 'WI-7', checkpoint: 'note before claiming' });
      expect(r.ok).toBe(true);
    });

    it('a mixed batch fails only the peer-held item; the caller\'s own item still writes', async () => {
      getWorkItem.mockImplementation(async (id: string) =>
        id === 'WI-MINE'
          ? { id: 'WI-MINE', harness: 'papercup', assignee: 'opspawn-bee-1' }
          : { id: 'WI-THEIRS', harness: 'papercup', assignee: 'someone-else' },
      );
      setWorkItemCheckpoint.mockResolvedValue('progress');
      const out = await env({ items: [{ id: 'WI-MINE', checkpoint: 'progress' }, { id: 'WI-THEIRS', checkpoint: 'nope' }] });
      expect(out.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
        ['WI-MINE', true],
        ['WI-THEIRS', false],
      ]);
      expect(out.results[1].error).toContain('not_holder');
    });
  });

  describe('EI-19399101595349211: the mock must cover what checkpoint.ts actually imports', () => {
    /**
     * A `vi.mock` factory REPLACES the module wholesale, so the moment checkpoint.ts imports an
     * ADDITIONAL symbol from work-items, that symbol is `undefined` here, the call throws inside
     * the per-item runBulk callback — after a successful store write — and every test that
     * actually WRITES comes back ok:false.
     *
     * That has now happened three times (markIssueProgress / WI-2900, isClaimHoldParked / today).
     * What makes it expensive is that the failure names NOTHING: ~20 unrelated-looking tests go
     * red at once, none mentioning the symbol you just added, so the first hypothesis is always
     * "I broke the write path" rather than "my import list changed".
     *
     * This guard turns that into one failure that names the missing symbol. It is deliberately
     * source-parsing rather than type-level: the drift is between a RUNTIME object's keys and an
     * import list, which the compiler cannot see (the real module type-checks fine either way).
     */
    it('every symbol checkpoint.ts imports from work-items is provided by the mock', () => {
      const src = readFileSync(new URL('./checkpoint.ts', import.meta.url), 'utf8');
      const m = src.match(/import\s*\{([^}]+)\}\s*from\s*'\.\.\/\.\.\/work-items'/);
      // A miss here means the import was reshaped (namespace/default/multi-line-with-comments).
      // Fail loudly rather than silently vacuously passing — a guard that quietly matches nothing
      // is worse than no guard, because it reads as coverage.
      expect(m, 'could not locate the work-items import in checkpoint.ts — update this guard').not.toBeNull();

      const imported = m![1]
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      expect(imported.length).toBeGreaterThan(0);

      const provided = new Set(Object.keys(workItemsMocked));
      expect(imported.filter((name) => !provided.has(name))).toEqual([]);
    });
  });

  describe('EI-19395730805289668: pauseNotEnforcedWarning — a pause declared only in prose', () => {
    // The real 2026-08-03T02:05Z note, owner name stripped for the shipped-source identity lint.
    const PAUSE_NOTE =
      'P-001 (real gym corpus) — PAUSED at owner request [owner:redacted 2026-08-02 "find a good stopping point"]';

    const write = async (item: Record<string, unknown>, stored: string) => {
      getWorkItem.mockResolvedValue({ harness: 'papercup', ...item });
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: null });
      getWorkItemCheckpoint.mockResolvedValue(stored);
      return one({ id: (item.id as string) ?? 'WI-7', checkpoint: stored });
    };

    it('warns when the note declares an owner pause and the item has NO claim hold', async () => {
      const r = await write({ id: 'WI-7' }, PAUSE_NOTE);
      expect(r.ok).toBe(true);
      expect(r.pauseNotEnforcedWarning).toBeDefined();
      expect(r.pauseNotEnforcedWarning).toContain('work_items:hold_open');
    });

    it('stays SILENT when the item already carries a claim hold — the author did it right', async () => {
      const r = await write({ id: 'WI-7', payload: { _claimHold: true } }, PAUSE_NOTE);
      expect(r.ok).toBe(true);
      expect(r.pauseNotEnforcedWarning).toBeUndefined();
    });

    it('honours the legacy string form of the hold', async () => {
      const r = await write({ id: 'WI-7', payload: { _claimHold: 'true' } }, PAUSE_NOTE);
      expect(r.pauseNotEnforcedWarning).toBeUndefined();
    });

    it('does NOT warn on an ordinary progress note', async () => {
      const r = await write({ id: 'WI-7' }, '## Did\nLanded the parser fix; 29/29 green.\n## Next\nP-005.');
      expect(r.ok).toBe(true);
      expect(r.pauseNotEnforcedWarning).toBeUndefined();
    });

    it('does NOT warn on prose that merely MENTIONS a pause (the false-positive class)', async () => {
      const r = await write({ id: 'WI-7' }, 'Do not touch p2p-ship/WI-3500/P-306 (paused). Continuing here.');
      expect(r.pauseNotEnforcedWarning).toBeUndefined();
    });

    it('does NOT warn on a CLEAR — there is no declaration left to enforce', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: null, priorLength: 400 });
      const r = await one({ id: 'WI-7' });
      expect(r.cleared).toBe(true);
      expect(r.pauseNotEnforcedWarning).toBeUndefined();
    });

    it('stays SILENT when the item could not be resolved — unknown hold state is not an absent one', async () => {
      // Fail-safe direction on purpose: reporting "no hold" from a failed read would nag the
      // authors who did set one, which is how a warn-only nudge earns being ignored.
      getWorkItem.mockResolvedValue(null);
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: PAUSE_NOTE, priorLength: null });
      getWorkItemCheckpoint.mockResolvedValue(PAUSE_NOTE);
      const r = await one({ id: 'WI-7', checkpoint: PAUSE_NOTE, harness: 'papercup' });
      expect(r.ok).toBe(true);
      expect(r.pauseNotEnforcedWarning).toBeUndefined();
    });

    it('never blocks the write — the checkpoint still stores and verifies', async () => {
      const r = await write({ id: 'WI-7' }, PAUSE_NOTE);
      expect(r.ok).toBe(true);
      expect(r.verified).toBe(true);
      expect(r.length).toBe(PAUSE_NOTE.length);
    });
  });

  describe('EI-9325: shrinkWarning nudge on a suspicious plain-replace shrink', () => {
    it('warns when a plain replace shrinks a substantial prior checkpoint by more than half', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      const stored = '[PRIOR CONTENT PRESERVED — omitted for size]';
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 23608 });
      getWorkItemCheckpoint.mockResolvedValue(stored); // verify-read echoes the write
      const r = await one({ id: 'WI-7', checkpoint: stored });
      expect(r.ok).toBe(true);
      expect(r.shrinkWarning).toBeDefined();
      expect(r.shrinkWarning).toContain('23608 chars previously stored');
      expect(r.shrinkWarning).toContain('EI-9325');
    });

    it('does NOT warn on a plain replace that is not a big shrink', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      const stored = 'a fresh, reasonably detailed note';
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 40 });
      getWorkItemCheckpoint.mockResolvedValue(stored);
      const r = await one({ id: 'WI-7', checkpoint: stored });
      expect(r.ok).toBe(true);
      expect(r.shrinkWarning).toBeUndefined();
    });

    it('does NOT warn when the prior checkpoint was small (not "substantial")', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      // Prior was only 100 chars — shrinking to 10 is not the "detailed record
      // accidentally truncated" failure mode this nudge targets.
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: 'x', priorLength: 100 });
      getWorkItemCheckpoint.mockResolvedValue('x');
      const r = await one({ id: 'WI-7', checkpoint: 'x' });
      expect(r.ok).toBe(true);
      expect(r.shrinkWarning).toBeUndefined();
    });

    // P-007: every path now goes through setWorkItemCheckpointWithPrior (the plain
    // setWorkItemCheckpoint was only a wrapper over it), so the clear/append paths
    // also get the prior length and the declared-dependency stamping. What these two
    // assert is the INVARIANT that survived the unification — a clear and an append
    // must never arm the shrink guard — rather than which function got called.
    it('does NOT warn on a clear (nothing to compare) and never arms the guard', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: null, priorLength: 19348 });
      const r = await one({ id: 'WI-7' }); // blank checkpoint ⇒ clear
      expect(r.ok).toBe(true);
      expect(r.cleared).toBe(true);
      expect(r.shrinkWarning).toBeUndefined();
      const call = setWorkItemCheckpointWithPrior.mock.calls[0] as [unknown, unknown, { guard?: unknown }];
      expect(call[2].guard).toBeUndefined();
    });

    it('does NOT warn on a NORMAL (successful pre-read) append — WI-7190 arms a guard on append too, but it does not fire here', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      getWorkItemCheckpoint.mockResolvedValueOnce('P'.repeat(5000));
      setWorkItemCheckpointWithPrior.mockImplementation(async (_key: unknown, text: string) => ({
        stored: text,
        priorLength: 5000,
      }));
      const r = await one({ id: 'WI-7', checkpoint: 'short addendum', append: true });
      expect(r.ok).toBe(true);
      expect(r.shrinkWarning).toBeUndefined();
      // WI-7190: append now ALSO arms a guard (it used to arm none at all) — but it
      // only blocks when the tool's own pre-read disagreed with the authoritative
      // prior. Here the pre-read succeeded (5000 chars, matching priorLength), so
      // invoking the guard with that same authoritative prior must NOT block.
      const call = setWorkItemCheckpointWithPrior.mock.calls[0] as [unknown, unknown, { guard?: (n: string | null, l: number) => string | null }];
      expect(call[2].guard).toBeTypeOf('function');
      expect(call[2].guard!('P'.repeat(5000), 5000)).toBeNull();
    });

    it('the default suite delegate (no override) never produces a shrinkWarning — priorLength:0 never trips the threshold', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpoint.mockResolvedValue('anything at all');
      const r = await one({ id: 'WI-7', checkpoint: 'anything at all' });
      expect(r.ok).toBe(true);
      expect(r.shrinkWarning).toBeUndefined();
    });
  });

  describe('EI-18140632570924965: a plain-replace shrink is BLOCKED by default (shrink_blocked), not just warned', () => {
    it('blocks the write when setWorkItemCheckpointWithPrior reports blockedReason — no progress bump, no verify-read', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-4487', harness: 'papercup' });
      setWorkItemCheckpointWithPrior.mockResolvedValue({
        stored: '19348-char forensic record, unchanged',
        priorLength: 19348,
        blockedReason:
          'plain replace would shrink the checkpoint from 19348 to 12 chars (>50% loss). Pass { append: true } ' +
          'to join onto the existing checkpoint instead, or { confirmShrink: true } if this replace is intentional.',
      });
      const r = await one({ id: 'WI-4487', checkpoint: 'short status' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('shrink_blocked');
      expect(r.error).toContain('19348');
      expect(r).toMatchObject({
        errorCode: 'shrink_blocked',
        recovery: {
          append: { args: { append: true } },
          replace: { args: { append: false, confirmShrink: true } },
        },
      });
      // Blocked ⇒ no read-after-write verification and no progress-anchor bump attempt.
      expect(getWorkItemCheckpoint).not.toHaveBeenCalled();
    });

    it('EI-20232176364474286: a concise plain refresh retries as an atomic append after the guard refuses it', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-202309', harness: 'papercup' });
      const prior = 'the detailed prior forensic checkpoint '.repeat(60);
      let stored: string | null = prior;
      let calls = 0;
      setWorkItemCheckpointWithPrior.mockImplementation(
        async (
          _ref: unknown,
          incoming: string | null | undefined,
          opts?: {
            guard?: (priorNote: string | null, priorLength: number) => string | null;
            transform?: (priorNote: string | null, note: string | null | undefined) => string | null | undefined;
          },
        ) => {
          calls += 1;
          if (calls === 1) {
            const blockedReason = opts?.guard?.(prior, prior.length) ?? undefined;
            return Promise.resolve({ stored: prior, priorLength: prior.length, blockedReason });
          }
          const next = opts?.transform ? opts.transform(prior, incoming) : incoming;
          stored = (next ?? '').trim() || null;
          return Promise.resolve({ stored, priorLength: prior.length });
        },
      );
      // The handler's verify-read must see the text the retry actually stored.
      getWorkItemCheckpoint.mockImplementation(async () => stored);

      const r = await one({ id: 'WI-202309', checkpoint: 'fresh concise status' });
      expect(r).toMatchObject({ ok: true, autoAppended: true });
      expect(stored).toContain(prior.trim());
      expect(stored).toContain('\n\n---\nfresh concise status');
      expect(calls).toBe(2);
      const retry = setWorkItemCheckpointWithPrior.mock.calls[1] as [
        unknown,
        unknown,
        { guard?: unknown; transform?: unknown },
      ];
      expect(retry[2].guard).toBeUndefined();
      expect(retry[2].transform).toBeTypeOf('function');
    });

    it('the guard callback passed to setWorkItemCheckpointWithPrior blocks only a >50% shrink off a substantial (>500 char) prior', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: 'short new note', priorLength: 20000 });
      getWorkItemCheckpoint.mockResolvedValue('short new note');
      await one({ id: 'WI-7', checkpoint: 'short new note' });
      const call = setWorkItemCheckpointWithPrior.mock.calls[0] as [unknown, string, { guard?: (n: string | null, l: number) => string | null }];
      const guard = call[2].guard!;
      expect(guard(null, 20000)).toMatch(/plain replace would shrink/); // 14-char new text vs 20000 prior
      expect(guard(null, 100)).toBeNull(); // prior not "substantial" (<=500)
      expect(guard(null, 501)).not.toBeNull(); // just over the substantial floor, still a >50% shrink
    });

    it('confirmShrink:true omits the guard entirely — the destructive replace proceeds (still gets the EI-9325 warning)', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-4487', harness: 'papercup' });
      const stored = 'short status';
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 19348 });
      getWorkItemCheckpoint.mockResolvedValue(stored);
      const r = await one({ id: 'WI-4487', checkpoint: stored, confirmShrink: true });
      expect(r.ok).toBe(true);
      expect(r.shrinkWarning).toBeDefined();
      const call = setWorkItemCheckpointWithPrior.mock.calls[0] as [unknown, string, { guard?: unknown }];
      expect(call[2].guard).toBeUndefined();
    });

    it('append:true with a SUCCESSFUL pre-read is never blocked, however huge the prior', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      getWorkItemCheckpoint.mockResolvedValueOnce('P'.repeat(20000));
      setWorkItemCheckpointWithPrior.mockImplementation(async (_key: unknown, text: string) => ({
        stored: text,
        priorLength: 20000,
      }));
      const r = await one({ id: 'WI-7', checkpoint: 'short addendum', append: true });
      expect(r.ok).toBe(true);
      const call = setWorkItemCheckpointWithPrior.mock.calls[0] as [unknown, unknown, { guard?: (n: string | null, l: number) => string | null }];
      expect(call[2].guard).toBeTypeOf('function');
      expect(call[2].guard!('P'.repeat(20000), 20000)).toBeNull();
    });

    describe('WI-7190: append silently clobbered a substantial checkpoint when its pre-read disagreed with the authoritative prior', () => {
      it('blocks the append when the pre-read used to build the join returned nothing but the authoritative prior (read inside the write transaction) is substantial', async () => {
        getWorkItem.mockResolvedValue({ id: 'WI-7190', harness: 'papercup' });
        // The append pre-read (getWorkItemCheckpoint) comes back empty — the exact
        // failure mode reported: the write path resolved the item, the read path
        // used to build the join did not.
        getWorkItemCheckpoint.mockResolvedValueOnce(null);
        setWorkItemCheckpointWithPrior.mockImplementation(
          async (_ref: unknown, _text: string, opts?: { guard?: (n: string | null, l: number) => string | null }) => {
            // The AUTHORITATIVE prior IS there — 10,671 chars, read inside the
            // store's own locked transaction, independent of the tool's separate
            // pre-read above.
            const blockedReason = opts?.guard ? (opts.guard('a 10671-char prior checkpoint...', 10671) ?? undefined) : undefined;
            return { stored: blockedReason ? 'unchanged prior' : 'new section', priorLength: 10671, blockedReason };
          },
        );
        const r = await one({ id: 'WI-7190', checkpoint: 'new section', append: true });
        expect(r.ok).toBe(false);
        expect(r.error).toContain('append_base_unreadable');
        expect(r.error).toContain('10671');
        expect(r.error).not.toContain('shrink_blocked');
        expect(r).toMatchObject({
          errorCode: 'append_base_unreadable',
          recovery: {
            append: { args: { append: true } },
            replace: { args: { append: false, confirmShrink: true } },
          },
        });
      });

      it('confirmShrink:true forces the append through even when the pre-read disagreed with the authoritative prior', async () => {
        getWorkItem.mockResolvedValue({ id: 'WI-7190', harness: 'papercup' });
        getWorkItemCheckpoint.mockResolvedValueOnce(null);
        setWorkItemCheckpointWithPrior.mockResolvedValue({ stored: 'new section', priorLength: 10671 });
        const r = await one({ id: 'WI-7190', checkpoint: 'new section', append: true, confirmShrink: true });
        expect(r.ok).toBe(true);
        const call = setWorkItemCheckpointWithPrior.mock.calls[0] as [unknown, unknown, { guard?: unknown }];
        expect(call[2].guard).toBeUndefined();
      });

      it('does not block a genuinely fresh item with no prior checkpoint at all (priorLength 0)', async () => {
        getWorkItem.mockResolvedValue({ id: 'WI-NEW', harness: 'papercup' });
        getWorkItemCheckpoint.mockResolvedValueOnce(null);
        setWorkItemCheckpointWithPrior.mockImplementation(
          async (_ref: unknown, _text: string, opts?: { guard?: (n: string | null, l: number) => string | null }) => {
            const blockedReason = opts?.guard ? (opts.guard(null, 0) ?? undefined) : undefined;
            return { stored: 'first note', priorLength: 0, blockedReason };
          },
        );
        const r = await one({ id: 'WI-NEW', checkpoint: 'first note', append: true });
        expect(r.ok).toBe(true);
      });
    });

    it('a per-item confirmShrink:true overrides a batch-level default of false/omitted', async () => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
      const stored = 'tiny';
      setWorkItemCheckpointWithPrior.mockResolvedValue({ stored, priorLength: 5000 });
      getWorkItemCheckpoint.mockResolvedValue(stored);
      const out = await env({ items: [{ id: 'WI-7', checkpoint: stored, confirmShrink: true }] });
      expect(out.results[0].ok).toBe(true);
      const call = setWorkItemCheckpointWithPrior.mock.calls[0] as [unknown, string, { guard?: unknown }];
      expect(call[2].guard).toBeUndefined();
    });

    it('a mixed batch: a concise shrink recovers on its own, siblings still write', async () => {
      getWorkItem.mockImplementation(async (id: string) => ({ id, harness: 'papercup' }));
      const storedById = new Map<string, string>();
      setWorkItemCheckpointWithPrior.mockImplementation(
        async (
          ref: { workItemId: string },
          text: string,
          opts?: {
            guard?: (n: string | null, l: number) => string | null;
            transform?: (n: string | null, text: string) => string | null | undefined;
          },
        ) => {
          const prior = text === 'clobber' ? 'P'.repeat(19348) : null;
          const priorLength = prior?.length ?? 0;
          const blockedReason = opts?.guard ? opts.guard(prior, priorLength) ?? undefined : undefined;
          const stored = blockedReason ? prior : opts?.transform ? opts.transform(prior, text) : text;
          storedById.set(ref.workItemId, stored ?? '');
          return { stored, priorLength, blockedReason };
        },
      );
      getWorkItemCheckpoint.mockImplementation(async (ref: { workItemId: string }) => storedById.get(ref.workItemId) ?? null);
      const out = await env({
        items: [
          { id: 'WI-BLOCKED', checkpoint: 'clobber' },
          { id: 'WI-FINE', checkpoint: 'fine, brand new note' },
        ],
      });
      expect(out.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
        ['WI-BLOCKED', true],
        ['WI-FINE', true],
      ]);
      expect(out.results[0].autoAppended).toBe(true);
    });
  });

  /**
   * EI-19298690705878336 — verified-vs-asserted marking on the work-item checkpoint.
   *
   * The gap: a checkpoint could carry a confident factual claim with nothing marking
   * whether it had been CHECKED, and it re-injects on every later invocation of the
   * item in the author's own voice — so a wrong claim reads as better-established each
   * time rather than more suspect. It matters more here than on the loop note, because
   * a work-item checkpoint is what an unrelated SUCCESSOR inherits.
   *
   * These drive the REAL merge: the store mock applies the `transform` the tool passes,
   * mirroring setCarryNoteWithPrior's own post-transform handling (trim; blank ⇒ null),
   * so the rows go through genuine render → parse → re-render round-trips.
   */
  describe('checks (verified-vs-asserted marking)', () => {
    const withPrior = (priorNote: string | null) => {
      setWorkItemCheckpointWithPrior.mockImplementation(
        async (
          _ref: unknown,
          cp: string | null | undefined,
          opts?: { transform?: (p: string | null, n: string | null | undefined) => string | null | undefined },
        ) => {
          const effective = opts?.transform ? opts.transform(priorNote, cp) : cp;
          const trimmed = (effective ?? '').trim();
          return { stored: trimmed.length > 0 ? trimmed : null, priorLength: (priorNote ?? '').length };
        },
      );
    };
    const lastStored = async (): Promise<string | null> =>
      ((await setWorkItemCheckpointWithPrior.mock.results.at(-1)!.value) as { stored: string | null }).stored;

    beforeEach(() => {
      getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup' });
    });

    it('accepts boolean compatibility rows without inventing verification evidence', async () => {
      withPrior(null);
      const r = await one({
        id: 'WI-7',
        checkpoint: 'boolean compatibility',
        checks: [
          { claim: 'true without evidence stays predicted', recheck: 'run probe A', verified: true },
          { claim: 'false stays predicted', recheck: 'run probe B', verified: false },
          {
            claim: 'false stays predicted even with stray evidence',
            recheck: 'run probe B2',
            verified: false,
            evidence: 'contradictory evidence must not override false',
          },
          {
            claim: 'true with evidence becomes verified',
            recheck: 'run probe C',
            verified: true,
            evidence: 'observed probe C pass',
          },
        ],
      });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(stored).toContain('- ? true without evidence stays predicted');
      expect(stored).toContain('- ? false stays predicted');
      expect(stored).toContain('- ? false stays predicted even with stray evidence');
      expect(stored).not.toContain('contradictory evidence must not override false');
      expect(stored).toContain('- ✓ true with evidence becomes verified');
      expect(stored).toContain('evidence: observed probe C pass');
    });

    it('EI-20234792018972820: accepts documented probe aliases alongside boolean verified rows', async () => {
      withPrior(null);
      const r = await one({
        id: 'WI-7',
        checkpoint: 'probe alias compatibility',
        checks: [
          {
            claim: 'probe alias true with evidence becomes verified',
            probe: 'run probe alias A',
            verified: true,
            evidence: 'observed probe alias A pass',
          },
          {
            claim: 'probe alias false stays predicted',
            probe: 'run probe alias B',
            verified: false,
            evidence: 'contradictory probe alias evidence must be discarded',
          },
          {
            claim: 'canonical recheck wins over probe alias',
            probe: 'ignored probe alias',
            recheck: 'canonical recheck command',
            verified: true,
            evidence: 'canonical evidence',
          },
        ],
      });

      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(stored).toContain('- ✓ probe alias true with evidence becomes verified — re-check: run probe alias A');
      expect(stored).toContain('evidence: observed probe alias A pass');
      expect(stored).toContain('- ? probe alias false stays predicted — re-check: run probe alias B');
      expect(stored).not.toContain('contradictory probe alias evidence must be discarded');
      expect(stored).toContain('- ✓ canonical recheck wins over probe alias — re-check: canonical recheck command');
      expect(stored).not.toContain('ignored probe alias');
      expect(r.checks).toBe(3);
    });

    it('applies the same boolean compatibility repair inside items[]', async () => {
      withPrior(null);
      const out = await env({
        items: [
          {
            id: 'WI-7',
            checkpoint: 'nested boolean compatibility',
            checks: [{ claim: 'nested row', recheck: 'run nested probe', verified: false }],
          },
        ],
      });
      expect(out.results[0]).toMatchObject({ ok: true, id: 'WI-7' });
      expect(await lastStored()).toContain('- ? nested row');
    });

    it('renders ✓ for a claim WITH evidence and ? for one without — the whole point of the field', async () => {
      withPrior(null);
      const r = await one({
        id: 'WI-7',
        checkpoint: 'mid-refactor',
        checks: [
          { claim: 'gate is green', recheck: 'npm run test:file -- x.test.ts', verified: 'ran 21:30Z, 24/24 pass' },
          { claim: 'the deploy will pick this up', recheck: 'dev:pipeline_position { path }' },
        ],
      });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(stored).toContain('## Checks');
      // VERIFIED carries its evidence; PREDICTED carries only its probe.
      expect(stored).toContain('- ✓ gate is green');
      expect(stored).toContain('evidence: ran 21:30Z, 24/24 pass');
      expect(stored).toContain('- ? the deploy will pick this up');
      // The count is read back off what was STORED, not off the input.
      expect(r.checks).toBe(2);
    });

    it('CARRIES ROWS FORWARD across a plain replace that drops the body — the silent-drop guard', async () => {
      // A rewrite that does not re-state the checks must not lose them: that silent
      // drop is exactly how a claim outlives the probe that would falsify it.
      withPrior(null);
      await one({ id: 'WI-7', checkpoint: 'first body', checks: [{ claim: 'X holds', recheck: 'probe X', verified: 'saw X' }] });
      const prior = await lastStored();
      expect(prior).toContain('- ✓ X holds');

      withPrior(prior);
      const r2 = await one({ id: 'WI-7', checkpoint: 'second body, fully rewritten' });
      const stored2 = await lastStored();
      expect(stored2).toContain('second body, fully rewritten');
      expect(stored2).not.toContain('first body');
      expect(stored2).toContain('- ✓ X holds');
      expect(r2.checks).toBe(1);
    });

    it('checks:[] clears the rows explicitly', async () => {
      withPrior(null);
      await one({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'X holds', recheck: 'probe X' }] });
      const prior = await lastStored();

      withPrior(prior);
      const r = await one({ id: 'WI-7', checkpoint: 'body', checks: [] });
      const stored = await lastStored();
      expect(stored).not.toContain('## Checks');
      expect(stored).not.toContain('X holds');
      expect(r.checks).toBe(0);
    });

    it('a CLEAR wipes the rows too, so completion cleanup cannot resurrect a checks-only checkpoint', async () => {
      // Deliberate divergence from loop:checkpoint, where checks survive a note clear.
      // work_items:complete clears the checkpoint as terminal cleanup; rows surviving
      // that would leave a closed item carrying a checkpoint made only of checks.
      withPrior(null);
      await one({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'X holds', recheck: 'probe X', verified: 'saw X' }] });
      const prior = await lastStored();

      withPrior(prior);
      const r = await one({ id: 'WI-7', checkpoint: '' });
      expect(r.ok).toBe(true);
      expect(r.cleared).toBe(true);
      expect(await lastStored()).toBeNull();
      expect(r.checks).toBe(0);
    });

    /**
     * EI-19447043119380534: `checks` supplied while `checkpoint` is ENTIRELY OMITTED
     * used to render a body-less note — a 9376-char checkpoint became 1562 chars of
     * bare `## Checks`, returning ok:true. Two properties made it the worst shape:
     * within ONE call an omitted `checks` PRESERVES while an omitted `checkpoint`
     * DESTROYED, and the >50% shrink guard never armed (it requires a non-empty
     * replacement body, which this path by definition does not have).
     *
     * These three pin the fix AND the two contracts it must not break — an explicit
     * clear stays reachable, and the terminal-cleanup clear is untouched.
     */
    it('EI-19447043119380534: `checks` with `checkpoint` OMITTED is a checks-only PATCH — the body SURVIVES', async () => {
      withPrior(null);
      await one({
        id: 'WI-7',
        checkpoint: 'the full plan: A, then B, then C — and the file-by-file record of what landed',
        checks: [{ claim: 'X holds', recheck: 'probe X' }],
      });
      const prior = await lastStored();
      expect(prior).toContain('the full plan: A, then B, then C');
      expect(prior).toContain('- ? X holds');

      // The reported call: promote one check to VERIFIED, touching nothing else.
      withPrior(prior);
      const r = await one({
        id: 'WI-7',
        checks: [{ claim: 'X holds', recheck: 'probe X', verified: 'ran probe X at 16:20Z' }],
      });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      // The body is the whole point: it must still be there.
      expect(stored).toContain('the full plan: A, then B, then C');
      expect(stored).toContain('the file-by-file record of what landed');
      expect(stored).toContain('- ✓ X holds');
      expect(stored).toContain('evidence: ran probe X at 16:20Z');
      expect(r.cleared).not.toBe(true);
    });

    it('EI-20252594592830798: append:true with checks and no checkpoint is an additive checks-only patch', async () => {
      withPrior(null);
      await one({
        id: 'WI-7',
        checkpoint: 'the detailed body that must survive an additive checks refresh',
        checks: [{ claim: 'existing check holds', recheck: 'run existing check' }],
      });
      const prior = await lastStored();

      withPrior(prior);
      const r = await one({
        id: 'WI-7',
        append: true,
        checks: [{ claim: 'new check holds', recheck: 'run the new check' }],
      });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(stored).toContain('the detailed body that must survive');
      expect(stored).toContain('existing check holds');
      expect(stored).toContain('new check holds');
      expect(stored).not.toContain('\n\n---\n');
      expect(r.checks).toBe(2);
    });

    describe("P-013 rowsMode:'merge' compatibility", () => {
      it("accepts rowsMode:'merge' in the single and bulk shapes", () => {
        expect(() => parse({ id: 'WI-7', checkpoint: 'body', rowsMode: 'merge' })).not.toThrow();
        expect(() =>
          parse({ items: [{ id: 'WI-7', checkpoint: 'body', rowsMode: 'merge' }] }),
        ).not.toThrow();
      });

      it("merges supplied checks while replacing the body, without dropping carried rows", async () => {
        withPrior(null);
        await one({
          id: 'WI-7',
          checkpoint: 'first body',
          checks: [
            { claim: 'A holds', recheck: 'probe A' },
            { claim: 'B holds', recheck: 'probe B', verified: 'saw B' },
          ],
        });
        const prior = await lastStored();

        withPrior(prior);
        const r = (await one({
          id: 'WI-7',
          checkpoint: 'rewritten body',
          rowsMode: 'merge',
          checks: [{ claim: 'C holds', recheck: 'probe C' }],
        })) as { ok: boolean; rowsMode?: string; checks: number; checksDropped?: string[] };
        const stored = await lastStored();

        expect(r).toMatchObject({ ok: true, rowsMode: 'merge', checks: 3 });
        expect(r.checksDropped).toBeUndefined();
        expect(stored).toContain('rewritten body');
        expect(stored).not.toContain('first body');
        expect(stored).not.toContain('\n\n---\n');
        expect(stored).toContain('A holds');
        expect(stored).toContain('B holds');
        expect(stored).toContain('C holds');
      });

      it("treats rowsMode:'merge' with checks:[] as a no-op and reports the mode", async () => {
        withPrior(null);
        await one({ id: 'WI-7', checkpoint: 'first body', checks: [{ claim: 'A holds', recheck: 'probe A' }] });
        const prior = await lastStored();

        withPrior(prior);
        const r = (await one({
          id: 'WI-7',
          checkpoint: 'updated body',
          rowsMode: 'merge',
          checks: [],
        })) as { ok: boolean; rowsMode?: string; rowsModeNote?: string; checks: number };
        const stored = await lastStored();

        expect(r).toMatchObject({ ok: true, rowsMode: 'merge', checks: 1 });
        expect(r.rowsModeNote).toContain('NO-OP');
        expect(stored).toContain('updated body');
        expect(stored).toContain('A holds');
      });
    });

    it('EI-19447043119380534: a checks-only patch that CLEARS the rows (checks:[]) still keeps the body', async () => {
      withPrior(null);
      await one({ id: 'WI-7', checkpoint: 'the body worth keeping', checks: [{ claim: 'X holds', recheck: 'probe X' }] });
      const prior = await lastStored();

      withPrior(prior);
      const r = await one({ id: 'WI-7', checks: [] });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(stored).toContain('the body worth keeping');
      expect(stored).not.toContain('## Checks');
      expect(r.checks).toBe(0);
    });

    it('EI-20232161144151845: a dependency-only patch preserves the body and bypasses shrink protection', async () => {
      withPrior(null);
      await one({
        id: 'WI-7',
        checkpoint: 'the detailed checkpoint body that must survive a metadata-only dependency correction '.repeat(18),
      });
      const prior = await lastStored();
      expect(prior!.length).toBeGreaterThan(500);

      withPrior(prior);
      const r = await one({ id: 'WI-7', dependsOn: ['work-item:WI-38026'] });
      expect(r.ok).toBe(true);
      expect(r.cleared).not.toBe(true);
      // No shortened body was sent to the store; the locked transform carries the
      // existing narrative forward while the dependency metadata is restamped.
      expect(await lastStored()).toBe(prior);
      const call = setWorkItemCheckpointWithPrior.mock.calls.at(-1) as [
        unknown,
        unknown,
        { guard?: unknown; dependsOn?: string[] },
      ];
      expect(call[1]).toBeUndefined();
      expect(call[2]).toMatchObject({ dependsOn: ['work-item:WI-38026'] });
      expect(call[2].guard).toBeUndefined();
    });

    it('EI-19447043119380534: an EXPLICIT clear (checkpoint:null) alongside checks still wipes the body — deliberate intent stays reachable', async () => {
      withPrior(null);
      await one({ id: 'WI-7', checkpoint: 'body to be discarded', checks: [{ claim: 'X holds', recheck: 'probe X' }] });
      const prior = await lastStored();
      expect(prior).toContain('body to be discarded');

      withPrior(prior);
      const r = await one({ id: 'WI-7', checkpoint: null, checks: [{ claim: 'Y holds', recheck: 'probe Y' }] });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(stored).not.toContain('body to be discarded');
      expect(stored).toContain('- ? Y holds');
    });

    /**
     * EI-19460631385508515: the field's own description promised "a list merges by claim
     * text", which reads as a UNION — so the natural way to mark ONE claim verified is to
     * send just that row. `normalizeCheckEntries` iterates only the INCOMING rows (prior
     * is a lookup for inheriting recheck/verified/sinceMs), so every stored claim left out
     * is dropped. Replace-with-inheritance is the right semantics — it is the only way to
     * retire a stale check — but it was documented as its opposite, and the loss left no
     * trace beyond a `checks` count the caller would have had to record beforehand.
     *
     * Reported against the LIVE operator, which was serving pre-fix code (deployed
     * 5b898b7b, gate red 3 reds deep) — so the reporter's own numbers were confounded by
     * that deploy gap and could not discriminate this from the already-fixed body-destroy
     * bug. These tests pin the behavior against the CURRENT tree instead.
     */
    describe('EI-19460631385508515: a supplied `checks` list REPLACES the stored set — and says what it dropped', () => {
      it('DROPS stored claims the supplied list omits, and names them in checksDropped', async () => {
        withPrior(null);
        await one({
          id: 'WI-7',
          checkpoint: 'the body worth keeping',
          checks: [
            { claim: 'A holds', recheck: 'probe A' },
            { claim: 'B holds', recheck: 'probe B' },
            { claim: 'C holds', recheck: 'probe C' },
          ],
        });
        const prior = await lastStored();
        expect(prior).toContain('- ? A holds');

        // The reporter's exact intent: touch ONE row, leave the rest alone.
        withPrior(prior);
        const r = (await one({
          id: 'WI-7',
          checks: [{ claim: 'A holds', recheck: 'probe A', verified: 'ran it, holds' }],
        })) as { ok: boolean; checks: number; checksDropped?: string[]; checksDroppedNote?: string };

        expect(r.ok).toBe(true);
        // The body still survives (that is EI-19447043119380534's fix, still holding)...
        const stored = await lastStored();
        expect(stored).toContain('the body worth keeping');
        // ...but B and C are genuinely gone. This is the contract, now stated out loud.
        expect(stored).toContain('- ✓ A holds');
        expect(stored).not.toContain('B holds');
        expect(stored).not.toContain('C holds');
        expect(r.checks).toBe(1);
        // The loss is REPORTED rather than silent — the whole point of the fix.
        expect(r.checksDropped).toEqual(['B holds', 'C holds']);
        expect(r.checksDroppedNote).toContain('REPLACES');
      });

      /**
       * EI-19944669306930709: `append: true` declares an ADDITIVE write — but `checks`
       * REPLACED the carried set inside that same call. So the single most natural
       * incremental write ("append a progress note, and record the one claim I just
       * verified") destroyed every other carried check. Reported twice in one session
       * ~25 min apart by an agent who had ALREADY read the replace-semantics warning:
       * knowing the rule did not help, because `append: true` sitting in the same call
       * establishes an additive frame for the whole invocation, and `checks` reads as
       * one more field of that append.
       *
       * The prior fix (EI-19460631385508515) made the loss VISIBLE via `checksDropped`.
       * Necessary but not sufficient — it is after-the-fact, rides on an `ok: true`, and
       * recovery means re-sending the full set verbatim (where any retyped claim text
       * silently becomes a new, unevidenced row). Under `append: true` the drop is now
       * PREVENTED rather than merely reported.
       *
       * Plain (non-append) replace semantics are deliberately UNCHANGED — that is the
       * only way to retire a stale check, and the test above pins it.
       */
      describe('EI-19944669306930709: `append: true` governs `checks` too (union, not replace)', () => {
        /** Seed a prior note, then serve it to BOTH reader paths STATEFULLY.
         *  `getWorkItemCheckpoint` backs the append pre-read AND the post-write
         *  verify-read, so a static mock returns the stale prior to the verify and the
         *  write fails `checkpoint_verify_failed` — advance it when the store commits. */
        const seed = async (checks: Array<{ claim: string; recheck?: string; verified?: string }>) => {
          withPrior(null);
          await one({ id: 'WI-7', checkpoint: 'the body worth keeping', checks });
          const prior = await lastStored();
          let current = prior;
          getWorkItemCheckpoint.mockImplementation(async () => current);
          setWorkItemCheckpointWithPrior.mockImplementation(
            async (
              _ref: unknown,
              cp: string | null | undefined,
              opts?: { transform?: (p: string | null, n: string | null | undefined) => string | null | undefined },
            ) => {
              const effective = opts?.transform ? opts.transform(prior, cp) : cp;
              const trimmed = (effective ?? '').trim();
              const stored = trimmed.length > 0 ? trimmed : null;
              current = stored;
              return { stored, priorLength: (prior ?? '').length };
            },
          );
          return prior;
        };

        it('UNIONS a supplied row onto the carried set instead of dropping the rest', async () => {
          await seed([
            { claim: 'A holds', recheck: 'probe A' },
            { claim: 'B holds', recheck: 'probe B', verified: 'saw B at 19:00Z' },
            { claim: 'C holds', recheck: 'probe C' },
          ]);

          const r = (await one({
            id: 'WI-7',
            checkpoint: 'ran the suite, 30/30',
            append: true,
            checks: [{ claim: 'D holds', recheck: 'probe D', verified: 'measured just now' }],
          })) as { ok: boolean; checks: number; checksDropped?: string[] };

          expect(r.ok).toBe(true);
          const stored = await lastStored();
          // The new row landed...
          expect(stored).toContain('- ✓ D holds');
          // ...and NOTHING carried was destroyed — the whole point.
          expect(stored).toContain('A holds');
          expect(stored).toContain('B holds');
          expect(stored).toContain('C holds');
          // B keeps its own evidence, not D's.
          expect(stored).toContain('saw B at 19:00Z');
          expect(r.checks).toBe(4);
          // Nothing was lost, so nothing is reported lost.
          expect(r.checksDropped).toBeUndefined();
          // The body still appended (EI-9036's contract, unaffected).
          expect(stored).toContain('the body worth keeping');
          expect(stored).toContain('ran the suite, 30/30');
        });

        it('a supplied row UPDATES a carried claim of the same text rather than duplicating it', async () => {
          await seed([
            { claim: 'A holds', recheck: 'probe A' },
            { claim: 'B holds', recheck: 'probe B' },
          ]);

          const r = (await one({
            id: 'WI-7',
            checkpoint: 'verified A',
            append: true,
            checks: [{ claim: 'A holds', recheck: 'probe A', verified: 'ran it, 12/12' }],
          })) as { ok: boolean; checks: number; checksDropped?: string[] };

          expect(r.ok).toBe(true);
          const stored = await lastStored();
          // Promoted from PREDICTED to VERIFIED in place — one row, not two.
          expect(stored).toContain('- ✓ A holds');
          expect(stored).not.toContain('- ? A holds');
          expect(stored).toContain('B holds');
          expect(r.checks).toBe(2);
          expect(r.checksDropped).toBeUndefined();
        });

        /**
         * EI-20004424625703051 — the union is NOT the whole story, and the gap between
         * those two facts destroyed 16 peer-authored claims on a `critical` item.
         *
         * `append` unions supplied-first, then `normalizeCheckEntries` breaks at
         * CARRY_NOTE_MAX_CHECKS. So on an item already AT the cap — precisely the
         * long-lived, multi-agent items whose history is worth most — an additive write
         * silently evicts the carried tail and still returns `ok: true`.
         *
         * The reported cause is what makes it expensive rather than merely lossy. The
         * note used to emit the REPLACE text here, so a caller who had correctly passed
         * `append: true`, observed rows vanish, and read the tool's own explanation was
         * led to exactly one conclusion: the union is broken. It was not. That caller
         * filed a bug against a working code path and published the wrong root cause,
         * while the real mechanism — the cap — went unnamed. Its remedy compounded it:
         * "re-send the FULL set" is unachievable at the cap, because the full set is by
         * definition larger than `.max(CARRY_NOTE_MAX_CHECKS)` and the call is rejected.
         *
         * The guard therefore prevents the loss, not just diagnoses it: the authoritative
         * locked prior is checked before the append transform can evict its carried tail.
         */
        it('at the cap, append refuses the overflowing union atomically instead of evicting the carried tail', async () => {
          const atCap = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({
            claim: `PEER-${String(i + 1).padStart(2, '0')} holds`,
            recheck: `probe ${i + 1}`,
          }));
          await seed(atCap);
          const prior = await lastStored();
          if (prior === null) throw new Error('seed did not produce a prior checkpoint');
          let writes = 0;

          // Model the real store contract: the guard runs against the authoritative
          // locked prior, and a blocked result performs no write.
          setWorkItemCheckpointWithPrior.mockImplementation(
            async (
              _ref: unknown,
              _incoming: string | null | undefined,
              opts?: { guard?: (priorNote: string | null, priorLength: number) => string | null },
            ) => {
              const blockedReason = opts?.guard?.(prior, prior.length) ?? undefined;
              if (blockedReason) return { stored: prior, priorLength: prior.length, blockedReason };
              writes += 1;
              return { stored: prior, priorLength: prior.length };
            },
          );

          const r = (await one({
            id: 'WI-7',
            checkpoint: 'my fresh finding',
            append: true,
            checks: [
              { claim: 'MINE-A holds', verified: 'measured' },
              { claim: 'MINE-B holds', verified: 'measured' },
            ],
          })) as { ok: boolean; error: string; errorCode: string; recovery: { append: unknown } };

          // The additive write is refused before the transform can evict rows.
          expect(r.ok).toBe(false);
          expect(r.errorCode).toBe('append_checks_overflow');
          expect(r.error).toContain('append_checks_overflow');
          expect(r.error).toContain(`${CARRY_NOTE_MAX_CHECKS}-row cap`);
          expect(r.error).toMatch(/RETIRE stale rows|without `checks`/i);
          expect(r.recovery.append).toMatchObject({ args: { append: true, checks: [] } });
          expect(writes).toBe(0);
          expect(await lastStored()).toBe(prior);
        });

        it('PLAIN (non-append) replace is UNCHANGED — retiring a stale check still works', async () => {
          // The escape hatch: no `append`, so the supplied list still REPLACES. This is
          // what keeps EI-19460631385508515's contract reachable; the fix above must not
          // take it away, or a stale check becomes unretirable.
          await seed([
            { claim: 'A holds', recheck: 'probe A' },
            { claim: 'B is stale', recheck: 'probe B' },
          ]);

          const r = (await one({
            id: 'WI-7',
            checks: [{ claim: 'A holds', recheck: 'probe A' }],
          })) as { ok: boolean; checks: number; checksDropped?: string[] };

          expect(r.ok).toBe(true);
          const stored = await lastStored();
          expect(stored).toContain('A holds');
          expect(stored).not.toContain('B is stale');
          expect(r.checks).toBe(1);
          expect(r.checksDropped).toEqual(['B is stale']);
        });
      });

      it('a re-sent claim INHERITS its stored evidence, so replace-semantics never loses a ✓ you kept', async () => {
        withPrior(null);
        await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [{ claim: 'A holds', recheck: 'probe A', verified: 'observed at 19:00Z' }],
        });
        const prior = await lastStored();

        // Re-sent with claim text only — the evidence must ride along, not be erased.
        withPrior(prior);
        const r = (await one({ id: 'WI-7', checks: [{ claim: 'A holds' }] })) as {
          ok: boolean;
          checksDropped?: string[];
        };
        expect(r.ok).toBe(true);
        const stored = await lastStored();
        expect(stored).toContain('- ✓ A holds');
        expect(stored).toContain('observed at 19:00Z');
        // Nothing was dropped, so the key is absent entirely (shape unchanged).
        expect(r.checksDropped).toBeUndefined();
      });

      it('OMITTING `checks` entirely still carries every row forward and reports no drop', async () => {
        withPrior(null);
        await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [
            { claim: 'A holds', recheck: 'probe A' },
            { claim: 'B holds', recheck: 'probe B' },
          ],
        });
        const prior = await lastStored();

        withPrior(prior);
        const r = (await one({ id: 'WI-7', checkpoint: 'a rewritten body' })) as {
          ok: boolean;
          checks: number;
          checksDropped?: string[];
        };
        expect(r.ok).toBe(true);
        const stored = await lastStored();
        expect(stored).toContain('- ? A holds');
        expect(stored).toContain('- ? B holds');
        expect(r.checks).toBe(2);
        expect(r.checksDropped).toBeUndefined();
      });

      it('an explicit clear (checks: []) drops every row and says so', async () => {
        withPrior(null);
        await one({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'A holds', recheck: 'probe A' }] });
        const prior = await lastStored();

        withPrior(prior);
        const r = (await one({ id: 'WI-7', checks: [] })) as { ok: boolean; checksDropped?: string[] };
        expect(r.ok).toBe(true);
        expect(r.checksDropped).toEqual(['A holds']);
      });
    });

    it('append mode folds the prior note WITHOUT emitting a second ## Checks section', async () => {
      // append joins the whole prior note — rendered Checks section and all — so the
      // transform has to strip it before re-attaching, or the note grows one section
      // per append and the parse becomes ambiguous.
      withPrior(null);
      await one({ id: 'WI-7', checkpoint: 'first', checks: [{ claim: 'X holds', recheck: 'probe X', verified: 'saw X' }] });
      const prior = await lastStored();

      // Two DIFFERENT reads happen on the append path and they must not be conflated:
      // the pre-read that fetches the prior to join onto, then the P-003 verify-read
      // that must see what was just STORED. Pinning both to `prior` fails the
      // verify-read and the handler returns its error shape instead.
      let reads = 0;
      getWorkItemCheckpoint.mockImplementation(async () => {
        reads += 1;
        if (reads === 1) return prior;
        const last = setWorkItemCheckpointWithPrior.mock.results.at(-1);
        return last ? ((await last.value) as { stored: string | null }).stored : null;
      });
      withPrior(prior);
      const r = await one({ id: 'WI-7', checkpoint: 'an addendum', append: true });
      expect(r.ok).toBe(true);
      const stored = await lastStored();
      expect(stored!.match(/## Checks/g) ?? []).toHaveLength(1);
      expect(stored).toContain('first');
      expect(stored).toContain('an addendum');
      expect(stored).toContain('- ✓ X holds');
      expect(r.checks).toBe(1);
    });

    it('re-stating a carried claim WITH evidence promotes it from ? to ✓', async () => {
      // The intended lifecycle: carry a prediction, then upgrade it once you actually
      // ran the probe — rather than leaving a stale prediction reading as established.
      withPrior(null);
      await one({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'X holds', recheck: 'probe X' }] });
      const prior = await lastStored();
      expect(prior).toContain('- ? X holds');

      withPrior(prior);
      await one({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'X holds', recheck: 'probe X', verified: 'ran probe X at 21:40Z' }] });
      const stored = await lastStored();
      expect(stored).toContain('- ✓ X holds');
      expect(stored).not.toContain('- ? X holds');
      expect(stored).toContain('evidence: ran probe X at 21:40Z');
    });

    /**
     * EI-19400299440742193 — the second instance of the class WI-7264 fixed on
     * loop:checkpoint. A zod `.max()` REJECTS THE WHOLE CALL, so one sub-field a few
     * chars over its cap discarded the entire accompanying multi-KB checkpoint and the
     * agent re-sent it: the bytes paid twice, and — the part that actually matters — an
     * item could be left with NO durable state at the moment its session ended, which is
     * exactly what a checkpoint exists to prevent.
     *
     * Measured over the same 6-day transcript window as WI-7264
     * (`node scripts/measure-carry-note-population.mjs 6 'work_items:checkpoint'`):
     * 665 calls, 11 rejected, and 6 of the 9 SCHEMA rejections were a `checks[].recheck`
     * overrun — 32,967 chars. The observed overruns were 311, 335, 386 and 460 chars
     * against a 300 cap, i.e. all a near miss rather than anything pathological.
     *
     * Deliberately NOT ported from WI-7264: the `{status, evidence}` row-shape coercion.
     * Re-measuring before building found ZERO instances of that confusion on this tool
     * (its one wrong-shape rejection was `dependsOn: expected array, received string`,
     * a different field entirely), so porting it would have added a coercion path
     * nothing exercises. The contract pinned here is cap-truncation only.
     */
    describe("EI-19400299440742193: repair-don't-refuse — an oversized check row must not discard the checkpoint", () => {
      it('WRITES the checkpoint instead of rejecting it when a recheck overruns, and reports the trim', async () => {
        withPrior(null);
        const r = (await one({
          id: 'WI-7',
          checkpoint: 'substantial in-flight state the agent already paid to transmit',
          checks: [{ claim: 'gate is green', recheck: 'x'.repeat(360) }],
        })) as { ok: boolean; repairs?: { field: string; kind: string; detail?: string }[] };
        // The whole checkpoint used to be discarded over this one field.
        expect(r.ok).toBe(true);
        const stored = await lastStored();
        expect(stored).toContain('substantial in-flight state');
        // The trim is REPORTED — a cut the caller cannot see is EI-18723223344390510.
        expect(r.repairs).toHaveLength(1);
        expect(r.repairs![0]).toMatchObject({ field: 'checks[0].recheck', kind: 'truncated' });
        expect(r.repairs![0]!.detail).toContain('360');
      });

      it('truncates to the SOFT cap — the stored row is bounded, not merely accepted', async () => {
        withPrior(null);
        await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [{ claim: 'c', recheck: 'y'.repeat(900), verified: 'z'.repeat(900) }],
        });
        const stored = await lastStored();
        // Relaxing the schema must not mean an unbounded row re-injects on every pickup.
        expect(stored!).not.toContain('y'.repeat(400));
        expect(stored!).not.toContain('z'.repeat(400));
      });

      it('caps `claim` too, and reports every trimmed field separately', async () => {
        withPrior(null);
        const r = (await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [{ claim: 'C'.repeat(700), recheck: 'R'.repeat(400), verified: 'V'.repeat(400) }],
        })) as { ok: boolean; repairs?: { field: string }[] };
        expect(r.ok).toBe(true);
        expect(r.repairs?.map((x) => x.field)).toEqual([
          'checks[0].claim',
          'checks[0].recheck',
          'checks[0].verified',
        ]);
      });

      it('omits `repairs` entirely when nothing was trimmed — an unaffected result keeps its old shape', async () => {
        withPrior(null);
        const r = (await one({
          id: 'WI-7',
          checkpoint: 'body',
          checks: [{ claim: 'short', recheck: 'also short', verified: 'observed 04:00Z' }],
        })) as { ok: boolean; repairs?: unknown };
        expect(r.ok).toBe(true);
        expect(r).not.toHaveProperty('repairs');
      });

      // These two reject at the SCHEMA, before the handler runs, so they assert on
      // `parse` throwing rather than on an ok:false envelope — same shape as the
      // WI-7264 block in loop/checkpoint.test.ts.
      it('still REJECTS a genuinely undeclared key — EI-10883 is preserved, not weakened', () => {
        // Relaxing a CAP is not the same as accepting an arg the tool never declared.
        expect(() => parse({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'a', nonsenseField: 'b' }] })).toThrow();
      });

      it('a hard backstop still exists — a pathological row is refused rather than stored', () => {
        const hard = CARRY_ROW_SOFT_CAPS.recheck * CARRY_CAP_HARD_MULTIPLE;
        // At the backstop: accepted by the schema, then truncated to the soft cap.
        expect(() =>
          parse({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'a', recheck: 'x'.repeat(hard) }] }),
        ).not.toThrow();
        // Past it: still refused. The relaxation is a 4× headroom, not an open door.
        expect(() =>
          parse({ id: 'WI-7', checkpoint: 'body', checks: [{ claim: 'a', recheck: 'x'.repeat(hard + 1) }] }),
        ).toThrow();
      });
    });
  });
});
