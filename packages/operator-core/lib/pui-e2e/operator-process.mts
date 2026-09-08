/** Isolated production Hono process for installed-PUI restart acceptance.
 * Launched only by the Vitest fixture, with its migrated throwaway database.
 * The observation channel never supplies model output or answers a card.
 */
import { createAdaptorServer } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { SuSessionHost } from '../su-session-host';

// These workspace TypeScript entrypoints are CommonJS under tsx. Resolve
// their exports with Node's CJS loader rather than relying on named-export
// inference across an ESM child-process entrypoint.
const require = createRequire(import.meta.url);
const { app } = require('../../../../apps/operator/bin/host-app') as typeof import('../../../../apps/operator/bin/host-app');
const { getRegisteredSuSessionHost } = require('../su-session-host') as typeof import('../su-session-host');
const { getAdvSession } = require('../adv-sessions') as typeof import('../adv-sessions');
const { SU_SESSION_SCHEMA, SU_SESSION_PROTOCOL_VERSION } = require('@papercusp/chat-protocol') as typeof import('@papercusp/chat-protocol');

if (!process.send || !process.env.PUI_OPERATOR_FIXTURE_WORKSPACE
  || process.env.PAPERCUSP_WORKSPACE_ID !== process.env.PUI_OPERATOR_FIXTURE_WORKSPACE
  || !process.env.HARNESS_ADMIN_DATABASE_URL) {
  throw new Error('The PUI operator fixture requires IPC and an explicitly isolated workspace/database');
}
const workspaceId = process.env.PUI_OPERATOR_FIXTURE_WORKSPACE;
const observed = new Set<SuSessionHost>();
const instanceId = randomUUID();
const send = (message: unknown) => { if (process.connected) process.send!(message); };
for (const level of ['warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    send({ type: 'diagnostic', level, args: args.map((arg) => arg instanceof Error ? arg.message : arg) });
    original(...args);
  };
}

function observe(agentChatId: string, harnessSlug: string): void {
  const host = getRegisteredSuSessionHost({ workspaceId, harnessSlug, agentChatId });
  if (!host || observed.has(host)) return;
  observed.add(host);
  send({ type: 'host', descriptor: host.descriptor(), events: host.recent.map(({ event }) => event) });
  void (async () => {
    for await (const { event } of host.subscribe()) {
      send({ type: 'event', descriptor: host.descriptor(), event });
    }
  })().catch((error) => { console.error('PUI fixture observation failed', error); });
}

const server = createAdaptorServer({ fetch: async (request, env) => {
  const pathname = new URL(request.url).pathname;
  const tracksReadiness = pathname.includes('/su-session');
  const before = tracksReadiness ? [...observed].map((host) => host.snapshot()) : undefined;
  const requestedAt = new Date().toISOString();
  const launch = request.method === 'POST' && pathname === '/api/adv/sessions/launch-su'
    ? await request.clone().json() as { agent_chat_id: string; harness_slug: string } : null;
  const response = await app.fetch(request, env);
  if (launch) observe(launch.agent_chat_id, launch.harness_slug);
  if (tracksReadiness) {
    const body = !pathname.endsWith('/events') ? await response.clone().json().catch(() => undefined) : undefined;
    send({ type: 'readiness', path: pathname, method: request.method, requestedAt, respondedAt: new Date().toISOString(),
      status: response.status, before, after: [...observed].map((host) => host.snapshot()), body });
  }
  if (pathname.endsWith('/su-session/commands')) {
    for (const host of observed) {
      const row = await getAdvSession(host.descriptor().identity.advSessionId);
      send({ type: 'host-state', descriptor: host.descriptor(), pid: row?.pid ?? null });
    }
  }
  if (launch || pathname.endsWith('/card-response')) send({ type: 'response', path: pathname, status: response.status });
  return response;
} });
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(Number(process.env.PUI_OPERATOR_FIXTURE_PORT ?? 0), '127.0.0.1', resolve);
});
const port = (server.address() as AddressInfo).port;
process.env.PAPERCUSP_HONO_PORT = String(port);
process.env.PAPERCUSP_OPERATOR_URL = `http://127.0.0.1:${port}`;
process.env.PAPERCUSP_MCP_PROXY_BASE = `http://127.0.0.1:${port}`;
send({ type: 'ready', pid: process.pid, instanceId, port });

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    for (const host of observed) {
      if (!host.snapshot().terminal) {
        const command = { schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
          type: 'end', commandId: randomUUID(), issuedAt: new Date().toISOString(), target: host.descriptor().identity };
        const dispatch = await host.acceptCommand(command);
        const terminal = await dispatch.terminal;
        if (terminal.status !== 'completed') throw new Error(`Native end refused: ${JSON.stringify(terminal)}`);
      }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { drainDetached } = require('../detached-imports') as typeof import('../detached-imports');
    await drainDetached();
    const { stopInvalidationListener } = require('../sync-sse') as typeof import('../sync-sse');
    await stopInvalidationListener();
    // Explicit process.exit skips beforeExit, so the embedding workers need
    // their normal per-environment teardown before Node unloads ONNX.
    const { shutdownLocalEmbedder } = require('@papercusp/memory') as typeof import('@papercusp/memory');
    const { shutdownLocalReranker } = require('@papercusp/rerank') as typeof import('@papercusp/rerank');
    await Promise.all([shutdownLocalEmbedder(), shutdownLocalReranker()]);
    send({ type: 'shutdown-stage', stage: 'embedding-workers-stopped', pid: process.pid, instanceId });
    const dbOrg = require('@papercusp/db-org') as typeof import('@papercusp/db-org');
    await dbOrg._resetForTests();
    send({ type: 'stopped', pid: process.pid, instanceId });
    process.exit(0);
  } catch (error) {
    console.error('PUI operator fixture shutdown failed', error);
    process.exit(1);
  }
}
process.on('message', (message: { type?: string }) => { if (message.type === 'stop') void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('disconnect', () => { void stop(); });
