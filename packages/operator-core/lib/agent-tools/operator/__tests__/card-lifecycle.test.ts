/**
 * operator:* card-lifecycle tools — audit, dismissed, nudge.
 *
 * Audit logs lifecycle events. Dismissed records cooldown entries.
 * Nudge arbitrates spoken voice nudges.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../operator-audit');
  vi.doUnmock('../../../operator-dismissed-cache');
  vi.doUnmock('../../../voice-nudges');
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('operator:audit', () => {
  it('passes through cardId + kind + actorMethod + context', async () => {
    const writeOperatorAudit = vi.fn(async () => undefined);
    vi.doMock('../../../operator-audit', () => ({ writeOperatorAudit }));
    const { default: tool } = await import('../audit');
    const result = await tool.handler(
      {
        cardId: 'card-1',
        kind: 'accepted',
        actorMethod: 'click',
        context: { reason: 'unit test' },
      },
      MAKE_CTX(),
    );
    expect(writeOperatorAudit).toHaveBeenCalledWith({
      cardId: 'card-1',
      kind: 'accepted',
      actorMethod: 'click',
      context: { reason: 'unit test' },
    });
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, cardId: 'card-1', kind: 'accepted' });
  });

  it('coerces missing actorMethod to null', async () => {
    const writeOperatorAudit = vi.fn(async () => undefined);
    vi.doMock('../../../operator-audit', () => ({ writeOperatorAudit }));
    const { default: tool } = await import('../audit');
    await tool.handler({ cardId: 'card-2', kind: 'ignored' }, MAKE_CTX());
    expect(writeOperatorAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actorMethod: null }),
    );
  });

  it('excludes validator + reviewer from the role allowlist', async () => {
    vi.doMock('../../../operator-audit', () => ({ writeOperatorAudit: vi.fn() }));
    const { default: tool } = await import('../audit');
    expect(tool.agentRoles).not.toContain('validator');
    expect(tool.agentRoles).not.toContain('reviewer');
    expect(tool.agentRoles).toContain('worker');
    expect(tool.agentRoles).toContain('operator');
  });
});

describe('operator:dismissed', () => {
  it('records the dismissed id', async () => {
    const recordDismissed = vi.fn(async () => undefined);
    vi.doMock('../../../operator-dismissed-cache', () => ({ recordDismissed }));
    const { default: tool } = await import('../dismissed');
    const result = await tool.handler({ id: 'card-9' }, MAKE_CTX());
    expect(recordDismissed).toHaveBeenCalledWith('card-9');
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, id: 'card-9' });
  });

  it('restricts to operator + architect + scoper', async () => {
    vi.doMock('../../../operator-dismissed-cache', () => ({ recordDismissed: vi.fn() }));
    const { default: tool } = await import('../dismissed');
    expect(tool.agentRoles).toEqual(['operator', 'architect', 'scoper']);
  });
});

describe('operator:nudge', () => {
  it('returns fired:true when maybeFireNudge accepts', async () => {
    vi.doMock('../../../voice-nudges', () => ({
      maybeFireNudge: vi.fn(async () => true),
    }));
    const { default: tool } = await import('../nudge');
    const result = await tool.handler({ kind: 'budget' }, MAKE_CTX({ role: 'operator' }));
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ fired: true, kind: 'budget' });
  });

  it('returns fired:false when within dedup window', async () => {
    vi.doMock('../../../voice-nudges', () => ({
      maybeFireNudge: vi.fn(async () => false),
    }));
    const { default: tool } = await import('../nudge');
    const result = await tool.handler({ kind: 'breaker' }, MAKE_CTX({ role: 'operator' }));
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ fired: false, kind: 'breaker' });
  });

  it('exposes only operator + architect role gate', async () => {
    vi.doMock('../../../voice-nudges', () => ({ maybeFireNudge: vi.fn() }));
    const { default: tool } = await import('../nudge');
    expect(tool.agentRoles).toEqual(['operator', 'architect']);
  });
});
