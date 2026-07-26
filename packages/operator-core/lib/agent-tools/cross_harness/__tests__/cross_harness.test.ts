/**
 * cross_harness:* tools — supervisor_notes, recent_activity.
 *
 * (inbox/outbox retired as part of the work-item mail surface retirement —
 * plan retire-work-item-mail-surface-2026-07-26 P-002.)
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

// supervisor_notes/recent_activity both return the canonical { data } shape
// (definetool-token-optimization P-003 migration, WI-5170) — a direct .handler() call
// (bypassing the wire-encoding path) gets the raw { data } object, not a { content } envelope.
function parseEnvelope(result: { data: unknown }): Record<string, unknown> {
  return result.data as Record<string, unknown>;
}

describe('cross_harness:supervisor_notes', () => {
  it('forwards slug + limit to readSupervisorNotes', async () => {
    const readSupervisorNotes = vi.fn(async () => [{ id: 1, body: 'note' }]);
    vi.doMock('../../../cross-harness-data', () => ({
      readSupervisorNotes,
      readRecentActivity: vi.fn(),
    }));
    const { default: tool } = await import('../supervisor_notes');
    const result = await tool.handler({ slug: 'sheets', limit: 5 }, MAKE_CTX());
    expect(readSupervisorNotes).toHaveBeenCalledWith('sheets', 5);
    const payload = parseEnvelope(result as never);
    expect(payload.notes).toEqual([{ id: 1, body: 'note' }]);
  });
});

describe('cross_harness:recent_activity', () => {
  it('forwards limit to readRecentActivity', async () => {
    const readRecentActivity = vi.fn(async () => [{ ts: '2026-05-10T00:00:00Z' }]);
    vi.doMock('../../../cross-harness-data', () => ({
      readSupervisorNotes: vi.fn(),
      readRecentActivity,
    }));
    const { default: tool } = await import('../recent_activity');
    const result = await tool.handler({ limit: 25 }, MAKE_CTX());
    expect(readRecentActivity).toHaveBeenCalledWith(25);
    const payload = parseEnvelope(result as never);
    expect(payload.events).toBeDefined();
  });

  it('default limit is undefined (lib applies its own default)', async () => {
    const readRecentActivity = vi.fn(async () => []);
    vi.doMock('../../../cross-harness-data', () => ({
      readSupervisorNotes: vi.fn(),
      readRecentActivity,
    }));
    const { default: tool } = await import('../recent_activity');
    await tool.handler({}, MAKE_CTX());
    expect(readRecentActivity).toHaveBeenCalledWith(undefined);
  });
});
