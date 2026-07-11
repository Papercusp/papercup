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
import { truncateHint } from './request-compaction';

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
  injectIntoHost.mockResolvedValue(true);
  buildCarryBrief.mockResolvedValue(emptyBrief);
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
    expect(msg.focus).toBe('finish the ratchet fix');
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
    expect(msg.data).toBe('/compact x');
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
      expect(msg.focus && msg.focus.length).toBeLessThanOrEqual(600);
    });

    it('an over-long continueNote also parses instead of rejecting', async () => {
      const b = body(await call({ focus: 'x', continueNote: 'z'.repeat(1400) }));
      expect(b).toMatchObject({ ok: true });
      // The NOTE is capped at 1000; the provenance envelope line rides on top of it.
      expect(injected().data.replace(ENVELOPE_LINE, '').length).toBeLessThanOrEqual(1000);
    });

    it('a normal short focus is unaffected (byte-for-byte in the injected envelope)', async () => {
      await call({ focus: 'finish EI-7032' });
      expect(injected().focus).toBe('finish EI-7032');
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
 * EI-8987: session:request-compaction proactively surfaces held work-items with
 * NO checkpoint at all — the highest-risk case (a compacted-away transcript with
 * zero durable carry-note is a genuine state loss). WARN-only: never refuses the
 * compaction (a hard-refuse gate on the tool an agent calls BECAUSE it's at its
 * context limit would strand it on any gate bug — worse than the failure this
 * catches). The compaction is already queued by the time the warning is read, but
 * the calling turn hasn't ended yet, so it's still actionable: the agent can fire
 * one more work_items:checkpoint before it truly stops.
 */
describe('session:request-compaction — EI-8987 stale-checkpoint warning', () => {
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

  it('a held item with NO checkpoint (null) → flagged in staleCheckpoints + the note, compaction STILL proceeds (warn, never refuse)', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-200', title: 'the risky one', body: null, harness: 'papercup', checkpoint: null }],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([{ id: 'WI-200', title: 'the risky one', reason: 'missing' }]);
    expect(b.note).toContain('WI-200');
    expect(b.note).toContain('NO checkpoint');
    // Never a refusal — the compaction is still queued.
    expect(b.ok).toBe(true);
    expect(b.requested).toBe(true);
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
  });

  it('multiple held items, mixed → only the checkpoint-less ones are flagged', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [
        { id: 'WI-1', title: 'has one', body: null, harness: 'papercup', checkpoint: 'ok' },
        { id: 'WI-2', title: 'missing', body: null, harness: 'papercup', checkpoint: null },
        { id: 'WI-3', title: 'also missing', body: null, harness: 'papercup', checkpoint: null },
      ],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([
      { id: 'WI-2', title: 'missing', reason: 'missing' },
      { id: 'WI-3', title: 'also missing', reason: 'missing' },
    ]);
  });

  it('P-003: a held item whose checkpoint is OLDER than the stale window → flagged reason:stale with ageMinutes, note names the age, compaction proceeds', async () => {
    const fortyMinAgo = Date.now() - 40 * 60_000;
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [
        { id: 'WI-300', title: 'long-running', body: null, harness: 'papercup', checkpoint: 'old flush', checkpointUpdatedAtMs: fortyMinAgo },
      ],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([{ id: 'WI-300', title: 'long-running', reason: 'stale', ageMinutes: 40 }]);
    expect(b.note).toContain('STALE checkpoint');
    expect(b.note).toContain('WI-300 40m old');
    expect(b.ok).toBe(true); // warn, never refuse
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

  it('P-003: missing + stale mix — both legs appear in the note independently', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [
        { id: 'WI-310', title: 'no note', body: null, harness: 'papercup', checkpoint: null },
        { id: 'WI-311', title: 'old note', body: null, harness: 'papercup', checkpoint: 'x', checkpointUpdatedAtMs: Date.now() - 20 * 60_000 },
      ],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([
      { id: 'WI-310', title: 'no note', reason: 'missing' },
      { id: 'WI-311', title: 'old note', reason: 'stale', ageMinutes: 20 },
    ]);
    expect(b.note).toContain('NO checkpoint');
    expect(b.note).toContain('STALE checkpoint');
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

  it('a failed socket write still surfaces staleCheckpoints (informational regardless of injection outcome)', async () => {
    injectIntoHost.mockResolvedValue(false);
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-9', title: null, body: null, harness: null, checkpoint: null }],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.ok).toBe(false);
    // Failed injection short-circuits the stale-note suffix (nothing was actually
    // queued), but the raw list is still returned for the caller to act on.
    expect(b.staleCheckpoints).toEqual([{ id: 'WI-9', title: null, reason: 'missing' }]);
  });
});
