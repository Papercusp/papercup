/**
 * messages-tools.test.ts — handler-level unit tests for messages:send and
 * messages:feature_send (Plan 1 P-015).
 *
 * Both tools delegate to executeAction; the tests confirm:
 *   - correct op/field mapping into executeAction
 *   - success path returns the expected data shape
 *   - executeAction failure is surfaced as degraded (not thrown)
 *   - feature_send slug/featureId validation guards
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'operator' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    principal: { slug: 'agent-test' },
    ...over,
  } as never);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@/lib/execute-action');
});

function payload(result: { content?: Array<{ text: string }> }): unknown {
  if (result.content) return JSON.parse(result.content[0].text);
  return result;
}

// ─── messages:send ────────────────────────────────────────────────────────────

describe('messages:send', () => {
  it('calls executeAction with send_message op and correct fields', async () => {
    const executeAction = vi.fn(async () => ({ ok: true, actionId: 'ax1' }));
    vi.doMock('@/lib/execute-action', () => ({ executeAction }));

    const { default: tool } = await import('@/lib/agent-tools/messages/send');
    await tool.handler(
      {
        to: ['sheets', 'org'],
        kind: 'Directive',
        subject: 'Retry F-001',
        body: 'Please retry the failed feature.',
        reason: 'Validator returned failing for a transient error.',
      },
      MAKE_CTX(),
    );

    expect(executeAction).toHaveBeenCalledTimes(1);
    const [, callArgs] = executeAction.mock.calls[0];
    expect(callArgs.action.op).toBe('send_message');
    expect(callArgs.action.to).toEqual(['sheets', 'org']);
    expect(callArgs.action.kind).toBe('Directive');
    expect(callArgs.action.subject).toBe('Retry F-001');
  });

  it('returns recipients + kind on success', async () => {
    vi.doMock('@/lib/execute-action', () => ({
      executeAction: vi.fn(async () => ({ ok: true, actionId: 'ax2' })),
    }));
    const { default: tool } = await import('@/lib/agent-tools/messages/send');
    const result = (await tool.handler(
      { to: ['org'], kind: 'Note', subject: 'S', body: 'B', reason: 'Testing the send tool.' },
      MAKE_CTX(),
    )) as any;
    expect(result.data.recipients).toEqual(['org']);
    expect(result.data.kind).toBe('Note');
  });

  it('surfaces executeAction failure as degraded, not thrown', async () => {
    vi.doMock('@/lib/execute-action', () => ({
      executeAction: vi.fn(async () => ({ ok: false, error: 'db_down', detail: 'PG refused' })),
    }));
    const { default: tool } = await import('@/lib/agent-tools/messages/send');
    const result = (await tool.handler(
      { to: ['org'], kind: 'Note', subject: 'S', body: 'B', reason: 'Testing failure path.' },
      MAKE_CTX(),
    )) as any;
    expect(result.data).toBeNull();
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons[0]).toMatch(/db_down/);
  });

  it('passes parentMessageId through when provided', async () => {
    const executeAction = vi.fn(async () => ({ ok: true }));
    vi.doMock('@/lib/execute-action', () => ({ executeAction }));
    const { default: tool } = await import('@/lib/agent-tools/messages/send');
    await tool.handler(
      {
        to: ['org'],
        kind: 'Reply',
        subject: 'Re: thing',
        body: 'Got it.',
        parentMessageId: 'msg_123',
        reason: 'Testing parentMessageId propagation now.',
      },
      MAKE_CTX(),
    );
    const [, call] = executeAction.mock.calls[0];
    expect(call.action.parentMessageId).toBe('msg_123');
  });
});

// ─── messages:feature_send ────────────────────────────────────────────────────

describe('messages:feature_send', () => {
  it('calls executeAction with toFeatureId + fromFeatureId fields', async () => {
    const executeAction = vi.fn(async () => ({ ok: true }));
    vi.doMock('@/lib/execute-action', () => ({ executeAction }));
    const { default: tool } = await import('@/lib/agent-tools/messages/feature_send');
    await tool.handler(
      {
        to_slug: 'sheets',
        to_feature_id: 'F-001',
        from_feature_id: 'F-002',
        subject: 'Status update',
        body: 'F-001 is unblocked.',
        reason: 'Coordinating between related features.',
      },
      MAKE_CTX(),
    );
    const [, call] = executeAction.mock.calls[0];
    expect(call.action.toFeatureId).toBe('F-001');
    expect(call.action.fromFeatureId).toBe('F-002');
    expect(call.action.to).toEqual(['sheets']);
  });

  it('rejects an invalid slug with degraded', async () => {
    vi.doMock('@/lib/execute-action', () => ({ executeAction: vi.fn() }));
    const { default: tool } = await import('@/lib/agent-tools/messages/feature_send');
    const result = (await tool.handler(
      {
        to_slug: 'bad slug!',
        to_feature_id: 'F-001',
        from_feature_id: 'F-002',
        subject: 'S',
        body: 'B',
        reason: 'Testing slug validation guard.',
      },
      MAKE_CTX(),
    )) as any;
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons[0]).toMatch(/invalid slug/);
  });

  it('surfaces executeAction failure as degraded', async () => {
    vi.doMock('@/lib/execute-action', () => ({
      executeAction: vi.fn(async () => ({ ok: false, error: 'timeout' })),
    }));
    const { default: tool } = await import('@/lib/agent-tools/messages/feature_send');
    const result = (await tool.handler(
      {
        to_slug: 'sheets',
        to_feature_id: 'F-001',
        from_feature_id: 'F-002',
        subject: 'S',
        body: 'B',
        reason: 'Testing failure propagation.',
      },
      MAKE_CTX(),
    )) as any;
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons[0]).toMatch(/timeout/);
  });
});
