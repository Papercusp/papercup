/**
 * Misc tools — autoloop:status/control, wiki:backlinks, omp:config.
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
  vi.doUnmock('../../autoloop');
  vi.doUnmock('@papercusp/db-org');
  vi.doUnmock('@papercusp/flags/server');
  vi.doUnmock('../../wiki-backlinks');
  vi.doUnmock('../../omp-config');
});

// The status/control tools read harness_shared.routines via getOrgPg().sql —
// stub the tagged-template client to return no schedule routines. PARTIAL mock:
// preserve the real module (esp. `generated`, which the full tool registry pulls
// in transitively via harness/get.ts when these tests load lookupByMcpName /
// dispatchProjectedTool) and override ONLY getOrgPg. A whole-module replacement
// dropped `generated` and crashed registry load.
const mockDbOrgSql = (rows: unknown[] = []) =>
  vi.doMock('@papercusp/db-org', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getOrgPg: () => ({ sql: vi.fn(async () => rows) }),
  }));

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('autoloop:status', () => {
  it('returns fire-state rows with the backoff gate verdict + the schedule routines (P-009/P-010)', async () => {
    const rows = [{ harness_slug: 's', role: 'r', consecutive_errors: 0, last_fired_at: null }];
    vi.doMock('../../autoloop', () => ({
      getAutoLoopState: vi.fn(async () => rows),
      evaluateFireGate: vi.fn(() => ({ allow: true, consecutiveErrors: 0 })),
    }));
    mockDbOrgSql([]);
    const { default: tool } = await import('../autoloop/status');
    const result = await tool.handler({ harnessSlug: 'sheets' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      harnessSlug: 'sheets',
      rows: [{ ...rows[0], gate: { allow: true, consecutiveErrors: 0 } }],
      scheduleRoutines: [],
    });
  });

  it('rejects with precondition_failed when no slug (declarative requires: — D-006)', async () => {
    // The former in-handler `if (!slug) throw` guard is lifted into a
    // `requires:` precondition; the DISPATCHER rejects before the handler runs.
    vi.doMock('../../autoloop', () => ({
      getAutoLoopState: vi.fn(async () => null),
      evaluateFireGate: vi.fn(() => ({ allow: true, consecutiveErrors: 0 })),
    }));
    mockDbOrgSql([]);
    const { default: tool } = await import('../autoloop/status');
    const { lookupByMcpName, dispatchProjectedTool } = await import('@papercusp/tooldef');
    // The tool declares the precondition…
    expect(tool.requires?.[0]?.id).toBe('harness-slug');
    // …and the dispatcher enforces it: no arg, no ctx slug → precondition_failed.
    const projected = lookupByMcpName('autoloop:status');
    expect(projected).toBeDefined();
    const denied = await dispatchProjectedTool(
      projected!,
      'autoloop:status',
      {},
      MAKE_CTX({ harnessSlug: undefined, emit: vi.fn() }),
      {},
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('precondition_failed');
    expect(denied.error?.message).toMatch(/slug required/i);
    // A ctx-scoped slug satisfies it (the handler then runs).
    const allowed = await dispatchProjectedTool(
      projected!,
      'autoloop:status',
      {},
      MAKE_CTX({ emit: vi.fn() }),
      {},
    );
    expect(allowed.ok).toBe(true);
  });
});

describe('autoloop:control', () => {
  it("pause flips the harness's bp-schedule-* routines inactive (durable — P-010)", async () => {
    vi.doMock('../../autoloop', () => ({ resetFireErrors: vi.fn() }));
    mockDbOrgSql([{ name: 'bp-schedule-0' }]);
    const { default: tool } = await import('../autoloop/control');
    const result = await tool.handler({ op: 'pause', harness: 'sheets' }, MAKE_CTX({ role: 'operator' }));
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, op: 'pause', harness: 'sheets', routines: ['bp-schedule-0'] });
  });

  it('resume reports when the blueprint declares no schedule', async () => {
    vi.doMock('../../autoloop', () => ({ resetFireErrors: vi.fn() }));
    mockDbOrgSql([]);
    const { default: tool } = await import('../autoloop/control');
    const result = await tool.handler({ op: 'resume', harness: 'sheets' }, MAKE_CTX({ role: 'operator' }));
    const payload = parsePayload(result as never);
    expect(payload).toMatchObject({ ok: true, op: 'resume', harness: 'sheets', routines: [] });
    expect(String(payload.note)).toMatch(/no bp-schedule/);
  });

  it('reset-errors zeroes the consecutive_errors counters (P-009 circuit reset)', async () => {
    const resetFireErrors = vi.fn(async () => 2);
    vi.doMock('../../autoloop', () => ({ resetFireErrors }));
    mockDbOrgSql([]);
    const { default: tool } = await import('../autoloop/control');
    const result = await tool.handler({ op: 'reset-errors', harness: 'sheets' }, MAKE_CTX({ role: 'operator' }));
    expect(resetFireErrors).toHaveBeenCalledWith('sheets', undefined);
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, op: 'reset-errors', harness: 'sheets', rowsReset: 2 });
  });

  it('exposes operator-only role gate + the harness-slug precondition (D-006)', async () => {
    vi.doMock('../../autoloop', () => ({ resetFireErrors: vi.fn() }));
    mockDbOrgSql([]);
    const { default: tool } = await import('../autoloop/control');
    expect(tool.agentRoles).toEqual(['operator']);
    expect(tool.requires?.[0]?.id).toBe('harness-slug');
  });
});

describe('wiki:backlinks', () => {
  it('forwards target + harness to findWikiBacklinks', async () => {
    const result_fixture = { target: 'doc', harness: null, hits: [] };
    const findWikiBacklinks = vi.fn(async () => result_fixture);
    vi.doMock('../../wiki-backlinks', () => ({ findWikiBacklinks }));
    const { default: tool } = await import('../wiki/backlinks');
    const result = await tool.handler({ target: 'doc' }, MAKE_CTX());
    expect(findWikiBacklinks).toHaveBeenCalledWith('doc', null);
    const payload = parsePayload(result as never);
    expect(payload).toEqual(result_fixture);
  });

  it('passes harness when provided', async () => {
    const findWikiBacklinks = vi.fn(async () => ({ target: '', harness: '', hits: [] }));
    vi.doMock('../../wiki-backlinks', () => ({ findWikiBacklinks }));
    const { default: tool } = await import('../wiki/backlinks');
    await tool.handler({ target: 'd', harness: 'sheets' }, MAKE_CTX());
    expect(findWikiBacklinks).toHaveBeenCalledWith('d', 'sheets');
  });
});

describe('omp:config', () => {
  it('get op returns sections', async () => {
    const sections = [{ name: 's', settings: [] }];
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(async () => sections),
      setOmpConfig: vi.fn(),
      unsetOmpConfig: vi.fn(),
    }));
    const { default: tool } = await import('../omp/config');
    const result = await tool.handler({ op: 'get' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, sections });
  });

  it('set rejects non-operator', async () => {
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(),
      setOmpConfig: vi.fn(),
      unsetOmpConfig: vi.fn(),
    }));
    const { default: tool } = await import('../omp/config');
    await expect(
      tool.handler({ op: 'set', key: 'k', value: 'v' }, MAKE_CTX({ role: 'architect' })),
    ).rejects.toThrow(/operator role/i);
  });

  it('set as operator persists', async () => {
    const setOmpConfig = vi.fn(async () => ({ raw: 'v' }));
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(),
      setOmpConfig,
      unsetOmpConfig: vi.fn(),
    }));
    const { default: tool } = await import('../omp/config');
    const result = await tool.handler(
      { op: 'set', key: 'k', value: 'v' },
      MAKE_CTX({ role: 'operator' }),
    );
    expect(setOmpConfig).toHaveBeenCalledWith('k', 'v');
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, raw: 'v' });
  });

  it('unset op as operator', async () => {
    const unsetOmpConfig = vi.fn(async () => undefined);
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(),
      setOmpConfig: vi.fn(),
      unsetOmpConfig,
    }));
    const { default: tool } = await import('../omp/config');
    const result = await tool.handler(
      { op: 'unset', key: 'k' },
      MAKE_CTX({ role: 'operator' }),
    );
    expect(unsetOmpConfig).toHaveBeenCalledWith('k');
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, unset: true, key: 'k' });
  });
});
