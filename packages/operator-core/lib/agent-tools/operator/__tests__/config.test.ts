/**
 * operator:* config tools — budget, paused, trigger_state, preferences,
 * multi_workspace, credentials_status.
 *
 * All read/write operator-config surfaces. Most have an in-handler
 * role check for the write path while reads are any-role.
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
  vi.doUnmock('../../../operator-budget');
  vi.doUnmock('../../../device-operator-actions');
  vi.doUnmock('../../../operator-trigger-state');
  vi.doUnmock('../../../operator-preferences');
  vi.doUnmock('../../../operator-multi-workspace');
  vi.doUnmock('../../../voice-credentials');
  vi.doUnmock('../../../workspace-registry');
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('operator:budget', () => {
  it('get returns checkBudget shape', async () => {
    vi.doMock('../../../operator-budget', () => ({
      checkBudget: vi.fn(async () => ({
        state: { spend: [{ usd: 1.0, date: '2026-05-09' }] },
        capUsd: 20,
        todaySpendUsd: 0.5,
        exceeded: false,
      })),
      setBudget: vi.fn(),
    }));
    const { default: tool } = await import('../budget');
    const result = await tool.handler({ op: 'get' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      configured: true,
      dailyCapUsd: 20,
      todaySpendUsd: 0.5,
      exceeded: false,
      spendHistory: [{ usd: 1.0, date: '2026-05-09' }],
    });
  });

  it('set rejects non-operator role at the handler level', async () => {
    vi.doMock('../../../operator-budget', () => ({
      checkBudget: vi.fn(),
      setBudget: vi.fn(),
    }));
    const { default: tool } = await import('../budget');
    await expect(
      tool.handler({ op: 'set', dailyCapUsd: 99 }, MAKE_CTX({ role: 'architect' })),
    ).rejects.toThrow(/operator role/i);
  });

  it('set as operator persists the new cap', async () => {
    const setBudget = vi.fn(async (cap: number) => ({ dailyCapUsd: cap }));
    vi.doMock('../../../operator-budget', () => ({
      checkBudget: vi.fn(),
      setBudget,
    }));
    const { default: tool } = await import('../budget');
    const result = await tool.handler(
      { op: 'set', dailyCapUsd: 50 },
      MAKE_CTX({ role: 'operator' }),
    );
    expect(setBudget).toHaveBeenCalledWith(50);
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, dailyCapUsd: 50 });
  });
});

describe('operator:paused', () => {
  it('reads pause sentinel', async () => {
    vi.doMock('../../../device-operator-actions', () => ({
      isPaused: vi.fn(async () => true),
    }));
    const { default: tool } = await import('../paused');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ paused: true });
  });
});

describe('operator:trigger_state', () => {
  it('returns fingerprint + state', async () => {
    const stateFixture = { unconsumedEvents: 0, projects: [] };
    vi.doMock('../../../operator-trigger-state', () => ({
      readTriggerState: vi.fn(async () => stateFixture),
      fingerprint: vi.fn(() => 'abc123'),
    }));
    const { default: tool } = await import('../trigger_state');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ fingerprint: 'abc123', state: stateFixture });
  });
});

describe('operator:preferences', () => {
  it('list returns entries', async () => {
    const entries = [{ key: 'k1', body: 'b1' }];
    vi.doMock('../../../operator-preferences', () => ({
      listPreferenceEntries: vi.fn(async () => entries),
      appendPreferenceEntry: vi.fn(),
      removePreferenceEntry: vi.fn(),
    }));
    const { default: tool } = await import('../preferences');
    const result = await tool.handler({ op: 'list' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ entries });
  });

  it('append rejects worker', async () => {
    vi.doMock('../../../operator-preferences', () => ({
      listPreferenceEntries: vi.fn(),
      appendPreferenceEntry: vi.fn(),
      removePreferenceEntry: vi.fn(),
    }));
    const { default: tool } = await import('../preferences');
    await expect(
      tool.handler({ op: 'append', entry: 'x' }, MAKE_CTX({ role: 'worker', chunkId: 'ck' })),
    ).rejects.toThrow(/operator, architect, or mug/i);
  });

  it('append as queen persists (operator-equivalent, EI-2204)', async () => {
    const appendPreferenceEntry = vi.fn(async () => undefined);
    vi.doMock('../../../operator-preferences', () => ({
      listPreferenceEntries: vi.fn(),
      appendPreferenceEntry,
      removePreferenceEntry: vi.fn(),
    }));
    const { default: tool } = await import('../preferences');
    const result = await tool.handler(
      { op: 'append', entry: 'a queen pref' },
      MAKE_CTX({ role: 'mug' }),
    );
    expect(appendPreferenceEntry).toHaveBeenCalledWith('a queen pref');
    const payload = parsePayload(result as never);
    expect(payload.ok).toBe(true);
  });

  it('append as architect persists', async () => {
    const appendPreferenceEntry = vi.fn(async () => undefined);
    vi.doMock('../../../operator-preferences', () => ({
      listPreferenceEntries: vi.fn(),
      appendPreferenceEntry,
      removePreferenceEntry: vi.fn(),
    }));
    const { default: tool } = await import('../preferences');
    const result = await tool.handler(
      { op: 'append', entry: 'a new pref' },
      MAKE_CTX({ role: 'architect' }),
    );
    expect(appendPreferenceEntry).toHaveBeenCalledWith('a new pref');
    const payload = parsePayload(result as never);
    expect(payload.ok).toBe(true);
  });

  it('remove returns ok=removed-bool', async () => {
    vi.doMock('../../../operator-preferences', () => ({
      listPreferenceEntries: vi.fn(),
      appendPreferenceEntry: vi.fn(),
      removePreferenceEntry: vi.fn(async () => false),
    }));
    const { default: tool } = await import('../preferences');
    const result = await tool.handler(
      { op: 'remove', key: 'missing' },
      MAKE_CTX({ role: 'operator' }),
    );
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: false, key: 'missing' });
  });
});

describe('operator:multi_workspace', () => {
  it('returns readMultiWorkspaceSnapshot output', async () => {
    const snap = { cards: [], workspaces: [{ id: 'a', name: 'A' }] };
    vi.doMock('../../../operator-multi-workspace', () => ({
      readMultiWorkspaceSnapshot: vi.fn(async () => snap),
    }));
    vi.doMock('../../../workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    const { default: tool } = await import('../multi_workspace');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual(snap);
  });
});

describe('operator:credentials_status', () => {
  it('returns masked-only status for each provider', async () => {
    vi.doMock('../../../voice-credentials', () => ({
      maskKey: vi.fn((k: string | null) => (k ? `masked:${k.slice(-4)}` : null)),
      readElevenLabsKey: vi.fn(async () => 'sk_xxx_abcd'),
      readOpenAiKey: vi.fn(async () => 'sk_yyy_efgh'),
      readCartesiaKey: vi.fn(async () => null),
      readDeepgramKey: vi.fn(async () => null),
      readPicovoiceKey: vi.fn(async () => null),
    }));
    const { default: tool } = await import('../credentials_status');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect((payload.elevenlabs as Record<string, unknown>).set).toBe(true);
    expect((payload.elevenlabs as Record<string, unknown>).masked).toBe('masked:abcd');
    expect((payload.cartesia as Record<string, unknown>).set).toBe(false);
    expect((payload.cartesia as Record<string, unknown>).masked).toBeNull();
  });

  it('never returns raw key strings', async () => {
    vi.doMock('../../../voice-credentials', () => ({
      maskKey: vi.fn(() => 'sk_••••1234'),
      readElevenLabsKey: vi.fn(async () => 'RAW_SECRET_DO_NOT_LEAK'),
      readOpenAiKey: vi.fn(async () => null),
      readCartesiaKey: vi.fn(async () => null),
      readDeepgramKey: vi.fn(async () => null),
      readPicovoiceKey: vi.fn(async () => null),
    }));
    const { default: tool } = await import('../credentials_status');
    const result = await tool.handler({}, MAKE_CTX());
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).not.toContain('RAW_SECRET_DO_NOT_LEAK');
  });
});
