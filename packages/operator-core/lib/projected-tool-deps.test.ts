/**
 * Operator-core WIRING of PROJECTED_DEPS — the shared `DispatchProjectedDeps`
 * the @papercusp/agent-mcp dispatcher runs on every transport (HTTP / IPC / MCP).
 *
 * HE-02 / P-010 gap #7 (hive-run-evaluation-2026-06-13 — close the Class-1
 * deterministic gaps the HE-01 audit found). The GENERIC dispatch step is tested
 * inside @papercusp/agent-mcp and the envelope POLICY in
 * capability-envelope/policy.test.ts — but the operator-core BINDING was
 * untested: the enforce-vs-observe flag read on a beyond-envelope hit, the
 * decision-ledger emit on every settled call (and that it can never break its
 * trigger), the llm-testing override wiring, and that `defaultDeny:true` is
 * plumbed. This pins that binding, using the REAL (pure) evaluateCapabilityEnvelope
 * and mocking only the flag + the PG-touching leaves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// PARTIAL mocks only (importOriginal) — preserve every other export so the heavy
// dispatch import graph (agent-mcp bootstrap reads the REAL @papercusp/db-org
// `generated` at module load) still resolves, and so a cross-worker registry
// leak can never strip a sibling's real export (the fleet flagged full vi.mock of
// shared modules as a flake source). We override ONLY: the enforce flag-read, the
// ledger emit (assert called + throws swallowed without a real PG insert), and the
// llm-testing override registry. @papercusp/db-org is left REAL + un-mocked —
// getOrgPg is lazy and never invoked by these tests.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(),
}));
vi.mock('@papercusp/testing-shell/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/testing-shell/llm')>()),
  getOverride: vi.fn(),
}));
vi.mock('./decision-ledger/emit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./decision-ledger/emit')>()),
  recordDecisionLedger: vi.fn(),
}));

import { PROJECTED_DEPS, setReactionPostInvoke, jsonbSafeStringify } from './projected-tool-deps';
import { getFlag } from '@papercusp/flags/server';
import { getOverride } from '@papercusp/testing-shell/llm';
import { recordDecisionLedger } from './decision-ledger/emit';
import { PASS_THROUGH } from '@papercusp/agent-mcp';
import type { PostInvokeEvent, UnifiedToolContext } from '@papercusp/agent-mcp';

function ctx(over: Partial<UnifiedToolContext> = {}): UnifiedToolContext {
  return { workspaceId: 'default', ...over } as UnifiedToolContext;
}

afterEach(() => {
  vi.clearAllMocks();
  // The reaction port is a module-level singleton — reset between tests so an
  // installed handler does not leak.
  setReactionPostInvoke(null);
});

describe('PROJECTED_DEPS.checkCapabilityEnvelope — enforce/observe wiring (gap #7)', () => {
  it('returns null (no verdict) for an EXEMPT superuser caller — flag never read (D-002)', async () => {
    const v = await PROJECTED_DEPS.checkCapabilityEnvelope!({
      toolName: 'secrets.read',
      capabilities: ['secrets:read:db'],
      ctx: ctx({ isSuperuser: true }),
      args: {},
    });
    expect(v).toBeNull();
    expect(getFlag).not.toHaveBeenCalled();
  });

  it('returns null for a non-fleet / roleless caller', async () => {
    const v = await PROJECTED_DEPS.checkCapabilityEnvelope!({
      toolName: 'plans.get',
      capabilities: ['plans:read'],
      ctx: ctx({ role: undefined }),
      args: {},
    });
    expect(v).toBeNull();
    expect(getFlag).not.toHaveBeenCalled();
  });

  it('ALLOWS a within-envelope fleet call (posture auto) without reading the flag (hot path stays sync)', async () => {
    const v = await PROJECTED_DEPS.checkCapabilityEnvelope!({
      toolName: 'plans.set-status',
      capabilities: ['plans:write'],
      ctx: ctx({ role: 'worker' }),
      args: {},
    });
    expect(v).toEqual({ decision: 'allow', posture: 'auto', applied: true });
    expect(getFlag).not.toHaveBeenCalled();
  });

  it('DENIES a beyond-envelope (protected) fleet call when the enforce flag is ON', async () => {
    vi.mocked(getFlag).mockResolvedValue(true);
    const v = await PROJECTED_DEPS.checkCapabilityEnvelope!({
      toolName: 'secrets.read',
      capabilities: ['secrets:read:db'],
      ctx: ctx({ role: 'worker' }),
      args: {},
    });
    expect(getFlag).toHaveBeenCalledOnce();
    expect(v).toMatchObject({ decision: 'deny', posture: 'rejected', applied: true });
    expect(v?.reason).toContain('never-auto protected set');
  });

  it('OBSERVES (does not block) a beyond-envelope call when the enforce flag is OFF — default-OFF shadow', async () => {
    vi.mocked(getFlag).mockResolvedValue(false);
    const v = await PROJECTED_DEPS.checkCapabilityEnvelope!({
      toolName: 'processes.kill',
      capabilities: ['processes:kill'],
      ctx: ctx({ role: 'bee' }),
      args: {},
    });
    expect(getFlag).toHaveBeenCalledOnce();
    expect(v).toMatchObject({ decision: 'observe', posture: 'gated', applied: true });
    expect(v?.reason).toContain('protected set');
  });
});

describe('PROJECTED_DEPS.postInvoke — decision-ledger emit + never breaks its trigger (gap #7)', () => {
  const event = (): PostInvokeEvent =>
    ({
      toolName: 'plans.set-status',
      pluginName: 'agent-mcp',
      args: { slug: 'p', status: 'wip' },
      result: { ok: true, result: { content: [] } },
      ctx: ctx({ role: 'worker', runId: 'r1', spawnId: 's1' }) as PostInvokeEvent['ctx'],
      durationMs: 5,
      capabilities: ['plans:write'],
    }) as PostInvokeEvent;

  it('records a decision-ledger row on every settled dispatch', () => {
    PROJECTED_DEPS.postInvoke!(event());
    expect(recordDecisionLedger).toHaveBeenCalledOnce();
  });

  it('forwards the event to the installed reaction handler', () => {
    const seen: PostInvokeEvent[] = [];
    setReactionPostInvoke((e) => {
      seen.push(e);
    });
    PROJECTED_DEPS.postInvoke!(event());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolName).toBe('plans.set-status');
  });

  it('still records the ledger even when an installed reaction handler throws (a reaction must never break its trigger)', () => {
    setReactionPostInvoke(() => {
      throw new Error('reaction boom');
    });
    expect(() => PROJECTED_DEPS.postInvoke!(event())).not.toThrow();
    expect(recordDecisionLedger).toHaveBeenCalledOnce();
  });

  it('swallows a throwing decision-ledger emit (the ledger must never break its trigger)', () => {
    vi.mocked(recordDecisionLedger).mockImplementationOnce(() => {
      throw new Error('ledger boom');
    });
    expect(() => PROJECTED_DEPS.postInvoke!(event())).not.toThrow();
  });
});

describe('PROJECTED_DEPS.overrideTool — llm-testing dispatch-override wiring (gap #7)', () => {
  it('passes through when the ctx is not an llm-testing run (registry not consulted)', () => {
    const r = PROJECTED_DEPS.overrideTool!('plans.get', {}, ctx({ uiClientId: 'desktop' }));
    expect(r).toBe(PASS_THROUGH);
    expect(getOverride).not.toHaveBeenCalled();
  });

  it('passes through a tagged llm-testing run with no registered override', () => {
    vi.mocked(getOverride).mockReturnValue(undefined as never);
    const r = PROJECTED_DEPS.overrideTool!('plans.get', {}, ctx({ uiClientId: 'llm-testing/run_x' }));
    expect(getOverride).toHaveBeenCalledWith('run_x');
    expect(r).toBe(PASS_THROUGH);
  });

  it('returns the registered override result for a tagged llm-testing run', () => {
    const overridden = { ok: true, result: { content: [{ type: 'text', text: 'stub' }] } };
    const overrideFn = vi.fn().mockReturnValue(overridden);
    vi.mocked(getOverride).mockReturnValue({ override: overrideFn } as never);
    const r = PROJECTED_DEPS.overrideTool!('plans.get', { a: 1 }, ctx({ uiClientId: 'llm-testing/run_y' }));
    expect(overrideFn).toHaveBeenCalledWith('plans.get', { a: 1 });
    expect(r).toBe(overridden);
  });
});

describe('PROJECTED_DEPS.defaultDeny — fail-closed floor for ungated tools (gap #7)', () => {
  it('is plumbed ON (a future/third-party tool with no declared gate gets a loud ungated 403)', () => {
    expect(PROJECTED_DEPS.defaultDeny).toBe(true);
  });
});

// recordInvocation writes args_json/metadata_json via `JSON.stringify(...)::jsonb`.
// Postgres jsonb rejects the U+0000 escape ("unsupported Unicode escape
// sequence"), so a tool call whose args carried a NUL byte (binary-ish payloads,
// truncated reads, terminal output) threw and the WHOLE invocation row was
// dropped (the catch swallows it -> telemetry silently lost). jsonbSafeStringify
// strips NUL from string values so the cast succeeds.
describe('jsonbSafeStringify -- NUL-byte sanitization for ::jsonb', () => {
  const NUL = String.fromCharCode(0);
  const NUL_ESCAPE = '\\u0000'; // the 6-char escape JSON.stringify emits for a real NUL

  it('strips NUL from string values so the output has no u0000 escape (jsonb-castable)', () => {
    const out = jsonbSafeStringify({ a: 'x' + NUL + 'y', b: ['p' + NUL, 'q'], n: 1 });
    expect(out.includes(NUL_ESCAPE)).toBe(false);
    expect(out.includes(NUL)).toBe(false);
    expect(JSON.parse(out)).toEqual({ a: 'xy', b: ['p', 'q'], n: 1 });
  });

  it('handles a top-level NUL-bearing string and deep nesting', () => {
    expect(jsonbSafeStringify(NUL + 'lead')).toBe('"lead"');
    const out = jsonbSafeStringify({ deep: { arr: [{ s: 'a' + NUL + 'b' }] } });
    expect(out.includes(NUL_ESCAPE)).toBe(false);
    expect(JSON.parse(out)).toEqual({ deep: { arr: [{ s: 'ab' }] } });
  });

  it('leaves a LITERAL backslash-u-0000 text intact (not an actual NUL byte)', () => {
    const literal = '\\u0000'; // six real chars: backslash u 0 0 0 0 -- valid in jsonb
    expect(JSON.parse(jsonbSafeStringify({ a: literal }))).toEqual({ a: literal });
  });

  it('is identical to JSON.stringify when there is no NUL (no behavior change otherwise)', () => {
    const v = { a: 1, b: 'hello', c: [true, null, { d: 'x' }] };
    expect(jsonbSafeStringify(v)).toBe(JSON.stringify(v));
  });
});
