/**
 * Tests for the tools:invoke meta-tool (dynamic-tool-surface-2026-07-01 D-003).
 * Importing the file triggers defineTool registration, so a compile/import/
 * capability error fails here too.
 *
 * The handler delegates to ctx.dispatchTool (the transport-provided server-side
 * dispatcher); these tests drive it with a stub dispatcher, so no DB / registry
 * boot is needed. The REAL dispatch (gating preserved) is proven end-to-end by
 * the live round-trip against :3170.
 */
import { describe, it, expect, vi } from 'vitest';

// P-012: default FALSE so the pre-existing exact-equality metadata assertions stay
// byte-identical; the dispatch-wrapper describe flips it per-test.
vi.mock('../../telemetry-dispatch-wrapper', () => ({
  dispatchWrapperMarkEnabled: vi.fn(async () => false),
}));
import { dispatchWrapperMarkEnabled } from '../../telemetry-dispatch-wrapper';

import toolInvoke, { summarizeNestedToolOutcome } from './invoke';

const markEnabledMock = vi.mocked(dispatchWrapperMarkEnabled);

type ToolDef = {
  name: string;
  capability: string;
  requirePrincipal: boolean;
  timeoutSec: number;
  args: { safeParse: (v: unknown) => { success: boolean } };
  handler: (a: unknown, c?: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

const def = toolInvoke as unknown as ToolDef;

describe('tools:invoke registration', () => {
  it('registers with the expected name + capability + args', () => {
    expect(def.name).toBe('tools:invoke');
    expect(def.capability).toBe('agent_tools:read');
    expect(def.requirePrincipal).toBe(false);
    // The inner target dispatcher owns the real timeout (agent tools max at
    // 600s). The meta-wrapper must not race it with defineTool's 60s default.
    expect(def.timeoutSec).toBe(660);
    expect(def.args.safeParse({ name: 'flags:set', args: { key: 'x', value: true } }).success).toBe(true);
    expect(def.args.safeParse({ name: 'flags:set' }).success).toBe(true); // args optional
    expect(def.args.safeParse({}).success).toBe(false); // name required
    expect(def.args.safeParse({ name: '' }).success).toBe(false); // non-empty
  });

  it('tolerates a JSON-stringified args payload (EI-6681 client-serialization quirk)', () => {
    const r = def.args.safeParse({
      name: 'flags:set',
      args: JSON.stringify({ key: 'x', value: true, nested: { a: [1, 2, 3] } }),
    }) as { success: true; data: { args: unknown } } | { success: false };
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.args).toEqual({ key: 'x', value: true, nested: { a: [1, 2, 3] } });
    }
  });

  it('still rejects a non-JSON string args payload (no silent pass-through)', () => {
    expect(def.args.safeParse({ name: 'flags:set', args: 'not-json {' }).success).toBe(false);
  });

  it('tolerates a DOUBLE-encoded deeply-nested args payload (EI-15360)', () => {
    // Repro of EI-15360: a client double-stringifies a deep spec object (e.g.
    // scheduler:set_claim_spec's ~10-level filter tree). A single JSON.parse
    // yields a *string*, which used to fail z.record with the exact reported
    // "expected record, received string". Iterative un-stringify recovers it.
    const spec = {
      specVersion: '1.0',
      specId: 'backlog-drain-clean',
      revision: 1,
      view: {
        filter: {
          all: [{ any: [{ not: { all: [{ any: [{ field: 'tags', op: 'contains', value: 'WI-1281' }] }] } }] }],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'asc' }] },
    };
    const r = def.args.safeParse({
      name: 'scheduler:set_claim_spec',
      args: JSON.stringify(JSON.stringify(spec)),
    }) as { success: true; data: { args: unknown } } | { success: false };
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.args).toEqual(spec);
  });

  it('recovers a triple-encoded args payload too, bounded (EI-15360)', () => {
    const obj = { key: 'x', value: true };
    const r = def.args.safeParse({
      name: 'flags:set',
      args: JSON.stringify(JSON.stringify(JSON.stringify(obj))),
    }) as { success: true; data: { args: unknown } } | { success: false };
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.args).toEqual(obj);
  });

  it('does NOT un-string a target tool\'s legitimate nested string arg', () => {
    // A nested value that HAPPENS to be JSON must survive untouched — only the
    // top-level args wrapper is un-stringified, never its members.
    const r = def.args.safeParse({
      name: 'work_items:create',
      args: { kind: 'bug', title: 't', body: '{"looks":"like json"}' },
    }) as { success: true; data: { args: { body: unknown } } } | { success: false };
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.args.body).toBe('{"looks":"like json"}');
  });
});

describe('tools:invoke handler', () => {
  it('routes the call through ctx.dispatchTool with name + args and returns its result', async () => {
    const calls: Array<[string, unknown]> = [];
    const metadata = vi.fn();
    const ctx = {
      metadata,
      dispatchTool: vi.fn(async (name: string, a: unknown) => {
        calls.push([name, a]);
        return { content: [{ type: 'text', text: 'dispatched-ok' }], isError: false };
      }),
    };
    const res = await def.handler({ name: 'flags:set', args: { key: 'k', value: true } }, ctx);
    expect(calls).toEqual([['flags:set', { key: 'k', value: true }]]);
    expect(res.content[0].text).toBe('dispatched-ok');
    expect(res.isError).toBe(false);
    expect(metadata).toHaveBeenCalledWith({ effectiveStatus: 'ok', childFailureCount: 0 });
  });

  it('defaults args to {} when omitted', async () => {
    const seen: unknown[] = [];
    const ctx = { dispatchTool: async (_n: string, a: unknown) => { seen.push(a); return { content: [] }; } };
    await def.handler({ name: 'harness:status' }, ctx);
    expect(seen).toEqual([{}]);
  });

  it('refuses to invoke itself (foot-gun guard)', async () => {
    const ctx = { dispatchTool: vi.fn() };
    const res = await def.handler({ name: 'tools:invoke', args: {} }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('cannot invoke itself');
    expect(ctx.dispatchTool).not.toHaveBeenCalled();
  });

  it('errors cleanly on a transport with no dispatcher (no throw)', async () => {
    const res = await def.handler({ name: 'flags:set', args: {} }, {}); // ctx without dispatchTool
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('unsupported_transport');
  });

  it('records an effective error when the nested tool reports ok:false', async () => {
    const metadata = vi.fn();
    const ctx = {
      metadata,
      dispatchTool: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'bad_input' }) }],
      }),
    };
    await def.handler({ name: 'plans:new', args: {} }, ctx);
    expect(metadata).toHaveBeenCalledWith({
      effectiveStatus: 'error',
      childFailureCount: 1,
      childFailureRefs: ['plans:new'],
    });
  });
});

describe('summarizeNestedToolOutcome', () => {
  it('marks mixed batch results partial', () => {
    expect(summarizeNestedToolOutcome({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, counts: { ok: 2, failed: 1 } }) }],
    })).toEqual({ effectiveStatus: 'partial', childFailureCount: 1 });
  });
});

/**
 * P-012 (census double-count): the inner dispatch writes its own telemetry row, so
 * tools:invoke marks its OWN row as a dispatch wrapper for census exclusion. The
 * flag-off case is the falsifiability control: an implementation that stamps
 * unconditionally (or never) fails one of these two in each direction.
 */
describe('tools:invoke dispatch-wrapper mark (P-012)', () => {
  it('marks its row with dispatchWrapper + the dispatched tool when the flag is on', async () => {
    markEnabledMock.mockResolvedValueOnce(true);
    const metadata = vi.fn();
    const ctx = {
      metadata,
      dispatchTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    };
    await def.handler({ name: 'flags:get', args: {} }, ctx);
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchWrapper: true, dispatchedTool: 'flags:get' }),
    );
  });

  it('flag OFF (the kill-switch / control): metadata carries NO wrapper keys', async () => {
    // The module mock defaults to false — no mockResolvedValueOnce here on purpose.
    const metadata = vi.fn();
    const ctx = {
      metadata,
      dispatchTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    };
    await def.handler({ name: 'flags:get', args: {} }, ctx);
    const stamped = metadata.mock.calls[0][0] as Record<string, unknown>;
    expect(stamped).not.toHaveProperty('dispatchWrapper');
    expect(stamped).not.toHaveProperty('dispatchedTool');
  });

  it('a refusal that never dispatched stamps no metadata at all (no inner row exists)', async () => {
    markEnabledMock.mockResolvedValueOnce(true);
    const metadata = vi.fn();
    const ctx = { metadata, dispatchTool: vi.fn() };
    const res = await def.handler({ name: 'tools:invoke', args: {} }, ctx);
    expect(res.isError).toBe(true);
    expect(metadata).not.toHaveBeenCalled();
  });
});
