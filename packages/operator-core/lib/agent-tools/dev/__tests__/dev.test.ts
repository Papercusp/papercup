/**
 * dev:* tools — 12 tools backing the /dev page.
 *
 * Each tool is a thin projection of a function in lib/dev-data.ts (or
 * lib/omp-sessions.ts for dev:omp_session). Tests mock the underlying
 * lib function and assert the tool's payload shape.
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
    runId: 'r',
    spawnId: 's',
    ...over,
  } as never);

function parsePayload(result: { data?: Record<string, unknown>; content?: Array<{ text: string }> }): Record<string, unknown> {
  if (result.data) return result.data;
  return JSON.parse(result.content![0].text);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../dev-data');
  vi.doUnmock('../../../omp-sessions');
});

// ── dev:activity ────────────────────────────────────────────────────

describe('dev:activity', () => {
  it('returns count + entries from activityFeed', async () => {
    const entries = [
      { id: '1', workspace_id: 'default', harness_slug: 'sheets', tool_name: 'foo', role: null, spawn_id: null, invoked_at: 'now', duration_ms: 10, status: 'ok', error_message: null },
    ];
    vi.doMock('../../../dev-data', () => ({ activityFeed: vi.fn(async () => ({ entries })) }));
    const { default: tool } = await import('../activity');
    const result = await tool.handler({ limit: 50 }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ count: 1, entries });
  });

  it('passes workspaceIds=null when omitted', async () => {
    const mock = vi.fn(async () => ({ entries: [] }));
    vi.doMock('../../../dev-data', () => ({ activityFeed: mock }));
    const { default: tool } = await import('../activity');
    await tool.handler({}, MAKE_CTX());
    expect(mock).toHaveBeenCalledWith({ workspaceIds: null, limit: undefined });
  });
});

// ── dev:audit ───────────────────────────────────────────────────────

describe('dev:audit', () => {
  it('returns count + entries from auditFeed', async () => {
    const entries = [{ id: 'a1', ts: 1, workspace_id: 'default', actor: 'u', action: 'x', subject: 's', details: {} }];
    vi.doMock('../../../dev-data', () => ({ auditFeed: vi.fn(async () => ({ entries })) }));
    const { default: tool } = await import('../audit');
    const result = await tool.handler({ hours: 24 }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ count: 1, entries });
  });
});

// ── dev:build_status ────────────────────────────────────────────────

describe('dev:build_status', () => {
  it('passes through buildStatus output', async () => {
    const data = {
      prodBuild: { exists: true, mtimeMs: 1000 },
      devBuild: { exists: true, mtimeMs: 1000 },
      prodLogTail: null,
      dev3055Reachable: true,
      prod3070Reachable: true,
      awaitable: {
        hint: 'Waiting on a build/deploy? Don\'t re-poll — events:await the deploy or the gate (or use deploy:await / checkpoint:await), then END YOUR TURN. Full list: events:catalog.',
        events: ['release:deployed', 'release:green'],
        sugar: ['deploy:await', 'checkpoint:await'],
      },
    };
    vi.doMock('../../../dev-data', () => ({ buildStatus: vi.fn(async () => data) }));
    const { default: tool } = await import('../build_status');
    const result = await tool.handler({}, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual(data);
  });
});

// ── dev:harnesses ───────────────────────────────────────────────────

describe('dev:harnesses', () => {
  it('returns count + harnesses with health', async () => {
    const harnesses = [
      { slug: 'sheets', path: '/x', workspaceId: 'default', workspaceName: 'Default', health: { ok: true } },
    ];
    vi.doMock('../../../dev-data', () => ({
      listAllHarnessesWithHealth: vi.fn(async () => ({ harnesses })),
    }));
    const { default: tool } = await import('../harnesses');
    const result = await tool.handler({}, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ count: 1, harnesses });
  });

  it('passes workspaceIds when provided', async () => {
    const mock = vi.fn(async () => ({ harnesses: [] }));
    vi.doMock('../../../dev-data', () => ({ listAllHarnessesWithHealth: mock }));
    const { default: tool } = await import('../harnesses');
    await tool.handler({ workspaceIds: ['default', 'ws2'] }, MAKE_CTX());
    expect(mock).toHaveBeenCalledWith(['default', 'ws2']);
  });
});

// ── dev:omp_session ─────────────────────────────────────────────────

describe('dev:omp_session', () => {
  it('mode=find returns matched session', async () => {
    const match = {
      id: '019x',
      filePath: '/tmp/x.jsonl',
      cwd: '/tmp',
      timestamp: '2026-05-11T00:00:00Z',
      title: '',
      matchKind: 'time-only',
      timeDriftMs: 0,
    };
    vi.doMock('../../../omp-sessions', () => ({
      findOmpSessionForSpawn: vi.fn(async () => match),
      readOmpSession: vi.fn(),
    }));
    const { default: tool } = await import('../omp_session');
    const result = await tool.handler({ spawnId: 's', mode: 'find' }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual(match);
  });

  it('mode=find returns error envelope on miss', async () => {
    vi.doMock('../../../omp-sessions', () => ({
      findOmpSessionForSpawn: vi.fn(async () => null),
      readOmpSession: vi.fn(),
    }));
    const { default: tool } = await import('../omp_session');
    const result = await tool.handler({ spawnId: 'unknown', mode: 'find' }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ error: 'no match' });
  });

  it('mode=read returns header + turns', async () => {
    const read = { header: { type: 'session', version: 3, id: 'x', timestamp: 't', cwd: '/c' }, turns: [], totalLines: 1, truncated: false };
    vi.doMock('../../../omp-sessions', () => ({
      findOmpSessionForSpawn: vi.fn(),
      readOmpSession: vi.fn(() => read),
    }));
    const { default: tool } = await import('../omp_session');
    const result = await tool.handler({ filePath: '/tmp/x.jsonl', mode: 'read' }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual(read);
  });

  it('mode=read with spawnId resolves filePath via find', async () => {
    const find = vi.fn(async () => ({ filePath: '/tmp/x.jsonl' }));
    const read = vi.fn(() => ({ header: { type: 'session', version: 3, id: 'x', timestamp: 't', cwd: '/c' }, turns: [], totalLines: 0, truncated: false }));
    vi.doMock('../../../omp-sessions', () => ({ findOmpSessionForSpawn: find, readOmpSession: read }));
    const { default: tool } = await import('../omp_session');
    await tool.handler({ spawnId: 's', mode: 'read' }, MAKE_CTX());
    expect(find).toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith({ filePath: '/tmp/x.jsonl', limit: undefined });
  });
});

// ── dev:pg_health ───────────────────────────────────────────────────

describe('dev:pg_health', () => {
  it('returns pgHealth output', async () => {
    const data = { version: 'PostgreSQL 18', totalConnections: 5, activeConnections: 1, idleConnections: 4 };
    vi.doMock('../../../dev-data', () => ({ pgHealth: vi.fn(async () => data) }));
    const { default: tool } = await import('../pg_health');
    expect(parsePayload((await tool.handler({}, MAKE_CTX())) as never)).toEqual(data);
  });
});

// ── dev:pg_active_queries ───────────────────────────────────────────

describe('dev:pg_active_queries', () => {
  it('returns count + queries', async () => {
    const queries = [{ pid: 1, state: 'active', query: 'SELECT 1', duration_seconds: 0.1, application_name: 'psql', client_addr: '127.0.0.1' }];
    vi.doMock('../../../dev-data', () => ({ pgActiveQueries: vi.fn(async () => ({ queries })) }));
    const { default: tool } = await import('../pg_active_queries');
    expect(parsePayload((await tool.handler({}, MAKE_CTX())) as never)).toEqual({ count: 1, queries });
  });
});

// ── dev:pg_table_sizes ──────────────────────────────────────────────

describe('dev:pg_table_sizes', () => {
  it('returns count + tables', async () => {
    const tables = [{ schema: 'harness_shared', table: 't', total_bytes: 1024, index_bytes: 128, rows_estimate: 10 }];
    vi.doMock('../../../dev-data', () => ({ pgTableSizes: vi.fn(async () => ({ tables })) }));
    const { default: tool } = await import('../pg_table_sizes');
    expect(parsePayload((await tool.handler({}, MAKE_CTX())) as never)).toEqual({ count: 1, tables });
  });

  it('forwards schema arg', async () => {
    const mock = vi.fn(async () => ({ tables: [] }));
    vi.doMock('../../../dev-data', () => ({ pgTableSizes: mock }));
    const { default: tool } = await import('../pg_table_sizes');
    await tool.handler({ schema: 'public', limit: 5 }, MAKE_CTX());
    expect(mock).toHaveBeenCalledWith('public', 5);
  });
});

// ── dev:processes ───────────────────────────────────────────────────

describe('dev:processes', () => {
  it('returns count + processes', async () => {
    const processes = [
      { pid: 1, kind: 'omp', cmdline: 'omp', cwd: '/x', started_seconds_ago: 1, harness_slug: null, workspace_id: null },
    ];
    vi.doMock('../../../dev-data', () => ({ listProcesses: vi.fn(async () => ({ processes })) }));
    const { default: tool } = await import('../processes');
    expect(parsePayload((await tool.handler({}, MAKE_CTX())) as never)).toEqual({ count: 1, processes });
  });

  it('forwards kinds filter', async () => {
    const mock = vi.fn(async () => ({ processes: [] }));
    vi.doMock('../../../dev-data', () => ({ listProcesses: mock }));
    const { default: tool } = await import('../processes');
    await tool.handler({ kinds: ['paperclip'] }, MAKE_CTX());
    expect(mock).toHaveBeenCalledWith({ kinds: ['paperclip'] });
  });
});

// ── dev:session_detail ──────────────────────────────────────────────

describe('dev:session_detail', () => {
  it('returns detail when getSessionDetail succeeds', async () => {
    const detail = { spawn_id: 's', agent: null, invocations: [], children: [], related_chats: [] };
    vi.doMock('../../../dev-data', () => ({ getSessionDetail: vi.fn(async () => detail) }));
    const { default: tool } = await import('../session_detail');
    expect(parsePayload((await tool.handler({ spawnId: 's' }, MAKE_CTX())) as never)).toEqual(detail);
  });

  it('returns error envelope when spawn not found', async () => {
    vi.doMock('../../../dev-data', () => ({ getSessionDetail: vi.fn(async () => null) }));
    const { default: tool } = await import('../session_detail');
    expect(parsePayload((await tool.handler({ spawnId: 'missing' }, MAKE_CTX())) as never)).toEqual({
      error: 'spawn not found',
    });
  });
});

// ── dev:sessions ────────────────────────────────────────────────────

describe('dev:sessions', () => {
  it('returns count + entries', async () => {
    const entries = [{ spawn_id: 's1', parent_spawn_id: null, workspace_id: 'default', harness_slug: null, role: null, run_id: null, coord_owner_id: 'su-abc', started_at: 'now', ended_at: 'now', tool_count: 1, error_count: 0, total_duration_ms: 100 }];
    vi.doMock('../../../dev-data', () => ({ listSessions: vi.fn(async () => ({ entries })) }));
    const { default: tool } = await import('../sessions');
    expect(parsePayload((await tool.handler({}, MAKE_CTX())) as never)).toEqual({ count: 1, entries });
  });
});

// ── dev:resolve_owner ───────────────────────────────────────────────

describe('dev:resolve_owner', () => {
  it('passes the ownerId through and returns the resolution payload', async () => {
    const resolution = {
      owner_id: 'su-5988767d',
      sessions: [
        {
          source: 'adv_sessions',
          owner_id: 'su-5988767d',
          session_id: 'fe9419e7-4430-4248-ab1a-b3ae0b8a1b1f',
          omp_thread_id: null,
          spawn_id: null,
          run_id: null,
          agent: 'claude',
          role: null,
          mode: 'console',
          harness_slug: null,
          plan_slug: null,
          cwd: '/x',
          status: null,
          started_at: 'then',
          ended_at: 'now',
        },
      ],
      activity: [],
    };
    const mock = vi.fn(async () => resolution);
    vi.doMock('../../../dev-data', () => ({ resolveOwnerSessions: mock }));
    const { default: tool } = await import('../resolve_owner');
    const result = await tool.handler({ ownerId: 'su-5988767d' }, MAKE_CTX());
    expect(mock).toHaveBeenCalledWith('su-5988767d');
    expect(parsePayload(result as never)).toEqual(resolution);
  });
});

// ── dev:telemetry ───────────────────────────────────────────────────

describe('dev:telemetry', () => {
  it('returns count + entries', async () => {
    const entries = [{ tool_name: 'x', call_count: 5, error_count: 0, p50_ms: 10, p95_ms: 20, workspaces: ['default'] }];
    vi.doMock('../../../dev-data', () => ({ telemetryRollup: vi.fn(async () => ({ entries })) }));
    const { default: tool } = await import('../telemetry');
    expect(parsePayload((await tool.handler({ hours: 24 }, MAKE_CTX())) as never)).toEqual({ count: 1, entries });
  });
});

// ── dev:tool_cooccurrence ───────────────────────────────────────────

describe('dev:tool_cooccurrence', () => {
  it('returns count + total_spawns + entries', async () => {
    const entries = [
      { tool_a: 'locks:acquire', tool_b: 'locks:release', support: 9, spawns_a: 10, spawns_b: 10, confidence: 0.9, lift: 9 },
    ];
    vi.doMock('../../../dev-data', () => ({ toolCooccurrence: vi.fn(async () => ({ totalSpawns: 100, entries })) }));
    const { default: tool } = await import('../tool_cooccurrence');
    const result = await tool.handler({ hours: 24 }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ count: 1, total_spawns: 100, entries });
  });

  it('forwards args with workspaceIds defaulted to null', async () => {
    const mock = vi.fn(async () => ({ totalSpawns: 0, entries: [] }));
    vi.doMock('../../../dev-data', () => ({ toolCooccurrence: mock }));
    const { default: tool } = await import('../tool_cooccurrence');
    await tool.handler({ minSupport: 5, orderBy: 'lift' }, MAKE_CTX());
    expect(mock).toHaveBeenCalledWith({
      workspaceIds: null,
      hours: undefined,
      minSupport: 5,
      limit: undefined,
      orderBy: 'lift',
    });
  });
});
