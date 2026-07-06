/**
 * Unit tests for work_items:complete (coord-lifecycle-automation-2026-06-04 D-004),
 * dual-arity keyed-array contract (bulk-endpoint-standardization-2026-06-21). The
 * engine (getWorkItem/setWorkItemStateWithAliasInfo) is mocked — this exercises the
 * tool's contract: existence check, optional terminal transition, the structured
 * completion record the lifecycle emits-rule reads, and per-item fan-out for items:[…].
 *
 * EI-7712: complete.ts calls the shared `setWorkItemStateWithAliasInfo` helper (not the
 * bare `setWorkItemState`) so every terminal transition also carries the fail-loud
 * aliased/requestedState/appliedState discriminator — see the dedicated describe block
 * near the end of this file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getWorkItem = vi.fn();
const setWorkItemStateWithAliasInfo = vi.fn();
const mergeWorkItemOutputPayload = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  setWorkItemStateWithAliasInfo: (...a: unknown[]) => setWorkItemStateWithAliasInfo(...a),
  workItemObjectRef: (x: { id: string }) => `wi:${x.id}`,
  mergeWorkItemOutputPayload: (...a: unknown[]) => mergeWorkItemOutputPayload(...a),
}));

// TEST-COMPLETION GATE (P-006): the flag + the gate helper are mocked so these unit tests
// exercise the gate WIRING in completeOne (flag-off skips, flag-on consults, refusal blocks)
// without PG. The default beforeEach state is flag OFF + gate OK (= today's behavior).
const getFlag = vi.fn();
vi.mock('@papercusp/flags/server', () => ({
  getFlag: (...a: unknown[]) => getFlag(...a),
}));
const itemTestGate = vi.fn();
vi.mock('../../harness-test-gate', () => ({
  itemTestGate: (...a: unknown[]) => itemTestGate(...a),
}));

import { z } from 'zod';
import complete from './complete';
import { coerceCompletionShape, gatherFlatCompletion } from './completion-coerce';

const ctx = { uiClientId: 'su-tester', isSuperuser: true, workspaceId: 'default' } as never;
const parse = (x: unknown) => (complete.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
/** Full envelope. */
const env = async (x: unknown) => {
  const res = (await complete.handler(parse(x) as never, ctx)) as Out;
  return (res.data);
};
/** The single (n=1) result item — the dual-arity verb wraps it in the bulk envelope. */
const one = async (x: unknown) => (await env(x)).results[0];

const item = { id: 'F-12', kind: 'feature', family: 'feature', state: 'in_progress', harness: 'papercup' };

/** A clean (non-aliased) setWorkItemStateWithAliasInfo resolution: the item lands
 *  exactly on the state it already carries — mirrors the common "it worked" mock. */
function okState(workItem: Record<string, unknown>) {
  return {
    workItem,
    aliased: false,
    requestedState: workItem.state as string,
    appliedState: workItem.state as string,
  };
}

beforeEach(() => {
  getWorkItem.mockReset();
  setWorkItemStateWithAliasInfo.mockReset();
  mergeWorkItemOutputPayload.mockReset();
  // Default: gate flag OFF + (when consulted) gate OK — reproduces today's behavior. The
  // flag mock MUST resolve a promise so the `.catch(() => false)` guard in completeOne works.
  getFlag.mockReset();
  getFlag.mockResolvedValue(false);
  itemTestGate.mockReset();
  itemTestGate.mockResolvedValue({ ok: true });
});

describe('work_items:complete (keyed-array)', () => {
  it('errors cleanly per item when the work-item does not exist', async () => {
    getWorkItem.mockResolvedValue(null);
    const out = await env({ id: 'F-404', completion: { workItem: 'F-404', summary: 'x' } });
    expect(out).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(out.results[0]).toEqual({ ok: false, id: 'F-404', error: "work_item 'F-404' not found" });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('records + returns the completion WITHOUT changing state when `state` omitted', async () => {
    getWorkItem.mockResolvedValue(item);
    const r = await one({
      id: 'F-12',
      completion: {
        workItem: 'F-12',
        summary: 'all phases done',
        tests: '40 green',
        migrations: ['137 add cols'],
        deferred: ['live smoke pending'],
      },
    });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.id).toBe('F-12');
    expect(r.workItem).toMatchObject({ id: 'F-12' });
    expect(r.completion.summary).toBe('all phases done');
    expect(r.completion.deferred).toEqual(['live smoke pending']);
    expect(r.completion.status).toBe('done'); // defaulted
    expect(r.completion.agent).toBeTruthy(); // filled from identity
  });

  it('transitions to the terminal state when `state` provided', async () => {
    getWorkItem.mockResolvedValue(item);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    const r = await one({ id: 'F-12', state: 'passed', completion: { workItem: 'F-12', summary: 'shipped' } });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith('F-12', 'passed', expect.objectContaining({ by: expect.any(String) }));
    expect(r.workItem.state).toBe('passed');
    expect(r.ok).toBe(true);
  });

  it('refuses terminal completion of a remote-authored issue before emitting a false completion', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-remote',
      kind: 'bug',
      family: 'issue',
      state: 'todo',
      harness: 'papercup',
      origin: 'remote',
    });
    const r = await one({
      id: 'WI-remote',
      state: 'resolved',
      completion: { summary: 'verified elsewhere', tests: 'n/a' },
    });
    expect(r).toMatchObject({
      ok: false,
      id: 'WI-remote',
      error: expect.stringMatching(/remote-authored.*cannot be completed locally/),
    });
    expect(r).not.toHaveProperty('completion');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('surfaces aliasNote when the requested state aliases instead of silently leaving the item open', async () => {
    const issue = { id: 'WI-1', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup' };
    getWorkItem.mockResolvedValue(issue);
    setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) => ({
      workItem: { ...issue, state: 'open' },
      aliased: true,
      requestedState: state,
      appliedState: 'open',
      aliasNote: `requested state '${state}' has no distinct representation for this item's family — recorded as 'open' instead.`,
    }));
    const r = await one({ id: 'WI-1', state: 'needs_human', completion: { summary: 'requires owner decision' } });
    expect(r.ok).toBe(true);
    expect(r.workItem.state).toBe('open');
    expect(r.aliasNote).toMatch(/requested state 'needs_human'.*recorded as 'open'/);
    expect(r.stateWarning).toMatch(/still 'open'/);
    expect(r.aliased).toBe(true);
    expect(r.requestedState).toBe('needs_human');
    expect(r.appliedState).toBe('open');
  });

  it('passes structured verification evidence to the terminal state writer', async () => {
    getWorkItem.mockResolvedValue(item);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    await one({
      id: 'F-12',
      state: 'passed',
      completion: {
        summary: 'shipped',
        tests: 'pnpm vitest complete.test.ts --run',
        testResult: '1/1 green',
        filesChanged: ['packages/operator-core/lib/agent-tools/work_items/complete.ts'],
        verifiedHow: 'unit',
        addedTests: true,
      },
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'F-12',
      'passed',
      expect.objectContaining({
        completionRef: 'shipped',
        completionEvidence: {
          filesChanged: ['packages/operator-core/lib/agent-tools/work_items/complete.ts'],
          testsRun: 'pnpm vitest complete.test.ts --run',
          testResult: '1/1 green',
          verifiedHow: 'unit',
          addedTests: true,
        },
      }),
    );
  });

  it('fills completion.workItem from the id when the caller omits it (DRY)', async () => {
    getWorkItem.mockResolvedValue(item);
    const r = await one({ id: 'F-12', completion: { summary: 's' } });
    expect(r.completion.workItem).toBe('F-12');
  });

  it('persists outputPayload onto the work-item row for sidecar reads (EI-7214)', async () => {
    const outputPayload = { signalId: 'sig-1', score: 0.87 };
    getWorkItem.mockResolvedValue(item);
    const r = await one({
      id: 'F-12',
      harness: 'papercup',
      completion: { summary: 'analysis complete', tests: 'unit fixture' },
      outputPayload,
    });

    expect(mergeWorkItemOutputPayload).toHaveBeenCalledWith('F-12', outputPayload, { harness: 'papercup' });
    expect(r.outputPayload).toEqual(outputPayload);
  });

  it('returns the completion-boundary reflect step (self-learning P-001/B)', async () => {
    getWorkItem.mockResolvedValue(item); // harness: 'papercup' → pipeline markers shown
    const r = await one({ id: 'F-12', completion: { summary: 'done' } });
    expect(typeof r.reflect).toBe('string');
    expect(r.reflect).toMatch(/improvements:capture/);
    expect(r.reflect).toMatch(/workaround/);
    expect(r.reflect).toMatch(/validator|reviewer/i);
  });

  it('reflect step omits the harness-pipeline markers for a harness-free unit of work', async () => {
    getWorkItem.mockResolvedValue({ ...item, harness: null });
    const r = await one({ id: 'F-12', completion: { summary: 'done' } });
    expect(r.reflect).toMatch(/workaround/);
    expect(r.reflect).not.toMatch(/validator|reviewer/i);
  });

  it('a FAILED state write never loses the completion (EI-24): ok + completion + stateError', async () => {
    getWorkItem.mockResolvedValue({ ...item, id: 'WI-8', kind: 'task', family: 'issue' });
    setWorkItemStateWithAliasInfo.mockRejectedValue(
      new Error("work_item 'WI-8' (kind=task) cannot take state 'bogus' — valid: open, resolved, closed, done, dropped, todo"),
    );
    const r = await one({ id: 'WI-8', state: 'bogus', completion: { summary: 'work landed; state vocab wrong' } });
    expect(r.ok).toBe(true);
    expect(r.completion.summary).toBe('work landed; state vocab wrong');
    expect(r.stateError).toMatch(/valid: open, resolved, closed/);
    expect(r.workItem.id).toBe('WI-8'); // falls back to the pre-transition item
    expect(r.aliased).toBeUndefined(); // a failed write has nothing to compare — see EI-7712 block below
  });

  it('completes MANY via items:[…] — one self-describing result per item; a not-found never fails the rest', async () => {
    getWorkItem.mockImplementation(async (id: string) => (id === 'F-404' ? null : { ...item, id }));
    const out = await env({
      items: [
        { id: 'F-1', completion: { summary: 'a' } },
        { id: 'F-404', completion: { summary: 'b' } },
        { id: 'F-3', completion: { summary: 'c' } },
      ],
    });
    expect(out.counts).toEqual({ ok: 2, failed: 1 });
    expect(out.results.map((r: { id: string }) => r.id)).toEqual(['F-1', 'F-404', 'F-3']);
    expect(out.results[1]).toMatchObject({ ok: false, id: 'F-404' });
    expect(out.results[0]).toMatchObject({ ok: true, id: 'F-1', completion: { summary: 'a' } });
  });

  // ── TEST-COMPLETION GATE (enforce-system-on-generic-work-2026-06-29 P-006) ──────────────
  describe('test-completion gate (P-006, flag default OFF)', () => {
    it('flag OFF: a terminal feature completion proceeds unchanged; the gate is never consulted', async () => {
      getFlag.mockResolvedValue(false); // explicit (also the beforeEach default)
      getWorkItem.mockResolvedValue(item); // family:'feature', harness:'papercup'
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'shipped' } });
      expect(itemTestGate).not.toHaveBeenCalled();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith('F-12', 'passed', expect.objectContaining({ by: expect.any(String) }));
      expect(r.ok).toBe(true);
      expect(r.workItem.state).toBe('passed');
    });

    it('flag ON + gate PASSES: completes + transitions normally (gate consulted with harness+id)', async () => {
      getFlag.mockResolvedValue(true);
      itemTestGate.mockResolvedValue({ ok: true });
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'shipped' } });
      expect(itemTestGate).toHaveBeenCalledWith('papercup', 'F-12');
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
      expect(r.ok).toBe(true);
      expect(r.workItem.state).toBe('passed');
    });

    it('flag ON + gate FAILS: refuses with {ok:false,id,error}, NO completion, setWorkItemStateWithAliasInfo NOT called', async () => {
      getFlag.mockResolvedValue(true);
      itemTestGate.mockResolvedValue({ ok: false, reason: 'test-requiring VAL(s) not yet passing: VAL-3' });
      getWorkItem.mockResolvedValue(item);
      const out = await env({ id: 'F-12', state: 'passed', completion: { summary: 'shipped' } });
      expect(out.counts).toEqual({ ok: 0, failed: 1 });
      expect(out.results[0]).toEqual({
        ok: false,
        id: 'F-12',
        error: 'refusing to complete F-12: test-requiring VAL(s) not yet passing: VAL-3',
      });
      // No completion record on a refusal ⇒ the emit rule (keys on result.completion) fires nothing.
      expect(out.results[0].completion).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('flag ON but record-only (no `state`): the gate is NOT consulted — only terminal transitions gate', async () => {
      getFlag.mockResolvedValue(true);
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', completion: { summary: 'progress note' } });
      expect(itemTestGate).not.toHaveBeenCalled();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.ok).toBe(true);
    });

    it('flag ON but an ISSUE-family item: the gate is NOT consulted (feature-only)', async () => {
      getFlag.mockResolvedValue(true);
      getWorkItem.mockResolvedValue({ ...item, id: 'WI-9', kind: 'bug', family: 'issue' });
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, id: 'WI-9', family: 'issue', state: 'resolved' }));
      const r = await one({ id: 'WI-9', state: 'resolved', completion: { summary: 'fixed' } });
      expect(itemTestGate).not.toHaveBeenCalled();
      expect(r.ok).toBe(true);
    });
  });

  // ── stateWarning: complete-without-terminal-state footgun (EI-5269) ──────────────────────
  // `completion.status` (defaults to 'done') does NOT close the item — only a terminal top-level
  // `state` does. Completing without one records the completion but leaves the row claimable +
  // reclaimable → the auto-loop re-places bees on landed work. We surface that LOUDLY (do not
  // auto-close: state is optional by design, D-004).
  describe('stateWarning — recorded-but-not-closed footgun (EI-5269)', () => {
    it('warns when a completion leaves a feature non-terminal (no `state`)', async () => {
      getWorkItem.mockResolvedValue(item); // state: 'in_progress'
      const r = await one({ id: 'F-12', completion: { summary: 'all done', status: 'done' } });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.completion.status).toBe('done'); // reads as done…
      expect(r.stateWarning).toMatch(/NOT closed/); // …but the item is not closed
      expect(r.stateWarning).toContain('F-12');
      expect(r.stateWarning).toMatch(/passed'\|'deprecated'/); // points at the terminal states
    });

    it('does NOT warn when a terminal `state` closed the item', async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'shipped' } });
      expect(r.workItem.state).toBe('passed');
      expect(r.stateWarning).toBeUndefined();
    });

    it('does NOT warn when the item was already terminal (re-complete a passed item)', async () => {
      getWorkItem.mockResolvedValue({ ...item, state: 'passed' });
      const r = await one({ id: 'F-12', completion: { summary: 'noting it again' } });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.stateWarning).toBeUndefined();
    });

    it('warns for an issue-family item left open (no `state`), not when resolved', async () => {
      const issue = { ...item, id: 'WI-7', kind: 'bug', family: 'issue', state: 'open' };
      getWorkItem.mockResolvedValue(issue);
      const open = await one({ id: 'WI-7', completion: { summary: 'fixed in tree' } });
      expect(open.stateWarning).toMatch(/resolved'\|'closed'/);

      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));
      const resolved = await one({ id: 'WI-7', state: 'resolved', completion: { summary: 'fixed in tree' } });
      expect(resolved.stateWarning).toBeUndefined();
    });

    it('still warns (item stays claimable) when an explicit `state` write FAILED', async () => {
      getWorkItem.mockResolvedValue({ ...item, id: 'WI-8', kind: 'task', family: 'issue', state: 'open' });
      setWorkItemStateWithAliasInfo.mockRejectedValue(new Error("cannot take state 'bogus'"));
      const r = await one({ id: 'WI-8', state: 'bogus', completion: { summary: 'landed; bad vocab' } });
      expect(r.stateError).toBeTruthy();
      expect(r.stateWarning).toMatch(/NOT closed/); // the failed transition left it claimable
    });
  });

  // ── assigneeMismatchWarning: wrong-id-grab footgun (EI-7264) ─────────────────────────────
  // A fast multi-wake loop's own tracking-task ids and peers' work-item ids flow through the
  // same coord broadcast stream — nothing visually distinguishes them. WARN (never block) when
  // the caller completing an item is not its current assignee, so a wrong-id grab is caught
  // before it lands on someone else's active work.
  describe('assigneeMismatchWarning — wrong-id-grab footgun (EI-7264)', () => {
    it('warns when the item is currently assigned to someone else', async () => {
      getWorkItem.mockResolvedValue({ ...item, assignee: 'su-someone-else' });
      const r = await one({ id: 'F-12', completion: { summary: 'noting it' } });
      expect(r.assigneeMismatchWarning).toMatch(/su-someone-else/);
      expect(r.assigneeMismatchWarning).toMatch(/su-tester/); // the caller's own id
      expect(r.assigneeMismatchWarning).toContain('F-12');
    });

    it('does NOT warn when the caller is the current assignee', async () => {
      getWorkItem.mockResolvedValue({ ...item, assignee: 'su-tester' });
      const r = await one({ id: 'F-12', completion: { summary: 'noting it' } });
      expect(r.assigneeMismatchWarning).toBeUndefined();
    });

    it('does NOT warn when the item is unclaimed (assignee null)', async () => {
      getWorkItem.mockResolvedValue({ ...item, assignee: null });
      const r = await one({ id: 'F-12', completion: { summary: 'noting it' } });
      expect(r.assigneeMismatchWarning).toBeUndefined();
    });
  });

  // ── verificationWarning: settled-but-unverified lint (flush-to-proceed P-006) ────────────
  // A settled unit is VERIFIED (`tests`) or CONSCIOUSLY DEFERRED (`deferred`) — never silent.
  // SOFT warning, not a hard reject (D-005 / EI-24: a finished completion is never lost).
  describe('verificationWarning — settled-but-unverified lint (P-006)', () => {
    beforeEach(() => {
      // A closed item so stateWarning stays silent and these assertions isolate verificationWarning.
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    });

    it('warns when a completion has NEITHER `tests` nor `deferred`', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'shipped it' } });
      expect(r.ok).toBe(true); // NOT rejected — the completion is still recorded + emitted
      expect(r.completion.summary).toBe('shipped it');
      expect(r.verificationWarning).toMatch(/neither `tests` nor `deferred`/);
      expect(r.verificationWarning).toContain('F-12');
    });

    it('does NOT warn when `tests` is populated', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 's', tests: '18 vitest green' } });
      expect(r.verificationWarning).toBeUndefined();
    });

    it('does NOT warn when `deferred` is a non-empty list (conscious deferral)', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 's', deferred: ['live smoke pending'] } });
      expect(r.verificationWarning).toBeUndefined();
    });

    it('treats an EMPTY `deferred` array + whitespace-only `tests` as absent (still warns)', async () => {
      getWorkItem.mockResolvedValue(item);
      // Note: the schema drops empty arrays / min(1) strings, but the lint is defensive about both.
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 's', deferred: [] } });
      expect(r.verificationWarning).toMatch(/neither `tests` nor `deferred`/);
    });

    it('does NOT warn when both are populated', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 's', tests: '5 green', deferred: ['perf pass later'] },
      });
      expect(r.verificationWarning).toBeUndefined();
    });

    // EI-7316: `tests` is only ONE of several schema-blessed ways to record verification
    // evidence (testsRun / testResult / verifiedHow, each also under a nested `verification.*`
    // alias) — completionEvidenceFromRecord already treats them as equally valid for the
    // completionEvidence written on a terminal state transition. The lint used to check ONLY
    // the bare `tests` field, so a caller who verified via a sibling field got a FALSE warning.
    it('does NOT warn when only `testsRun` is populated (not the bare `tests` field)', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 's', testsRun: 'npx vitest run foo.test.ts' },
      });
      expect(r.verificationWarning).toBeUndefined();
    });

    it('does NOT warn when only `testResult` is populated', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 's', testResult: '9/9 green' } });
      expect(r.verificationWarning).toBeUndefined();
    });

    it('does NOT warn when only `verifiedHow` is populated', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 's', verifiedHow: 'manual' } });
      expect(r.verificationWarning).toBeUndefined();
    });

    it('does NOT warn when only the nested `verification.testsRun` alias is populated', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 's', verification: { testsRun: 'live-drove-ui' } },
      });
      expect(r.verificationWarning).toBeUndefined();
    });

    it('STILL warns when none of tests/testsRun/testResult/verifiedHow/deferred are populated', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'shipped, trust me' } });
      expect(r.verificationWarning).toMatch(/neither `tests` nor `deferred`/);
    });
  });

  // ── aliased/requestedState/appliedState on every result (EI-7712) ────────────────────────
  // complete's optional terminal `state` write goes through the SAME shared
  // setWorkItemStateWithAliasInfo helper as work_items:set_state, so a completion that
  // silently aliases — or, per the WI-2381 recurrence guard, silently diverges even
  // without the normalize-layer's onAlias ever firing — must surface it identically.
  describe('aliased/requestedState/appliedState on every result (EI-7712)', () => {
    it('a clean (non-aliased) terminal transition reports aliased:false with matching requested/applied state', async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'shipped' } });
      expect(r.aliased).toBe(false);
      expect(r.requestedState).toBe('passed');
      expect(r.appliedState).toBe('passed');
    });

    it('an aliased terminal transition reports aliased:true with DIVERGENT requested/applied state', async () => {
      const issue = { id: 'WI-2', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup' };
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) => ({
        workItem: { ...issue, state: 'open' },
        aliased: true,
        requestedState: state,
        appliedState: 'open',
        aliasNote: `requested state '${state}' has no distinct representation for this item's family — recorded as 'open' instead.`,
      }));
      const r = await one({ id: 'WI-2', state: 'blocked', completion: { summary: 'blocked on X' } });
      expect(r.aliased).toBe(true);
      expect(r.requestedState).toBe('blocked');
      expect(r.appliedState).toBe('open');
      expect(r.requestedState).not.toBe(r.appliedState);
    });

    it('a bare completion (no `state` passed) leaves aliased/requestedState/appliedState unset — nothing was compared', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', completion: { summary: 'progress note' } });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.aliased).toBeUndefined();
      expect(r.requestedState).toBeUndefined();
      expect(r.appliedState).toBeUndefined();
    });

    it('a silent divergence with NO onAlias fire still surfaces as aliased:true — the WI-2381 recurrence guard', async () => {
      getWorkItem.mockResolvedValue({ ...item, id: 'WI-2381', family: 'issue', state: 'open' });
      setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) => ({
        workItem: { ...item, id: 'WI-2381', family: 'issue', state: 'open' }, // silently stayed 'open'
        aliased: true,
        requestedState: state,
        appliedState: 'open',
        aliasNote: `requested state '${state}' was not applied verbatim — recorded as 'open' instead.`,
      }));
      const r = await one({ id: 'WI-2381', state: 'blocked', completion: { summary: 'trying to block it' } });
      expect(r.ok).toBe(true); // the write itself succeeded — exactly why `ok` alone is not enough
      expect(r.aliased).toBe(true);
      expect(r.appliedState).not.toBe(r.requestedState);
    });
  });
});

/**
 * EI-7031 — work_items:complete failed ~15% of calls, almost entirely on malformed
 * `completion` SHAPE from LLM callers (bare string, scalar↔array swaps, missing
 * summary, flat fields with no wrapper). Each was a finished unit of work whose
 * completion was REJECTED and LOST, leaving the item claimable. We coerce those
 * shapes to the contract BEFORE validation ("be liberal in what you accept"); a
 * well-formed completion is unaffected. These pin the coercion + the wiring + that
 * the published tools/list schema is unchanged.
 */
describe('work_items:complete input coercion (EI-7031)', () => {
  describe('coerceCompletionShape (unit)', () => {
    it('a bare string completion → { summary } (the 18× "expected object, received string")', () => {
      expect(coerceCompletionShape('shipped the fix')).toEqual({ summary: 'shipped the fix' });
    });

    it('an empty/whitespace-only string is left for validation to reject (not silently accepted)', () => {
      expect(coerceCompletionShape('   ')).toBe('   ');
    });

    it('a scalar in an array-typed field is wrapped LOSSLESSLY (no comma-splitting)', () => {
      const out = coerceCompletionShape({ summary: 's', whatLanded: 'did A, B and C' }) as { whatLanded: unknown };
      expect(out.whatLanded).toEqual(['did A, B and C']);
    });

    it('coerces migrations + deferred scalars the same way', () => {
      const out = coerceCompletionShape({ summary: 's', migrations: '137 foo', deferred: 'timeout follow-up' }) as {
        migrations: unknown;
        deferred: unknown;
      };
      expect(out.migrations).toEqual(['137 foo']);
      expect(out.deferred).toEqual(['timeout follow-up']);
    });

    it('coerces structured verification aliases', () => {
      const out = coerceCompletionShape({
        summary: 's',
        filesChanged: 'packages/operator-core/lib/work-items.ts',
        addedTests: 'true',
      }) as { filesChanged: unknown; addedTests: unknown };
      expect(out.filesChanged).toEqual(['packages/operator-core/lib/work-items.ts']);
      expect(out.addedTests).toBe(true);
    });

    it('an array in a string-typed field is joined (the "tests: expected string, received array")', () => {
      const out = coerceCompletionShape({ summary: 's', tests: ['67 green', 'vitest'] }) as { tests: unknown };
      expect(out.tests).toBe('67 green; vitest');
    });

    it('derives a summary from title / whatLanded / status when omitted (the 2× missing summary)', () => {
      expect((coerceCompletionShape({ title: 'Fix loop guard' }) as { summary: string }).summary).toBe('Fix loop guard');
      expect((coerceCompletionShape({ whatLanded: 'guard.ts patched' }) as { summary: string }).summary).toBe('guard.ts patched');
      expect((coerceCompletionShape({ status: 'shipped' }) as { summary: string }).summary).toBe('shipped');
      expect((coerceCompletionShape({}) as { summary: string }).summary).toBe('done');
    });

    it('leaves a WELL-FORMED completion deep-equal (only rescues mis-shapes)', () => {
      const good = { summary: 'all green', whatLanded: ['a.ts', 'b.ts'], tests: '5 green', deferred: ['x'] };
      expect(coerceCompletionShape(good)).toEqual(good);
    });

    it('passes a non-string, non-object value through untouched', () => {
      expect(coerceCompletionShape(42)).toBe(42);
      expect(coerceCompletionShape(null)).toBe(null);
    });
  });

  describe('EI-7311: a JSON-STRINGIFIED completion object is parsed back into an object, not swallowed as one giant summary', () => {
    it('a JSON-object-shaped string is parsed and every field survives (the exact EI-6516/EI-6528 shape)', () => {
      const jsonString = JSON.stringify({
        summary: 'Stale summary-lag observation — all 3 cited placements completed successfully.',
        status: 'resolved',
        whatLanded: ['WI-1088, WI-1502, WI-1503 all now state=passed'],
        tests: 'N/A — investigation only. Verified via work_items:get on all 3 cited ids.',
        coordNotes: 'closing as resolved',
      });
      const out = coerceCompletionShape(jsonString) as {
        summary: string;
        status: string;
        whatLanded: unknown;
        tests: string;
        coordNotes: string;
      };
      expect(out.summary).toBe('Stale summary-lag observation — all 3 cited placements completed successfully.');
      expect(out.tests).toBe('N/A — investigation only. Verified via work_items:get on all 3 cited ids.');
      expect(out.whatLanded).toEqual(['WI-1088, WI-1502, WI-1503 all now state=passed']);
      expect(out.coordNotes).toBe('closing as resolved');
    });

    it('a JSON-stringified completion with mis-shaped sub-fields still runs through the normal array/string coercion (recurses, not a one-shot parse)', () => {
      const jsonString = JSON.stringify({ summary: 's', tests: ['67 green', 'vitest'], whatLanded: 'one file' });
      const out = coerceCompletionShape(jsonString) as { tests: unknown; whatLanded: unknown };
      expect(out.tests).toBe('67 green; vitest');
      expect(out.whatLanded).toEqual(['one file']);
    });

    it('genuine prose that merely starts/ends with braces but is not valid JSON still falls back to the bare-string summary path', () => {
      const prose = '{fixed the thing, verified it works}';
      expect(coerceCompletionShape(prose)).toEqual({ summary: prose });
    });

    it('a JSON ARRAY string (not an object) is not mistaken for the object shape — falls back to bare-string summary', () => {
      const jsonArrayString = JSON.stringify(['a', 'b']);
      expect(coerceCompletionShape(jsonArrayString)).toEqual({ summary: jsonArrayString });
    });
  });

  describe('gatherFlatCompletion (unit)', () => {
    it('gathers flat completion fields under `completion` when there is no wrapper', () => {
      expect(gatherFlatCompletion({ id: 'WI-1', summary: 'done', whatLanded: ['a'] })).toEqual({
        id: 'WI-1',
        completion: { summary: 'done', whatLanded: ['a'] },
      });
    });

    it('gathers flat structured verification fields under `completion`', () => {
      expect(gatherFlatCompletion({ id: 'WI-1', summary: 'done', testsRun: 'vitest green', addedTests: true })).toEqual({
        id: 'WI-1',
        completion: { summary: 'done', testsRun: 'vitest green', addedTests: true },
      });
    });

    it('leaves a call that already has `completion` unchanged (same reference)', () => {
      const call = { id: 'WI-1', completion: { summary: 'x' } };
      expect(gatherFlatCompletion(call)).toBe(call);
    });

    it('leaves an items:[…] batch unchanged', () => {
      const call = { items: [{ id: 'WI-1', completion: { summary: 'x' } }] };
      expect(gatherFlatCompletion(call)).toBe(call);
    });

    it('does NOT gather id/harness/state — only completion fields', () => {
      expect(gatherFlatCompletion({ id: 'WI-1', harness: 'papercusp', state: 'resolved', summary: 's' })).toEqual({
        id: 'WI-1',
        harness: 'papercusp',
        state: 'resolved',
        completion: { summary: 's' },
      });
    });

    it('leaves a call with an id but no completion-ish fields unchanged', () => {
      const call = { id: 'WI-1', harness: 'papercusp' };
      expect(gatherFlatCompletion(call)).toBe(call);
    });
  });

  describe('end-to-end through the real tool schema + handler (the wire shapes that 400ed)', () => {
    beforeEach(() => {
      getWorkItem.mockResolvedValue({ ...item, id: 'WI-9', kind: 'bug', family: 'issue', state: 'open' });
      setWorkItemStateWithAliasInfo.mockResolvedValue(
        okState({ ...item, id: 'WI-9', kind: 'bug', family: 'issue', state: 'resolved' }),
      );
    });

    it('completion passed as a bare STRING now records instead of 400ing', async () => {
      const r = await one({ id: 'WI-9', state: 'resolved', completion: 'fixed the thing' });
      expect(r.ok).toBe(true);
      expect(r.completion.summary).toBe('fixed the thing');
    });

    it('scalar whatLanded + array tests now record', async () => {
      const r = await one({
        id: 'WI-9',
        state: 'resolved',
        completion: { summary: 's', whatLanded: 'one file', tests: ['5 green', 'vitest'] },
      });
      expect(r.completion.whatLanded).toEqual(['one file']);
      expect(r.completion.tests).toBe('5 green; vitest');
    });

    it('a FLAT completion (fields on args, no wrapper) now records instead of tripping the refine', async () => {
      const r = await one({ id: 'WI-9', state: 'resolved', summary: 'landed flat', whatLanded: ['x.ts'] });
      expect(r.ok).toBe(true);
      expect(r.completion.summary).toBe('landed flat');
      expect(r.completion.whatLanded).toEqual(['x.ts']);
    });

    it('a completion with NO summary is derived, not rejected', async () => {
      const r = await one({ id: 'WI-9', state: 'resolved', completion: { title: 'Guard fix', whatLanded: ['g.ts'] } });
      expect(r.ok).toBe(true);
      expect(r.completion.summary).toBe('Guard fix');
    });

    it('a well-formed call is unaffected by the coercion path', async () => {
      const r = await one({ id: 'WI-9', state: 'resolved', completion: { summary: 'clean', whatLanded: ['a.ts'] } });
      expect(r.completion.summary).toBe('clean');
      expect(r.completion.whatLanded).toEqual(['a.ts']);
    });

    // EI-6999: a shape with NEITHER `completion` NOR any recognizable flat
    // completion field (gatherFlatCompletion has nothing to rescue) must fail
    // with the FULL minimal closing shape up front — not just "you're missing
    // `completion`" — so a caller doesn't need 3+ round-trips to discover
    // `completion.summary` and `state` are both required to actually close.
    it('a shape with no completion at all states the FULL minimal closing contract in ONE error', () => {
      const result = (complete.args as { safeParse: (x: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } })
        .safeParse({ id: 'WI-1', note: 'just a note, not a completion' });
      expect(result.success).toBe(false);
      const message = result.error?.issues.map((i) => i.message).join(' ') ?? '';
      expect(message).toContain('{ id, state, completion: { summary } }');
      expect(message).toContain('state');
      expect(message).toContain('REQUIRED');
    });
  });

  describe('published JSON schema (tools/list projection) is unchanged by the preprocess wrappers', () => {
    it('still advertises id / completion / items as object properties', () => {
      const json = z.toJSONSchema(complete.args as never) as {
        type?: string;
        properties?: Record<string, unknown>;
      };
      expect(json.type).toBe('object');
      expect(json.properties).toHaveProperty('id');
      expect(json.properties).toHaveProperty('completion');
      expect(json.properties).toHaveProperty('items');
    });
  });
});
