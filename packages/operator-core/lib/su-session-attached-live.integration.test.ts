/** Opt-in acceptance against the current source, real SU bootstrap and engine.
 * Creates one named test conversation in the selected project and archives it.
 * No UI/PTY is launched. Provider tokens are spent only with the explicit flag;
 * backend is Claude, model defaults to explicitly pinned `sonnet` (PUI D-012),
 * and account defaults to `auto` so the gateway can choose from its provider pool.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAdaptorServer } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA, type SuSessionEvent } from '@papercusp/chat-protocol';
import { confirmedProviderRateLimit } from './su-session-attached-live-rate-limit';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';

describe.skipIf(process.env.PAPERCUSP_REAL_ATTACHED_ENGINE !== '1')('live attached SU engine', () => {
  let db: OrgTestDb | undefined;
  let fixture: BaselineCoordFixture | undefined;
  let server: ReturnType<typeof createAdaptorServer> | undefined;
  let home: string | undefined;
  let previousEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const account = process.env.PAPERCUSP_ATTACHED_TEST_ACCOUNT?.trim() || 'auto';
    const catalogPath = process.env.PUI_NATIVE_ACCOUNT_CATALOG;
    const accounts = account === 'auto' ? (() => {
      if (!catalogPath) throw new Error('Attached auto-route acceptance requires PUI_NATIVE_ACCOUNT_CATALOG');
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as { accounts?: unknown };
      if (!Array.isArray(catalog.accounts) || !catalog.accounts.length) throw new Error('Attached account catalog is empty');
      return catalog.accounts.map((entry: { id?: string; provider?: string }) => {
        if (!entry.id || !/^[A-Za-z0-9._-]+$/.test(entry.id) || !['claude', 'codex'].includes(entry.provider ?? '')) {
          throw new Error('Attached account catalog needs valid id/provider metadata');
        }
        return { id: entry.id, provider: entry.provider, credentialRef: '', addedAt: 0, boundTo: [] };
      });
    })() : [];
    db = await createOrgTestDb();
    if (account === 'auto') await db.adminSql`
      INSERT INTO harness_shared.operator_account_pool (workspace_id, payload, updated_at)
      VALUES ('papercusp-workspace', ${JSON.stringify({ accounts })}::text::jsonb, ${Date.now()})
      ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`;
    home = mkdtempSync(join(tmpdir(), 'pui-attached-live-'));
    const privateHome = join(home, '.papercusp');
    mkdirSync(privateHome, { recursive: true });
    writeFileSync(join(privateHome, 'superuser-token'), randomBytes(32).toString('base64url'), { mode: 0o600 });
    const env = {
      PAPERCUSP_HOME: privateHome, DATABASE_URL: db.adminDsn,
      PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace',
      PAPERCUSP_WORKSPACES_ROOT: join(home, 'workspaces'),
      PAPERCUSP_LAUNCH_CONTEXT_DIR: join(home, 'launch-context'),
      PAPERCUSP_SU_CODEX_HOMES_DIR: join(home, 'native-codex'),
      PAPERCUSP_SU_OMP_HOMES_DIR: join(home, 'native-omp'),
      PAPERCUSP_SESSION_CLAUDE_DIR: join(home, 'native-claude'),
      PAPERCUSP_SESSION_MCP_DIR: join(home, 'native-mcp'),
      PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_DBOS_ENABLE: '0',
      PAPERCUSP_MEMORY_EMBEDDER: 'disabled', PAPERCUSP_SERVE_UI: '0',
    };
    previousEnv = Object.fromEntries([...Object.keys(env), 'HARNESS_DATABASE_URL',
      'HARNESS_ADMIN_DATABASE_URL', 'PAPERCUSP_HONO_PORT', 'PAPERCUSP_OPERATOR_URL',
      'PAPERCUSP_MCP_PROXY_BASE'].map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    fixture = await setupBaselineCoordFixture({ dsn: db.adminDsn });
    const harness = process.env.PAPERCUSP_ATTACHED_TEST_HARNESS ?? 'papercusp';
    const { saveHarnessRegistry } = await import('./harness-registry');
    await saveHarnessRegistry({ projects: [{ slug: harness, path: resolve(import.meta.dirname, '../../..'),
      harness_kind: 'hive', self_repo: true }] }, 'papercusp-workspace');
    const { scaffoldHarnessSchema } = await import('./scaffold-harness-schema');
    await scaffoldHarnessSchema(harness);
    const { app } = await import('../../../apps/operator/bin/host-app');
    server = createAdaptorServer({ fetch: app.fetch });
    await new Promise<void>((done, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', done);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Private attached test operator has no port');
    expect([3070, 3170, 3271, 3278]).not.toContain(address.port);
    const origin = `http://127.0.0.1:${address.port}`;
    Object.assign(process.env, { PAPERCUSP_HONO_PORT: String(address.port),
      PAPERCUSP_OPERATOR_URL: origin, PAPERCUSP_MCP_PROXY_BASE: origin });
  }, 180_000);

  afterAll(async () => {
    try {
      if (server) await new Promise<void>((done, reject) => {
        server!.close(error => error ? reject(error) : done());
        server!.closeAllConnections();
      });
    } finally {
      await fixture?.dispose();
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await db?.cleanup();
      if (home) rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates through launch-su, commits an owner turn, proves scoped SU tools, and ends the child', async (ctx) => {
    const [{ createChat, archiveChat, getChat }, { default: launchRoutes }, { suSessionRoutes }, { getRegisteredSuSessionHost }, { readSuperuserToken }, { activeWorkspaceId }, { readDurableSuSession }] = await Promise.all([
      import('./agent-chats-data'), import('./endpoint-route/routes/adv/launch-su'),
      import('./endpoint-route/routes/agent-chats/su-session'), import('./su-session-host'),
      import('./superuser-token'), import('./workspace-registry'), import('./su-session-persistence'),
    ]);
    const harness = process.env.PAPERCUSP_ATTACHED_TEST_HARNESS ?? 'papercusp';
    const backend = 'claude' as const;
    const model = process.env.PAPERCUSP_ATTACHED_TEST_MODEL?.trim() || 'sonnet';
    const account = process.env.PAPERCUSP_ATTACHED_TEST_ACCOUNT?.trim() || 'auto';
    const workspaceId = activeWorkspaceId();
    const created = await createChat({ slug: harness, role: 'operator', title: `PUI attached acceptance ${randomUUID()}` });
    expect(created.ok, !created.ok ? created.error : '').toBe(true);
    if (!created.ok) return;
    const chatId = created.data.id;
    const key = { workspaceId, harnessSlug: harness, agentChatId: chatId };
    const headers = { 'content-type': 'application/json', host: 'localhost', authorization: `Bearer ${readSuperuserToken()}` };
    const context = { params: { slug: harness, chatId } } as never;
    let host: ReturnType<typeof getRegisteredSuSessionHost>;
    let engineTaskId: string | undefined;
    let iterator: AsyncIterator<{ id: number; event: SuSessionEvent }> | undefined;
    try {
      const response = await launchRoutes.find((route) => route.method === 'POST')!.handler(new Request(
        'http://localhost/api/adv/sessions/launch-su', {
          method: 'POST', headers,
          body: JSON.stringify({ agent: backend, attached_engine: true, agent_chat_id: chatId,
            harness_slug: harness, model, account, carry: 'warm' }),
        }), context);
      const launched = await response.json() as { status: string; transport?: string; advSessionId: number; ownerId?: string };
      expect(response.status, JSON.stringify(launched)).toBe(200);
      expect(launched).toMatchObject({ status: 'ok', transport: 'structured' });
      const advSessionId = launched.advSessionId;
      const durable = await readDurableSuSession({ workspaceId, agentChatId: chatId });
      expect(durable).toMatchObject({ advSessionId, agentChatId: chatId, backend, harnessSlug: harness });
      host = getRegisteredSuSessionHost(key);
      if (!host) throw new Error('No live host after attached launch');
      const readyDeadline = Date.now() + 120_000;
      while (Date.now() < readyDeadline) {
        const snapshot = host.snapshot();
        if (snapshot.terminal) {
          const events = host.recent.map((entry) => entry.event);
          const rateLimit = confirmedProviderRateLimit(events);
          if (rateLimit.confirmed) {
            ctx.skip(`NOT MEASURED: provider account limit during engine startup (${rateLimit.signals[0]})`);
          }
          const failures = events.flatMap((event) => event.type === 'error' ? [`${event.code}: ${event.message}`] : []);
          throw new Error(`Attached ${backend} engine ended before ready: lifecycle=${host.descriptor().lifecycle}; errors=${JSON.stringify(failures)}; snapshot=${JSON.stringify(snapshot)}`);
        }
        if (snapshot.executorAttached && snapshot.streamReady) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const readySnapshot = host.snapshot();
      if (!readySnapshot.executorAttached || !readySnapshot.streamReady || readySnapshot.terminal) {
        const events = host.recent.map((entry) => entry.event);
        const rateLimit = confirmedProviderRateLimit(events);
        if (rateLimit.confirmed) {
          ctx.skip(`NOT MEASURED: provider account limit during engine startup (${rateLimit.signals[0]})`);
        }
        const failures = events.flatMap((event) => event.type === 'error' ? [`${event.code}: ${event.message}`] : []);
        throw new Error(`Attached ${backend} engine did not become ready in 120s: lifecycle=${host.descriptor().lifecycle}; errors=${JSON.stringify(failures)}; snapshot=${JSON.stringify(readySnapshot)}`);
      }
      const identity = host.descriptor().identity;
      expect(identity).toMatchObject({ workspaceId, harnessSlug: harness, ownerId: launched.ownerId });
      expect(identity.nativeSessionId).toBeTruthy();
      const actualModel = host.descriptor().model;
      expect(actualModel, 'the native engine must identify the model that will answer').toBeTruthy();
      expect(host.descriptor().accountRoute).toBe(account);
      const { listTasks } = await import('./task-manager/store');
      const tasks = await listTasks({ workspaceId, sessionId: identity.nativeSessionId!, coordOwnerId: identity.ownerId, classes: ['agent-session'] });
      expect(tasks).toHaveLength(1);
      engineTaskId = tasks[0].taskId;
      expect(tasks[0].argv.length).toBeGreaterThan(0);
      const modelFlag = tasks[0].argv.indexOf('--model');
      expect(modelFlag, 'the real native launch must carry the explicit model pin').toBeGreaterThanOrEqual(0);
      expect(tasks[0].argv[modelFlag + 1]).toBe(model);
      expect(tasks[0].detail).toMatchObject({ coordOwnerId: identity.ownerId, transport: 'structured' });
      iterator = host.subscribe()[Symbol.asyncIterator]();
      const nonce = `PUI-ATTACHED-${randomUUID()}`;
      const content = `This is a bounded, read-only PUI transport acceptance test. Call the Papercusp coord:whoami tool exactly once (use tools:invoke if deferred), then reply with ${nonce} and the returned ownerId and workspaceId. Do not change files, send messages, register work, or start other work.`;
      const command = { schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
        type: 'owner_turn', commandId: `command-${randomUUID()}`, turnId: `turn-${randomUUID()}`,
        issuedAt: new Date().toISOString(), target: identity, content };
      const commandRoute = suSessionRoutes.find((route) => route.method === 'POST')!;
      const accepted = await commandRoute.handler(new Request('http://localhost/commands', { method: 'POST', headers, body: JSON.stringify(command) }), context);
      expect(accepted.status, JSON.stringify(await accepted.json())).toBe(202);
      const saved = await getChat({ slug: harness, chatId });
      expect(saved.ok && saved.data.transcript.some((turn) => turn.content === content)).toBe(true);
      const observedEvents: SuSessionEvent[] = [];
      let toolIdentity = false;
      let reply = false;
      const deadline = Date.now() + 120_000;
      while ((!toolIdentity || !reply) && Date.now() < deadline) {
        let timer: ReturnType<typeof setTimeout>;
        let next: IteratorResult<{ id: number; event: SuSessionEvent }>;
        try {
          next = await Promise.race([iterator.next(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Timed out waiting for the scoped SU tool and reply')), Math.max(1, deadline - Date.now()));
          })]).finally(() => clearTimeout(timer));
        } catch (error) {
          const buffered = host.recent.map((entry) => entry.event);
          const rateLimit = confirmedProviderRateLimit([...observedEvents, ...buffered]);
          if (rateLimit.confirmed) {
            ctx.skip(`NOT MEASURED: provider account limit during the owner turn (${rateLimit.signals[0]})`);
          }
          const recentTypes = buffered.slice(-8).map((event) => event.type).join(',') || 'none';
          throw new Error(`${String(error)}; lifecycle=${host.descriptor().lifecycle}; bufferedEvents=${buffered.length}; recentTypes=${recentTypes}`);
        }
        if (next.done) throw new Error('SU stream ended before acceptance');
        const event = next.value.event;
        observedEvents.push(event);
        if (event.type === 'error') {
          const rateLimit = confirmedProviderRateLimit(observedEvents);
          if (rateLimit.confirmed) {
            ctx.skip(`NOT MEASURED: provider account limit during the owner turn (${rateLimit.signals[0]})`);
          }
          throw new Error(`${event.code}: ${event.message}`);
        }
        if (event.type === 'tool' && event.phase === 'completed' && !event.isError) {
          const output = JSON.stringify(event.output);
          toolIdentity ||= output.includes(identity.ownerId) && output.includes(workspaceId);
        }
        if (event.type === 'transcript' && 'content' in event && event.role === 'assistant' && event.content?.includes(nonce)) {
          expect(event.turnId).toBe(command.turnId);
          reply = true;
        }
      }
      const rateLimit = confirmedProviderRateLimit(observedEvents);
      if (rateLimit.confirmed) {
        ctx.skip(`NOT MEASURED: provider account limit during the owner turn (${rateLimit.signals[0]})`);
      }
      expect({ toolIdentity, reply }).toEqual({ toolIdentity: true, reply: true });
      const replay = await commandRoute.handler(new Request('http://localhost/commands', { method: 'POST', headers, body: JSON.stringify(command) }), context);
      expect(await replay.json()).toMatchObject({ ok: true, replayed: true });
      console.log(JSON.stringify({ acceptance: 'attached-su-identity', workspaceId, harness, chatId, ownerId: identity.ownerId, nativeSessionId: identity.nativeSessionId, requestedModel: model, actualModel, accountRoute: account, toolIdentity, reply }));
    } finally {
      host ??= getRegisteredSuSessionHost(key);
      if (host && !host.snapshot().terminal) {
        const terminal = await host.startCommand({ schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
          type: 'end', commandId: `end-${randomUUID()}`, issuedAt: new Date().toISOString(), target: host.descriptor().identity }).terminal;
        expect(terminal.status).toBe('completed');
      }
      host?.dispose('live acceptance finished');
      await iterator?.return?.();
      if (engineTaskId) {
        const { getTask } = await import('./task-manager/store');
        await vi.waitFor(async () => expect((await getTask(engineTaskId!))?.endedAt).toBeTruthy(), { timeout: 5_000 });
      }
      expect((await archiveChat({ slug: harness, chatId })).ok).toBe(true);
    }
  }, 240_000);
});
