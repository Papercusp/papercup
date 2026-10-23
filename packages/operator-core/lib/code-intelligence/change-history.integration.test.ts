import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { changeHistoryProviders, coChangeFromCommits, readSymbolProvenance } from './change-history';
import { enrichTaskBriefWithReuse, type TaskBrief, type TaskBriefDeps } from './task-brief';
import graphQuery from '../agent-tools/gitnexus/query';
const holder = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async original => ({ ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: holder.sql }) }));
const source = 'export function work() { return 2; }\n';

describe('P013 invocation/session/work-item SQL join', () => {
  let db: OrgTestDb;
  let root: string;
  const WS = 'test-p013-history', HARNESS = 'history-fixture', OWNER = 'su-history-fixture', SESSION = 'native-history-fixture';
  beforeAll(async () => {
    db = await createOrgTestDb(); root = await mkdtemp(join(tmpdir(), 'provenance-')); await writeFile(join(root, 'a.ts'), source);
    holder.sql = db.adminSql;
    await db.adminSql`INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, session_id, started_at)
      VALUES (${WS}, 'console', ${OWNER}, ${SESSION}, '2026-10-01T00:00:00Z')`;
    await db.adminSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, title, summary, taken_by, taken_at, created_ts, updated_ts)
      VALUES (${WS}, ${HARNESS}, 'WI-recorded-edit', 'feature', 'open', 'fixture', 'fixture', ${OWNER}, '2026-10-02T00:00:00Z', 1, 1)`;
    const args = { session_id: SESSION, tool_name: 'Edit', status: 'ok',
      tool_input: { file_path: 'a.ts', old_string: 'return 1;', new_string: 'return 2;' } };
    await db.adminSql`INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, invoked_at, status, coord_owner_id, args_json)
      VALUES (${WS}, ${HARNESS}, 'papercusp', 'activity:report', 'su', 'spawn-history', 'fixture', '2026-10-10T12:00:00Z', 'ok',
        ${OWNER}, ${db.adminSql.json(args)})`;
  });
  afterAll(async () => { await db?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });
  it('names the expected recorded WI through real migrated tables and excludes other workspaces', async () => {
    const result = await readSymbolProvenance({ workspaceId: WS, harness: HARNESS, root, path: 'a.ts', since: '2026-10-01T00:00:00Z' }, db.adminSql);
    expect(result.symbols[0]).toMatchObject({ status: 'measured', workItem: 'WI-recorded-edit' });
    const other = await readSymbolProvenance({ workspaceId: `${WS}-other`, harness: HARNESS, root, path: 'a.ts', since: '2026-10-01T00:00:00Z' }, db.adminSql);
    expect(other.symbols[0]).toMatchObject({ status: 'unknown', workItem: null });
  });
  it('exposes the same exact join through graph:query and refuses a foreign harness', async () => {
    const args = { op: 'provenance', file_path: 'a.ts', harnesses: [HARNESS], name: 'work' };
    const ctx = { workspaceId: WS, harnessSlug: HARNESS, projectDir: root };
    const result = await graphQuery.handler(args as never, ctx as never) as { data: { symbols: { workItem: string }[] } };
    expect(result.data.symbols[0]?.workItem).toBe('WI-recorded-edit');
    const denied = await graphQuery.handler({ ...args, harnesses: ['foreign'] } as never, ctx as never) as { data: { status: string } };
    expect(denied.data.status).toBe('unknown');
  });
  it('adds recorded provenance and an unanchored co-change through the actual claim adapter', async () => {
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    const sourceVersion = hash(JSON.stringify([['a.ts', hash(source)]]));
    const report = coChangeFromCommits({ end: '2026-10-23T00:00:00Z', paths: ['a.ts'], commit: 'a'.repeat(40), complete: true,
      commits: [1, 2, 3].map(n => ({ sha: String(n), parents: ['parent'], at: `2026-10-0${n}T00:00:00Z`,
        files: [{ status: 'M', path: 'a.ts' }, { status: 'M', path: 'b.ts' }] })) });
    const providers = changeHistoryProviders({ cochange: async () => report, provenance: async () =>
      (await readSymbolProvenance({ workspaceId: WS, harness: HARNESS, root, path: 'a.ts', since: '2026-10-01T00:00:00Z' }, db.adminSql)).symbols });
    const base: TaskBrief = { status: 'current', scope: { harness: HARNESS, paths: ['a.ts'] }, sourceFingerprint: sourceVersion,
      repository: { workspaceId: WS, rootPath: root }, commit: report.commit, files: [{ path: 'a.ts', sha256: hash(source), kind: 'implementation' }],
      excerpts: [], graph: { status: 'measured', consumers: [], relationships: [] }, exclusions: [],
      recover: { tool: 'code:pack', args: { op: 'pack', include: ['a.ts'], rootPath: root } } };
    const append = (brief: TaskBrief, contribution: { text: string }) => ({ ...brief, exclusions: [...brief.exclusions, contribution.text] });
    const observe = vi.fn();
    const deps = { root: async () => root, reuse: { providers,
      adapters: { coChange: append, whatChangedSincePlanning: append }, recordIssued: async () => true } } as unknown as TaskBriefDeps;
    const result = await enrichTaskBriefWithReuse(base, { workspaceId: WS, harness: HARNESS,
      workItem: { id: 'WI-recorded-edit', harness: HARNESS }, reuse: { owner: OWNER, invocation: 'claim-fixture', observe } }, deps, Date.now() + 6000);
    expect(result.files).toEqual(base.files); expect(result.exclusions.join('\n')).toContain('WI-recorded-edit');
    expect(result.exclusions.join('\n')).toContain('Unanchored b.ts');
    expect(observe.mock.calls[0]?.[0].observations.map((row: { status: string }) => row.status)).toEqual(['issued', 'issued']);
  });
});
