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
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';

const setLoopCarryNote = vi.fn();
const getLoopCarryNote = vi.fn();
const getLoopStatus = vi.fn();
const getSessionBrief = vi.fn();
const getPresence = vi.fn();
const readInbox = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const readWatermark = vi.fn(async (..._a: unknown[]) => ({ messages_since_ts: '' }));
const orgSql = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const currentContextTokensForOwner = vi.fn(async (..._a: unknown[]) => null as number | null);
const defaultCompactionLimitForSpec = vi.fn(
  (..._a: Parameters<typeof import('../../agent-config-constants').defaultCompactionLimitForSpec>) => 100,
);
const listActiveAwaits = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const getModes = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const selfCompactionAvailability = vi.fn(
  (..._a: Parameters<typeof import('../../events/await/psu-pty-discovery').selfCompactionAvailability>) =>
    ({ available: false }),
);
const readFleetWindDownLoopEndAuthorization = vi.fn(async (..._a: unknown[]) => null as boolean | null);
const withBoundedTimeout = vi.fn(
  async (..._a: unknown[]): Promise<{ value: unknown; degraded: boolean; elapsedMs: number }> =>
    ({ value: undefined, degraded: false, elapsedMs: 0 }),
);
const listVerifiedWaitTakeoversForSubscribers = vi.fn(
  async (..._a: unknown[]): Promise<unknown[]> => [],
);
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
// WI-7124: what the STORE actually persisted on the last write — the fixture for the new
// verify-read (getLoopCarryNoteWithMeta), so every PRE-EXISTING test in this suite (which
// only ever configures setLoopCarryNote's return value) automatically gets a verify-read
// that AGREES with it, with zero changes needed at each call site. A test that wants to
// exercise the checkpoint_verify_failed path overrides getLoopCarryNoteWithMeta directly
// (see the WI-7124 describe block below).
let lastStoredNote: string | null = null;
const setLoopCarryNoteWithPrior = vi.fn(
  async (
    ref: unknown,
    note: unknown,
    // Derived from the real signature, not a hand-written subset: a narrower
    // literal here drifts silently the moment carry-note grows an option, and
    // reds the fleet gate from a file nobody edited.
    opts?: Parameters<typeof import('../../carry-note').setLoopCarryNoteWithPrior>[2],
  ) => {
    const prior =
      storePriorOverride !== undefined ? storePriorOverride : (((await getLoopCarryNote()) as string | null) ?? null);
    const merged = opts?.transform
      ? opts.transform(prior, note as string | null | undefined)
      : (note as string | null | undefined);
    const stored = await setLoopCarryNote(ref, merged);
    lastStoredNote = (stored as string | null | undefined) ?? null;
    return { stored, priorLength: (prior ?? '').length };
  },
);
const getLoopCarryNoteWithMeta = vi.fn(async (..._a: unknown[]) => ({
  note: lastStoredNote,
  updatedAtMs: lastStoredNote !== null ? Date.now() : null,
}));
vi.mock('../../carry-note', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setLoopCarryNote: (...a: unknown[]) => setLoopCarryNote(...a),
  // Derive the tuple from the real signature rather than hardcoding one: a
  // hardcoded `[unknown, unknown, never]` silently drifts the moment the
  // signature changes, and reds the fleet gate from a file nobody edited.
  setLoopCarryNoteWithPrior: (...a: Parameters<typeof import('../../carry-note').setLoopCarryNoteWithPrior>) =>
    setLoopCarryNoteWithPrior(...a),
  getLoopCarryNote: (...a: unknown[]) => getLoopCarryNote(...a),
  getLoopCarryNoteWithMeta: (...a: unknown[]) => getLoopCarryNoteWithMeta(...a),
  renderCarryNote: (f: Record<string, string | undefined>) => `RENDERED:${JSON.stringify(f)}`,
}));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-caller', ownerLabel: 'su · caller', workspaceId: 'ws-1' })),
}));
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPresence: (...a: unknown[]) => getPresence(...a),
}));
vi.mock('../coordination/messages', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readInbox: (...a: unknown[]) => readInbox(...a),
}));
vi.mock('../coordination/watermarks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWatermark: (...a: unknown[]) => readWatermark(...a),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: orgSql }),
}));
vi.mock('../../compaction-usage', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentContextTokensForOwner: (...a: unknown[]) => currentContextTokensForOwner(...a),
}));
vi.mock('../../agent-config-constants', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  defaultCompactionLimitForSpec: (
    ...a: Parameters<typeof import('../../agent-config-constants').defaultCompactionLimitForSpec>
  ) => defaultCompactionLimitForSpec(...a),
}));
vi.mock('../../modes/store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getModes: (...a: unknown[]) => getModes(...a),
}));
vi.mock('../../events/await/psu-pty-discovery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  selfCompactionAvailability: (
    ...a: Parameters<typeof import('../../events/await/psu-pty-discovery').selfCompactionAvailability>
  ) => selfCompactionAvailability(...a),
}));
vi.mock('../coordination/tools/continuation-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFleetWindDownLoopEndAuthorization: (...a: unknown[]) => readFleetWindDownLoopEndAuthorization(...a),
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
// WI-2148: loop:checkpoint resolves its default harness from the ARMED routine
// (getLoopStatus), so it matches whatever the cold-wake reader resolves. A concrete
// EXPLICIT harness remains an intentional cross-harness address and wins over that
// default. Most tests have no armed routine (null), so they fall through to the old
// arg/ctx/home-hive chain.
vi.mock('../../harness/routines/loop', () => ({ getLoopStatus: (...a: unknown[]) => getLoopStatus(...a) }));
vi.mock('../../session-brief', () => ({ getSessionBrief: (...a: unknown[]) => getSessionBrief(...a) }));
vi.mock('../../bounded-timeout', () => ({
  withBoundedTimeout: (...a: unknown[]) => withBoundedTimeout(...a),
}));
vi.mock('../../events/await/store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listVerifiedWaitTakeoversForSubscribers: (...a: unknown[]) =>
    listVerifiedWaitTakeoversForSubscribers(...a),
  listActiveAwaits: (...a: unknown[]) => listActiveAwaits(...a),
}));

const tool = (await import('./checkpoint')).default;
// REAL (the carry-note mock above spreads importOriginal) — used to build prior notes
// through the same renderer the store persists, rather than a drift-prone literal.
const {
  mergeCarryRows,
  CARRY_CAP_HARD_MULTIPLE,
  CARRY_NOTE_MAX_CHECKS,
  CARRY_NOTE_MAX_WALLS,
  CARRY_ROW_SOFT_CAPS,
  CARRY_ROW_ID_MAX,
} = await import('../../carry-note');

type Out = { content: { text: string }[]; isError?: boolean };
const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
const call = (args: Record<string, unknown>, ctx: unknown = { harnessSlug: 'papercusp', workspaceId: 'ws-1' }) =>
  tool.handler(parse(args) as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  storePriorOverride = undefined; // default: the store's prior IS getLoopCarryNote's value
  lastStoredNote = null; // WI-7124: reset the verify-read fixture between tests
  setLoopCarryNote.mockResolvedValue('stored-note');
  getLoopCarryNote.mockResolvedValue(null); // default: no prior note ⇒ no walls to carry
  getLoopStatus.mockResolvedValue(null); // default: no armed routine found
  getSessionBrief.mockResolvedValue(null); // default: no durable coord:orient scope found
  getPresence.mockResolvedValue(null);
  readInbox.mockResolvedValue([]);
  readWatermark.mockResolvedValue({ messages_since_ts: '' });
  orgSql.mockResolvedValue([]);
  currentContextTokensForOwner.mockResolvedValue(null);
  defaultCompactionLimitForSpec.mockReturnValue(100);
  listActiveAwaits.mockResolvedValue([]);
  getModes.mockResolvedValue([]);
  selfCompactionAvailability.mockReturnValue({ available: false });
  readFleetWindDownLoopEndAuthorization.mockResolvedValue(null);
  withBoundedTimeout.mockResolvedValue({ value: undefined, degraded: false, elapsedMs: 0 });
  listVerifiedWaitTakeoversForSubscribers.mockResolvedValue([]);
});

describe('loop:checkpoint — the loop carry-note producer', () => {
  it('returns a retryable structured result when the carry write hits transient PostgreSQL contention', async () => {
    setLoopCarryNoteWithPrior.mockRejectedValueOnce(new OrgTxnTimeoutError('55P03', new Error('lock timeout')));

    const b = body(await call({ did: 'checkpoint before the next cold wake' }));

    expect(b).toMatchObject({ ok: false, error: 'timeout', retryable: true, pgCode: '55P03' });
    expect(b.message).toContain('No carry-note was committed');
  });

  it('opts out of the ambient workspace transaction because the handler owns independent DB scopes', () => {
    expect((tool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  // The default flipped to merge (see the P-013 block below), so what the tool must
  // document flipped with it: the preserving default, and the explicit REPLACE that is
  // now the only way to retire a row. An agent that cannot find the retirement path in
  // the description has no way to drop a stale check at all.
  it('documents the preserving default and the explicit rowsMode retirement path', () => {
    const description = (tool as unknown as { description?: string }).description ?? '';
    const guidance = (tool as unknown as { guidance?: { when?: string } }).guidance?.when ?? '';
    expect(description).toContain("rowsMode:'replace'");
    expect(description).toContain("rowsMode:'merge'");
    expect(description).toMatch(/empty list with replace/i);
    expect(guidance).toContain("rowsMode:'replace'");
    expect(guidance).toMatch(/default merge mode preserves them/i);
  });

  it('guides cold-carry authors to anchor owner directives and completed actions', () => {
    const guidance = (tool as unknown as { guidance?: { when?: string } }).guidance;
    expect(guidance?.when).toContain('[turn:<session>@<iso-ts>]');
    expect(guidance?.when).toMatch(/same-line/i);
    expect(guidance?.when).toMatch(/never invent a ref/i);
    expect(guidance?.when).toContain('[self-imposed]');
  });

  it('structured fields → renderCarryNote, keyed by caller ownerId + ctx harness (the loopScope the wake executor reads)', async () => {
    const b = body(await call({ did: 'wired producer', left: 'run tests', insight: 'inject wraps note', next: 'vitest' }));
    expect(b).toMatchObject({ ok: true, harness: 'papercusp', ownerId: 'su-caller', cleared: false });
    expect(b.length).toBeGreaterThan(0);
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      { harness: 'papercusp', ownerId: 'su-caller', workspaceId: 'ws-1' },
      'RENDERED:' + JSON.stringify({ did: 'wired producer', left: 'run tests', insight: 'inject wraps note', next: 'vitest' }),
    );
  });

  it('surfaces durable stalled-wait evidence and the takeover remedy in the checkpoint result', async () => {
    const alert = {
      subscriberId: 'su-caller',
      eventKey: 'release:green:papercusp',
      firedAt: '2026-08-13T12:00:00.000Z',
      classification: 'stalled',
      nextAction: 'wake-owner-or-takeover',
      producer: { kind: 'green-checkpoint', id: 'run-42' },
      owner: { ownerId: 'su-producer', workItemId: 'WI-42' },
      checkedAtMs: 42,
      verificationDeadlineMs: 40,
      lastProgressAtMs: 1,
      lastFireAtMs: null,
      evidence: { phase: 'suite' },
      remedy: 'Wake the owner of WI-42; if it does not resume promptly, claim/take over WI-42.',
    } as const;
    listVerifiedWaitTakeoversForSubscribers.mockResolvedValueOnce([alert]);
    withBoundedTimeout
      .mockResolvedValueOnce({ value: undefined, degraded: false, elapsedMs: 0 })
      .mockResolvedValueOnce({ value: [alert], degraded: false, elapsedMs: 1 });

    const b = body(await call({ did: 'checkpointing before takeover', next: 'wake owner' }));

    expect(listVerifiedWaitTakeoversForSubscribers).toHaveBeenCalledWith(['su-caller']);
    expect(b.verifiedWaitTakeovers).toEqual([alert]);
  });

  it('accepts goal as a compatibility alias for next, while explicit next wins', async () => {
    await call({ did: 'made progress', goal: 'run the focused suite' });
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toBe(
      'RENDERED:' +
        JSON.stringify({ did: 'made progress', left: undefined, insight: undefined, next: 'run the focused suite' }),
    );

    setLoopCarryNote.mockClear();
    await call({ goal: 'stale alias', next: 'authoritative next action' });
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toBe(
      'RENDERED:' +
        JSON.stringify({ did: undefined, left: undefined, insight: undefined, next: 'authoritative next action' }),
    );
  });

  it('warns when left/next imperatively invokes a singleton mutator without its precondition', async () => {
    const b = body(
      await call({
        next: "FIRE IT NOW: tools:invoke { name:'release:checkpoint-run' }",
      }),
    );
    expect(b.ok).toBe(true);
    expect(b.imperativeLint?.flagged).toBe(true);
    expect(b.imperativeLint?.matches[0]).toMatchObject({ target: 'release:checkpoint-run' });
    expect(setLoopCarryNote).toHaveBeenCalled();
  });

  it('clears the imperative warning only with a matching runnable checks recheck', async () => {
    const b = body(
      await call({
        left: 'run release:checkpoint-run only when no active run exists',
        checks: [
          {
            claim: 'checkpoint run is safe only when no active singleton exists',
            recheck: 'systemctl --user list-units --all | grep green-checkpoint',
          },
        ],
      }),
    );
    expect(b.ok).toBe(true);
    expect(b.imperativeLint).toBeUndefined();
  });

  it('checksLint accepts matching stable row ids as coverage anchors', async () => {
    const prose =
      'Stable-C generation stable-c-false-0517 MUST remain false; ' +
      'c58 re-arm generation c58-rearm-pending MUST remain pending.';
    const b = body(
      await call({
        note: prose,
        checks: [
          {
            id: 'stable-c-false-0517',
            claim: 'Stable-C is false',
            recheck: 'read current Stable-C result',
            verified: 'current value confirmed',
          },
          {
            id: 'c58-rearm-pending',
            claim: 'c58 re-arm is pending',
            recheck: 'read current c58 await status',
            verified: 'current value confirmed',
          },
        ],
      }),
    );
    expect(b.ok).toBe(true);
    expect(b.checksLint).toBeUndefined();
  });

  // outage-must-not-be-silent-2026-08-02 P-009 — the absence-claim leg.
  //
  // The pre-existing checksLint keys on a distinctive token (hash / WI-EI id / ISO instant)
  // or an external-state noun. An absence claim carries none of those and passed straight
  // through. The sentence used below is the REAL one from the incident that motivated this:
  // it was checkpointed as settled fact, read back as fact on the next wake, and ~180 lines
  // were shipped on it before a reverse-grep refuted it (plan D-005).
  describe('absenceLint — an absence assertion in the carry-note is flagged with its falsifier', () => {
    const INCIDENT_CLAIM =
      'The mcp-proxy failure ledger has been written since W8 and there is no reader for it — nothing ingests the file.';

    it('flags an absence claim and hands back a concrete recheck', async () => {
      const b = body(await call({ did: INCIDENT_CLAIM, next: 'ship the summary' }));
      expect(b.ok).toBe(true);
      expect(b.absenceLint?.flagged).toBe(true);
      expect(b.absenceLint.claims.length).toBeGreaterThan(0);
      // The remedy must be a SEARCH, not merely "double-check this".
      expect(b.absenceLint.claims[0].recheck).toBeTruthy();
      // The directive has to name the reverse direction — the actual failure was grepping
      // the write site and never searching for readers.
      expect(b.absenceLint.note).toMatch(/reverse-grep/i);
    });

    it('is ADVISORY — the checkpoint is still written', async () => {
      await call({ did: INCIDENT_CLAIM, next: 'ship it' });
      expect(setLoopCarryNote).toHaveBeenCalled();
    });

    it('omits the key entirely for a note that asserts no absence', async () => {
      const b = body(await call({ did: 'shipped the classifier fix', left: 'run tests', next: 'vitest' }));
      expect(b.absenceLint).toBeUndefined();
    });

    it('stays quiet for rhetorical `no X` prose', async () => {
      const b = body(await call({ did: 'Cheap enough that there is no excuse for relaying.', next: 'continue' }));
      expect(b.ok).toBe(true);
      expect(b.absenceLint).toBeUndefined();
    });

    it('stays quiet when the author already parked the falsifier as a check', async () => {
      const b = body(
        await call({
          did: INCIDENT_CLAIM,
          next: 'ship it',
          checks: [
            {
              claim: INCIDENT_CLAIM,
              recheck: "grep -rn 'mcp-proxy-health' packages apps libs",
              verified: 'searched importers 2026-08-03: none found',
            },
          ],
        }),
      );
      expect(b.absenceLint).toBeUndefined();
    });
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

  it('honors an explicit cross-harness target over another active loop', async () => {
    getLoopStatus.mockResolvedValueOnce({ harnessSlug: 'papercusp' } as never);

    await call({ next: 'x', harness: 'sidestage' }, { harnessSlug: 'papercusp', workspaceId: 'ws-1' });

    expect(getLoopStatus).toHaveBeenCalledWith('su-caller');
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'sidestage', ownerId: 'su-caller' }),
      expect.any(String),
    );
    expect(getLoopCarryNoteWithMeta).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'sidestage', ownerId: 'su-caller' }),
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

  it('EI-21183575241304993: uses the durable session scope before an unrelated owner loop under wildcard transport', async () => {
    getSessionBrief.mockResolvedValueOnce({ harnessSlug: 'papercusp' } as never);
    getLoopStatus.mockResolvedValueOnce({ harnessSlug: 'sb-devboard-hive', active: false } as never);

    await call({ next: 'x' }, { harnessSlug: '*', workspaceId: 'ws-1' });

    expect(getSessionBrief).toHaveBeenCalledWith({ ownerId: 'su-caller' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'papercusp', ownerId: 'su-caller' }),
      expect.any(String),
    );
  });

  it('EI-21189207633735449: an active routine install_slug wins over a stale session scope', async () => {
    getSessionBrief.mockResolvedValueOnce({ harnessSlug: 'papercusp' } as never);
    getLoopStatus.mockResolvedValueOnce({ harnessSlug: 'sb-devboard-hive', active: true } as never);

    await call({ next: 'x' }, { harnessSlug: '*', workspaceId: 'ws-1' });

    expect(getSessionBrief).toHaveBeenCalledWith({ ownerId: 'su-caller' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'sb-devboard-hive', ownerId: 'su-caller' }),
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

  it('runtime wiring: feeds live context, inbox, re-wake, and typed wind-down reads into the gate', async () => {
    // Execute the bounded callback instead of returning its default fallback. This is
    // deliberately handler-level coverage: the pure gate tests cannot catch a dropped
    // dynamic import, stale presence-only token source, or an unread cursor that never
    // reaches the continuation verdict.
    withBoundedTimeout.mockImplementation(async (work: unknown) => ({
      value:
        typeof work === 'function'
          ? await (work as () => Promise<unknown>)()
          : await (work as Promise<unknown>),
      degraded: false,
      elapsedMs: 0,
    }));
    getLoopStatus.mockResolvedValue({ harnessSlug: 'papercusp', active: true, carry: 'warm' });
    getPresence.mockResolvedValue({ contextTokens: 1, compactionLimit: 100 });
    currentContextTokensForOwner.mockResolvedValue(95);
    readWatermark.mockResolvedValue({ messages_since_ts: '2026-08-21T05:00:00.000Z' });
    readInbox.mockResolvedValue([]);
    selfCompactionAvailability.mockReturnValue({ available: false });
    readFleetWindDownLoopEndAuthorization.mockResolvedValue(true);

    const b = body(await call({ next: 'wire the gate' }));

    expect(b.continuation).toMatchObject({
      contextPct: 95,
      unreadInbox: 0,
      rewakeGuaranteed: true,
      nextWakeFresh: false,
      selfCompactionAvailable: false,
      fleetWindDownLoopEndAuthorized: true,
    });
    expect(b.continuation.guidance).toContain('AUTHORIZED FLEET WIND-DOWN');
    expect(b.continuation.guidance).toContain('loop:end');
    expect(b.continuation.guidance).toContain('do not call session:end or respawn');
    expect(currentContextTokensForOwner).toHaveBeenCalledWith('su-caller');
    expect(readWatermark).toHaveBeenCalledWith('su-caller');
    expect(orgSql).toHaveBeenCalled();
    expect(readInbox).toHaveBeenCalledWith(
      'su-caller',
      { since_ts: '2026-08-21T05:00:00.000Z', excludeOwn: true },
    );
    expect(selfCompactionAvailability).toHaveBeenCalledWith('su-caller');
    expect(readFleetWindDownLoopEndAuthorization).toHaveBeenCalledWith({
      ownerId: 'su-caller',
      workspaceId: 'ws-1',
    });
  });
});

describe('WI-7124: verify-read — the write must read back via the SAME path a cold wake uses', () => {
  it('a normal write reports verified:true + a contentHash (read-back agrees with what was stored)', async () => {
    const b = body(await call({ next: 'x' }));
    expect(b).toMatchObject({ ok: true, verified: true });
    expect(b.contentHash).toMatch(/^[0-9a-f]{12}$/);
    expect(getLoopCarryNoteWithMeta).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'papercusp', ownerId: 'su-caller' }),
    );
  });

  it('a clear (stored=null) skips the verify-read entirely — nothing to verify', async () => {
    setLoopCarryNote.mockResolvedValueOnce(null);
    const b = body(await call({ note: '' }));
    expect(b).toMatchObject({ ok: true, cleared: true, verified: null, contentHash: null });
    expect(getLoopCarryNoteWithMeta).not.toHaveBeenCalled();
  });

  it('WI-2148-class divergence: a read-back that disagrees with what was stored fails LOUDLY (checkpoint_verify_failed), never silently', async () => {
    // Simulate exactly the documented failure: the write landed under one scope key
    // but the reader resolves a DIFFERENT (stale/absent) row.
    getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note: null, updatedAtMs: null });
    const out = await call({ next: 'x' });
    expect(out.isError).toBe(true);
    const b = body(out);
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/checkpoint_verify_failed/);
    expect(b.error).toMatch(/WI-2148/);
  });

  it('a verify-read that throws is treated as a miss (fails loud, never crashes the tool)', async () => {
    getLoopCarryNoteWithMeta.mockRejectedValueOnce(new Error('pg down'));
    const out = await call({ next: 'x' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ ok: false });
    expect(body(out).error).toMatch(/checkpoint_verify_failed/);
  });

  it('a verify mismatch short-circuits BEFORE the advisory continuation-gate reads run', async () => {
    getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note: 'something-else', updatedAtMs: 1 });
    await call({ next: 'x' });
    expect(withBoundedTimeout).not.toHaveBeenCalled();
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

  // Post-P-013 the empty list is a NO-OP under the merge default (the tool says so in
  // its own rowsModeNote), so the clear has to be asked for: replace + []. That is the
  // point of the change — a commitment can no longer be cleared incidentally.
  it("walls:[] under rowsMode:'replace' is the one true clear — with a blank note the whole row clears", async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    setLoopCarryNote.mockResolvedValue(null);
    const b = body(await call({ note: '', walls: [], rowsMode: 'replace' }));
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

  it("a walls-ONLY write keeps the prior narrative body and, under rowsMode:'replace', replaces the walls set", async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    const b = body(await call({ walls: [{ claim: 'new wall', recheck: 'check-it' }], rowsMode: 'replace' }));
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

describe('loop:checkpoint — current-vs-retained provenance (EI-21165235642497045)', () => {
  it('reports lint from carried rows under retainedProvenance, not provenanceLint', async () => {
    const current = 'the owner said to run the focused suite';
    const retained = 'the owner said to retain the old checkpoint';
    const prior = mergeCarryRows({
      priorNote: null,
      baseNote: 'old narrative',
      checks: [{ claim: retained }],
      hasNoteWrite: true,
    }).note;

    getLoopCarryNote.mockResolvedValue(prior);
    setLoopCarryNote.mockImplementation(async (_ref: unknown, note: unknown) => note as string);
    withBoundedTimeout.mockImplementation(async (_work: unknown, options: unknown) => ({
      value: (options as { label?: string } | undefined)?.label === 'carry-provenance-stamp' ? [[], null] : undefined,
      degraded: false,
      elapsedMs: 0,
    }));

    const result = body(await call({ note: current }));

    expect(result.ok).toBe(true);
    expect(result.provenanceLint?.matches.some((match: { line: string }) => match.line === current)).toBe(true);
    expect(result.retainedProvenance?.matches.some((match: { line: string }) => match.line.includes(retained))).toBe(true);
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

// WI-7264 — a carry-note write must not be DISCARDED over one oversized or
// wrong-shaped sub-field.
//
// Measured over 6 days of real transcripts: 80 of 1,152 loop:checkpoint calls were
// rejected (541,043 argument chars, 7.7% of this tool's total), and the bytes are
// spent TWICE because the agent rewrites and re-sends the whole note. 53 of those
// were a sub-field a few chars over its cap; ~97 were the `{status, evidence}` row
// shape. Both discard a ~6KB note the caller had already paid to transmit.
//
// The contract these tests pin: repair what is unambiguously repairable, REPORT any
// repair that lost bytes, and keep rejecting what is genuinely undeclared (EI-10883).
describe("WI-7264: repair-don't-refuse — an oversized or wrong-shaped sub-field must not discard the note", () => {
  describe('row SHAPE coercion (the {status, evidence} confusion)', () => {
    it('maps {status, evidence} to `verified`, PRESERVING the evidence rather than dropping it', () => {
      const out = parse({
        checks: [{ claim: 'gate is green', recheck: 'state:read', status: 'verified', evidence: 'saw 30/30 pass' }],
      }) as { checks: { claim: string; recheck?: string; verified?: string }[] };
      // The evidence survives, so the row still renders VERIFIED. This is the exact
      // data EI-18723223344390510 used to destroy silently.
      expect(out.checks[0]).toEqual({ claim: 'gate is green', recheck: 'state:read', verified: 'saw 30/30 pass' });
    });

    it('downgrades contradictory verification evidence at the writer boundary and reports the repair', async () => {
      const b = body(
        await call({
          did: 'checkpointed the affected suite',
          checks: [{ claim: 'the suite is green', recheck: 'run the suite', verified: 'STILL RUNNING at compaction' }],
        }),
      );
      expect(b.ok).toBe(true);
      expect(b.repairs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'checks[0].verified',
            kind: 'downgraded',
            detail: expect.stringContaining('STILL RUNNING'),
          }),
        ]),
      );
      const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
      expect(written).toContain('- ⚠ ');
      expect(written).toContain('STILL RUNNING');
      expect(written).not.toContain('- ✓ ');
    });

    it('keeps clean verification evidence as VERIFIED', async () => {
      const b = body(
        await call({
          did: 'checkpointed the affected suite',
          checks: [{ claim: 'the suite is green', recheck: 'run the suite', verified: '30/30 passed' }],
        }),
      );
      expect(b.ok).toBe(true);
      expect(b.repairs).toBeUndefined();
      const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
      expect(written).toContain('- ✓ ');
    });

    it('keeps literal lifecycle fields and await counts VERIFIED at the writer boundary', async () => {
      const literalStateEvidence = [
        'events:status expected_verdict=pending',
        'D-077 pending-fire hold',
        'loop health check reported five live awaits',
      ];

      for (const evidence of literalStateEvidence) {
        const b = body(
          await call({
            did: 'checkpointed the observed loop state',
            checks: [{ claim: 'the observed loop state is verified', recheck: 'repeat the state probe', verified: evidence }],
          }),
        );
        expect(b.ok, evidence).toBe(true);
        expect(b.repairs, evidence).toBeUndefined();
        const [, written] = setLoopCarryNote.mock.calls.at(-1) as [unknown, string];
        expect(written, evidence).toContain('- ✓ ');
        expect(written, evidence).toContain(evidence);
        expect(written, evidence).not.toContain('- ⚠ ');
      }
    });

    it('maps descriptive label/name rows to `claim` while preserving an explicit claim', () => {
      const out = parse({
        checks: [
          { label: 'labelled claim', status: 'verified', evidence: 'observed labelled claim' },
          { name: 'named claim' },
          {
            claim: 'canonical claim',
            label: 'ignored label',
            name: 'ignored name',
            status: 'verified',
            evidence: 'observed canonical claim',
          },
        ],
      }) as { checks: { claim: string; verified?: string }[] };

      expect(out.checks).toEqual([
        { claim: 'labelled claim', verified: 'observed labelled claim' },
        { claim: 'named claim' },
        { claim: 'canonical claim', verified: 'observed canonical claim' },
      ]);
    });

    it('does NOT invent a verification: a not-yet-verified status maps to no `verified` at all (stays PREDICTED)', () => {
      const out = parse({ checks: [{ claim: 'deploy landed', status: 'predicted' }] }) as {
        checks: { claim: string; verified?: string }[];
      };
      expect(out.checks[0]).toEqual({ claim: 'deploy landed' });
      expect(out.checks[0]).not.toHaveProperty('verified');
    });

    it('accepts the boolean `verified` the schema used to reject, without upgrading false to verified', () => {
      const t = parse({ checks: [{ claim: 'a', verified: true, evidence: 'observed at 03:00Z' }] }) as {
        checks: { verified?: string }[];
      };
      expect(t.checks[0]!.verified).toBe('observed at 03:00Z');
      const f = parse({ checks: [{ claim: 'a', verified: false }] }) as { checks: { verified?: string }[] };
      expect(f.checks[0]).not.toHaveProperty('verified');
    });

    it('maps compact check claim strings to lossless `{ claim }` rows', () => {
      const out = parse({ checks: ['gate is green', 'main is at abc123'] }) as { checks: { claim: string }[] };
      expect(out.checks).toEqual([{ claim: 'gate is green' }, { claim: 'main is at abc123' }]);
    });

    it('accepts scalar and JSON-encoded check strings from stale wire manifests', () => {
      expect(parse({ checks: 'gate is green' })).toMatchObject({ checks: [{ claim: 'gate is green' }] });
      expect(parse({ checks: '["gate is green"]' })).toMatchObject({ checks: [{ claim: 'gate is green' }] });
    });

    it('writes compact check strings through the normal typed row path', async () => {
      const b = body(await call({ did: 'progress', checks: ['gate is green'] }));
      expect(b).toMatchObject({ ok: true, checks: 1 });
    });

    it('does NOT coerce that shape onto walls — a wall has no `verified`, so the only mapping would DROP data', () => {
      // Deliberate asymmetry with checks. Coercing here would have to discard the
      // caller's `evidence` (there is nowhere lossless to put it), which is precisely
      // the silent-loss failure EI-18723223344390510 was fixed to stop. Failing loudly
      // is the correct outcome, and walls see ~2 such calls per 6 days vs 97 for checks.
      expect(() => parse({ walls: [{ claim: 'needs owner key', status: 'verified', evidence: 'asked 02:00Z' }] })).toThrow();
    });

    it('maps compact wall claim strings to lossless `{ claim }` rows', () => {
      const out = parse({ walls: ['needs owner key', 'awaiting owner approval'] }) as {
        walls: { claim: string }[];
      };
      expect(out.walls).toEqual([{ claim: 'needs owner key' }, { claim: 'awaiting owner approval' }]);
    });

    it('accepts a scalar or JSON-encoded string wall from a stale wire manifest', () => {
      expect(parse({ walls: 'needs owner key' })).toMatchObject({ walls: [{ claim: 'needs owner key' }] });
      expect(parse({ walls: '["needs owner key"]' })).toMatchObject({ walls: [{ claim: 'needs owner key' }] });
    });

    it('writes compact wall strings through the normal typed row path', async () => {
      const b = body(await call({ did: 'progress', walls: ['needs owner key'] }));
      expect(b).toMatchObject({ ok: true, walls: 1 });
    });

    it('walls still get the cap RELAXATION even though they get no shape coercion', async () => {
      const b = body(await call({ did: 'p', walls: [{ claim: 'W'.repeat(700) }] }));
      expect(b.ok).toBe(true);
      expect(b.repairs[0]).toMatchObject({ field: 'walls[0].claim', kind: 'truncated' });
    });

    it('still REJECTS a genuinely undeclared key — EI-10883 is preserved, not weakened', () => {
      expect(() => parse({ did: 'x', totallyMadeUpKey: 'y' })).toThrow();
      expect(() => parse({ checks: [{ claim: 'a', nonsenseField: 'b' }] })).toThrow();
    });
  });

  describe('soft caps are enforced by TRUNCATION, and every trim is reported', () => {
    it('accepts a bounded overlong row id but still rejects an absurdly long one at the input boundary', () => {
      expect(() => parse({ did: 'progress', checks: [{ claim: 'c', id: 'x'.repeat(CARRY_ROW_ID_MAX) }] })).not.toThrow();
      expect(() => parse({ did: 'progress', checks: [{ claim: 'c', id: 'x'.repeat(CARRY_ROW_ID_MAX + 1) }] })).not.toThrow();
      expect(() =>
        parse({
          did: 'progress',
          checks: [{ claim: 'c', id: 'x'.repeat(CARRY_ROW_ID_MAX * CARRY_CAP_HARD_MULTIPLE + 1) }],
        }),
      ).toThrow();
    });

    it('reports a long-id identity repair and stores the bounded merge identity', async () => {
      const longId = 'x'.repeat(CARRY_ROW_ID_MAX + 1);
      const b = body(await call({ did: 'progress', checks: [{ claim: 'c', id: longId }] }));
      expect(b.ok).toBe(true);
      expect(b.repairs).toHaveLength(1);
      expect(b.repairs[0]).toMatchObject({ field: 'checks[0].id', kind: 'truncated' });
      expect(b.repairs[0].detail).toContain(`${longId.length} chars`);
      expect(b.repairs[0].detail).toContain(`${CARRY_ROW_ID_MAX} chars`);
      const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
      expect(written).toContain(`[#${'x'.repeat(CARRY_ROW_ID_MAX)}]`);
    });

    it('accepts recovery rows past the stored cap and reports the supplied overflow', async () => {
      const checks = Array.from({ length: CARRY_NOTE_MAX_CHECKS + 1 }, (_, i) => ({ claim: `supplied ${i + 1}` }));
      expect(() =>
        parse({
          did: 'progress',
          checks: Array.from({ length: CARRY_NOTE_MAX_CHECKS * CARRY_CAP_HARD_MULTIPLE + 1 }, (_, i) => ({
            claim: `too many ${i + 1}`,
          })),
        }),
      ).toThrow();
      const b = body(await call({ did: 'progress', checks }));
      expect(b.ok).toBe(true);
      expect(b.checks).toBe(CARRY_NOTE_MAX_CHECKS);
      expect(b.checksOverflowed).toEqual([`supplied ${CARRY_NOTE_MAX_CHECKS + 1}`]);
      expect(b.overflowNote).toContain('NOT stored');
    });

    it('writes the note instead of rejecting it when a check row overruns, and reports the trim', async () => {
      const b = body(await call({ did: 'progress', checks: [{ claim: 'c', recheck: 'x'.repeat(360) }] }));
      expect(b.ok).toBe(true); // the whole note used to be discarded over this
      expect(b.repairs).toHaveLength(1);
      expect(b.repairs[0]).toMatchObject({ field: 'checks[0].recheck', kind: 'truncated' });
      expect(b.repairs[0].detail).toContain('360');
    });

    it('publishes each row soft cap alongside its hard input backstop', () => {
      type JsonNode = { [key: string]: unknown };
      const schema = (tool.args as unknown as { toJSONSchema: () => unknown }).toJSONSchema() as JsonNode;
      const properties = ((schema.properties as JsonNode).checks as JsonNode).items as JsonNode;
      const rowProperties = properties.properties as Record<string, JsonNode>;

      for (const [field, softCap] of Object.entries(CARRY_ROW_SOFT_CAPS)) {
        expect(rowProperties[field]).toMatchObject({
          maxLength: softCap * CARRY_CAP_HARD_MULTIPLE,
          'x-soft-maxLength': softCap,
        });
        expect(rowProperties[field].description).toContain(`Soft cap: ${softCap} chars`);
      }
    });

    it('truncates an overlong narrative field to the soft cap rather than rejecting the call', async () => {
      const b = body(await call({ did: 'D'.repeat(9000) }));
      expect(b.ok).toBe(true);
      expect(b.repairs[0]).toMatchObject({ field: 'did', kind: 'truncated' });
      const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
      // The cap's real job — bounding what re-injects into every future wake — still holds.
      expect(written.length).toBeLessThan(9000);
    });

    it('reports NOTHING when everything is within cap (no false positives on the normal path)', async () => {
      const b = body(await call({ did: 'short', checks: [{ claim: 'c', recheck: 'probe', verified: 'seen' }] }));
      expect(b.ok).toBe(true);
      expect(b.repairs).toBeUndefined();
    });

    it('still rejects a payload past the hard backstop — repair is for overruns, not for absurdity', () => {
      expect(() => parse({ did: 'D'.repeat(8000 * 4 + 1) })).toThrow();
    });
  });
});

/**
 * EI-19463731740128181 — the REPLY must announce rows a write dropped.
 *
 * carry-note.test.ts pins the merge helper's `droppedWalls`/`droppedChecks`; this block
 * pins the TOOL WIRING, which is the half that actually reaches an agent. The two are
 * separately breakable: the helper can compute a correct drop list that the handler
 * never surfaces, and that failure mode is invisible to a helper-level test — it is
 * exactly the shape the original bug had (a correct post-merge count, reported in a way
 * no caller could read a loss from).
 */
describe('loop:checkpoint — a dropped row is REPORTED, never silent (EI-19463731740128181)', () => {
  // Real via importOriginal (the module mock spreads it), so the prior is built by the
  // same renderer the store persists — not a hand-written fixture that can drift.
  const buildPrior = (
    checks: { claim: string; recheck?: string; verified?: string }[],
    walls: { claim: string; recheck?: string }[] = [],
  ) => mergeCarryRows({ priorNote: null, baseNote: 'prior body', checks, walls, hasNoteWrite: true }).note;

  it('names the carried checks a supplied list left out, with a note saying how to avoid it', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior([
        { claim: 'gate is green', recheck: 'state:read', verified: 'saw 30/30 @2026-08-03T10:00:00.000Z' },
        { claim: 'main is at abc123', recheck: 'git rev-parse main' },
        { claim: 'deploy landed', recheck: 'curl :3070/api/health' },
      ]),
    );
    // Post-P-013 the drop only happens under an EXPLICIT replace — which is exactly when
    // it still has to be announced: an agent that asked to retire one stale row must be
    // told which others went with it.
    const b = body(await call({ did: 'progress', checks: [{ claim: 'a brand new claim' }], rowsMode: 'replace' }));

    expect(b.ok).toBe(true); // the write SUCCEEDS — this reports a loss, never a refusal
    expect(b.checks).toBe(1);
    expect(b.checksDropped).toEqual(['gate is green', 'main is at abc123', 'deploy landed']);
    expect(b.checksDroppedNote).toContain('REPLACES');
  });

  it('names dropped WALLS separately — an owner-gated commitment must never vanish quietly', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior([], [{ claim: 'owner must ratify the cutover' }, { claim: 'awaiting capital arming' }]),
    );
    const b = body(
      await call({ did: 'progress', walls: [{ claim: 'awaiting capital arming' }], rowsMode: 'replace' }),
    );

    expect(b.walls).toBe(1);
    expect(b.wallsDropped).toEqual(['owner must ratify the cutover']);
    expect(b.checksDropped).toBeUndefined(); // independent axes — no cross-reporting
  });

  it('says NOTHING on the carry-forward path, so the common reply shape is unchanged', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior([{ claim: 'gate is green', recheck: 'state:read' }], [{ claim: 'owner must ratify' }]),
    );
    // No `checks`/`walls` args at all ⇒ every carried row is preserved by construction.
    const b = body(await call({ did: 'progress' }));

    expect(b.checks).toBe(1);
    expect(b.walls).toBe(1);
    expect(b.checksDropped).toBeUndefined();
    expect(b.checksDroppedNote).toBeUndefined();
    expect(b.wallsDropped).toBeUndefined();
  });
});

/**
 * P-013 (fleet-lead-instrumentation-audit-2026-08-09) — the drop must be AVOIDABLE,
 * not merely visible. The block above pins the report; this one pins the two escapes
 * from needing it, at the TOOL boundary where an agent meets them: `rowsMode:'merge'`
 * and a stable row `id`.
 *
 * Same separately-breakable split as above — the helper can merge perfectly while the
 * handler never threads `rowsMode` through (it is passed at TWO call sites, the locked
 * transform and its fallback), and no helper-level test can see that.
 */
describe("loop:checkpoint — rowsMode:'merge' and row ids make the drop avoidable (P-013)", () => {
  const buildPrior = (
    checks: { id?: string; claim: string; recheck?: string; verified?: string }[],
    walls: { id?: string; claim: string; recheck?: string }[] = [],
  ) => mergeCarryRows({ priorNote: null, baseNote: 'prior body', checks, walls, hasNoteWrite: true }).note;

  const THREE = [
    { claim: 'gate is green', recheck: 'state:read', verified: 'saw 30/30 @2026-08-03T10:00:00.000Z' },
    { claim: 'main is at abc123', recheck: 'git rev-parse main' },
    { claim: 'deploy landed', recheck: 'curl :3070/api/health' },
  ];

  it('adds ONE check without dropping the carried three, and says which mode it ran', async () => {
    getLoopCarryNote.mockResolvedValue(buildPrior(THREE));
    const b = body(await call({ did: 'progress', checks: [{ claim: 'a brand new claim' }], rowsMode: 'merge' }));

    expect(b.ok).toBe(true);
    expect(b.checks).toBe(4);
    expect(b.checksDropped).toBeUndefined();
    expect(b.rowsMode).toBe('merge');
  });

  // The default is now MERGE (EI-20281899810081153: "rowsMode:'merge' as the default for
  // additive checks on both checkpoint tools. Explicit rowsMode:'replace' remains the
  // retirement path"). This pair replaces the old CONTROL, which pinned the opposite —
  // it asserted the default "is unchanged" and so became the thing that had to change.
  // Both halves are kept deliberately: one proves the preserving default, the other
  // proves retirement is still REACHABLE, which is the property that flip could break.
  it('DEFAULT — the identical call WITHOUT rowsMode now PRESERVES the carried three', async () => {
    getLoopCarryNote.mockResolvedValue(buildPrior(THREE));
    const b = body(await call({ did: 'progress', checks: [{ claim: 'a brand new claim' }] }));

    expect(b.checks).toBe(4);
    expect(b.checksDropped).toBeUndefined();
  });

  it("CONTROL — retirement is still reachable: rowsMode:'replace' drops the omitted rows and says so", async () => {
    // Guards the OTHER direction: a change that made merge unconditional would make the
    // test above pass while silently removing the only way to retire a stale row.
    getLoopCarryNote.mockResolvedValue(buildPrior(THREE));
    const b = body(await call({ did: 'progress', checks: [{ claim: 'a brand new claim' }], rowsMode: 'replace' }));

    expect(b.checks).toBe(1);
    expect(b.checksDropped).toHaveLength(3);
  });

  it('merges WALLS under the same flag', async () => {
    getLoopCarryNote.mockResolvedValue(buildPrior([], [{ claim: 'owner must ratify the cutover' }]));
    const b = body(await call({ did: 'progress', walls: [{ claim: 'awaiting capital arming' }], rowsMode: 'merge' }));

    expect(b.walls).toBe(2);
    expect(b.wallsDropped).toBeUndefined();
  });

  it('re-words a claim in place under a stable id, keeping its evidence and reporting no loss', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior([{ id: 'gate', claim: 'gate is green', recheck: 'state:read', verified: 'saw 30/30' }]),
    );
    const b = body(
      await call({ did: 'progress', checks: [{ id: 'gate', claim: 'gate is green AT TIP, not at the candidate' }] }),
    );

    expect(b.checks).toBe(1);
    expect(b.checksDropped).toBeUndefined();
    // The stored note is the artifact a cold wake reads — assert against IT, not a count.
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('gate is green AT TIP, not at the candidate');
    expect(written).toContain('saw 30/30'); // evidence inherited across the reword
    expect(written).not.toContain('- ✓ [#gate] gate is green —'); // the old wording is GONE, not duplicated
  });

  it("explains that merge's [] is a no-op, so a caller never reads it as a failed clear", async () => {
    getLoopCarryNote.mockResolvedValue(buildPrior(THREE));
    const b = body(await call({ did: 'progress', checks: [], rowsMode: 'merge' }));

    expect(b.checks).toBe(3); // untouched
    expect(b.rowsModeNote).toContain('NO-OP');
    expect(b.rowsModeNote).toContain("rowsMode:'replace'");
  });

  it('keeps supplied rows and reports CAP EVICTION of the carried tail', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior(Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({ claim: `carried ${i + 1}` }))),
    );
    const b = body(await call({ did: 'progress', checks: [{ claim: 'one row past the cap' }], rowsMode: 'merge' }));

    expect(b.checks).toBe(CARRY_NOTE_MAX_CHECKS);
    expect(b.checksDropped).toEqual([`carried ${CARRY_NOTE_MAX_CHECKS}`]);
    expect(b.checksOverflowed).toBeUndefined();
    expect(b.checksDroppedNote).toContain('CAP EVICTION');
    expect(b.checksDroppedNote).not.toContain('REPLACES the carried set');
    expect(b.checksDroppedNote).not.toMatch(/re-send the full set/i);
    expect(b.checksDroppedNote).toMatch(/RETIRE/);
  });

  it('uses the same CAP EVICTION diagnosis for supplied walls', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior([], Array.from({ length: CARRY_NOTE_MAX_WALLS }, (_, i) => ({ claim: `carried wall ${i + 1}` }))),
    );
    const b = body(await call({ did: 'progress', walls: [{ claim: 'new wall' }], rowsMode: 'merge' }));

    expect(b.walls).toBe(CARRY_NOTE_MAX_WALLS);
    expect(b.wallsDropped).toEqual([`carried wall ${CARRY_NOTE_MAX_WALLS}`]);
    expect(b.wallsDroppedNote).toContain('CAP EVICTION');
    expect(b.wallsDroppedNote).not.toContain('REPLACES the carried set');
  });

  it('says nothing about overflow on an ordinary write', async () => {
    getLoopCarryNote.mockResolvedValue(buildPrior(THREE));
    const b = body(await call({ did: 'progress', checks: [{ claim: 'a fourth' }], rowsMode: 'merge' }));

    expect(b.checksOverflowed).toBeUndefined();
    expect(b.wallsOverflowed).toBeUndefined();
    expect(b.overflowNote).toBeUndefined();
  });
});
