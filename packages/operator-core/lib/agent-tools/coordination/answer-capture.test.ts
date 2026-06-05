/**
 * answer-capture.test.ts — D-004 capture core (answer-capture.ts), unit.
 *
 * The capture is stubbed in every OTHER test (the conversations integration test
 * injects a fake CaptureFn), so the REAL captureResolvedAnswer + captureMem0Key
 * have no direct coverage. This file unit-tests them against a MOCKED mem0 client:
 *  • captureMem0Key — the pseudo-user-key mapping (harness:<slug> vs
 *    workspace:<id> vs workspace:default) that must mirror memory:remember's
 *    scoping so coord:ask's mem0 read finds a captured answer.
 *  • captureResolvedAnswer — target:'none' (skip, no client touched);
 *    getMemoryClient→null (mem0_unavailable); client.add throwing (mem0_error);
 *    and the happy path's `Q:…\nA:…` content written under the right userId.
 *
 * The whole posture is best-effort: a capture failure reports {ok:false} but is
 * NEVER thrown (the resolve must not fail on a mem0 outage).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// answer-capture imports getMemoryClient from '../../memory/mem0-client'; mock it.
const getMemoryClient = vi.fn();
vi.mock('../../memory/mem0-client', () => ({
  getMemoryClient: () => getMemoryClient(),
}));

import { captureMem0Key, captureResolvedAnswer, type CaptureInput } from './answer-capture';

function baseInput(over: Partial<CaptureInput> = {}): CaptureInput {
  return {
    target: 'mem0',
    question: 'why does the shop freeze?',
    answer: 'zero-cache was down (orphaned replicator lock)',
    scope: 'operator',
    harness_slug: null,
    workspace_id: 'default',
    asker_id: 'agA',
    resolver_id: 'agB',
    conversation_id: 'conv-1',
    ...over,
  };
}

describe('captureMem0Key — pseudo-user-key mapping', () => {
  it('harness scope with a slug → harness:<slug>', () => {
    expect(captureMem0Key('harness', 'papercup', 'default')).toBe('harness:papercup');
    // The slug wins over the workspace id when scope is harness.
    expect(captureMem0Key('harness', 'restart', 'ws-7')).toBe('harness:restart');
  });

  it('operator scope → workspace:<workspace_id>', () => {
    expect(captureMem0Key('operator', null, 'ws-7')).toBe('workspace:ws-7');
  });

  it('no workspace id → workspace:default (the fallback)', () => {
    expect(captureMem0Key('operator', null, null)).toBe('workspace:default');
    expect(captureMem0Key('operator', null, undefined)).toBe('workspace:default');
  });

  it('harness scope WITHOUT a slug falls back to the workspace key (guards the CHECK-less core)', () => {
    // scope==='harness' but no slug → not a valid harness key; the core degrades
    // to the workspace key rather than emitting `harness:null`.
    expect(captureMem0Key('harness', null, 'ws-7')).toBe('workspace:ws-7');
    expect(captureMem0Key('harness', '', 'ws-7')).toBe('workspace:ws-7');
  });
});

describe('captureResolvedAnswer', () => {
  beforeEach(() => {
    getMemoryClient.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('target:none → skipped, ok, and the memory client is never resolved', async () => {
    const res = await captureResolvedAnswer(baseInput({ target: 'none' }));
    expect(res).toEqual({ target: 'none', ok: true, detail: 'capture skipped by resolver' });
    expect(getMemoryClient).not.toHaveBeenCalled();
  });

  it('getMemoryClient → null → mem0_unavailable (ok:false), never throws', async () => {
    getMemoryClient.mockResolvedValue(null);
    const res = await captureResolvedAnswer(baseInput());
    expect(res.ok).toBe(false);
    expect(res.target).toBe('mem0_unavailable');
  });

  it('getMemoryClient itself throwing → mem0_unavailable (client caught → null)', async () => {
    getMemoryClient.mockRejectedValue(new Error('boom resolving client'));
    const res = await captureResolvedAnswer(baseInput());
    expect(res.ok).toBe(false);
    expect(res.target).toBe('mem0_unavailable');
  });

  it('client.add throwing → mem0_error (ok:false) carrying the error message', async () => {
    const add = vi.fn().mockRejectedValue(new Error('mem0 add failed'));
    getMemoryClient.mockResolvedValue({ add });
    const res = await captureResolvedAnswer(baseInput());
    expect(res.ok).toBe(false);
    expect(res.target).toBe('mem0_error');
    expect(res.detail).toBe('mem0 add failed');
  });

  it('happy path (operator) → writes Q:…\\nA:… under workspace:<id>, returns mem0:<userId>', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    getMemoryClient.mockResolvedValue({ add });
    const res = await captureResolvedAnswer(baseInput({ workspace_id: 'ws-7' }));

    expect(res).toEqual({ target: 'mem0:workspace:ws-7', ok: true });
    expect(add).toHaveBeenCalledTimes(1);
    const [content, opts] = add.mock.calls[0];
    expect(content).toBe('Q: why does the shop freeze?\nA: zero-cache was down (orphaned replicator lock)');
    expect(opts.userId).toBe('workspace:ws-7');
    expect(opts.metadata).toMatchObject({
      kind: 'project',
      scope: 'workspace',
      source: 'conversation',
      conversation_id: 'conv-1',
      resolved_by: 'agB',
      asked_by: 'agA',
      workspace_id: 'ws-7',
    });
    expect(opts.metadata.harness_slug).toBeUndefined();
  });

  it('happy path (harness) → writes under harness:<slug> with the harness metadata', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    getMemoryClient.mockResolvedValue({ add });
    const res = await captureResolvedAnswer(
      baseInput({ scope: 'harness', harness_slug: 'papercup', workspace_id: 'ws-7' }),
    );

    expect(res).toEqual({ target: 'mem0:harness:papercup', ok: true });
    const [, opts] = add.mock.calls[0];
    expect(opts.userId).toBe('harness:papercup');
    expect(opts.metadata).toMatchObject({ scope: 'harness', harness_slug: 'papercup' });
  });

  it('trims the question + answer before the Q/A content', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    getMemoryClient.mockResolvedValue({ add });
    await captureResolvedAnswer(baseInput({ question: '  spaced q  ', answer: '\tspaced a\n' }));
    expect(add.mock.calls[0][0]).toBe('Q: spaced q\nA: spaced a');
  });
});
