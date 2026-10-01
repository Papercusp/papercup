/**
 * claude_session.test.ts — keeps the indexed-session fallback wired into the
 * dev:claude_session read path. Raw JSONL transcripts are disposable, while
 * session_turns remains available to sessions:read; a missing raw metadata row
 * must therefore not become a false "no session found".
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../claude-sessions', () => ({
  listClaudeSessions: vi.fn(),
  searchClaudeSessions: vi.fn(),
  readClaudeSession: vi.fn(),
  allClaudeSessionMetas: vi.fn(),
}));
// The handler only destructures `sql` from getOrgPg(), so the factory hands back just that
// member from a hoisted holder instead of casting a partial OrgPgHandle at the call site.
const orgPg = vi.hoisted((): { sql: unknown } => ({ sql: null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: orgPg.sql })),
}));

import { allClaudeSessionMetas } from '../../claude-sessions';

const allMetasMock = vi.mocked(allClaudeSessionMetas);
const tool = (await import('./claude_session')).default;

type Out = { content: Array<{ text: string }>; isError?: boolean };
const body = (out: Out) => JSON.parse(out.content[0]!.text) as Record<string, any>;

describe('dev:claude_session — indexed fallback', () => {
  it('opts out of the ambient workspace transaction used to dispatch filesystem scans', () => {
    expect((tool as { needsWorkspaceTx?: boolean }).needsWorkspaceTx).not.toBe(true);
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('reads an indexed Claude session when no raw JSONL metadata exists', async () => {
    const sessionId = 'indexed-claude-session-123';
    allMetasMock.mockResolvedValue([]);
    const sql = vi.fn(async () => [
      { turn_idx: 1, speaker: 'assistant', ts: '2026-08-24T10:01:00.000Z', text: 'second turn' },
      { turn_idx: 0, speaker: 'user', ts: '2026-08-24T10:00:00.000Z', text: 'first turn' },
    ]);
    orgPg.sql = sql;

    const out = (await tool.handler(
      { op: 'read', sessionId },
      {
        workspaceId: 'workspace-1',
        get tx(): never { throw new Error('the filesystem read must not retain or use an ambient tx'); },
      } as never,
    )) as Out;
    const result = body(out);

    expect(out.isError).toBeUndefined();
    expect(result).toMatchObject({
      sessionId,
      cwd: null,
      gitBranch: null,
      firstTs: '2026-08-24T10:00:00.000Z',
      lastTs: '2026-08-24T10:01:00.000Z',
      totalRecords: 2,
      truncated: false,
      turns: [
        { i: 0, type: 'user', role: 'user', text: 'first turn' },
        { i: 1, type: 'assistant', role: 'assistant', text: 'second turn' },
      ],
    });
    expect(sql).toHaveBeenCalledTimes(1);
    expect(sql.mock.calls[0]!.slice(1)).toEqual(['workspace-1', sessionId, 201]);
  });
});
