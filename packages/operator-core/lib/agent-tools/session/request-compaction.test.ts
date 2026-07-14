/**
 * request-compaction.test.ts — the WI-1804 caps-gating branch (post-compaction
 * auto-continuation), the tested surface WI-1804's plan named but never landed.
 *
 * Verifies session:request-compaction picks the AUTO-CONTINUE wake path
 * (mode:'compact' + a NON-EMPTY continuation note = the turn that wakes the agent
 * after /compact) on a host advertising the 'compact' capability, and falls back to
 * a plain /compact turn (mode:'turn', no continuation) on an old host or when the
 * caller opts out. injectIntoHost / findLiveHost are mocked so the assertions are
 * purely about WHICH envelope the tool emits; the real hostSupports predicate runs so
 * the caps gating is exercised honestly.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/session/request-compaction.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { truncateHint, COMPACT_PROVENANCE_MARKER } from './request-compaction';
import { __resetRefusalMarkers } from '../../enforcement-gate-io';

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

// deterministic-context-carry P-010: the open-owner-question WARN reads the
// session continuation. Mock the derive so tests drive the open/answered branch;
// keep the REAL gateOpenOwnerQuestion so the gate logic is exercised honestly.
const deriveSessionContinuation = vi.fn();
vi.mock('../../carry-doc', async () => {
  const actual = await vi.importActual<typeof import('../../carry-doc')>('../../carry-doc');
  return { ...actual, deriveSessionContinuation: (...a: unknown[]) => deriveSessionContinuation(...a) };
});

const tool = (await import('./request-compaction')).default;

type Out = { content: { text: string }[]; isError?: boolean };
type Envelope = { mode: string; data: string; focus?: string };
const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
const call = (args: Record<string, unknown>, ctx: unknown = {}) =>
  tool.handler(parse(args) as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const injected = (): Envelope => (injectIntoHost.mock.calls[0] as [string, Envelope])[1];

const compactHost = { ownerId: 'su-caller', sock: '/tmp/sock', caps: ['compact'] };
const oldHost = { ownerId: 'su-caller', sock: '/tmp/sock' }; // predates the 'compact' cap

// turn-provenance P-002: the continuation note is now envelope+ledger-tagged
// (origin self-compaction). Isolate the ledger dir so this suite never writes the
// real ~/.papercusp/turn-provenance, and strip the envelope where an assertion is
// about the NOTE itself.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
let provDir = '';
const ENVELOPE_LINE = /^⟦turn-origin:self-compaction nonce:[a-f0-9]{16}⟧\n/;

beforeEach(() => {
  vi.clearAllMocks();
  __resetRefusalMarkers(); // P-016 gate marker is module-level — isolate each test
  injectIntoHost.mockResolvedValue(true);
  buildCarryBrief.mockResolvedValue(emptyBrief);
  // Default: nothing open (mirrors the real no-transcript fallback), so the WARN
  // stays silent in every unrelated test; the P-010 suite overrides per-case.
  deriveSessionContinuation.mockResolvedValue({ lastOwnerMessage: null, answered: true, deliberate: true });
  provDir = mkdtempSync(join(tmpdir(), 'reqcomp-prov-'));
  process.env.PAPERCUSP_TURN_PROVENANCE_DIR = provDir;
});
afterEach(() => {
  delete process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
  rmSync(provDir, { recursive: true, force: true });
});

describe('session:request-compaction — WI-1804 auto-continuation caps gating', () => {
  it('compact-capable host + default autoContinue → mode:compact carrying a NON-EMPTY wake note derived from focus', async () => {
    findLiveHost.mockReturnValue(compactHost);
    const b = body(await call({ focus: 'finish the ratchet fix' }));
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
    const msg = injected();
    expect(msg.mode).toBe('compact');
    // EI-10135: the /compact focus is prefixed with the machine-origin marker; the
    // continuation note (msg.data, asserted below) stays clean.
    expect(msg.focus).toBe(`${COMPACT_PROVENANCE_MARKER} finish the ratchet fix`);
    // The continuation turn is what WAKES the agent post-/compact — it must be non-empty.
    expect(typeof msg.data).toBe('string');
    expect(msg.data.length).toBeGreaterThan(0);
    expect(msg.data).toContain('finish the ratchet fix');
    expect(msg.data.toLowerCase()).toContain('orient'); // re-orient-first (stale-snapshot boundary)
    expect(b).toMatchObject({ ok: true, requested: true, autoContinue: true });
  });

  it('old host without the compact cap → falls back to a plain /compact turn (compaction still runs, NO auto-continue)', async () => {
    findLiveHost.mockReturnValue(oldHost);
    const b = body(await call({ focus: 'x' }));
    const msg = injected();
    expect(msg.mode).toBe('turn');
    expect(msg.data).toBe(`/compact ${COMPACT_PROVENANCE_MARKER} x`); // EI-10135 marker rides in the command turn
    expect(msg.focus).toBeUndefined();
    expect(b).toMatchObject({ ok: true, autoContinue: false });
  });

  it('autoContinue:false on a capable host → caller opts out to a plain /compact turn', async () => {
    findLiveHost.mockReturnValue(compactHost);
    const b = body(await call({ focus: 'x', autoContinue: false }));
    expect(injected().mode).toBe('turn');
    expect(b).toMatchObject({ autoContinue: false });
  });

  it('continueNote overrides the derived wake text verbatim (behind the provenance envelope)', async () => {
    findLiveHost.mockReturnValue(compactHost);
    await call({ focus: 'x', continueNote: 'resume: do the thing' });
    const msg = injected();
    expect(msg.mode).toBe('compact');
    // turn-provenance P-002: the typed continuation opens with the self-compaction
    // envelope; the note itself rides verbatim after it.
    expect(msg.data).toMatch(ENVELOPE_LINE);
    expect(msg.data.replace(ENVELOPE_LINE, '')).toBe('resume: do the thing');
  });

  it('no live psu-pty host → clean no_live_pty_host error, nothing injected', async () => {
    findLiveHost.mockReturnValue(null);
    const out = await call({ focus: 'x' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ ok: false, error: 'no_live_pty_host' });
    expect(injectIntoHost).not.toHaveBeenCalled();
  });

  it('no focus → the default preserve-set focus applies and still auto-continues on a capable host', async () => {
    findLiveHost.mockReturnValue(compactHost);
    const b = body(await call({}));
    const msg = injected();
    expect(msg.mode).toBe('compact');
    expect(msg.focus && msg.focus.length).toBeGreaterThan(0); // DEFAULT_FOCUS applied
    expect(b).toMatchObject({ autoContinue: true });
  });

  it('a failed socket write (injectIntoHost=false) surfaces requested:false, autoContinue:false', async () => {
    findLiveHost.mockReturnValue(compactHost);
    injectIntoHost.mockResolvedValue(false);
    const b = body(await call({ focus: 'x' }));
    expect(b).toMatchObject({ ok: false, requested: false, autoContinue: false });
  });

  it('EI-10135: the harness-issued /compact carries the machine-origin marker on its focus in BOTH paths, but NOT the continuation note', async () => {
    // auto-continue path: marker prefixes the /compact focus; the continuation note stays clean (it is separately envelope-tagged).
    findLiveHost.mockReturnValue(compactHost);
    await call({ focus: 'do X' });
    const cap = injected();
    expect(cap.mode).toBe('compact');
    expect(cap.focus).toBe(`${COMPACT_PROVENANCE_MARKER} do X`);
    expect(cap.data).not.toContain(COMPACT_PROVENANCE_MARKER);

    // fallback (plain /compact turn) path: the marker rides inside the command turn text.
    vi.clearAllMocks();
    injectIntoHost.mockResolvedValue(true);
    buildCarryBrief.mockResolvedValue(emptyBrief);
    findLiveHost.mockReturnValue(oldHost);
    await call({ focus: 'do Y' });
    const fb = injected();
    expect(fb.mode).toBe('turn');
    expect(fb.data).toBe(`/compact ${COMPACT_PROVENANCE_MARKER} do Y`);
  });
});

/**
 * EI-7032 — session:request-compaction failed 40% of calls (130/321 in 24h), and
 * EVERY failure was the SAME thing: `focus: Too big <=600 chars`. That reject lands
 * at the worst moment (the agent is AT its context limit, which is WHY it called
 * this), forcing a wasted retry. A focus/continueNote is only a summarizer HINT, so
 * an over-long one is now TRUNCATED to the cap instead of rejected — the compaction
 * always proceeds.
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
      findLiveHost.mockReturnValue(compactHost);
      injectIntoHost.mockResolvedValue(true);
    });

    it('a 700-char focus no longer 400s — it parses, truncated to ≤600, and the compaction proceeds', async () => {
      const long = 'preserve '.repeat(100); // 900 chars, well over 600
      expect(long.length).toBeGreaterThan(600);
      const b = body(await call({ focus: long }));
      expect(b).toMatchObject({ ok: true, requested: true });
      const msg = injected();
      // EI-10135: the marker is prefixed AFTER the 600-cap truncation, so strip it before the cap check.
      expect(msg.focus!.replace(`${COMPACT_PROVENANCE_MARKER} `, '').length).toBeLessThanOrEqual(600);
    });

    it('an over-long continueNote also parses instead of rejecting', async () => {
      const b = body(await call({ focus: 'x', continueNote: 'z'.repeat(1400) }));
      expect(b).toMatchObject({ ok: true });
      // The NOTE is capped at 1000; the provenance envelope line rides on top of it.
      expect(injected().data.replace(ENVELOPE_LINE, '').length).toBeLessThanOrEqual(1000);
    });

    it('a normal short focus is unaffected (byte-for-byte in the injected envelope)', async () => {
      await call({ focus: 'finish EI-7032' });
      expect(injected().focus).toBe(`${COMPACT_PROVENANCE_MARKER} finish EI-7032`);
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
 * missing/stale checkpoint (the highest-risk case: a compacted-away transcript with
 * zero durable carry-note is a genuine state loss). P-016 turns the old warn into an
 * enforcement gate: unflushed state HOLDS the compaction ONCE (naming the flush);
 * a retry that still hasn't flushed gets a system-written mechanical fallback and
 * proceeds. The ladder never strands — the second encounter always proceeds — so it
 * respects the original "don't hard-refuse the tool an agent calls at its limit"
 * constraint while adding teeth. staleCheckpoints (the raw list) is still surfaced
 * on every proceed path. (The pure detection is covered in enforcement-gate.test.ts.)
 */
describe('session:request-compaction — P-016 flush-enforcement gate', () => {
  beforeEach(() => {
    findLiveHost.mockReturnValue(compactHost);
    injectIntoHost.mockResolvedValue(true);
  });

  it('no held items → staleCheckpoints empty, no warning text, compaction proceeds normally', async () => {
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

  it('a held item with NO checkpoint (null) → the gate REFUSES the compaction ONCE, naming the flush; nothing queued (P-016)', async () => {
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
    // The compaction was NOT queued — the agent must flush (or retry) first.
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

  it('buildCarryBrief throwing → fails soft to an empty staleCheckpoints list, never blocks the compaction', async () => {
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

  it('the P-016 ladder: an un-flushed RETRY (already refused) gets a mechanical fallback and the compaction PROCEEDS', async () => {
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
    // the compaction proceeds (never strands). The mechanicalFallback field is present
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
 * deterministic-context-carry-2026-07-14 P-010: a DELIBERATE self-compaction that
 * would cross an UNANSWERED owner message is surfaced WARN-ONLY — never a block.
 * The gate itself (gateOpenOwnerQuestion, carry-doc.ts) is pure and unit-tested
 * there; this asserts the WIRING — the warn appears (field + note) when the owner
 * message is open, stays silent when answered/absent, always passes
 * boundaryDeliberate:true, and NEVER blocks the compaction (a hard refuse would
 * strand: a retry cannot answer the owner for you). The REAL gate runs; only the
 * continuation derivation is mocked.
 */
describe('session:request-compaction — P-010 open-owner-question WARN (warn-only)', () => {
  beforeEach(() => {
    findLiveHost.mockReturnValue(compactHost);
    injectIntoHost.mockResolvedValue(true);
    buildCarryBrief.mockResolvedValue(emptyBrief);
  });

  it('an OPEN (unanswered) owner message at this deliberate boundary → openOwnerQuestion:true + a warn note, compaction STILL queued', async () => {
    deriveSessionContinuation.mockResolvedValue({
      lastOwnerMessage: { text: 'ship the release when green', ts: null },
      answered: false,
      deliberate: true,
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.openOwnerQuestion).toBe(true);
    expect(b.note).toContain('open-owner-question');
    // Warn-only: the compaction was NOT blocked and still auto-continues.
    expect(b.ok).toBe(true);
    expect(b.requested).toBe(true);
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
    // A self-compaction is a DELIBERATE boundary — the wiring must say so.
    expect(deriveSessionContinuation).toHaveBeenCalledWith(
      expect.objectContaining({ boundaryDeliberate: true }),
    );
  });

  it('an ANSWERED owner message → no warn (openOwnerQuestion:false), compaction proceeds clean', async () => {
    deriveSessionContinuation.mockResolvedValue({
      lastOwnerMessage: { text: 'ship it', ts: null },
      answered: true,
      deliberate: true,
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.openOwnerQuestion).toBe(false);
    expect(b.note).not.toContain('open-owner-question');
    expect(b.ok).toBe(true);
  });

  it('no owner turn in the recent tail → no warn', async () => {
    deriveSessionContinuation.mockResolvedValue({ lastOwnerMessage: null, answered: true, deliberate: true });
    const b = body(await call({ focus: 'x' }));
    expect(b.openOwnerQuestion).toBe(false);
    expect(b.note).not.toContain('open-owner-question');
  });

  it('deriveSessionContinuation throwing never blocks the compaction (the warn fails soft)', async () => {
    deriveSessionContinuation.mockRejectedValue(new Error('transcript unreadable'));
    const b = body(await call({ focus: 'x' }));
    expect(b.openOwnerQuestion).toBe(false);
    expect(b.ok).toBe(true);
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
  });
});
