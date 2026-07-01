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

import toolInvoke from './invoke';

type ToolDef = {
  name: string;
  capability: string;
  requirePrincipal: boolean;
  args: { safeParse: (v: unknown) => { success: boolean } };
  handler: (a: unknown, c?: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

const def = toolInvoke as unknown as ToolDef;

describe('tools:invoke registration', () => {
  it('registers with the expected name + capability + args', () => {
    expect(def.name).toBe('tools:invoke');
    expect(def.capability).toBe('agent_tools:read');
    expect(def.requirePrincipal).toBe(false);
    expect(def.args.safeParse({ name: 'flags:set', args: { key: 'x', value: true } }).success).toBe(true);
    expect(def.args.safeParse({ name: 'flags:set' }).success).toBe(true); // args optional
    expect(def.args.safeParse({}).success).toBe(false); // name required
    expect(def.args.safeParse({ name: '' }).success).toBe(false); // non-empty
  });
});

describe('tools:invoke handler', () => {
  it('routes the call through ctx.dispatchTool with name + args and returns its result', async () => {
    const calls: Array<[string, unknown]> = [];
    const ctx = {
      dispatchTool: vi.fn(async (name: string, a: unknown) => {
        calls.push([name, a]);
        return { content: [{ type: 'text', text: 'dispatched-ok' }], isError: false };
      }),
    };
    const res = await def.handler({ name: 'flags:set', args: { key: 'k', value: true } }, ctx);
    expect(calls).toEqual([['flags:set', { key: 'k', value: true }]]);
    expect(res.content[0].text).toBe('dispatched-ok');
    expect(res.isError).toBe(false);
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
});
