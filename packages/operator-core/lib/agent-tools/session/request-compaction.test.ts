/**
 * request-compaction.test.ts — the P-018/P-022 carry-respawn actuation.
 *
 * Native /compact is RETIRED (deterministic-context-carry P-022, WI-4998): the
 * tool now assembles the deterministic RespawnLaunchSpec and sends the psu-pty
 * host a mode:'carry-respawn' envelope (successor first prompt + carry-doc
 * system-prompt addendum). Verifies: the envelope shape; the P-010 first-prompt
 * rule (an OPEN owner message rides verbatim as the successor's first prompt,
 * else the tagged continue+re-orient note); the capability gate (a host without
 * 'carry-respawn' errors loudly — NO /compact fallback exists anymore); the
 * carry_build_failed refusal (session left intact); and the pre-existing
 * EI-7032 truncation + P-016 flush-gate behavior, unchanged across the swap.
 * injectIntoHost / findLiveHost / buildOwnerRespawnLaunchSpec are mocked so the
 * assertions are purely about WHICH envelope the tool emits; the real
 * hostSupports predicate runs so the caps gating is exercised honestly.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/session/request-compaction.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { truncateHint } from './request-compaction';
import { __resetRefusalMarkers } from '../../enforcement-gate-io';
import { __resetRespawnExpectedMarkers, consumeRespawnExpected } from '../../carry-respawn-marker';

const findLiveHost = vi.fn();
const injectIntoHost = vi.fn();
vi.mock('../../events/await/psu-pty-discovery', () => ({
  findLiveHost: (...a: unknown[]) => findLiveHost(...a),
  injectIntoHost: (...a: unknown[]) => injectIntoHost(...a),
  // Keep the REAL caps predicate so the gating logic is exercised honestly.
  hostSupports: (host: { caps?: string[] } | null | undefined, cap: string) =>
    Array.isArray(host?.caps) && host!.caps!.includes(cap),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-caller', ownerLabel: 'su · caller' })),
}));
// EI-8987: buildCarryBrief drives both the default focus AND the stale-checkpoint
// warning. Mocked with a default empty brief; individual tests override per-case.
const buildCarryBrief = vi.fn();
vi.mock('../../carry-brief', async () => {
  const actual = await vi.importActual<typeof import('../../carry-brief')>('../../carry-brief');
  return { ...actual, buildCarryBrief: (...a: unknown[]) => buildCarryBrief(...a) };
});
const emptyBrief = { ownerId: 'su-caller', loop: null, heldItems: [], walls: [], facts: [], awaits: [], fleet: null };

// P-018: the deterministic successor spec. Mocked so tests drive firstPrompt /
// openOwnerQuestion / null-assembly branches without a real transcript.
const buildOwnerRespawnLaunchSpec = vi.fn();
vi.mock('../../carry-respawn', async () => {
  const actual = await vi.importActual<typeof import('../../carry-respawn')>('../../carry-respawn');
  return { ...actual, buildOwnerRespawnLaunchSpec: (...a: unknown[]) => buildOwnerRespawnLaunchSpec(...a) };
});
// The effective-window resolve is a live PG/session read — pin it to the
// fallback path so tests stay hermetic (the fallback constant is 200k).
vi.mock('../../compaction-usage', async () => {
  const actual = await vi.importActual<typeof import('../../compaction-usage')>('../../compaction-usage');
  return { ...actual, resolveModelSpecForOwner: async () => null };
});

const tool = (await import('./request-compaction')).default;

type Out = { content: { text: string }[]; isError?: boolean };
type Envelope = { mode: string; data: string; systemPromptAddendum?: string };
const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
const call = (args: Record<string, unknown>, ctx: unknown = {}) =>
  tool.handler(parse(args) as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const injected = (): Envelope => (injectIntoHost.mock.calls[0] as [string, Envelope])[1];

const carryHost = { ownerId: 'su-caller', sock: '/tmp/sock', caps: ['compact', 'carry-respawn', 'mcp-reconnect'] };
const staleHost = { ownerId: 'su-caller', sock: '/tmp/sock', caps: ['compact'] }; // predates carry-respawn
const closedSpec = {
  systemPromptAddendum: 'CARRY-DOC-ADDENDUM',
  firstPrompt: null,
  budgetChars: 24_000,
  openOwnerQuestion: { crossesOpenOwnerMessage: false },
};

// turn-provenance P-002: the continuation-note first prompt is envelope+ledger-
// tagged (origin self-compaction). Isolate the ledger dir so this suite never
// writes the real ~/.papercusp/turn-provenance, and strip the envelope where an
// assertion is about the NOTE itself.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
let provDir = '';
const ENVELOPE_LINE = /^⟦turn-origin:self-compaction nonce:[a-f0-9]{16}⟧\n/;

beforeEach(() => {
  vi.clearAllMocks();
  __resetRefusalMarkers(); // P-016 gate marker is module-level — isolate each test
  __resetRespawnExpectedMarkers(); // EI-18676518990229124 — same module-level isolation
  injectIntoHost.mockResolvedValue(true);
  buildCarryBrief.mockResolvedValue(emptyBrief);
  buildOwnerRespawnLaunchSpec.mockResolvedValue(closedSpec);
  provDir = mkdtempSync(join(tmpdir(), 'reqcomp-prov-'));
  process.env.PAPERCUSP_TURN_PROVENANCE_DIR = provDir;
});
afterEach(() => {
  delete process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
  rmSync(provDir, { recursive: true, force: true });
});

describe('session:request-compaction — P-018/P-022 carry-respawn actuation', () => {
  it('carry-respawn-capable host → mode:carry-respawn with the addendum + a NON-EMPTY continue note derived from focus', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const b = body(await call({ focus: 'finish the ratchet fix' }));
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
    const msg = injected();
    expect(msg.mode).toBe('carry-respawn');
    expect(msg.systemPromptAddendum).toBe('CARRY-DOC-ADDENDUM');
    // The first prompt is what RESUMES the successor — it must be non-empty.
    expect(typeof msg.data).toBe('string');
    expect(msg.data.length).toBeGreaterThan(0);
    expect(msg.data).toContain('finish the ratchet fix');
    expect(msg.data.toLowerCase()).toContain('orient'); // re-orient-first (stale-snapshot boundary)
    // turn-provenance P-002: the machine-authored continuation is envelope-tagged.
    expect(msg.data).toMatch(ENVELOPE_LINE);
    expect(b).toMatchObject({
      ok: true,
      requested: true,
      respawn: true,
      budgetChars: 24_000,
      firstPromptSource: 'continuation-note',
    });
  });

  it('host WITHOUT the carry-respawn cap → loud host_predates_carry_respawn error, NOTHING injected (no /compact fallback exists — P-022)', async () => {
    findLiveHost.mockReturnValue(staleHost);
    const out = await call({ focus: 'x' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ ok: false, error: 'host_predates_carry_respawn' });
    expect(injectIntoHost).not.toHaveBeenCalled();
    expect(buildOwnerRespawnLaunchSpec).not.toHaveBeenCalled();
  });

  it('spec assembly failure (null) → carry_build_failed, session left intact, nothing injected', async () => {
    findLiveHost.mockReturnValue(carryHost);
    buildOwnerRespawnLaunchSpec.mockResolvedValue(null);
    const out = await call({ focus: 'x' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ ok: false, requested: false, error: 'carry_build_failed' });
    expect(injectIntoHost).not.toHaveBeenCalled();
  });

  it('the spec build is a DELIBERATE boundary with the resolved (fallback) window', async () => {
    findLiveHost.mockReturnValue(carryHost);
    await call({ focus: 'x' });
    expect(buildOwnerRespawnLaunchSpec).toHaveBeenCalledWith(
      'su-caller',
      expect.objectContaining({
        effectiveWindowTokens: 200_000,
        buildOpts: expect.objectContaining({ boundaryDeliberate: true }),
      }),
    );
  });

  it('continueNote overrides the derived first prompt verbatim (behind the provenance envelope)', async () => {
    findLiveHost.mockReturnValue(carryHost);
    await call({ focus: 'x', continueNote: 'resume: do the thing' });
    const msg = injected();
    expect(msg.mode).toBe('carry-respawn');
    expect(msg.data).toMatch(ENVELOPE_LINE);
    expect(msg.data.replace(ENVELOPE_LINE, '')).toBe('resume: do the thing');
  });

  it('autoContinue is a wire-compat no-op: passing false still respawns (a carry-respawn always resumes)', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const b = body(await call({ focus: 'x', autoContinue: false }));
    expect(injected().mode).toBe('carry-respawn');
    expect(b).toMatchObject({ ok: true, respawn: true });
  });

  it('no live psu-pty host → clean no_live_pty_host error, nothing injected', async () => {
    findLiveHost.mockReturnValue(null);
    const out = await call({ focus: 'x' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ ok: false, error: 'no_live_pty_host' });
    expect(injectIntoHost).not.toHaveBeenCalled();
  });

  it('no focus → the carry-brief/default preserve-set focus still yields a non-empty first prompt', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const b = body(await call({}));
    const msg = injected();
    expect(msg.mode).toBe('carry-respawn');
    expect(msg.data.length).toBeGreaterThan(0); // DEFAULT_FOCUS folded into the note
    expect(b).toMatchObject({ ok: true, respawn: true });
  });

  it('a failed socket write (injectIntoHost=false) surfaces requested:false, respawn:false', async () => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(false);
    const b = body(await call({ focus: 'x' }));
    expect(b).toMatchObject({ ok: false, requested: false, respawn: false });
  });

  // EI-18686525818431054: the default injectIntoHost socket timeout (2000ms) is
  // sized for an ordinary wake turn, not a carry-respawn — the host's busy-gate
  // wait behind the ack can legitimately run far longer (up to the doubled
  // busy-gate cap), and a host predating the ack-early fix awaits the WHOLE
  // gated pipeline before acking at all. A carry-respawn call must use a much
  // longer client-side timeout so it doesn't false-negative exactly when the
  // sanctioned context-shedding path is needed most.
  it('carry-respawn passes a socket timeout FAR longer than injectIntoHost\'s 2000ms default (EI-18686525818431054)', async () => {
    findLiveHost.mockReturnValue(carryHost);
    await call({ focus: 'x' });
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
    const timeoutArg = injectIntoHost.mock.calls[0]![2] as number;
    expect(timeoutArg).toBeGreaterThanOrEqual(5 * 60_000); // safely past the 2x180s busy-gate cap
  });

  // EI-18686525818431054 ask #3: the failure note must name the socket path
  // tried (+ host pid) so the next diagnosis doesn't have to reverse-engineer
  // it from `ps`/`find` (this filing's own investigation cost ~6 tool calls).
  it('a failed socket write names the socket path + host pid in the failure note and body', async () => {
    findLiveHost.mockReturnValue({ ...carryHost, pid: 4242 });
    injectIntoHost.mockResolvedValue(false);
    const b = body(await call({ focus: 'x' })) as { note: string; hostSock?: string; hostPid?: number };
    expect(b.hostSock).toBe('/tmp/sock');
    expect(b.hostPid).toBe(4242);
    expect(b.note).toContain('/tmp/sock');
    expect(b.note).toContain('4242');
  });
});

/**
 * EI-18676518990229124: a successful carry-respawn must mark the owner
 * "respawn expected" so activity:report's SessionEnd/Stop P-002 fast path
 * skips force-releasing its work-item leases (the killed child's SessionEnd
 * is a scheduled same-owner continuation, not a death). A FAILED respawn
 * (nothing actually queued) must NOT mark the owner — the P-001 scheduled
 * backstop remains the correct recovery for that case, unchanged.
 */
describe('session:request-compaction — carry-respawn marker (EI-18676518990229124)', () => {
  it('a successful respawn marks the owner as respawn-expected', async () => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(true);
    const b = body(await call({ focus: 'x' }));
    expect(b.ok).toBe(true);
    expect(consumeRespawnExpected('su-caller')).toBe(true);
  });

  it('a failed socket write does NOT mark the owner', async () => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(false);
    await call({ focus: 'x' });
    expect(consumeRespawnExpected('su-caller')).toBe(false);
  });

  it('a refused cut (host predates carry-respawn) never marks the owner', async () => {
    findLiveHost.mockReturnValue(staleHost);
    await call({ focus: 'x' });
    expect(consumeRespawnExpected('su-caller')).toBe(false);
  });

  it('a P-016 flush-gate refusal never marks the owner (nothing was queued)', async () => {
    findLiveHost.mockReturnValue(carryHost);
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-500', title: 'unflushed', body: null, harness: 'papercup', checkpoint: null }],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.error).toBe('flush-required');
    expect(consumeRespawnExpected('su-caller')).toBe(false);
  });
});

/**
 * EI-7032 — session:request-compaction failed 40% of calls (130/321 in 24h), and
 * EVERY failure was the SAME thing: `focus: Too big <=600 chars`. That reject lands
 * at the worst moment (the agent is AT its context limit, which is WHY it called
 * this), forcing a wasted retry. A focus/continueNote is only a first-prompt HINT,
 * so an over-long one is now TRUNCATED to the cap instead of rejected — the
 * boundary always proceeds.
 */
describe('session:request-compaction over-long hint truncation (EI-7032)', () => {
  describe('truncateHint (unit)', () => {
    it('returns a within-cap string unchanged (same value)', () => {
      expect(truncateHint('short focus', 600)).toBe('short focus');
      const exact = 'x'.repeat(600);
      expect(truncateHint(exact, 600)).toBe(exact);
    });

    it('truncates an over-cap string to EXACTLY the cap, …-marked (never > cap)', () => {
      const long = 'x'.repeat(700);
      const out = truncateHint(long, 600);
      expect(out.length).toBe(600);
      expect(out.endsWith('…')).toBe(true);
      expect(out.startsWith('x'.repeat(599))).toBe(true);
    });

    it('handles the 1000-cap continueNote the same way', () => {
      expect(truncateHint('y'.repeat(1500), 1000).length).toBe(1000);
    });
  });

  describe('through the real tool schema (the 40% of calls that 400ed now parse)', () => {
    beforeEach(() => {
      findLiveHost.mockReturnValue(carryHost);
      injectIntoHost.mockResolvedValue(true);
    });

    it('a 900-char focus no longer 400s — it parses, truncated to ≤600, and the boundary proceeds', async () => {
      const long = 'preserve '.repeat(100); // 900 chars, well over 600
      expect(long.length).toBeGreaterThan(600);
      const b = body(await call({ focus: long }));
      expect(b).toMatchObject({ ok: true, requested: true });
      // The truncated (…-marked) focus rides inside the continuation-note first prompt.
      const note = injected().data.replace(ENVELOPE_LINE, '');
      expect(note).toContain('…');
      expect(note).not.toContain(long); // the untruncated 900-char original never rides
    });

    it('an over-long continueNote also parses instead of rejecting', async () => {
      const b = body(await call({ focus: 'x', continueNote: 'z'.repeat(1400) }));
      expect(b).toMatchObject({ ok: true });
      // The NOTE is capped at 1000; the provenance envelope line rides on top of it.
      expect(injected().data.replace(ENVELOPE_LINE, '').length).toBeLessThanOrEqual(1000);
    });

    it('a normal short focus rides untouched inside the first prompt', async () => {
      await call({ focus: 'finish EI-7032' });
      expect(injected().data).toContain('finish EI-7032');
    });
  });

  it('the published tools/list JSON schema still advertises focus maxLength 600 (clients keep aiming short)', () => {
    const json = z.toJSONSchema(tool.args as never) as {
      properties?: Record<string, { maxLength?: number; type?: string }>;
    };
    expect(json.properties?.focus?.type).toBe('string');
    expect(json.properties?.focus?.maxLength).toBe(600);
    expect(json.properties?.continueNote?.maxLength).toBe(1000);
  });
});

/**
 * EI-8987 + P-016: session:request-compaction surfaces held work-items with a
 * missing/stale checkpoint (the highest-risk case: a cut-away transcript with
 * zero durable carry-note is a genuine state loss). P-016 turns the old warn into an
 * enforcement gate: unflushed state HOLDS the boundary ONCE (naming the flush);
 * a retry that still hasn't flushed gets a system-written mechanical fallback and
 * proceeds. The ladder never strands — the second encounter always proceeds — so it
 * respects the original "don't hard-refuse the tool an agent calls at its limit"
 * constraint while adding teeth. staleCheckpoints (the raw list) is still surfaced
 * on every proceed path. (The pure detection is covered in enforcement-gate.test.ts.)
 */
describe('session:request-compaction — P-016 flush-enforcement gate', () => {
  beforeEach(() => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(true);
  });

  it('no held items → staleCheckpoints empty, no warning text, the cut proceeds normally', async () => {
    buildCarryBrief.mockResolvedValue(emptyBrief);
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([]);
    expect(b.note).not.toContain('NO checkpoint');
    expect(b.ok).toBe(true);
  });

  it('a held item WITH a checkpoint → not flagged', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-100', title: 'fix the thing', body: null, harness: 'papercup', checkpoint: 'in progress' }],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([]);
  });

  it('a held item with NO checkpoint (null) → the gate REFUSES the cut ONCE, naming the flush; nothing queued (P-016)', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-200', title: 'the risky one', body: null, harness: 'papercup', checkpoint: null }],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.ok).toBe(false);
    expect(b.error).toBe('flush-required');
    expect(b.tripwires.map((t: { kind: string }) => t.kind)).toContain('missing-checkpoint');
    expect(b.note).toContain('WI-200');
    expect(b.note).toContain('work_items:checkpoint');
    // The cut was NOT queued — the agent must flush (or retry) first.
    expect(injectIntoHost).not.toHaveBeenCalled();
  });

  it('the refusal names ALL un-checkpointed held items', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [
        { id: 'WI-1', title: 'has one', body: null, harness: 'papercup', checkpoint: 'ok' },
        { id: 'WI-2', title: 'missing', body: null, harness: 'papercup', checkpoint: null },
        { id: 'WI-3', title: 'also missing', body: null, harness: 'papercup', checkpoint: null },
      ],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.ok).toBe(false);
    expect(b.error).toBe('flush-required');
    const subjects = b.tripwires.map((t: { subject: string }) => t.subject);
    expect(subjects).toContain('WI-2');
    expect(subjects).toContain('WI-3');
    expect(subjects).not.toContain('WI-1'); // the checkpointed one is not flagged
    expect(b.note).toContain('WI-2');
    expect(b.note).toContain('WI-3');
  });

  it('P-003: a held item whose checkpoint is OLDER than the stale window → refuses with a stale tripwire naming the age', async () => {
    const fortyMinAgo = Date.now() - 40 * 60_000;
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [
        { id: 'WI-300', title: 'long-running', body: null, harness: 'papercup', checkpoint: 'old flush', checkpointUpdatedAtMs: fortyMinAgo },
      ],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.ok).toBe(false);
    expect(b.error).toBe('flush-required');
    expect(b.tripwires).toEqual([
      expect.objectContaining({ kind: 'stale-checkpoint', subject: 'WI-300', ageMinutes: 40 }),
    ]);
    expect(b.note).toContain('WI-300 (40m old)');
  });

  it('P-003: a FRESH checkpoint (within the stale window) is not flagged', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [
        { id: 'WI-301', title: 'fresh', body: null, harness: 'papercup', checkpoint: 'just flushed', checkpointUpdatedAtMs: Date.now() - 60_000 },
      ],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([]);
  });

  it('P-003: a checkpoint with NO write-instant meta (legacy/injected read) is never age-flagged', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-302', title: 'no meta', body: null, harness: 'papercup', checkpoint: 'state', checkpointUpdatedAtMs: null }],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([]);
  });

  it('P-003: missing + stale mix — both tripwire kinds appear in the refusal', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [
        { id: 'WI-310', title: 'no note', body: null, harness: 'papercup', checkpoint: null },
        { id: 'WI-311', title: 'old note', body: null, harness: 'papercup', checkpoint: 'x', checkpointUpdatedAtMs: Date.now() - 20 * 60_000 },
      ],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.ok).toBe(false);
    expect(b.tripwires.map((t: { kind: string }) => t.kind).sort()).toEqual(['missing-checkpoint', 'stale-checkpoint']);
    expect(b.note).toContain('WI-310');
    expect(b.note).toContain('WI-311 (20m old)');
  });

  it('an armed loop with NO carry-note refuses, naming loop:checkpoint', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      loop: { harness: 'papercusp', active: true, intervalSec: 60, carryNote: null, carryNoteUpdatedAtMs: null },
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.ok).toBe(false);
    expect(b.tripwires[0].kind).toBe('armed-loop-no-carry-note');
    expect(b.note).toContain('loop:checkpoint');
    expect(injectIntoHost).not.toHaveBeenCalled();
  });

  it('buildCarryBrief throwing → fails soft to an empty staleCheckpoints list, never blocks the cut', async () => {
    buildCarryBrief.mockRejectedValue(new Error('db unavailable'));
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([]);
    expect(b.ok).toBe(true);
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
  });

  it('only ONE buildCarryBrief call per request (focus derivation + warning share the same brief)', async () => {
    buildCarryBrief.mockResolvedValue(emptyBrief);
    await call({}); // no focus → also drives the default-focus derivation
    expect(buildCarryBrief).toHaveBeenCalledTimes(1);
  });

  it('the P-016 ladder: an un-flushed RETRY (already refused) gets a mechanical fallback and the cut PROCEEDS', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-9', title: null, body: null, harness: null, checkpoint: null }],
    });
    // First call → refused, nothing queued.
    const first = body(await call({ focus: 'x' }));
    expect(first.ok).toBe(false);
    expect(first.error).toBe('flush-required');
    expect(injectIntoHost).not.toHaveBeenCalled();

    // Retry with the SAME unflushed state → the system writes the fallback ITSELF and
    // the cut proceeds (never strands). The mechanicalFallback field is present
    // and staleCheckpoints is still surfaced.
    const second = body(await call({ focus: 'x' }));
    expect(second.ok).toBe(true);
    expect(second.requested).toBe(true);
    expect(second.mechanicalFallback).toBeDefined();
    expect(second.staleCheckpoints).toEqual([{ id: 'WI-9', title: null, reason: 'missing' }]);
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
  });
});

/**
 * deterministic-context-carry-2026-07-14 P-010: the first-prompt rule at a
 * DELIBERATE boundary. An OPEN (unanswered) owner message is the successor's
 * first prompt — delivered VERBATIM through the spec (deriveLaunchPromptText),
 * never envelope-tagged and never quoted inside a machine note — and the warn
 * field/note surface it. Answered/absent → the tagged continuation note rides
 * instead. Warn-only: an open question never blocks the cut (a hard refuse
 * would strand — a retry cannot answer the owner for you).
 */
describe('session:request-compaction — P-010 open-owner-question first-prompt rule', () => {
  beforeEach(() => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(true);
    buildCarryBrief.mockResolvedValue(emptyBrief);
  });

  it('an OPEN owner message → it IS the successor first prompt (verbatim, un-enveloped), warn surfaced, cut STILL queued', async () => {
    buildOwnerRespawnLaunchSpec.mockResolvedValue({
      ...closedSpec,
      firstPrompt: 'ship the release when green',
      openOwnerQuestion: { crossesOpenOwnerMessage: true },
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.openOwnerQuestion).toBe(true);
    expect(b.firstPromptSource).toBe('open-owner-message');
    expect(b.note).toContain('open-owner-question');
    // Warn-only: the cut was NOT blocked.
    expect(b.ok).toBe(true);
    expect(b.requested).toBe(true);
    const msg = injected();
    expect(msg.data).toBe('ship the release when green'); // verbatim spec prompt, no envelope
    expect(msg.data).not.toMatch(ENVELOPE_LINE);
  });

  it('no open owner message → the tagged continuation note rides and no warn appears', async () => {
    buildOwnerRespawnLaunchSpec.mockResolvedValue(closedSpec);
    const b = body(await call({ focus: 'x' }));
    expect(b.openOwnerQuestion).toBe(false);
    expect(b.firstPromptSource).toBe('continuation-note');
    expect(b.note).not.toContain('open-owner-question');
    expect(injected().data).toMatch(ENVELOPE_LINE);
  });
});
