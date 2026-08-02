/**
 * checkpoint.test.ts — the loop:checkpoint handler (su-cold-auto-mode-2026-07-03 P-002
 * PRODUCER). The carry-note store (setLoopCarryNote) + renderCarryNote are mocked so the
 * assertions are purely about the tool's CONTRACT: structured-fields-vs-raw-note routing,
 * ownerId / harness resolution (matching the loopScope the wake executor reads),
 * write-vs-clear, and the no-harness guard.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/loop/checkpoint.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setLoopCarryNote = vi.fn();
const getLoopCarryNote = vi.fn();
const getLoopStatus = vi.fn();
const withBoundedTimeout = vi.fn(async (..._a: unknown[]) => ({ value: undefined, degraded: false, elapsedMs: 0 }));
// Mock the STORE fns; a sentinel renderCarryNote keeps the routing tests about ROUTING
// (structured → render, raw → passthrough), not renderCarryNote's exact output. The pure
// walls machinery (splitCarryNoteWalls / withCarryNoteWalls / normalizeWallEntries) stays
// REAL via importOriginal — the P-006 merge tests below pin the tool's contract around it.
//
// WI-6813: the tool now writes through setLoopCarryNoteWithPrior and performs the
// walls/checks merge INSIDE that call's `transform` (atomic with the write) rather
// than caller-side. The double below therefore RUNS the real transform against the
// prior `getLoopCarryNote` is configured with, then records the transform's OUTPUT on
// the `setLoopCarryNote` spy — so every assertion in this suite still reads
// `setLoopCarryNote.mock.calls[0][1]` as "the note that was actually stored", and the
// merge under test is genuinely exercised rather than stubbed past.
// When set, the prior the STORE hands the transform from its locked row — which is
// deliberately allowed to differ from what `getLoopCarryNote` returns, so a test can
// simulate a concurrent writer landing where the old caller-side read → merge → write
// had its race window.
let storePriorOverride: string | null | undefined;
const setLoopCarryNoteWithPrior = vi.fn(
  async (
    ref: unknown,
    note: unknown,
    opts?: { transform?: (prior: string | null, note: unknown) => string | null | undefined },
  ) => {
    const prior =
      storePriorOverride !== undefined ? storePriorOverride : (((await getLoopCarryNote()) as string | null) ?? null);
    const merged = opts?.transform ? opts.transform(prior, note) : (note as string | null | undefined);
    const stored = await setLoopCarryNote(ref, merged);
    return { stored, priorLength: (prior ?? '').length };
  },
);
vi.mock('../../carry-note', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setLoopCarryNote: (...a: unknown[]) => setLoopCarryNote(...a),
  setLoopCarryNoteWithPrior: (...a: [unknown, unknown, never]) => setLoopCarryNoteWithPrior(...a),
  getLoopCarryNote: (...a: unknown[]) => getLoopCarryNote(...a),
  renderCarryNote: (f: Record<string, string | undefined>) => `RENDERED:${JSON.stringify(f)}`,
}));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-caller', ownerLabel: 'su · caller', workspaceId: 'ws-1' })),
}));
// EI-7734 fallout: checkpoint.ts now routes EVERY no-armed-routine fallback through this
// mock (previously a raw ctx.harnessSlug check short-circuited before ever calling it), so
// a static `() => 'home-hive'` that ignores its args broke every test asserting an explicit
// harness/ctx value wins — it silently returned 'home-hive' regardless of what was passed.
// Mirror the real resolvePotHomeSlug's precedence (explicit arg > ctx slug > 'home-hive'
// env-fallback stand-in) so the mock actually honors the inputs it's given.
vi.mock('../../pot/wake', () => ({
  resolvePotHomeSlug: vi.fn((explicit?: string | null, ctxSlug?: string | null) => {
    const concrete = (s?: string | null) => (s && s !== '*' ? s : undefined);
    return concrete(explicit) ?? concrete(ctxSlug) ?? 'home-hive';
  }),
}));
// WI-2148: the fix under test — loop:checkpoint resolves harness from the ARMED routine
// (getLoopStatus) FIRST, so it matches whatever the cold-wake reader resolves. Default
// (most tests): no armed routine found (null) ⇒ falls through to the old arg/ctx/home-hive
// chain, preserving every pre-existing test's behavior unchanged.
vi.mock('../../harness/routines/loop', () => ({ getLoopStatus: (...a: unknown[]) => getLoopStatus(...a) }));
vi.mock('../../bounded-timeout', () => ({
  withBoundedTimeout: (...a: unknown[]) => withBoundedTimeout(...a),
}));

const tool = (await import('./checkpoint')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
const call = (args: Record<string, unknown>, ctx: unknown = { harnessSlug: 'papercusp', workspaceId: 'ws-1' }) =>
  tool.handler(parse(args) as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  storePriorOverride = undefined; // default: the store's prior IS getLoopCarryNote's value
  setLoopCarryNote.mockResolvedValue('stored-note');
  getLoopCarryNote.mockResolvedValue(null); // default: no prior note ⇒ no walls to carry
  getLoopStatus.mockResolvedValue(null); // default: no armed routine found
  withBoundedTimeout.mockResolvedValue({ value: undefined, degraded: false, elapsedMs: 0 });
});

describe('loop:checkpoint — the loop carry-note producer', () => {
  it('structured fields → renderCarryNote, keyed by caller ownerId + ctx harness (the loopScope the wake executor reads)', async () => {
    const b = body(await call({ did: 'wired producer', left: 'run tests', insight: 'inject wraps note', next: 'vitest' }));
    expect(b).toMatchObject({ ok: true, harness: 'papercusp', ownerId: 'su-caller', cleared: false });
    expect(b.length).toBeGreaterThan(0);
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      { harness: 'papercusp', ownerId: 'su-caller', workspaceId: 'ws-1' },
      'RENDERED:' + JSON.stringify({ did: 'wired producer', left: 'run tests', insight: 'inject wraps note', next: 'vitest' }),
    );
  });

  it('a raw { note } is written verbatim (renderCarryNote NOT called)', async () => {
    await call({ note: 'freeform carry text' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      { harness: 'papercusp', ownerId: 'su-caller', workspaceId: 'ws-1' },
      'freeform carry text',
    );
  });

  it("structured fields WIN over a raw note when both are passed", async () => {
    await call({ note: 'ignore me', did: 'the real state' });
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('RENDERED:');
    expect(written).not.toBe('ignore me');
  });

  it("an explicit { note:'' } clears (stored=null ⇒ cleared:true, length:0)", async () => {
    setLoopCarryNote.mockResolvedValue(null);
    const b = body(await call({ note: '' }));
    expect(setLoopCarryNote).toHaveBeenCalledWith(expect.anything(), '');
    expect(b).toMatchObject({ ok: true, cleared: true, length: 0 });
  });

  it('honors an explicit ownerId override (mirrors loop:arm/end/status — checkpoint another session\'s loop)', async () => {
    await call({ next: 'x', ownerId: 'su-other-session' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-other-session', harness: 'papercusp' }),
      expect.any(String),
    );
  });

  it('honors an explicit harness override over ctx', async () => {
    await call({ next: 'x', harness: 'other-harness' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'other-harness' }),
      expect.any(String),
    );
  });

  // WI-2148: the actual bug — the checkpoint WRITER must key its carry-note under the
  // SAME harness the cold-wake READER resolves (the armed routine's fixed install_slug),
  // never the checkpointing session's own transient ctx.harnessSlug. A live incident showed
  // wakes 1-3 writing under harness '*' and wake-4 writing under 'papercusp' for the SAME
  // loop, purely because ctx.harnessSlug resolved differently — creating two diverging
  // carry_notes rows and risking a cold reset resuming from the stale one.
  it("WI-2148: resolves harness from the ARMED ROUTINE's install_slug, not ctx.harnessSlug — even when they disagree", async () => {
    getLoopStatus.mockResolvedValueOnce({ harnessSlug: '*' } as never);
    // ctx says 'papercusp' (as if this wake's session context resolved differently than the
    // routine it was armed under) — the routine's '*' must still win, since that's what the
    // reader will resolve the note by.
    await call({ next: 'x' }, { harnessSlug: 'papercusp', workspaceId: 'ws-1' });
    expect(getLoopStatus).toHaveBeenCalledWith('su-caller');
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: '*', ownerId: 'su-caller' }),
      expect.any(String),
    );
  });

  it('WI-2148: falls back to args/ctx/home-hive when getLoopStatus errors (fail-open, never blocks a checkpoint write)', async () => {
    getLoopStatus.mockRejectedValueOnce(new Error('pg down'));
    await call({ next: 'x' }, { harnessSlug: 'papercusp', workspaceId: 'ws-1' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'papercusp' }),
      expect.any(String),
    );
  });

  it('falls back to the home-hive slug when neither arg nor ctx has a harness', async () => {
    await call({ next: 'x' }, { workspaceId: 'ws-1' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'home-hive' }),
      expect.any(String),
    );
  });

  it('errors cleanly (no_harness) when no harness resolves anywhere — never writes an empty-namespace note', async () => {
    const { resolvePotHomeSlug } = await import('../../pot/wake');
    vi.mocked(resolvePotHomeSlug).mockReturnValueOnce(undefined as never);
    const out = await call({ next: 'x' }, { workspaceId: 'ws-1' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ ok: false, error: 'no_harness' });
    expect(setLoopCarryNote).not.toHaveBeenCalled();
  });

  it('rejects an empty call (nothing to write) at the args boundary', () => {
    expect(() => parse({})).toThrow();
  });

  it('bounds advisory continuation reads well below the tool transport timeout', async () => {
    const { CONTINUATION_READ_BUDGET_MS } = await import('./checkpoint');
    await call({ next: 'x' });
    expect(CONTINUATION_READ_BUDGET_MS).toBe(5_000);
    expect(withBoundedTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        fallback: undefined,
        timeoutMs: CONTINUATION_READ_BUDGET_MS,
        label: 'loop:checkpoint continuation reads',
      }),
    );
  });
});

describe('loop:checkpoint — the P-006 walls merge (commitments cleared explicitly, never incidentally)', () => {
  const PRIOR_WITH_WALL = [
    '## Next action',
    'old next step',
    '',
    '## Walls',
    '- zombie PIDs await owner OK — re-check: ps -p 95902 (since 2026-07-07T12:00:00.000Z)',
  ].join('\n');

  it('a rewrite WITHOUT walls carries the prior walls forward onto the new note', async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    const b = body(await call({ did: 'landed X', next: 'ship Y' }));
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('RENDERED:');
    expect(written).toContain('## Walls');
    expect(written).toContain('- zombie PIDs await owner OK — re-check: ps -p 95902 (since 2026-07-07T12:00:00.000Z)');
    expect(b).toMatchObject({ ok: true, walls: 1 });
  });

  it("a note CLEAR with standing walls preserves them as a walls-only note (never an incidental clear)", async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    await call({ note: '' });
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('## Walls\n- zombie PIDs await owner OK');
    expect(written).not.toContain('old next step');
  });

  it('walls:[] is the one true clear — with a blank note the whole row clears', async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    setLoopCarryNote.mockResolvedValue(null);
    const b = body(await call({ note: '', walls: [] }));
    expect(setLoopCarryNote).toHaveBeenCalledWith(expect.anything(), '');
    expect(b).toMatchObject({ ok: true, cleared: true, walls: 0 });
  });

  it('explicit walls replace the set, preserving sinceMs + recheck for a claim that already stood', async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    await call({
      next: 'continue',
      walls: [{ claim: 'zombie PIDs await owner OK' }, { claim: 'capital arming pending owner decision' }],
    });
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('- zombie PIDs await owner OK — re-check: ps -p 95902 (since 2026-07-07T12:00:00.000Z)');
    expect(written).toContain('- capital arming pending owner decision (since ');
  });

  it('a walls-ONLY write keeps the prior narrative body and replaces the walls set', async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    const b = body(await call({ walls: [{ claim: 'new wall', recheck: 'check-it' }] }));
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('## Next action\nold next step'); // body carried forward
    expect(written).toContain('- new wall — re-check: check-it');
    expect(written).not.toContain('zombie PIDs');
    expect(b).toMatchObject({ ok: true, walls: 1 });
  });

  // ── WI-6813: the merge moved INSIDE the write transaction ──────────────────
  //
  // This replaces an older test that pinned the opposite contract ("a throwing
  // prior-note read FAILS OPEN: the write proceeds with no carried walls"). That
  // behaviour was a latent data-loss bug, not a safety property: the tool read the
  // prior in a SEPARATE round-trip, so a transient read blip silently dropped every
  // carried wall — owner-gated commitments — and still reported ok:true, which is
  // precisely the failure walls exist to prevent. There is no separate read to fail
  // any more, so the fail-open path it protected is now unreachable by construction.
  it('WI-6813: merges against the STORE-side prior, so a concurrent writer is not clobbered', async () => {
    // The race the old caller-side read → merge → write had: a peer lands between
    // the read and the write. Here the stale caller-side view (getLoopCarryNote)
    // shows NO walls, while the row the write actually LOCKS carries one. The
    // stored note must reflect the locked row — under the old shape the peer's wall
    // was silently clobbered.
    getLoopCarryNote.mockResolvedValue(null);
    storePriorOverride = PRIOR_WITH_WALL;
    const b = body(await call({ next: 'x' }));
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('zombie PIDs');
    // The REPORTED count comes from the transform's own output, so it describes what
    // was actually stored rather than a second, staler merge that could disagree.
    expect(b).toMatchObject({ ok: true, walls: 1 });
  });

  it('WI-6813: performs no separate prior read — the merge runs in the write transaction', async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    await call({ next: 'x' });
    // Exactly one write call, and it carries the transform the store runs under its
    // row lock. (The only getLoopCarryNote call is the double's own, standing in for
    // the store's locked read — the tool itself no longer reads the prior at all.)
    expect(setLoopCarryNoteWithPrior).toHaveBeenCalledTimes(1);
    const opts = setLoopCarryNoteWithPrior.mock.calls[0]![2] as { transform?: unknown };
    expect(typeof opts?.transform).toBe('function');
    expect(getLoopCarryNote).toHaveBeenCalledTimes(1);
  });

  it('WI-6813: a failing store surfaces the error instead of storing a walls-less note', async () => {
    // The corrected contract. Losing the checkpoint loudly is strictly safer than
    // succeeding with the carried commitments silently stripped out.
    setLoopCarryNote.mockRejectedValue(new Error('pg down'));
    storePriorOverride = PRIOR_WITH_WALL;
    await expect(call({ next: 'x' })).rejects.toThrow('pg down');
  });
});

describe('pickUnreadCursor — P-007 fleet-member-dx (EI-9035)', () => {
  it('never-settled watermark + a real inbox read ⇒ the read is the cursor (the old permanent "inbox not evaluated" case)', async () => {
    const { pickUnreadCursor } = await import('./checkpoint');
    expect(pickUnreadCursor('', '2026-07-10T03:00:00.000Z')).toBe('2026-07-10T03:00:00.000Z');
    expect(pickUnreadCursor(null, '2026-07-10T03:00:00.000Z')).toBe('2026-07-10T03:00:00.000Z');
  });

  it('a mid-turn read AFTER the last settle narrows the window to post-read arrivals', async () => {
    const { pickUnreadCursor } = await import('./checkpoint');
    expect(
      pickUnreadCursor('2026-07-10T01:00:00.000Z', '2026-07-10T03:00:00.000Z'),
    ).toBe('2026-07-10T03:00:00.000Z');
  });

  it('a stale read BEFORE the last settle defers to the watermark', async () => {
    const { pickUnreadCursor } = await import('./checkpoint');
    expect(
      pickUnreadCursor('2026-07-10T03:00:00.000Z', '2026-07-10T01:00:00.000Z'),
    ).toBe('2026-07-10T03:00:00.000Z');
  });

  it('neither cursor ⇒ null (the gate blocks — fail-safe toward settling, unchanged)', async () => {
    const { pickUnreadCursor } = await import('./checkpoint');
    expect(pickUnreadCursor('', null)).toBeNull();
    expect(pickUnreadCursor(undefined, undefined)).toBeNull();
  });
});

// EI-18833865002636933 — the SEAM: a `did` that is really a tag-serialized whole note is
// rescued back into four fields + typed checks BEFORE renderCarryNote sees it, and the
// rescue is REPORTED (silence is the defect this closes: the degraded note reached the
// next cold wake looking like sloppy authoring, with nothing saying it had been mangled).
describe('EI-18833865002636933: rescue-by-parse of a tag-serialized structured write', () => {
  const BLOB = [
    'Closed two gate threats.</did>',
    '<left>Nothing claimed.</left>',
    '<insight>A gate verdict is a snapshot.</insight>',
    '<next>Confirm the gate outcome.</next>',
    '<checks>[{"claim":"main is green","recheck":"git rev-parse main","verified":"21:05Z verdict"}]</checks>',
  ].join('\n');

  it('splits the blob into four fields, recovers typed checks, and REPORTS the rescue', async () => {
    const b = body(await call({ did: BLOB }));
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain(
      'RENDERED:' +
        JSON.stringify({
          did: 'Closed two gate threats.',
          left: 'Nothing claimed.',
          insight: 'A gate verdict is a snapshot.',
          next: 'Confirm the gate outcome.',
        }),
    );
    // the checks became a real `## Checks` section with the ✓ badge, not inert JSON prose
    expect(b.checks).toBe(1);
    expect(written).toContain('## Checks');
    expect(written).toContain('- ✓ main is green — re-check: git rev-parse main');
    expect(b.rescued).toMatchObject({ from: 'tagged-blob' });
    expect(b.rescued.recovered).toEqual(expect.arrayContaining(['left', 'insight', 'next', 'checks']));
  });

  it('an explicit `checks` arg still WINS over a rescued <checks> block', async () => {
    const b = body(await call({ did: BLOB, checks: [{ claim: 'explicit wins' }] }));
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(b.checks).toBe(1);
    expect(written).toContain('explicit wins');
    expect(written).not.toContain('main is green');
  });

  // ── NEGATIVE CONTROLS (the load-bearing half) ──────────────────────────────────
  it('NEGATIVE: a `did` quoting code/JSX/shell is stored BYTE-IDENTICAL and never split', async () => {
    const honest = 'Ran `cmd 2>&1 > /tmp/x.log`; fixed `<div><span/></div>` and the `a < b` guard.';
    await call({ did: honest });
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toBe('RENDERED:' + JSON.stringify({ did: honest }));
  });

  it('NEGATIVE: a correctly-structured call is untouched by the rescue path', async () => {
    // `did` even contains the literal close tag — siblings ARE present, so this is a
    // well-formed write that merely quotes the tag, not a serialized blob.
    const b = body(await call({ did: 'documented </did> in the runbook', left: 'l', insight: 'i', next: 'n' }));
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain(
      'RENDERED:' + JSON.stringify({ did: 'documented </did> in the runbook', left: 'l', insight: 'i', next: 'n' }),
    );
    expect(b.rescued).toBeUndefined();
  });

  it('NEGATIVE: a raw { note } containing the tag shape is written verbatim (raw notes are never parsed)', async () => {
    await call({ note: BLOB });
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('</did>');
    expect(written).not.toContain('RENDERED:');
  });
});
