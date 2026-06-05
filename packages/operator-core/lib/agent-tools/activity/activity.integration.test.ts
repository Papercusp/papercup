/**
 * activity.integration.test.ts — real testcontainer PG for the cross-CLI activity
 * bridge tools (papercusp-worker-integration-2026-06-04, D-003).
 *
 * Exercises the activity:report write + activity:recent read against the real
 * migration-143 table shape (so a column/JSONB drift is caught), the server-side
 * summary derivation, and the NOTIFY agent_activity trigger (the wake-up rail the
 * /api/activity/stream SSE rides).
 *
 * Table+trigger DDL applied inline WITHOUT the GRANTs — the throwaway container has
 * no harness_app/harness_zero roles (the tui-workbench-store integration pattern).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: null as unknown as import('postgres').Sql }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { default: reportTool } = await import('./report');
const { default: recentTool } = await import('./recent');

// A worker ctx (role session) — not superuser, so owner falls back to the explicit
// arg the hook passes. workspaceId pins the row's workspace.
const WORKER_CTX = { isSuperuser: false, role: 'worker', principal: { workspaceId: 'ws-test', slug: 'agent:worker' } } as never;

// Table + the migration-143 NOTIFY trigger, no GRANTs (no roles in the container).
const DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.agent_activity (
    id BIGSERIAL PRIMARY KEY,
    workspace_id text NOT NULL DEFAULT '*',
    owner_id text NOT NULL,
    agent text, session_id text, harness_slug text,
    kind text NOT NULL, tool_name text, phase text, tool_use_id text,
    summary text, status text, detail jsonb, cwd text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE OR REPLACE FUNCTION harness_shared.notify_agent_activity() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
  BEGIN
    PERFORM pg_notify('agent_activity', COALESCE(NEW.workspace_id, '') || '::' || COALESCE(NEW.owner_id, ''));
    RETURN NEW;
  END;
  $fn$;
  DROP TRIGGER IF EXISTS agent_activity_notify_trg ON harness_shared.agent_activity;
  CREATE TRIGGER agent_activity_notify_trg
    AFTER INSERT ON harness_shared.agent_activity
    FOR EACH ROW EXECUTE FUNCTION harness_shared.notify_agent_activity();
`;

async function report(args: Record<string, unknown>, ctx: never = WORKER_CTX) {
  const res = (await reportTool.handler(args as never, ctx)) as { content: { text: string }[]; isError?: boolean };
  return { parsed: JSON.parse(res.content[0]!.text), isError: res.isError };
}
async function recent(args: Record<string, unknown>) {
  const res = (await recentTool.handler(args as never, WORKER_CTX)) as { content: { text: string }[] };
  return JSON.parse(res.content[0]!.text) as { activity: Array<Record<string, unknown>>; count: number };
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('activity');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.agent_activity RESTART IDENTITY');
});

describe('activity:report — write + server-side summary', () => {
  it('inserts an edit with a derived ✎ summary + {file} detail', async () => {
    const { parsed } = await report({
      owner: 'su-w1', agent: 'claude', phase: 'post',
      tool_name: 'Edit', tool_input: { file_path: '/repo/src/gen.ts' },
      session_id: 'sess-1', cwd: '/repo',
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.summary).toBe('✎ gen.ts');

    const rows = await db.sql<Array<Record<string, unknown>>>`SELECT * FROM harness_shared.agent_activity`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: 'ws-test', owner_id: 'su-w1', agent: 'claude',
      kind: 'tool', tool_name: 'Edit', phase: 'post', summary: '✎ gen.ts',
    });
    expect(rows[0]!.detail).toEqual({ file: '/repo/src/gen.ts' });
  });

  it('derives ▶ for a shell call and carries status', async () => {
    const { parsed } = await report({ owner: 'su-w1', tool_name: 'Bash', tool_input: { command: 'npm test' }, status: 'error' });
    expect(parsed.summary).toBe('▶ npm test');
    const rows = await db.sql<Array<{ summary: string; status: string; kind: string }>>`SELECT summary, status, kind FROM harness_shared.agent_activity`;
    expect(rows[0]).toMatchObject({ summary: '▶ npm test', status: 'error', kind: 'tool' });
  });

  it('summarises a TodoWrite snapshot as kind=todos', async () => {
    await report({
      owner: 'su-w1', tool_name: 'TodoWrite',
      todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'Bing' }],
    });
    const rows = await db.sql<Array<{ kind: string; summary: string; detail: { count: number; done: number } }>>`SELECT kind, summary, detail FROM harness_shared.agent_activity`;
    expect(rows[0]!.kind).toBe('todos');
    expect(rows[0]!.summary).toBe('⇄ Bing (1/2)');
    expect(rows[0]!.detail.count).toBe(2);
    expect(rows[0]!.detail.done).toBe(1);
  });

  it('honors an explicit pre-formatted summary over the derived one', async () => {
    const { parsed } = await report({ owner: 'su-w1', tool_name: 'Edit', tool_input: { file_path: '/x.ts' }, summary: 'custom marker' });
    expect(parsed.summary).toBe('custom marker');
  });

  it('falls back to the principal slug when owner is omitted', async () => {
    const { parsed } = await report({ tool_name: 'Read', tool_input: { file_path: '/r.md' } });
    expect(parsed.owner).toBe('agent:worker');
  });
});

describe('activity:recent — read + filters', () => {
  beforeEach(async () => {
    await report({ owner: 'su-a', agent: 'claude', tool_name: 'Edit', tool_input: { file_path: '/a.ts' }, harness_slug: 'papercup' });
    await report({ owner: 'su-a', agent: 'claude', tool_name: 'Bash', tool_input: { command: 'ls' }, harness_slug: 'papercup' });
    await report({ owner: 'su-b', agent: 'codex', tool_name: 'apply_patch', tool_input: { files: ['/b.ts'] }, harness_slug: 'restart' });
    await report({ owner: 'su-a', tool_name: 'TodoWrite', todos: [{ content: 'x', status: 'pending' }] });
  });

  it('returns newest-first by default', async () => {
    const r = await recent({});
    expect(r.count).toBe(4);
    expect(Number(r.activity[0]!.id)).toBeGreaterThan(Number(r.activity[3]!.id));
  });

  it('filters by owner', async () => {
    const r = await recent({ owner: 'su-a' });
    expect(r.count).toBe(3);
    expect(r.activity.every((x) => x.owner_id === 'su-a')).toBe(true);
  });

  it('filters by agent + kind + harness', async () => {
    expect((await recent({ agent: 'codex' })).count).toBe(1);
    expect((await recent({ kind: 'todos' })).count).toBe(1);
    expect((await recent({ harness: 'papercup' })).count).toBe(2);
  });

  it('since_id pages forward oldest-first', async () => {
    const all = await recent({});
    const oldest = Number(all.activity[all.activity.length - 1]!.id);
    const r = await recent({ since_id: oldest });
    expect(r.count).toBe(3);
    // ascending after the cursor
    expect(Number(r.activity[0]!.id)).toBeLessThan(Number(r.activity[2]!.id));
  });

  it('respects limit', async () => {
    expect((await recent({ limit: 2 })).count).toBe(2);
  });
});

describe('activity:recent — numeric id ordering across digit boundaries (regression)', () => {
  // Regression for the silent freeze where `SELECT id::text AS id … ORDER BY id`
  // bound to the TEXT output alias and sorted lexicographically, so once the
  // sequence crossed 999→1000 the read pinned to id 999 forever (lexically
  // "999" > "1000"). Insert explicit ids straddling the boundary and assert true
  // numeric order in BOTH the default-DESC and since_id-ASC branches.
  beforeEach(async () => {
    await db.sql.unsafe(`
      INSERT INTO harness_shared.agent_activity (id, workspace_id, owner_id, kind, summary) VALUES
        (8,    'ws-test', 'su-x', 'tool', 'r8'),
        (9,    'ws-test', 'su-x', 'tool', 'r9'),
        (10,   'ws-test', 'su-x', 'tool', 'r10'),
        (998,  'ws-test', 'su-x', 'tool', 'r998'),
        (999,  'ws-test', 'su-x', 'tool', 'r999'),
        (1000, 'ws-test', 'su-x', 'tool', 'r1000'),
        (1500, 'ws-test', 'su-x', 'tool', 'r1500')
    `);
  });

  it('default read returns the true numeric max first, not lexical "999"', async () => {
    const r = await recent({});
    // The bug returned "999" here (lexical max); the correct head is the numeric max.
    expect(r.activity[0]!.id).toBe('1500');
    const ids = r.activity.map((x) => Number(x.id));
    expect(ids).toEqual([1500, 1000, 999, 998, 10, 9, 8]);
  });

  it('since_id branch pages forward in numeric (not lexical) ascending order', async () => {
    // Lexical asc of "8","9","10","998","999","1000","1500" would lead with "10"/"1000";
    // numeric asc must lead with 9 (first id > 8) and end at 1500.
    const r = await recent({ since_id: 8 });
    const ids = r.activity.map((x) => Number(x.id));
    expect(ids).toEqual([9, 10, 998, 999, 1000, 1500]);
  });
});

describe('migration-143 NOTIFY trigger — the wake-up rail', () => {
  it('fires NOTIFY agent_activity with <workspace_id>::<owner_id> on insert', async () => {
    const got: string[] = [];
    const conn = await db.sql.listen('agent_activity', (payload) => { got.push(payload); });
    try {
      await report({ owner: 'su-notify', tool_name: 'Read', tool_input: { file_path: '/n.md' } });
      // Give the LISTEN/NOTIFY round-trip a moment.
      await new Promise((r) => setTimeout(r, 300));
      expect(got).toContain('ws-test::su-notify');
    } finally {
      await conn.unlisten();
    }
  });
});
