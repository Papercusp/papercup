/**
 * cross_harness:* tools — inbox, outbox, supervisor_notes,
 * recent_activity.
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
  vi.doUnmock('../../../cross-harness-data');
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('cross_harness:inbox', () => {
  it('forwards slug + status + role + limit to readInbox', async () => {
    const readInbox = vi.fn(async () => [{ id: 'm1' }]);
    vi.doMock('../../../cross-harness-data', () => ({
      readInbox,
      readOutbox: vi.fn(),
      readSupervisorNotes: vi.fn(),
      readRecentActivity: vi.fn(),
    }));
    const { default: tool } = await import('../inbox');
    const result = await tool.handler(
      { slug: 'sheets', status: 'all', role: 'worker', limit: 50 },
      MAKE_CTX(),
    );
    expect(readInbox).toHaveBeenCalledWith('sheets', {
      status: 'all',
      role: 'worker',
      limit: 50,
    });
    const payload = parsePayload(result as never);
    expect(payload.messages).toEqual([{ id: 'm1' }]);
  });

  it('falls back to ctx.harnessSlug', async () => {
    const readInbox = vi.fn(async () => []);
    vi.doMock('../../../cross-harness-data', () => ({
      readInbox,
      readOutbox: vi.fn(),
      readSupervisorNotes: vi.fn(),
      readRecentActivity: vi.fn(),
    }));
    const { default: tool } = await import('../inbox');
    await tool.handler({}, MAKE_CTX({ harnessSlug: 'fallback' }));
    expect(readInbox).toHaveBeenCalledWith('fallback', expect.any(Object));
  });
});

describe('cross_harness:outbox', () => {
  it('forwards slug + limit to readOutbox', async () => {
    const readOutbox = vi.fn(async () => []);
    vi.doMock('../../../cross-harness-data', () => ({
      readInbox: vi.fn(),
      readOutbox,
      readSupervisorNotes: vi.fn(),
      readRecentActivity: vi.fn(),
    }));
    const { default: tool } = await import('../outbox');
    await tool.handler({ slug: 'sheets', limit: 10 }, MAKE_CTX());
    expect(readOutbox).toHaveBeenCalledWith('sheets', 10);
  });
});

describe('cross_harness:supervisor_notes', () => {
  it('forwards slug + limit to readSupervisorNotes', async () => {
    const readSupervisorNotes = vi.fn(async () => [{ id: 1, body: 'note' }]);
    vi.doMock('../../../cross-harness-data', () => ({
      readInbox: vi.fn(),
      readOutbox: vi.fn(),
      readSupervisorNotes,
      readRecentActivity: vi.fn(),
    }));
    const { default: tool } = await import('../supervisor_notes');
    const result = await tool.handler({ slug: 'sheets', limit: 5 }, MAKE_CTX());
    expect(readSupervisorNotes).toHaveBeenCalledWith('sheets', 5);
    const payload = parsePayload(result as never);
    expect(payload.notes).toEqual([{ id: 1, body: 'note' }]);
  });
});

describe('cross_harness:recent_activity', () => {
  it('forwards limit to readRecentActivity', async () => {
    const readRecentActivity = vi.fn(async () => [{ ts: '2026-05-10T00:00:00Z' }]);
    vi.doMock('../../../cross-harness-data', () => ({
      readInbox: vi.fn(),
      readOutbox: vi.fn(),
      readSupervisorNotes: vi.fn(),
      readRecentActivity,
    }));
    const { default: tool } = await import('../recent_activity');
    const result = await tool.handler({ limit: 25 }, MAKE_CTX());
    expect(readRecentActivity).toHaveBeenCalledWith(25);
    const payload = parsePayload(result as never);
    expect(payload.events).toBeDefined();
  });

  it('default limit is undefined (lib applies its own default)', async () => {
    const readRecentActivity = vi.fn(async () => []);
    vi.doMock('../../../cross-harness-data', () => ({
      readInbox: vi.fn(),
      readOutbox: vi.fn(),
      readSupervisorNotes: vi.fn(),
      readRecentActivity,
    }));
    const { default: tool } = await import('../recent_activity');
    await tool.handler({}, MAKE_CTX());
    expect(readRecentActivity).toHaveBeenCalledWith(undefined);
  });
});
