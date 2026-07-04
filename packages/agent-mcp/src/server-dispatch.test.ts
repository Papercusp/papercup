/**
 * Tests for server.ts#dispatch() — the single in-process entry point both the
 * MCP stdio transport and Operator/Oracle call. It had no direct coverage (the
 * existing __tests__/dispatch.test.ts exercises tooldef's defineTool, not this).
 *
 * dispatch composes: lookup → resolveBearer → capability check → arg validate →
 * withWorkspace(principal.workspaceId, handler). The security-relevant invariant
 * (also the heart of plan P-005): the run is scoped to the PRINCIPAL's workspace,
 * and DispatchOptions has NO caller-supplied workspace channel — so a caller can
 * never steer a tool into another workspace. These tests pin every branch + that
 * invariant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FAKE_TX = { __fakeTx: true } as const;

// withWorkspace records the workspace id it was scoped to and runs the callback
// with a sentinel tx, so we can assert both the scope and what the handler got.
vi.mock('@papercusp/db-org', () => ({
  withWorkspace: vi.fn(async (_wsId: string, cb: (tx: unknown) => unknown) => cb(FAKE_TX)),
}));

vi.mock('./auth', () => ({ resolveBearer: vi.fn() }));

// Mock the tooldef surface server.ts imports. dispatch only uses lookup +
// standardValidate + formatIssues; the rest are imported for other (untested)
// functions and just need to exist so the module loads.
vi.mock('@papercusp/tooldef', () => ({
  lookup: vi.fn(),
  standardValidate: vi.fn(),
  formatIssues: (issues: unknown) => `issues:${JSON.stringify(issues)}`,
  getCatalog: vi.fn(() => []),
  getResourceCatalog: vi.fn(() => []),
  matchResource: vi.fn(() => null),
  getPromptCatalog: vi.fn(() => []),
  lookupPrompt: vi.fn(() => undefined),
}));

import { dispatch, unwrapDoubleEncodedArgs } from './server';
import { resolveBearer } from './auth';
import { withWorkspace } from '@papercusp/db-org';
import { lookup, standardValidate } from '@papercusp/tooldef';

type AnyFn = ReturnType<typeof vi.fn>;

const principalA = {
  kind: 'system' as const,
  slug: 'system:operator',
  workspaceId: 'ws-A',
  capabilities: new Set(['test:read']),
  authMethod: 'bearer-token' as const,
  trust: 'trusted' as const,
};

let handler: AnyFn;
function makeTool(over: Record<string, unknown> = {}) {
  handler = vi.fn(async (value: unknown, ctx: { principal: { workspaceId: string }; tx: unknown }) => ({
    data: { echoed: value, ws: ctx.principal.workspaceId, tx: ctx.tx },
  }));
  return { name: 'test:echo', capability: 'test:read', args: {}, handler, ...over };
}

beforeEach(() => {
  vi.mocked(lookup).mockReset();
  vi.mocked(standardValidate).mockReset();
  vi.mocked(resolveBearer).mockReset();
  vi.mocked(withWorkspace).mockClear();
  // Default: a known tool, a valid principal, args validate cleanly.
  vi.mocked(lookup).mockReturnValue(makeTool() as never);
  vi.mocked(resolveBearer).mockResolvedValue(principalA as never);
  vi.mocked(standardValidate).mockResolvedValue({ ok: true, value: { x: 1 } } as never);
});

afterEach(() => vi.restoreAllMocks());

describe('dispatch — control flow', () => {
  it('unknown tool → unknown_tool, never resolves a bearer', async () => {
    vi.mocked(lookup).mockReturnValue(undefined as never);
    const res = await dispatch({ toolName: 'nope', args: {}, bearer: 'b' });
    expect(res).toMatchObject({ ok: false, error: { code: 'unknown_tool' } });
    expect(resolveBearer).not.toHaveBeenCalled();
  });

  it('unresolvable bearer → invalid_bearer, never runs the handler', async () => {
    vi.mocked(resolveBearer).mockResolvedValue(null as never);
    const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'bad' });
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_bearer' } });
    expect(handler).not.toHaveBeenCalled();
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('principal lacking the capability → missing_capability, handler not run', async () => {
    vi.mocked(resolveBearer).mockResolvedValue({
      ...principalA,
      capabilities: new Set(['something:else']),
    } as never);
    const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('missing_capability');
    expect(handler).not.toHaveBeenCalled();
  });

  it('invalid args → invalid_args, handler not run', async () => {
    vi.mocked(standardValidate).mockResolvedValue({ ok: false, issues: [{ message: 'bad' }] } as never);
    const res = await dispatch({ toolName: 'test:echo', args: { x: 'no' }, bearer: 'b' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('invalid_args');
    expect(res.error?.message).toBe('bad');
    expect(handler).not.toHaveBeenCalled();
  });

  it('too_big string → message states how far over + the trim target (P-003)', async () => {
    // A Zod too_big issue carries { code, origin, maximum } at runtime; dispatch
    // pairs `maximum` with the actual input length so the agent trims in one retry
    // instead of blind-retrying the same over-length value.
    vi.mocked(standardValidate).mockResolvedValue({
      ok: false,
      issues: [
        {
          message: 'Too big: expected string to have <=500 characters',
          code: 'too_big',
          origin: 'string',
          maximum: 500,
          path: ['goal'],
        },
      ],
    } as never);
    const res = await dispatch({ toolName: 'test:echo', args: { goal: 'x'.repeat(912) }, bearer: 'b' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('invalid_args');
    expect(res.error?.message).toBe('goal: too long — 412 chars over the 500-char limit; trim to 500.');
  });

  it('handler throw → handler_error carrying the message', async () => {
    vi.mocked(lookup).mockReturnValue(
      makeTool({ handler: vi.fn(async () => { throw new Error('boom'); }) }) as never,
    );
    const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('handler_error');
    expect(res.error?.message).toBe('boom');
  });

  it('happy path → runs the handler with validated args + a ctx, returns the response', async () => {
    const res = await dispatch({ toolName: 'test:echo', args: { x: 1 }, bearer: 'b' });
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    // handler receives the VALIDATED value (standardValidate.value), not raw args.
    const [value, ctx] = handler.mock.calls[0];
    expect(value).toEqual({ x: 1 });
    expect(ctx.principal).toBe(principalA);
    expect(ctx.tx).toBe(FAKE_TX);
    expect(res.response).toMatchObject({ data: { ws: 'ws-A', tx: FAKE_TX } });
  });
});

describe('unwrapDoubleEncodedArgs — EI-7068 client double-encoding fix', () => {
  it('unwraps { args: "<json-object-string>" } to the parsed object', () => {
    expect(unwrapDoubleEncodedArgs({ args: '{"content":"hi","kind":"note"}' })).toEqual({
      content: 'hi',
      kind: 'note',
    });
  });

  it('passes through a normal args object unchanged', () => {
    const normal = { content: 'hi', kind: 'note' };
    expect(unwrapDoubleEncodedArgs(normal)).toBe(normal);
  });

  it('does NOT unwrap when there are sibling keys alongside "args" (not the degenerate shape)', () => {
    const withSibling = { args: '{"a":1}', other: 'field' };
    expect(unwrapDoubleEncodedArgs(withSibling)).toBe(withSibling);
  });

  it('does NOT unwrap a LEGITIMATE args:{...} object field (only a STRING value triggers it)', () => {
    const realArgsField = { args: { nested: true } };
    expect(unwrapDoubleEncodedArgs(realArgsField)).toBe(realArgsField);
  });

  it('does NOT unwrap when the args string is not valid JSON', () => {
    const bad = { args: 'not json {' };
    expect(unwrapDoubleEncodedArgs(bad)).toBe(bad);
  });

  it('does NOT unwrap when the parsed JSON is an array or a primitive', () => {
    expect(unwrapDoubleEncodedArgs({ args: '[1,2,3]' })).toEqual({ args: '[1,2,3]' });
    expect(unwrapDoubleEncodedArgs({ args: '"just a string"' })).toEqual({ args: '"just a string"' });
    expect(unwrapDoubleEncodedArgs({ args: '42' })).toEqual({ args: '42' });
  });

  it('passes through non-object input (null, array, primitive) unchanged', () => {
    expect(unwrapDoubleEncodedArgs(null)).toBeNull();
    expect(unwrapDoubleEncodedArgs(undefined)).toBeUndefined();
    expect(unwrapDoubleEncodedArgs([1, 2])).toEqual([1, 2]);
    expect(unwrapDoubleEncodedArgs('str')).toBe('str');
  });

  it('dispatch integration: a double-encoded call still reaches the handler with real fields', async () => {
    // standardValidate is mocked to just echo whatever object it receives as `.value`
    // (not literally what production Zod does, but sufficient to prove dispatch
    // handed the UNWRAPPED object to validation, not the degenerate wrapper).
    vi.mocked(standardValidate).mockImplementation(async (_schema: unknown, value: unknown) => ({
      ok: true,
      value,
    }) as never);
    const res = await dispatch({
      toolName: 'test:echo',
      args: { args: '{"x":1}' },
      bearer: 'b',
    });
    expect(res.ok).toBe(true);
    const [value] = handler.mock.calls[0];
    expect(value).toEqual({ x: 1 });
  });
});

describe('dispatch — workspace isolation', () => {
  it('scopes the run to the PRINCIPAL\'s workspace (no caller-supplied workspace channel exists)', async () => {
    await dispatch({ toolName: 'test:echo', args: { x: 1 }, bearer: 'b' });
    expect(withWorkspace).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withWorkspace).mock.calls[0][0]).toBe('ws-A');
  });

  it('a different principal moves the scope — proving it tracks the resolved principal, not the input', async () => {
    vi.mocked(resolveBearer).mockResolvedValue({ ...principalA, workspaceId: 'ws-OTHER' } as never);
    await dispatch({ toolName: 'test:echo', args: { x: 1 }, bearer: 'b' });
    expect(vi.mocked(withWorkspace).mock.calls[0][0]).toBe('ws-OTHER');
  });
});
