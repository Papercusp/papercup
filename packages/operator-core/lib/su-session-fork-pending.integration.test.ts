/** Installed clients + production engines/cards/queues + real PG wake ledger.
 * Inference is served only by a loopback fixture; no provider inference claim. */
import postgres from 'postgres';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from '@iarna/toml';
import { afterAll, afterEach, beforeAll, expect, inject, it, vi } from 'vitest';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA, type SuSessionIdentity } from '@papercusp/chat-protocol';
import { resolveCardResponse } from '@papercusp/agent-mcp';
import { acquireBaselineSchemaMutex, releaseBaselineSchemaMutex } from '@papercusp/test-config/baseline-schema-mutex';
import type {} from '../../../libs/test-config/src/baseline-schema-global-setup';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import type { RpcFrame } from './su-session-stdio-peer';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql,
  children: new Map<string, ChildProcess>() }));
vi.mock('@papercusp/db-org', async original => ({ ...await original<object>(), getOrgPg: () => ({ sql: fixture.sql }) }));
vi.mock('./su-session-persistence', () => ({ bindSuSessionToAdvSession: vi.fn(async () => ({ status: 'bound' })),
  persistSuSessionDescriptor: vi.fn(async () => true) }));
vi.mock('./su-session-commands', async original => ({ ...await original<object>(), loadSuOwnerTurnReceipts: async () => [] }));
vi.mock('./role-codex-home', () => ({ makeCodingAssistantCodexHome: vi.fn() }));
vi.mock('./task-manager/managed-spawn', () => ({ managedSpawn: async (bin: string, args: string[], _spec: unknown,
  options: { spawnOptions: object }) => {
  const child = spawn(bin, args, options.spawnOptions), taskId = randomUUID();
  fixture.children.set(taskId, child); return { child, taskId };
} }));
vi.mock('./task-manager/control', () => ({ killTask: async (id: string) => {
  fixture.children.get(id)?.kill('SIGKILL'); return { ok: true };
} }));
vi.mock('../../../apps/operator/scripts/psu-launcher.mjs', async original => ({
  ...await original<object>(), assertLaunchPersona: vi.fn(), startSupervisorBeat: vi.fn(),
  prepareSuLaunch: (boot: BootstrapSuResult) => ({ env: { ...boot.envelopeEnv }, args: [], modelArgs: [], model: boot.model }),
}));

import { startSuRpcEngine } from './su-session-rpc-engine';
import { startClaudeSuEngine } from './su-session-claude-engine';
import { startSuStdioPeer } from './su-session-stdio-peer';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from './inference-gateway/codex-cli-bridge';
import { registerAwait, fireAwaitsForKey, insertDeliveries, markDeliveryDelivered, ackDelivery } from './events/await/store';

let mutex: postgres.Sql;
const engines: Array<{ close(): Promise<void>; done: Promise<void>; adapter: { dispose(): void } }> = [];
const roots: string[] = [], subscribers: string[] = [];
beforeAll(async () => {
  mutex = await acquireBaselineSchemaMutex(inject('baselineSchemaDsn'), { label: 'fork-pending-isolation' });
  fixture.sql = postgres(inject('baselineSchemaDsn'), { max: 2, onnotice: () => {} });
});
afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) { await engine.close(); await engine.done; engine.adapter.dispose(); }
  await vi.waitFor(() => expect([...fixture.children.values()]
    .every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true));
  fixture.children.clear();
  for (const subscriber of subscribers.splice(0)) {
    await fixture.sql`DELETE FROM harness_shared.event_wake_deliveries WHERE subscriber_id = ${subscriber}`;
    await fixture.sql`DELETE FROM harness_shared.event_awaits WHERE subscriber_id = ${subscriber}`;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(async () => { await fixture.sql?.end({ timeout: 5 }); if (mutex) await releaseBaselineSchemaMutex(mutex); });

function command(host: { descriptor(): { identity: SuSessionIdentity } }, type: 'owner_turn' | 'queue', content: string) {
  return { schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION, issuedAt: new Date().toISOString(),
    target: host.descriptor().identity, type, commandId: randomUUID(), turnId: randomUUID(), content };
}
function sendClaude(res: ServerResponse, question: boolean) {
  const block = question ? { type: 'tool_use', id: 'toolu_pending', name: 'AskUserQuestion', input: { questions: [{
    question: 'PARENT_PRIVATE_QUESTION', header: 'Choice', multiSelect: false,
    options: [{ label: 'Keep', description: 'Keep it' }, { label: 'Change', description: 'Change it' }],
  }] } } : { type: 'text', text: 'ACK' };
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(event('message_start', { message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant',
    model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    + event('content_block_start', { index: 0, content_block: question ? { ...block, input: {} } : { type: 'text', text: '' } })
    + event('content_block_delta', { index: 0, delta: question
      ? { type: 'input_json_delta', partial_json: JSON.stringify('input' in block ? block.input : {}) }
      : { type: 'text_delta', text: 'ACK' } })
    + event('content_block_stop', { index: 0 })
    + event('message_delta', { delta: { stop_reason: question ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    + event('message_stop', {}));
}
function sendCodex(res: ServerResponse, question: boolean, questionTool: string) {
  const response = codexCliResponsesBody({ model: 'gpt-6-sol', text: 'ACK', inputTokens: 10, outputTokens: 1 });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (!question) { res.end(codexCliResponsesCompletionSse(response)); return; }
  const toolPath = questionTool.split('.');
  const item = { id: 'fc_pending', type: 'function_call', call_id: 'call_pending', name: toolPath.at(-1),
    ...(toolPath.length > 1 ? { namespace: toolPath.slice(0, -1).join('.') } : {}),
    arguments: JSON.stringify({ questions: [{ id: 'pending', header: 'Choice', question: 'PARENT_PRIVATE_QUESTION',
      options: [{ label: 'Keep', description: 'Keep it' }, { label: 'Change', description: 'Change it' }] }] }), status: 'completed' };
  const event = (type: string, fields: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  res.end(event('response.created', { response: { ...response, status: 'in_progress', output: [] } })
    + event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } })
    + event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments })
    + event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments })
    + event('response.output_item.done', { output_index: 0, item })
    + event('response.completed', { response: { ...response, output: [item] } }));
}

function toolNames(tools: RpcFrame[], prefix = ''): string[] {
  return tools.flatMap(tool => tool.type === 'namespace' && Array.isArray(tool.tools)
    ? toolNames(tool.tools, `${prefix}${tool.name}.`) : typeof tool.name === 'string' ? [prefix + tool.name] : []);
}

it.each(['codex', 'claude'] as const)('%s native fork leaves pending question, queued input and accepted wake exclusively with parent', async backend => {
  const root = mkdtempSync(join(tmpdir(), 'su-fork-pending-')); roots.push(root);
  const parentOwner = `su-parent-${randomUUID()}`, childOwner = `su-child-${randomUUID()}`;
  subscribers.push(parentOwner, childOwner);
  const bodies: object[] = [], outbound = new Map<string, string[]>(), requests: object[] = [], fixtureErrors: string[] = [];
  const nativeRequests: object[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200); res.end('{}'); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":10}'); return; }
    bodies.push(body);
    const conversation = (backend === 'codex' ? body.input : body.messages) as Array<RpcFrame>;
    const encoded = JSON.stringify(conversation.filter(item => item.type !== 'additional_tools' && item.role !== 'system'));
    const answered = conversation.some(item => item.type === 'function_call_output'
      || Array.isArray(item.content) && item.content.some((block: RpcFrame) => block.type === 'tool_result'));
    const question = encoded.includes('ASK_PARENT_NOW') && !answered && !encoded.includes('CHILD_ONLY');
    const names = toolNames([...(body.tools ?? []), ...conversation.filter(item => item.type === 'additional_tools')
      .flatMap(item => Array.isArray(item.tools) ? item.tools : [])]);
    const questionTool = names.find(name => /(?:^|\.)request_user_input$/.test(name)) ?? '';
    requests.push({ question, answered, questionTool, questions: names.filter(name => /Question|request_user_input/.test(name)),
      toolResults: conversation.filter(item => item.type === 'function_call_output').map(item => item.output),
      lastUser: conversation.filter(item => item.role === 'user').map(item => JSON.stringify(item.content).slice(-400)).at(-1) });
    if (question && !(backend === 'codex' ? questionTool : names.includes('AskUserQuestion'))) {
      fixtureErrors.push(`Native ${backend} request did not advertise its question tool`);
      res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: fixtureErrors.at(-1) })); return;
    }
    if (backend === 'codex') sendCodex(res, question, questionTool); else sendClaude(res, question);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let parentNativeId = '';
  async function open(owner: string, child = false) {
    const home = join(root, child ? 'child' : 'parent'); mkdirSync(home);
    const nativeId = backend === 'claude' ? randomUUID() : null;
    const binding = { operation: 'created', backend, advSessionId: child ? 92 : 91, ownerId: owner,
      workspaceId: 'fork-pending-fixture', harnessSlug: null, planSlug: null, nativeSession: null } as PuiSuSessionBinding;
    const boot = { status: 'ok', agent: backend, sessionId: binding.advSessionId, nativeSessionId: nativeId,
      workspaceId: binding.workspaceId!, harnessSlug: null, planSlug: null, cwd: root,
      promptFile: join(home, 'su.md'), codexHome: backend === 'codex' ? home : null, coordExtPath: null,
      model: backend === 'codex' ? 'gpt-6-sol' : 'claude-haiku-4-5', specificationRevision: 'fixture', stateRevision: 'fixture',
      compositionSource: 'compatibility', envelopeEnv: { PAPERCUSP_SID: owner, PATH: process.env.PATH!, HOME: home,
        ...(backend === 'codex' ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
          ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'offline-fixture-only',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }) } } satisfies BootstrapSuResult;
    writeFileSync(boot.promptFile, 'Fork isolation fixture.'); outbound.set(owner, []);
    if (backend === 'codex') {
      writeFileSync(join(home, 'config.toml'), stringify({ model_provider: 'local_fork', model: boot.model,
        model_providers: { local_fork: { name: 'Local fixture', base_url: `${baseUrl}/v1`, wire_api: 'responses',
          requires_openai_auth: false, supports_websockets: false, request_max_retries: 0 } },
        features: { apps: false, shell_tool: false }, web_search: 'disabled' }));
      const engine = startSuRpcEngine(boot, binding as PuiSuSessionBinding & { backend: 'codex' }, {
        agentChatId: owner, register: false, identity: 'coding-assistant', servedAccountReader: async () => null,
        ownerTurnReceipts: async () => [], startupTimeoutMs: 20_000,
        ...(child ? { forkFrom: { backend: 'codex' as const, source: 'adv_sessions' as const, ownerId: parentOwner,
          codexHome: join(root, 'parent'), rolloutId: parentNativeId, exactResumeSupported: true, missingReason: null } } : {}),
        turnLifecycle: { admit: async () => ({ ok: true, bindNativeTurn: async () => {}, complete: async () => {}, reconcile: async () => {} }) },
        peerFactory: async options => {
          const peer = await startSuStdioPeer({ ...options, onMessage: frame => {
            if (frame.id != null && frame.method) nativeRequests.push({ method: frame.method, params: frame.params });
            options.onMessage(frame);
          } });
          return { ...peer, request: (frame, timeout) => {
            if (frame.method === 'initialize') frame = { ...frame, params: { ...frame.params as object,
              capabilities: { experimentalApi: true } } };
            if (frame.method === 'turn/start') {
              outbound.get(owner)!.push(JSON.stringify(frame.params));
              frame = { ...frame, params: { ...frame.params as object, collaborationMode: { mode: 'plan', settings: {
                model: boot.model, reasoning_effort: null, developer_instructions: null } } } };
            }
            return peer.request(frame, timeout);
          } };
        },
      });
      engines.push(engine); await engine.ready;
      const handle = engine.nativeSession();
      if (handle.backend !== 'codex' || !handle.rolloutId) throw new Error('Missing native Codex identity');
      if (!child) parentNativeId = handle.rolloutId;
      return { host: engine.adapter.host, nativeId: handle.rolloutId };
    }
    const engine = startClaudeSuEngine(boot, binding as PuiSuSessionBinding & { backend: 'claude' }, {
      nativeSession: { backend: 'claude', source: 'adv_sessions', ownerId: owner, sessionId: nativeId!,
        configDir: join(root, 'claude-config'), configDirSource: 'live-process', configDirUnresolvedReason: null,
        exactResumeSupported: true, missingReason: null }, transcriptPath: null,
    }, { agentChatId: owner, register: false, identity: 'coding-assistant', toolApproval: 'prompt',
      servedAccountReader: async () => null, startupTimeoutMs: 20_000, query: input => query({
        ...input, prompt: (async function* () { for await (const message of input.prompt) {
          outbound.get(owner)!.push(JSON.stringify(message)); yield message;
        } })(), options: { ...input.options, env: { ...boot.envelopeEnv },
          settingSources: [], settings: { disableAllHooks: true }, mcpServers: {},
          ...(child ? { resume: parentNativeId, forkSession: true, sessionId: nativeId! } : {}),
          spawnClaudeCodeProcess: options => {
            const process = spawn(options.command, options.args, { cwd: root, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
            fixture.children.set(randomUUID(), process); return process;
          } },
      }) });
    engines.push(engine); await engine.ready;
    if (!child) parentNativeId = nativeId!;
    return { host: engine.adapter.host, nativeId: nativeId! };
  }
  try {
    const parent = await open(parentOwner);
    const initial = await parent.host.startCommand(command(parent.host, 'owner_turn', 'PARENT_HISTORY')).terminal;
    expect(initial, JSON.stringify(initial)).toMatchObject({ status: 'completed' });
    await vi.waitFor(() => expect(parent.host.descriptor().lifecycle).toBe('waiting-for-owner'), { timeout: 20_000 });
    await expect(parent.host.startCommand(command(parent.host, 'owner_turn', 'ASK_PARENT_NOW')).terminal)
      .resolves.toMatchObject({ status: 'completed' });
    const parentCard = () => parent.host.recentSince(0).map(row => row.event).find(event => event.type === 'card' && event.phase === 'opened');
    await vi.waitFor(() => expect(parentCard(), JSON.stringify({
      lifecycle: parent.host.descriptor().lifecycle, requests, fixtureErrors, nativeRequests,
      events: parent.host.recentSince(0).map(row => row.event).filter(event => event.type === 'transcript' || event.type === 'error').slice(-6),
    })).toBeDefined(), { timeout: 20_000 });
    const card = parentCard(); if (card?.type !== 'card' || card.phase !== 'opened') throw new Error('No parent question');
    let queueSettled = false;
    const queued = parent.host.startCommand(command(parent.host, 'queue', 'PARENT_QUEUED_PRIVATE'));
    void queued.terminal.then(() => { queueSettled = true; });
    const eventKey = `fork-pending:${randomUUID()}`;
    const awaited = await registerAwait({ subscriberId: parentOwner, eventKey, policy: 'wake' });
    const fired = await fireAwaitsForKey({ eventKey }); expect(fired.map(row => row.id)).toEqual([awaited.id]);
    expect(await insertDeliveries({ awaits: fired, payload: { secret: 'PARENT_WAKE_PRIVATE' } })).toBe(1);
    const [delivery] = await fixture.sql`SELECT * FROM harness_shared.event_wake_deliveries WHERE await_id = ${awaited.id}`;
    await markDeliveryDelivered(Number(delivery.id), 'psu-socket-inject');
    const [before] = await fixture.sql`SELECT * FROM harness_shared.event_wake_deliveries WHERE id = ${delivery.id}`;
    expect(before).toMatchObject({ status: 'delivered', turn_proof: 'awaiting', turn_started_at: null });
    expect(queueSettled).toBe(false);
    const child = await open(childOwner, true);
    expect(child.nativeId).not.toBe(parent.nativeId);
    expect(child.host.recentSince(0).some(({ event }) => event.type === 'card')).toBe(false);
    expect(queueSettled).toBe(false);
    expect(outbound.get(childOwner)).toEqual([]);
    expect(await ackDelivery({ deliveryId: Number(delivery.id), subscriberId: childOwner }))
      .toMatchObject({ acked: false });
    const [after] = await fixture.sql`SELECT * FROM harness_shared.event_wake_deliveries WHERE id = ${delivery.id}`;
    expect(after).toEqual(before);
    const childRows = await fixture.sql`SELECT id FROM harness_shared.event_awaits WHERE subscriber_id = ${childOwner}`;
    expect(childRows).toHaveLength(0);
    await expect(child.host.startCommand(command(child.host, 'owner_turn', 'CHILD_ONLY')).terminal)
      .resolves.toMatchObject({ status: 'completed' });
    await vi.waitFor(() => expect(JSON.stringify(bodies)).toContain('CHILD_ONLY'), { timeout: 20_000 });
    const childBody = bodies.find(body => JSON.stringify(body).includes('CHILD_ONLY'));
    expect(JSON.stringify(childBody)).toContain('PARENT_HISTORY');
    expect(JSON.stringify(childBody)).not.toContain('PARENT_QUEUED_PRIVATE');
    expect(JSON.stringify(childBody)).not.toContain('PARENT_WAKE_PRIVATE');
    expect(outbound.get(parentOwner)).toHaveLength(2);
    expect(resolveCardResponse({ correlationId: card.card.correlationId, action: 'submit', payload: { picks: ['0'] },
      expectedWorkspaceId: 'fork-pending-fixture' }).ok).toBe(true);
    await expect(queued.terminal).resolves.toMatchObject({ status: 'completed' });
    expect(outbound.get(parentOwner)).toHaveLength(3);
    expect(outbound.get(parentOwner)!.at(-1)).toContain('PARENT_QUEUED_PRIVATE');
    expect(outbound.get(childOwner)).toHaveLength(1);
    const [retained] = await fixture.sql`SELECT * FROM harness_shared.event_wake_deliveries WHERE id = ${delivery.id}`;
    expect(retained).toEqual(before);
    expect(readFileSync(join(root, 'child', 'su.md'), 'utf8')).toBe('Fork isolation fixture.');
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}, 120_000);
