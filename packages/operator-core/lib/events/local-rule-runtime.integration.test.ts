/** Real PG restore → shared matching → wearer-authorized execution (P-002). */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
const h = vi.hoisted(() => ({ sql: null as unknown, appUnavailable: false, appReads: 0 }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql, poolLabel: 'org-admin' }),
  withPriorityOrgPg: async (run: () => unknown) => run(),
  withWorkspace: async (_ws: string, fn: (tx: unknown) => unknown) => {
    h.appReads++;
    if (h.appUnavailable) throw new Error('app transaction pool unavailable');
    return fn(h.sql);
  },
}));
// Keep the immutable launch artifact a fixture; revision and local-rule reads
// below use private PostgreSQL, and the native HTTP handler/evaluator are real.
vi.mock('../agent-tools/coordination/control-anchor', async original => ({
  ...(await original<typeof import('../agent-tools/coordination/control-anchor')>()),
  readGateSelectedLaunchSpec: async () => ({}),
}));
vi.mock('../capability-envelope/identity-grants-port', async original => ({
  ...(await original<typeof import('../capability-envelope/identity-grants-port')>()),
  appliedOrCurrentIdentityArtifact: () => ({ inputs: [] }),
}));
vi.mock('../memory/hive-scope', () => ({ resolvePotSlugsForHarnesses: async (_ws: string, harnesses: string[]) => [harnesses[0] === 'demo' ? 'demo' : 'other'] }));
import { defineCapabilityClass } from '../capability-class-registry-store';
import { putLocalRule, recordLocalRuleTest, setLocalRuleEnabled, localRuleSource } from './local-rule-store';
import { matchLocalRules, localReactionPayload, localRuleRegistrationId, readLocalSyncRules } from './local-rule-runtime';
import { evaluateToolGuard } from '../agent-identities/sync-hook-rules';
import { executeIdentityReaction } from './identity-reaction';
import { buildWearerToolContext } from '../agent-identities/wearer-authority';
import { listReactionRules } from './registry';
import type { ToolInvocationEvent } from './types';

let db: OrgTestDb;
const workspaceId = 'ws-local-runtime';
const scope = { workspaceId, potSlug: 'demo' };
const definition = (id: string) => ({ schemaVersion: 1, id, title: id, description: 'Runtime fixture',
  version: '1.0.0', delivery: 'async', on: 'event:demo:*', fire: 'class:demo.tasks@1.0.0#create',
  when: { 'payload.kind': { equals: 'bug' } }, args: { title: 'restored' } });
const event = (key = 'event:demo:done', ws = workspaceId, harness = 'demo'): ToolInvocationEvent => ({
  tool: key, args: { key: key.slice(6), payload: { kind: 'bug' } }, result: { ok: true, data: { kind: 'bug' } },
  ctx: buildWearerToolContext({ workspaceId: ws, ownerId: 'emitter', role: 'su', harnessSlug: harness, capabilities: [], spawnId: 'test' }),
});
beforeAll(async () => {
  db = await createOrgTestDb(); h.sql = db.adminSql;
  await db.adminSql.unsafe(await readFile(new URL('../../../../libs/papercusp/libs/db/sql/1521-locally-authored-rules.sql', import.meta.url), 'utf8'));
  await defineCapabilityClass(db.adminSql, { workspaceId, id: 'demo.tasks', version: '1.0.0', title: 'Tasks',
    description: 'Runtime test class', interfaceVerbs: { create: { capability: 'tasks:create', inputSchema: {}, outputSchema: {} } } });
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

describe('enabled local runtime', () => {
  it('uses the supplied applied harness scope and re-reads current sync rules', async () => {
    const id = 'fresh-sync-scope';
    const row = await putLocalRule({ ...scope, authorId: 'author',
      definition: { schemaVersion: 1, id, title: id, description: 'Runtime fixture', version: '1.0.0',
        delivery: 'sync', sink: 'pre-tool', tools: ['Bash'],
        guard: { deny: { 'input.command': { matches: 'rm -rf' } } } } }, db.adminSql);
    await recordLocalRuleTest(scope, row.id, 1, { passed: true, samples: 1 }, db.adminSql);
    await setLocalRuleEnabled(scope, row.id, true, db.adminSql);

    expect((await readLocalSyncRules('author', workspaceId, 'demo')).rules.map(({ rule }) => rule.id)).toEqual([id]);

    await setLocalRuleEnabled(scope, row.id, false, db.adminSql);
    expect(await readLocalSyncRules('author', workspaceId, 'demo')).toEqual({ rules: [], unreadable: [] });
  });

  it('keeps native sync authority scoped and observes rule disablement immediately', async () => {
    const seeds = [
      { workspaceId, potSlug: 'demo', authorId: 'author', id: 'native-own-pot' },
      { workspaceId, potSlug: null, authorId: 'author', id: 'native-own-workspace' },
      { workspaceId, potSlug: 'demo', authorId: 'someone-else', id: 'native-other-author' },
      { workspaceId, potSlug: 'other', authorId: 'author', id: 'native-other-pot' },
      { workspaceId: 'ws-other-local-runtime', potSlug: 'demo', authorId: 'author', id: 'native-other-workspace' },
    ];
    for (const seed of seeds) {
      await putLocalRule({ ...seed, definition: {
        schemaVersion: 1, id: seed.id, title: seed.id, description: 'Native authority fixture', version: '1.0.0',
        delivery: 'sync', sink: 'pre-tool', tools: ['Bash'],
        guard: { deny: { 'input.command': { matches: 'blocked-local-fixture' } } },
      } }, db.adminSql);
      await recordLocalRuleTest(seed, seed.id, 1, { passed: true, samples: 1 }, db.adminSql);
      await setLocalRuleEnabled(seed, seed.id, true, db.adminSql);
    }
    const currentRules = () => readLocalSyncRules('author', workspaceId, 'demo', {
      signal: new AbortController().signal, deadlineAtMs: performance.now() + 1_000,
    });
    expect((await currentRules()).rules.map(({ rule }) => rule.id).sort())
      .toEqual(['native-own-pot', 'native-own-workspace']);
    const pending = { tool: 'Bash', input: { command: 'blocked-local-fixture' }, client: 'codex' };
    expect(await evaluateToolGuard(pending, currentRules)).toMatchObject({ decision: 'deny' });
    for (const seed of seeds.slice(0, 2)) await setLocalRuleEnabled(seed, seed.id, false, db.adminSql);
    expect(await currentRules()).toEqual({ rules: [], unreadable: [] });
    expect(await evaluateToolGuard(pending, currentRules)).toMatchObject({ decision: 'none' });
  });

  it('restores enabled rows after a fresh module load and executes as the live author', async () => {
    const row = await putLocalRule({ ...scope, authorId: 'author', definition: definition('restore') }, db.adminSql);
    expect(await matchLocalRules(event())).toEqual([]);
    await recordLocalRuleTest(scope, row.id, 1, { passed: true, samples: 1 }, db.adminSql);
    const enabled = await setLocalRuleEnabled(scope, row.id, true, db.adminSql);
    vi.resetModules();
    const restarted = await import('./local-rule-runtime');
    const ev = event();
    const actions = await restarted.matchLocalRules(ev);
    expect(actions.map(a => a.rule.id)).toEqual([localRuleRegistrationId(enabled)]);
    const cause = { depth: 1, chain: [actions[0]!.rule.id], ruleId: actions[0]!.rule.id, rootRunId: ev.ctx.runId };
    const payload = localReactionPayload(ev, cause);
    const target = { classId: 'demo.tasks', classVersion: '1.0.0', classRef: 'demo.tasks@1.0.0', verb: 'create' };
    const dispatch = vi.fn(async () => ({ ok: true }));
    const result = await executeIdentityReaction(payload, { sql: db.adminSql,
      readWearer: async () => ({ ownerId: 'author', workspaceId, role: 'su', harnessSlug: 'demo', revisionTag: 'live',
        rules: { applied: { specificationRevision: 'live', stateRevision: 'live' }, packagePins: [], pins: { rules: [], unreadable: [] }, sync: { rules: [], unreadable: [] }, declaredClassNeeds: null, recall: null } }),
      resolvePot: async () => 'demo', readCeiling: async () => ({ potSlug: 'demo', ceilings: [], protectedAdditions: [] }),
      resolveFire: async () => ({ status: 'resolved', target, tool: 'tasks:create', providerPackage: 'demo', providerVersion: '1.0.0', providerKind: 'tool' }),
      isRegisteredTool: () => true, dispatch });
    expect(result).toMatchObject({ status: 'fired' });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'author', capabilities: ['tasks:create'], args: { title: 'restored' } }));
    const [receipt] = await db.adminSql`SELECT status, contributor FROM harness_shared.event_reactions WHERE dedup_id=${payload.receiptId}`;
    expect(receipt).toMatchObject({ status: 'fired', contributor: localRuleSource(enabled) });
    await setLocalRuleEnabled(scope, row.id, false, db.adminSql);
    expect(await restarted.matchLocalRules(event())).toEqual([]);
    expect(listReactionRules().some(r => r.id === localRuleRegistrationId(enabled))).toBe(false);
  });
  it('serves fresh native guard verdicts over HTTP while the app pool is unavailable', async () => {
    const owner = 'native-http-author';
    const id = 'native-http-local-rule';
    await db.adminSql`INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_state)
      VALUES (${owner}, ${workspaceId}, ${db.adminSql.json({ activation: { applied: {
        specificationRevision: 'native-http-spec', stateRevision: 'native-http-state',
      } }, scope: { harness: 'demo' } })})`;
    await putLocalRule({ ...scope, authorId: owner, definition: {
      schemaVersion: 1, id, title: id, description: 'Native HTTP guard fixture', version: '1.0.0',
      delivery: 'sync', sink: 'pre-tool', tools: ['Read'],
      guard: { deny: { 'input.file_path': { matches: 'blocked-local-http-fixture' } } },
    } }, db.adminSql);
    await recordLocalRuleTest(scope, id, 1, { passed: true, samples: 1 }, db.adminSql);
    await setLocalRuleEnabled(scope, id, true, db.adminSql);
    // The earlier restore case reloads modules. Mirror operator startup on
    // this module generation before calling the real native guard handler.
    const runtime = await import('./local-rule-runtime');
    runtime.startLocalRuleRuntime();
    const { default: routes } = await import('../endpoint-route/routes/agent-mcp/identity-hook-sinks');
    const route = (routes as unknown as Array<{
      path: string; handler: (request: Request) => Promise<Response>;
    }>).find(entry => entry.path === '/agent-mcp/tool-guard')!;
    expect(route).toBeDefined();
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const response = await route.handler(new Request('http://localhost/api/agent-mcp/tool-guard', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks).toString(),
        }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      } catch (error) { res.writeHead(500); res.end(String(error)); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    expect(address && typeof address === 'object').toBe(true);
    const url = `http://127.0.0.1:${(address as { port: number }).port}/api/agent-mcp/tool-guard`;
    const post = async () => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner, workspace: workspaceId, client: 'codex', tool: 'Read',
          input: { file_path: 'blocked-local-http-fixture' } }), signal: AbortSignal.timeout(5_000) });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ ok: boolean; text: string }>;
    };
    h.appReads = 0;
    h.appUnavailable = true;
    try {
      expect(await post()).toEqual({ ok: true,
        text: expect.stringContaining(`rule ${id}:`) });
      await setLocalRuleEnabled(scope, id, false, db.adminSql);
      expect(await post()).toEqual({ ok: true, text: '' });
      expect(h.appReads).toBe(0);
    } finally {
      h.appUnavailable = false;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it('matches event patterns and payloads while isolating workspaces and pots', async () => {
    const d = definition('scoped-runtime');
    await putLocalRule({ ...scope, authorId: 'author', definition: d }, db.adminSql);
    await recordLocalRuleTest(scope, d.id, 1, { passed: true, samples: 1 }, db.adminSql);
    await setLocalRuleEnabled(scope, d.id, true, db.adminSql);
    expect(await matchLocalRules(event('event:other:done'))).toEqual([]);
    expect(await matchLocalRules(event('event:demo:done', 'elsewhere'))).toEqual([]);
    expect(await matchLocalRules(event('event:demo:done', workspaceId, 'elsewhere'))).toEqual([]);
    const miss = event(); miss.args = { payload: { kind: 'task' } };
    expect(await matchLocalRules(miss)).toEqual([]);
    expect(await matchLocalRules(event())).toHaveLength(1);
  });
});
