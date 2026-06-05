/**
 * operator:standing_approvals_* tools — list, decide, mark_shown.
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
    ...over,
  } as never);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../operator-standing-candidates');
  vi.doUnmock('../../../operator-preferences');
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('operator:standing_approvals_list', () => {
  it('refreshes and returns candidates', async () => {
    const candidates = [{ capability: 'send_message', targetHarness: 'foo' }];
    const refreshCandidates = vi.fn(async () => candidates);
    vi.doMock('../../../operator-standing-candidates', () => ({
      readCandidates: vi.fn(),
      refreshCandidates,
      markCandidateShown: vi.fn(),
    }));
    const { default: tool } = await import('../standing_approvals_list');
    const result = await tool.handler({}, MAKE_CTX());
    expect(refreshCandidates).toHaveBeenCalled();
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ candidates });
  });

  it('falls back to readCandidates if refresh throws', async () => {
    const readCandidates = vi.fn(async () => [{ capability: 'cached', targetHarness: 'bar' }]);
    vi.doMock('../../../operator-standing-candidates', () => ({
      readCandidates,
      refreshCandidates: vi.fn(async () => {
        throw new Error('refresh failed');
      }),
      markCandidateShown: vi.fn(),
    }));
    const { default: tool } = await import('../standing_approvals_list');
    const result = await tool.handler({}, MAKE_CTX());
    expect(readCandidates).toHaveBeenCalled();
    const payload = parsePayload(result as never);
    expect((payload.candidates as Array<{ capability: string }>)[0].capability).toBe('cached');
  });
});

describe('operator:standing_approvals_decide', () => {
  it('approve appends a [STANDING-APPROVE] entry to preferences', async () => {
    const appendPreferenceEntry = vi.fn(async () => undefined);
    const refreshCandidates = vi.fn(async () => []);
    vi.doMock('../../../operator-preferences', () => ({ appendPreferenceEntry }));
    vi.doMock('../../../operator-standing-candidates', () => ({
      readCandidates: vi.fn(),
      refreshCandidates,
      markCandidateShown: vi.fn(),
    }));
    const { default: tool } = await import('../standing_approvals_decide');
    const result = await tool.handler(
      { capability: 'send_message', targetHarness: 'sheets', decision: 'approve' },
      MAKE_CTX(),
    );
    expect(appendPreferenceEntry).toHaveBeenCalled();
    const entry = appendPreferenceEntry.mock.calls[0][0];
    expect(entry).toMatch(/STANDING-APPROVE/);
    expect(entry).toMatch(/capability=send_message/);
    expect(entry).toMatch(/target=sheets/);
    expect(refreshCandidates).toHaveBeenCalled();
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, decision: 'approve' });
  });

  it('dismiss does NOT write to preferences', async () => {
    const appendPreferenceEntry = vi.fn(async () => undefined);
    vi.doMock('../../../operator-preferences', () => ({ appendPreferenceEntry }));
    vi.doMock('../../../operator-standing-candidates', () => ({
      readCandidates: vi.fn(),
      refreshCandidates: vi.fn(async () => []),
      markCandidateShown: vi.fn(),
    }));
    const { default: tool } = await import('../standing_approvals_decide');
    await tool.handler(
      { capability: 'cap', targetHarness: 'tgt', decision: 'dismiss' },
      MAKE_CTX(),
    );
    expect(appendPreferenceEntry).not.toHaveBeenCalled();
  });

  it('exposes operator-only role gate', async () => {
    vi.doMock('../../../operator-preferences', () => ({ appendPreferenceEntry: vi.fn() }));
    vi.doMock('../../../operator-standing-candidates', () => ({
      readCandidates: vi.fn(),
      refreshCandidates: vi.fn(),
      markCandidateShown: vi.fn(),
    }));
    const { default: tool } = await import('../standing_approvals_decide');
    expect(tool.agentRoles).toEqual(['operator']);
  });
});

describe('operator:standing_approval_mark_shown', () => {
  it('forwards to markCandidateShown', async () => {
    const markCandidateShown = vi.fn(async () => undefined);
    vi.doMock('../../../operator-standing-candidates', () => ({
      readCandidates: vi.fn(),
      refreshCandidates: vi.fn(),
      markCandidateShown,
    }));
    const { default: tool } = await import('../standing_approval_mark_shown');
    const result = await tool.handler(
      { capability: 'send_message', targetHarness: 'sheets' },
      MAKE_CTX(),
    );
    expect(markCandidateShown).toHaveBeenCalledWith('send_message', 'sheets');
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      ok: true,
      capability: 'send_message',
      targetHarness: 'sheets',
    });
  });
});
