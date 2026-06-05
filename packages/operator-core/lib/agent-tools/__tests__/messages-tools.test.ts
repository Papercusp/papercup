/**
 * messages-tools.test.ts — handler-level unit tests for the merged
 * messages surface: `messages:send` (harness-level + optional feature
 * scope) and `messages:dismiss`.
 *
 * Both delegate to executeAction; the tests confirm:
 *   - correct op/field mapping into executeAction
 *   - the conditional kind default (Directive vs feature-note)
 *   - feature scoping (to_feature_id / from_feature_id) mapping
 *   - slug validation guard on recipients
 *   - executeAction failure surfaces as degraded (not thrown)
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
  vi.doUnmock('../../execute-action');
});

// ─── messages:send (harness-level) ──────────────────────────────────────

describe('messages:send', () => {
  it('calls executeAction with send_message op and correct fields', async () => {
    const executeAction = vi.fn(async () => ({ ok: true, actionId: 'ax1' }));
    vi.doMock('../../execute-action', () => ({ executeAction }));

    const { default: tool } = await import('../messages/send');
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
    const [, callArgs] = (executeAction.mock.calls[0] ?? []) as any[];
    expect(callArgs.action.op).toBe('send_message');
    expect(callArgs.action.to).toEqual(['sheets', 'org']);
    expect(callArgs.action.kind).toBe('Directive');
    expect(callArgs.action.subject).toBe('Retry F-001');
  });

  it('defaults kind to Directive for a harness-level send (no feature)', async () => {
    const executeAction = vi.fn(async () => ({ ok: true }));
    vi.doMock('../../execute-action', () => ({ executeAction }));
    const { default: tool } = await import('../messages/send');
    await tool.handler(
      { to: ['org'], subject: 'S', body: 'B', reason: 'Default-kind test for harness send.' },
      MAKE_CTX(),
    );
    const [, call] = (executeAction.mock.calls[0] ?? []) as any[];
    expect(call.action.kind).toBe('Directive');
    expect(call.action.toFeatureId).toBeUndefined();
  });

  it('returns recipients + kind on success', async () => {
    vi.doMock('../../execute-action', () => ({
      executeAction: vi.fn(async () => ({ ok: true, actionId: 'ax2' })),
    }));
    const { default: tool } = await import('../messages/send');
    const result = (await tool.handler(
      { to: ['org'], kind: 'Note', subject: 'S', body: 'B', reason: 'Testing the send tool.' },
      MAKE_CTX(),
    )) as any;
    expect(result.data.recipients).toEqual(['org']);
    expect(result.data.kind).toBe('Note');
  });

  it('rejects an invalid recipient slug with degraded', async () => {
    vi.doMock('../../execute-action', () => ({ executeAction: vi.fn() }));
    const { default: tool } = await import('../messages/send');
    const result = (await tool.handler(
      { to: ['bad slug!'], subject: 'S', body: 'B', reason: 'Testing slug validation guard.' },
      MAKE_CTX(),
    )) as any;
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons[0]).toMatch(/invalid slug/);
  });

  it('surfaces executeAction failure as degraded, not thrown', async () => {
    vi.doMock('../../execute-action', () => ({
      executeAction: vi.fn(async () => ({ ok: false, error: 'db_down', detail: 'PG refused' })),
    }));
    const { default: tool } = await import('../messages/send');
    const result = (await tool.handler(
      { to: ['org'], kind: 'Note', subject: 'S', body: 'B', reason: 'Testing failure path.' },
      MAKE_CTX(),
    )) as any;
    expect(result.data).toBeNull();
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons[0]).toMatch(/db_down/);
  });

  it('passes parent_message_id through when provided', async () => {
    const executeAction = vi.fn(async () => ({ ok: true }));
    vi.doMock('../../execute-action', () => ({ executeAction }));
    const { default: tool } = await import('../messages/send');
    await tool.handler(
      {
        to: ['org'],
        kind: 'Reply',
        subject: 'Re: thing',
        body: 'Got it.',
        parent_message_id: 'msg_123',
        reason: 'Testing parent_message_id propagation now.',
      },
      MAKE_CTX(),
    );
    const [, call] = (executeAction.mock.calls[0] ?? []) as any[];
    expect(call.action.parentMessageId).toBe('msg_123');
  });
});

// ─── messages:send (feature-scoped — subsumes old feature_send) ──────────

describe('messages:send (feature-scoped)', () => {
  it('maps to_feature_id + from_feature_id and defaults kind to feature-note', async () => {
    const executeAction = vi.fn(async () => ({ ok: true }));
    vi.doMock('../../execute-action', () => ({ executeAction }));
    const { default: tool } = await import('../messages/send');
    await tool.handler(
      {
        to: ['sheets'],
        to_feature_id: 'F-001',
        from_feature_id: 'F-002',
        subject: 'Status update',
        body: 'F-001 is unblocked.',
        reason: 'Coordinating between related features.',
      },
      MAKE_CTX(),
    );
    const [, call] = (executeAction.mock.calls[0] ?? []) as any[];
    expect(call.action.toFeatureId).toBe('F-001');
    expect(call.action.fromFeatureId).toBe('F-002');
    expect(call.action.to).toEqual(['sheets']);
    expect(call.action.kind).toBe('feature-note'); // conditional default
  });

  it('surfaces executeAction failure as degraded', async () => {
    vi.doMock('../../execute-action', () => ({
      executeAction: vi.fn(async () => ({ ok: false, error: 'timeout' })),
    }));
    const { default: tool } = await import('../messages/send');
    const result = (await tool.handler(
      {
        to: ['sheets'],
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

// ─── messages:dismiss (subsumes old feature_dismiss) ────────────────────

describe('messages:dismiss', () => {
  it('marks a message archived via mark_message_status', async () => {
    const executeAction = vi.fn(async () => ({ ok: true }));
    vi.doMock('../../execute-action', () => ({ executeAction }));
    const { default: tool } = await import('../messages/dismiss');
    await tool.handler(
      { message_id: 'm-1', reason: 'Handled this note already, dismissing.' },
      MAKE_CTX(),
    );
    const [, call] = (executeAction.mock.calls[0] ?? []) as any[];
    expect(call.action.op).toBe('mark_message_status');
    expect(call.action.messageId).toBe('m-1');
    expect(call.action.status).toBe('archived');
  });

  it('surfaces executeAction failure as degraded', async () => {
    vi.doMock('../../execute-action', () => ({
      executeAction: vi.fn(async () => ({ ok: false, error: 'not_found' })),
    }));
    const { default: tool } = await import('../messages/dismiss');
    const result = (await tool.handler(
      { message_id: 'nope', reason: 'Testing dismiss failure path.' },
      MAKE_CTX(),
    )) as any;
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons[0]).toMatch(/not_found/);
  });
});
