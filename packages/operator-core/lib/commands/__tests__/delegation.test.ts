/**
 * commands/defs/delegation.ts — retired delegate-session history surface.
 *
 * `delegate_to_claude` / `delegate_to_agent` are intentionally absent. The
 * remaining `delegates.*` queries only read historical records.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listDelegatedSessions: vi.fn(async (_opts: { status?: string; limit?: number }) => [] as unknown[]),
  getDelegatedSession: vi.fn(async (_ref: string) => null as unknown),
  searchDelegatedSessions: vi.fn(async (_q: string, _limit?: number) => [] as unknown[]),
}));

vi.mock('../../delegated-tasks', () => ({
  listDelegatedSessions: h.listDelegatedSessions,
  getDelegatedSession: h.getDelegatedSession,
  searchDelegatedSessions: h.searchDelegatedSessions,
}));

import '../defs/delegation';
import { get, runQuery } from '../registry';
import type { CommandContext } from '../types';

const ctx = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  agent: 'operator',
  workspace: 'default',
  requestId: 'r-1',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registration surface', () => {
  it('registers the historical delegate queries for oracle + operator', () => {
    for (const id of ['delegates.list', 'delegates.get', 'delegates.search']) {
      const def = get(id);
      expect(def, `${id} registered`).toBeTruthy();
      expect(def!.kind).toBe('query');
      expect(def!.tier).toBe('fast-query');
      expect(def!.agents).toEqual(['oracle', 'operator']);
    }
  });

  it('does not register retired delegate launch commands', () => {
    expect(get('delegate_to_claude')).toBeUndefined();
    expect(get('delegate_to_agent')).toBeUndefined();
  });
});

describe('delegates.* queries', () => {
  it('delegates.list applies defaults and wraps rows as { sessions }', async () => {
    const rows = [{ id: 1, title: 'A' }];
    h.listDelegatedSessions.mockResolvedValueOnce(rows);
    const r = await runQuery('delegates.list', {}, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ sessions: rows });
    expect(h.listDelegatedSessions).toHaveBeenCalledWith({ status: 'open', limit: 20 });
  });

  it('delegates.list passes explicit filters through to the session store', async () => {
    await runQuery('delegates.list', { status: 'archived', limit: 5 }, ctx());
    expect(h.listDelegatedSessions).toHaveBeenCalledWith({ status: 'archived', limit: 5 });
  });

  it('delegates.list validates filter args before the handler runs', async () => {
    for (const args of [{ limit: 0 }, { limit: 51 }, { status: 'running' }]) {
      const r = await runQuery('delegates.list', args, ctx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid-args');
    }
    expect(h.listDelegatedSessions).not.toHaveBeenCalled();
  });

  it('delegates.list is denied to agents outside its allowlist', async () => {
    const r = await runQuery('delegates.list', {}, ctx({ agent: 'pi' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('denied');
    expect(h.listDelegatedSessions).not.toHaveBeenCalled();
  });

  it('delegates.get requires an id and wraps the row as { session }', async () => {
    const missing = await runQuery('delegates.get', {}, ctx());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('invalid-args');

    const row = { id: 7, title: 'Auth refactor' };
    h.getDelegatedSession.mockResolvedValueOnce(row);
    const r = await runQuery('delegates.get', { id: 'abc-123' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ session: row });
    expect(h.getDelegatedSession).toHaveBeenCalledWith('abc-123');
  });

  it('delegates.get surfaces an unknown ref as { session: null }', async () => {
    h.getDelegatedSession.mockResolvedValueOnce(null);
    const r = await runQuery('delegates.get', { id: 'nope' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ session: null });
  });

  it('delegates.search routes query and limit to the session store', async () => {
    const rows = [{ id: 2, title: 'B' }];
    h.searchDelegatedSessions.mockResolvedValue(rows);
    const r = await runQuery('delegates.search', { query: 'needle', limit: 3 }, ctx({ agent: 'oracle' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ sessions: rows });
    expect(h.searchDelegatedSessions).toHaveBeenCalledWith('needle', 3);

    await runQuery('delegates.search', { query: 'needle' }, ctx());
    expect(h.searchDelegatedSessions).toHaveBeenLastCalledWith('needle', 10);
  });
});
