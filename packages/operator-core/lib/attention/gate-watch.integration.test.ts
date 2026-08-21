/**
 * gate-watch.integration.test.ts — tickGateWatch end-to-end against real
 * Postgres + real temp JSONL files (mirrors
 * ingest-claude-transcripts.session-attribution.integration.test.ts's
 * fixture pattern).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const WS = 'ws-gate-watch-test';

const h = vi.hoisted(() => ({ sql: undefined as unknown }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { tickGateWatch } = await import('./gate-watch');
const { listPendingGates } = await import('./gate-store');

let org: OrgTestDb;
let sql: Sql;
const tmpDirs: string[] = [];

const askLine = (id: string, question: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question, options: [{ label: 'yes' }] }] } }] },
  });
const resultLine = (id: string) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
}, 120_000);
afterAll(async () => {
  await org?.cleanup();
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.session_pending_gates WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.session_gate_watcher_files WHERE workspace_id = ${WS}`;
});

describe('tickGateWatch (real PG + real transcript files)', () => {
  it('opens a gate for an unanswered AskUserQuestion, then closes it once the tool_result lands', async () => {
    const uuid = 'cccc3333-dddd-4444-eeee-555566667777';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    const file = path.join(dir, `${uuid}.jsonl`);
    await fs.writeFile(file, askLine('toolu_abc', 'Deploy now?') + '\n');

    const first = await tickGateWatch({ root: dir });
    expect(first.opened).toBe(1);

    let open = await listPendingGates({ workspaceId: WS, sessionId: uuid });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ ref_id: 'toolu_abc', question: 'Deploy now?', source: 'watcher', client: 'claude' });

    // Answer arrives — appended to the SAME file.
    await fs.appendFile(file, resultLine('toolu_abc') + '\n');
    const second = await tickGateWatch({ root: dir });
    expect(second.closed).toBe(1);

    open = await listPendingGates({ workspaceId: WS, sessionId: uuid });
    expect(open).toHaveLength(0);
  });

  it('never surfaces an ask that is answered before the first tick sees it', async () => {
    const uuid = 'dddd4444-eeee-5555-ffff-666677778888';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    await fs.writeFile(path.join(dir, `${uuid}.jsonl`), [askLine('toolu_fast', 'Quick?'), resultLine('toolu_fast')].join('\n') + '\n');

    const result = await tickGateWatch({ root: dir });
    expect(result.opened).toBe(0);
    const open = await listPendingGates({ workspaceId: WS, sessionId: uuid });
    expect(open).toHaveLength(0);
  });

  it('is idempotent across re-ticks with no new content (byte watermark holds)', async () => {
    const uuid = 'eeee5555-ffff-6666-aaaa-777788889999';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    await fs.writeFile(path.join(dir, `${uuid}.jsonl`), askLine('toolu_idem', 'Again?') + '\n');

    const first = await tickGateWatch({ root: dir });
    expect(first.opened).toBe(1);
    const second = await tickGateWatch({ root: dir });
    // No new bytes past the watermark — skipped, not re-opened.
    expect(second.opened).toBe(0);
    expect(second.alreadyOpen).toBe(0);

    const rows = await listPendingGates({ workspaceId: WS, sessionId: uuid, includeClosed: true });
    expect(rows).toHaveLength(1);
  });

  it('ignores a non-gate tool_use entirely', async () => {
    const uuid = 'ffff6666-aaaa-7777-bbbb-888899990000';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    const bashLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } }] },
    });
    await fs.writeFile(path.join(dir, `${uuid}.jsonl`), bashLine + '\n');

    const result = await tickGateWatch({ root: dir });
    expect(result.opened).toBe(0);
    expect(await listPendingGates({ workspaceId: WS, sessionId: uuid })).toHaveLength(0);
  });
});
