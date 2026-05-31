/**
 * Tests for device-feeds. Mocks @papercusp/db-org so we can verify the
 * workspace-scoping contract and SQL shape without a live database.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

type Captured = { strings: TemplateStringsArray; values: unknown[] };
const captured: Captured[] = [];
const queue: unknown[][] = [];

function makeTx() {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    captured.push({ strings, values });
    return Promise.resolve(queue.shift() ?? []);
  };
}

vi.mock('@papercusp/db-org', () => ({
  withWorkspace: vi.fn(async (workspaceId: string, fn: (tx: any) => Promise<unknown>) => {
    (globalThis as any).__lastWorkspaceId = workspaceId;
    return fn(makeTx());
  }),
}));

import { recentToasts, recentAuditEntries, currentlyRunning, lastActivityAt } from './device-feeds';

beforeEach(() => {
  captured.length = 0;
  queue.length = 0;
  delete (globalThis as any).__lastWorkspaceId;
});

describe('recentToasts', () => {
  it('passes workspaceId to withWorkspace and returns rows', async () => {
    queue.push([
      { id: 1, level: 'info', message: 'hi', description: null, harness_slug: null,
        created_at: 1, action_label: null, action_href: null },
    ]);
    const rows = await recentToasts('ws-A', 25);
    expect((globalThis as any).__lastWorkspaceId).toBe('ws-A');
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('hi');
    expect(captured).toHaveLength(1);
    expect(captured[0].values).toEqual([25]);
    expect(captured[0].strings.join('?')).toContain('FROM harness_shared.toast_log');
    expect(captured[0].strings.join('?')).toContain('ORDER BY created_at DESC');
  });

  it('defaults limit to 50', async () => {
    queue.push([]);
    await recentToasts('ws-B');
    expect(captured[0].values).toEqual([50]);
  });
});

describe('recentAuditEntries', () => {
  it('queries audit_log with workspaceId scope and limit', async () => {
    queue.push([
      { id: 'a1', ts: 1, actor: 'op', action: 'scan', subject: 'h', details: {} },
    ]);
    const rows = await recentAuditEntries('ws-X', 10);
    expect((globalThis as any).__lastWorkspaceId).toBe('ws-X');
    expect(rows[0].id).toBe('a1');
    expect(captured[0].values).toEqual([10]);
    expect(captured[0].strings.join('?')).toContain('FROM harness_shared.audit_log');
  });
});

describe('lastActivityAt', () => {
  it('returns the GREATEST(audit, toast) timestamp', async () => {
    queue.push([{ ts: 1700000000 }]);
    expect(await lastActivityAt('ws-A')).toBe(1700000000);
    expect((globalThis as any).__lastWorkspaceId).toBe('ws-A');
    expect(captured[0].strings.join('?')).toContain('GREATEST');
  });
  it('returns null when ts is 0 (no activity)', async () => {
    queue.push([{ ts: 0 }]);
    expect(await lastActivityAt('ws-empty')).toBeNull();
  });
  it('returns null when no row', async () => {
    queue.push([]);
    expect(await lastActivityAt('ws-?')).toBeNull();
  });
});

describe('currentlyRunning', () => {
  it('returns null scan + empty harnesses when nothing is running', async () => {
    queue.push([]); // scans
    queue.push([]); // harnesses
    queue.push([]); // lanes
    const out = await currentlyRunning('ws-Y');
    expect(out.scan).toBeNull();
    expect(out.harnesses).toEqual([]);
  });

  it('returns the most recent unfinished scan + active harnesses with merged roles', async () => {
    queue.push([{ id: 7, started_at: 1000, request_text: 'scan all', cost_usd: 0.42 }]);
    queue.push([
      { harness_slug: 'h1', phase: 'staging', status: 'iterating', iteration: 2,
        total_features: 5, passed_count: 3, todo_count: 1, blocked_count: 0,
        last_active_ts: 999 },
      { harness_slug: 'h2', phase: 'production', status: 'planning', iteration: 1,
        total_features: 2, passed_count: 0, todo_count: 2, blocked_count: 0,
        last_active_ts: null },
    ]);
    queue.push([
      { harness_slug: 'h1', phase: 'staging', role: 'worker' },
      { harness_slug: 'h1', phase: 'staging', role: 'reviewer' },
      { harness_slug: 'h2', phase: 'production', role: 'planner' },
      // unrelated lane shouldn't show up
      { harness_slug: 'h3', phase: 'staging', role: 'worker' },
    ]);

    const out = await currentlyRunning('ws-Z');
    expect(out.scan?.id).toBe(7);
    expect(out.scan?.request_text).toBe('scan all');
    expect(out.harnesses).toHaveLength(2);
    const h1 = out.harnesses.find((h) => h.harness_slug === 'h1')!;
    expect(h1.active_roles.sort()).toEqual(['reviewer', 'worker']);
    const h2 = out.harnesses.find((h) => h.harness_slug === 'h2')!;
    expect(h2.active_roles).toEqual(['planner']);
  });

  it('emits empty active_roles when no lanes match', async () => {
    queue.push([]); // no scan
    queue.push([
      { harness_slug: 'lonely', phase: 'staging', status: 'running', iteration: 1,
        total_features: 1, passed_count: 0, todo_count: 1, blocked_count: 0,
        last_active_ts: null },
    ]);
    queue.push([]); // no lanes

    const out = await currentlyRunning('ws-Q');
    expect(out.harnesses[0].active_roles).toEqual([]);
  });
});
