/**
 * Unit tests for kettle:declare-wake (overwatch-role-2026-06-15 B-04 — the
 * overwatch's own declare-next-wake, the persona's turn-end loop step).
 *
 * Pin the contract: REPLACE semantics over the overwatch's OWN wake channel — a
 * time (`at`/`inSeconds`), the configured cadence default (no time given), or
 * `mode:'none'` (clear); a refused declaration without a resolvable home harness;
 * and the at⊕inSeconds / none-vs-time refinements. (That it is gated on coord:write
 * — so it can't reach the Queen's routines:write pot:declare-wake — is pinned by
 * the role-cap surface tests; here we pin the handler behaviour.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const declareOverwatchTimeWake = vi.fn();
const clearOverwatchTimeWake = vi.fn();
vi.mock('../../overwatch/liveness', () => ({
  declareOverwatchTimeWake: (...a: unknown[]) => declareOverwatchTimeWake(...a),
  clearOverwatchTimeWake: (...a: unknown[]) => clearOverwatchTimeWake(...a),
  overwatchWakeFloorSec: () => 60,
}));

const getOverwatchCadenceSec = vi.fn();
vi.mock('../../overwatch/control-state', () => ({
  getOverwatchCadenceSec: (...a: unknown[]) => getOverwatchCadenceSec(...a),
}));

vi.mock('../../hive/wake', () => ({
  resolvePotHomeSlug: (explicit?: string | null, ctxSlug?: string | null) =>
    explicit?.trim() || ctxSlug?.trim() || null,
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: () => Promise.resolve([]) }) };
});

import overwatchDeclareWake from './declare_wake';

const ctx = { workspaceId: 'ws-1', isSuperuser: true } as never;
const call = async (tool: { args: unknown; handler: Function }, x: unknown) => {
  const parsed = (tool.args as { parse: (v: unknown) => unknown }).parse(x);
  const res = await tool.handler(parsed, ctx);
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  declareOverwatchTimeWake.mockImplementation(async (_sql: unknown, opts: { at: Date }) => ({ at: opts.at, clamped: false }));
  getOverwatchCadenceSec.mockResolvedValue(600);
});

describe('kettle:declare-wake', () => {
  it('refuses without a resolvable home harness', async () => {
    const out = await call(overwatchDeclareWake as never, {});
    expect(out.ok).toBe(false);
    expect(out.error).toBe('no_home_harness');
    expect(declareOverwatchTimeWake).not.toHaveBeenCalled();
  });

  it('inSeconds → arms a time wake that far out', async () => {
    const before = Date.now();
    const out = await call(overwatchDeclareWake as never, { harness: 'my-hive', inSeconds: 120 });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('time');
    expect(out.defaultedToCadence).toBe(false);
    const opts = declareOverwatchTimeWake.mock.calls[0][1] as { installSlug: string; at: Date };
    expect(opts.installSlug).toBe('my-hive');
    expect(opts.at.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(opts.at.getTime()).toBeLessThanOrEqual(Date.now() + 120_000 + 5_000);
  });

  it('at (ISO) → arms a time wake at exactly that instant', async () => {
    const at = new Date(Date.now() + 600_000).toISOString();
    const out = await call(overwatchDeclareWake as never, { harness: 'my-hive', at });
    expect(out.ok).toBe(true);
    const opts = declareOverwatchTimeWake.mock.calls[0][1] as { at: Date };
    expect(opts.at.toISOString()).toBe(at);
  });

  it('bare call (no time) → DEFAULTS to the configured cadence (D-017)', async () => {
    getOverwatchCadenceSec.mockResolvedValue(900);
    const before = Date.now();
    const out = await call(overwatchDeclareWake as never, { harness: 'my-hive' });
    expect(out.ok).toBe(true);
    expect(out.defaultedToCadence).toBe(true);
    expect(getOverwatchCadenceSec).toHaveBeenCalledWith('ws-1', 'my-hive');
    const opts = declareOverwatchTimeWake.mock.calls[0][1] as { at: Date };
    expect(opts.at.getTime()).toBeGreaterThanOrEqual(before + 900_000);
  });

  it("mode:'none' → clears the pending wake, never declares one", async () => {
    const out = await call(overwatchDeclareWake as never, { harness: 'my-hive', mode: 'none' });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('none');
    expect(clearOverwatchTimeWake).toHaveBeenCalledWith(expect.anything(), 'my-hive', { workspaceId: 'ws-1' });
    expect(declareOverwatchTimeWake).not.toHaveBeenCalled();
  });

  it('rejects at + inSeconds together (the refinement)', () => {
    const parse = () =>
      (overwatchDeclareWake as unknown as { args: { parse: (v: unknown) => unknown } }).args.parse({
        harness: 'my-hive',
        at: new Date().toISOString(),
        inSeconds: 60,
      });
    expect(parse).toThrow();
  });

  it("rejects mode:'none' combined with a time", () => {
    const parse = () =>
      (overwatchDeclareWake as unknown as { args: { parse: (v: unknown) => unknown } }).args.parse({
        harness: 'my-hive',
        mode: 'none',
        inSeconds: 60,
      });
    expect(parse).toThrow();
  });
});
