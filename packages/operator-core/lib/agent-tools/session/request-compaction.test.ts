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

beforeEach(() => {
  vi.clearAllMocks();
  injectIntoHost.mockResolvedValue(true);
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

  it('continueNote overrides the derived wake text verbatim', async () => {
    findLiveHost.mockReturnValue(compactHost);
    await call({ focus: 'x', continueNote: 'resume: do the thing' });
    const msg = injected();
    expect(msg.mode).toBe('compact');
    expect(msg.data).toBe('resume: do the thing');
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
