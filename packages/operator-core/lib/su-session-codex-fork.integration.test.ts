/** Installed Codex, isolated homes and a loopback provider. No provider inference. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from '@iarna/toml';
import { afterEach, expect, it, vi } from 'vitest';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from './inference-gateway/codex-cli-bridge';
import { forkCodexNativeHistory } from './su-session-codex-fork';
import { startSuStdioPeer, type RpcFrame, type SuStdioPeer } from './su-session-stdio-peer';

const processes = vi.hoisted(() => new Map<string, ChildProcess>());
vi.mock('./task-manager/managed-spawn', () => ({ managedSpawn: async (bin: string, args: string[], _spec: unknown,
  options: { spawnOptions: object }) => {
  const child = spawn(bin, args, options.spawnOptions), taskId = randomUUID(); processes.set(taskId, child); return { child, taskId };
} }));
vi.mock('./task-manager/control', () => ({ killTask: async (id: string) => { processes.get(id)?.kill('SIGKILL'); return { ok: true }; } }));
vi.mock('../../../apps/operator/scripts/psu-launcher.mjs', () => ({ startSupervisorBeat: vi.fn() }));
const peers: SuStdioPeer[] = [], homes: string[] = [];
afterEach(async () => {
  for (const p of peers.splice(0)) { await p.close(); await p.done; }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  expect([...processes.values()].every(p => p.exitCode !== null || p.signalCode !== null)).toBe(true); processes.clear();
});

it('refuses incomplete paginated history in a fresh home without mutating the live parent', async () => {
  const bodies: RpcFrame[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol', text: 'ACK', inputTokens: 20, outputTokens: 1 })));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local fixture port');
  const config = stringify({ model_provider: 'local_fork', model: 'gpt-6-sol',
    model_providers: { local_fork: { name: 'Local fork fixture', base_url: `http://127.0.0.1:${address.port}/v1`,
      wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, request_max_retries: 0 } },
    features: { apps: false, shell_tool: false }, web_search: 'disabled' });
  async function open(home?: string) {
    home ??= mkdtempSync(join(tmpdir(), 'su-native-fork-')); if (!homes.includes(home)) homes.push(home);
    writeFileSync(join(home, 'config.toml'), config);
    const events: RpcFrame[] = [];
    const peer = await startSuStdioPeer({ binary: 'codex', args: ['app-server'], cwd: home,
      env: { PATH: process.env.PATH, CODEX_HOME: home }, workspaceId: 'fork-fixture', ownerId: randomUUID(),
      spec: { class: 'test', title: 'Tracked native fork', launchedBy: 'vitest', argv: ['codex', 'app-server'] }, onMessage: f => events.push(f) });
    peers.push(peer);
    await peer.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_fork_test', version: '1' } } });
    peer.send({ method: 'initialized', params: {} }); return { peer, home, events };
  }
  async function turn(p: Awaited<ReturnType<typeof open>>, threadId: string, text: string) {
    const result = await p.peer.request({ method: 'turn/start', params: { threadId, input: [{ type: 'text', text }] } });
    const id = (result.turn as RpcFrame).id;
    await vi.waitFor(() => expect(p.events).toContainEqual(expect.objectContaining({ method: 'turn/completed',
      params: expect.objectContaining({ threadId, turn: expect.objectContaining({ id, status: 'completed' }) }) })), { timeout: 20_000 });
  }
  try {
    const parent = await open();
    const start = await parent.peer.request({ method: 'thread/start', params: { cwd: parent.home, approvalPolicy: 'never', sandbox: 'read-only' } });
    const parentId = String((start.thread as RpcFrame).id);
    await turn(parent, parentId, 'PARENT_HISTORY_MARKER');
    const read = await parent.peer.request({ method: 'thread/read', params: { threadId: parentId, includeTurns: true } });
    const sourcePath = String((read.thread as RpcFrame).path), before = readFileSync(sourcePath);
    console.info('FORK_SOURCE_STORAGE', JSON.stringify({ historyMode: (read.thread as RpcFrame).historyMode,
      turnStatuses: ((read.thread as RpcFrame).turns as RpcFrame[]).map(turn => turn.status),
      homeFiles: readdirSync(parent.home), historyBytes: before.length,
      recordTypes: before.toString().trim().split('\n').map(line => { const row = JSON.parse(line); return [row.type, row.payload?.type]; }) }));
    const child = await open();
    await expect(forkCodexNativeHistory({ peer: child.peer,
      source: { backend: 'codex', source: 'adv_sessions', ownerId: 'su-parent', codexHome: parent.home,
        rolloutId: parentId, exactResumeSupported: true, missingReason: null }, childOwnerId: 'su-child', childHome: child.home,
      params: { cwd: parent.home, approvalPolicy: 'never', sandbox: 'read-only' } }))
      .rejects.toThrow('Codex fork has no completed parent turn boundary');
    // This is safety proof for an incomplete transfer, never successful fork
    // parity. P008 still owes the complete native history transfer, divergent
    // continuation, restart and tracked launch/registration acceptance.
    expect(bodies).toHaveLength(1);
    expect(readFileSync(sourcePath)).toEqual(before);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}, 90_000);
