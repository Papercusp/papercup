/** Real PG registration + installed native Codex, with a loopback model fixture. */
import postgres from 'postgres';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from '@iarna/toml';
import { spawn as spawnPty } from '@lydell/node-pty';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, expect, inject, it, vi } from 'vitest';
import { acquireBaselineSchemaMutex, releaseBaselineSchemaMutex } from '@papercusp/test-config/baseline-schema-mutex';
import type {} from '../../../libs/test-config/src/baseline-schema-global-setup';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql,
  homes: new Map<string, string>(), processes: new Map<string, ChildProcess>() }));
vi.mock('@papercusp/db-org', async original => ({ ...await original<object>(), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('@papercusp/orchestrator/session-launch-dirs', async original => ({ ...await original<object>(),
  codexHomeForSessionKey: (id: number) => h.homes.get(String(id))! }));
vi.mock('./task-manager/managed-spawn', () => ({ managedSpawn: async (bin: string, args: string[], _spec: unknown,
  options: { spawnOptions: object }) => {
  const child = spawn(bin, args, options.spawnOptions), taskId = randomUUID(); h.processes.set(taskId, child); return { child, taskId };
} }));
vi.mock('./task-manager/control', () => ({ killTask: async (id: string) => { h.processes.get(id)?.kill('SIGKILL'); return { ok: true }; } }));

import { recordAdvSession } from './adv-sessions';
import { completeTrackedCodexFork, registerTrackedCodexFork } from './su-session-tracked-codex-fork';
import { startSuStdioPeer, type RpcFrame, type SuStdioPeer } from './su-session-stdio-peer';
import { findCodexRolloutPathByUuid } from './session-transcript-resolvers';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from './inference-gateway/codex-cli-bridge';

const workspace = `tracked-codex-fork-${randomUUID()}`;
let mutex: postgres.Sql, root: string;
const peers: SuStdioPeer[] = [];
beforeAll(async () => {
  mutex = await acquireBaselineSchemaMutex(inject('baselineSchemaDsn'), { label: 'tracked-codex-fork' });
  h.sql = postgres(inject('baselineSchemaDsn'), { max: 2, onnotice: () => {} });
});
afterEach(async () => {
  for (const p of peers.splice(0)) { await p.close(); await p.done; }
  expect([...h.processes.values()].every(p => p.exitCode !== null || p.signalCode !== null)).toBe(true);
  h.processes.clear(); h.homes.clear();
  await h.sql`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${workspace}`;
  if (root) rmSync(root, { recursive: true, force: true });
});
afterAll(async () => { await h.sql?.end({ timeout: 5 }); if (mutex) await releaseBaselineSchemaMutex(mutex); });

async function row(owner: string, home: string, nativeId: string | null) {
  const id = (await recordAdvSession({ agent: 'codex', workspaceId: workspace, mode: 'console',
    coordOwnerId: owner, cwd: root, sessionId: nativeId }))!;
  expect(id).toBeTruthy(); h.homes.set(String(id), home);
  await h.sql`UPDATE harness_shared.adv_sessions SET launch_spec = ${JSON.stringify({ v: 1, agent: 'codex', workspaceId: workspace })}::text::jsonb WHERE id = ${id}`;
  const [written] = await h.sql`SELECT jsonb_typeof(launch_spec) AS kind FROM harness_shared.adv_sessions WHERE id = ${id}`;
  expect(written.kind).toBe('object');
  return Number(id);
}

it.each(['registered', 'stale-source', 'startup-failure'] as const)('registers native child ancestry before success; scenario=%s', async scenario => {
  const stale = scenario === 'stale-source', startupFailure = scenario === 'startup-failure';
  root = mkdtempSync(join(tmpdir(), 'tracked-codex-fork-'));
  const parentHome = join(root, 'parent'), childHome = join(root, 'child');
  mkdirSync(parentHome); mkdirSync(childHome);
  let calls = 0;
  const bodies: RpcFrame[] = [];
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    calls++; res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol', text: 'ACK', inputTokens: 10, outputTokens: 1 })));
  });
  await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('No provider port');
  const config = stringify({ model_provider: 'fork_fixture', model: 'gpt-6-sol',
    model_providers: { fork_fixture: { name: 'Fixture', base_url: `http://127.0.0.1:${address.port}/v1`,
      wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, request_max_retries: 0 } },
    features: { apps: false, shell_tool: false }, web_search: 'disabled',
    tui: { screen_reader_detection_done: true } });
  for (const home of [parentHome, childHome]) writeFileSync(join(home, 'config.toml'), config);
  const prompt = join(childHome, 'AGENTS.md'); writeFileSync(prompt, 'Child identity only');
  try {
    const events: RpcFrame[] = [];
    const parent = await startSuStdioPeer({ binary: 'codex', args: ['app-server'], cwd: root,
      env: { PATH: process.env.PATH, CODEX_HOME: parentHome }, workspaceId: workspace, ownerId: 'su-parent',
      spec: { class: 'test', title: 'Parent fork fixture', launchedBy: 'vitest', argv: ['codex', 'app-server'] },
      onMessage: frame => events.push(frame) }); peers.push(parent);
    await parent.request({ method: 'initialize', params: { clientInfo: { name: 'fork_test', version: '1' } } });
    parent.send({ method: 'initialized', params: {} });
    const start = await parent.request({ method: 'thread/start', params: { cwd: root, approvalPolicy: 'never', sandbox: 'read-only' } });
    const native = String((start.thread as RpcFrame).id);
    await parent.request({ method: 'turn/start', params: { threadId: native, input: [{ type: 'text', text: 'PARENT_VISIBLE_HISTORY' }] } });
    await vi.waitFor(() => expect(events.some(f => f.method === 'turn/completed')).toBe(true), { timeout: 20_000 });
    const parentId = await row('su-parent', parentHome, native), childId = await row('su-child', childHome, null);
    const [before] = await h.sql`SELECT * FROM harness_shared.adv_sessions WHERE id = ${parentId}`;
    const boot = { status: 'ok', agent: 'codex', sessionId: childId, nativeSessionId: null,
      codexHome: childHome, cwd: root, workspaceId: workspace, promptFile: prompt, model: 'gpt-6.1-sol:xhigh',
      harnessSlug: null, planSlug: null, specificationRevision: 'fixture', stateRevision: 'fixture',
      compositionSource: 'compatibility', coordExtPath: null,
      envelopeEnv: { PAPERCUSP_SID: 'su-child', CODEX_HOME: childHome } } satisfies BootstrapSuResult;
    const methods: unknown[] = [];
    let attemptedNativeId: string | undefined;
    const result = completeTrackedCodexFork(boot, { advSessionId: parentId, nativeSessionId: native }, {
      startPeer: async options => {
        // Exercise a real installed CLI process exiting before initialization,
        // rather than throwing from a mocked native fork completer.
        const peer = await startSuStdioPeer({ ...options,
          ...(startupFailure ? { args: ['app-server', '--p008-invalid-startup-option'] } : {}) });
        if (!startupFailure) peers.push(peer); // the failed peer is drained by the subject
        return { ...peer, request: async (frame, timeout) => {
          methods.push(frame.method); const result = await peer.request(frame, timeout);
          if (stale && frame.method === 'thread/fork') {
            attemptedNativeId = String((result.thread as RpcFrame).id);
            await h.sql`UPDATE harness_shared.adv_sessions SET session_id = ${randomUUID()} WHERE id = ${parentId}`;
          }
          return result;
        } };
      },
    });
    if (startupFailure) {
      await expect(result).rejects.toThrow(/Structured engine exited|unexpected argument/);
      const [child] = await h.sql`SELECT session_id, launch_spec FROM harness_shared.adv_sessions WHERE id = ${childId}`;
      expect(child.session_id).toBeNull(); expect(child.launch_spec).not.toHaveProperty('nativeFork');
      const [after] = await h.sql`SELECT * FROM harness_shared.adv_sessions WHERE id = ${parentId}`;
      expect(after).toEqual(before);
      expect(await findCodexRolloutPathByUuid(native, { homeOverride: childHome })).toBeNull();
      expect(methods).not.toContain('thread/fork');
    } else if (stale) {
      await expect(result).rejects.toThrow('lineage registration refused');
      const [child] = await h.sql`SELECT session_id, launch_spec FROM harness_shared.adv_sessions WHERE id = ${childId}`;
      expect(child.session_id).toBeNull(); expect(child.launch_spec).not.toHaveProperty('nativeFork');
      expect(attemptedNativeId).toBeTruthy();
      expect(await findCodexRolloutPathByUuid(attemptedNativeId!, { homeOverride: childHome })).toBeNull();
      expect(await findCodexRolloutPathByUuid(native, { homeOverride: childHome })).toBeNull();
      // A removed rollout must not leave an addressable native thread or an
      // indexed ancestor in the failed child's otherwise preserved home.
      for (const file of ['state_5.sqlite', 'thread_history_1.sqlite']) {
        const db = new Database(join(childHome, file), { readonly: true, fileMustExist: true });
        try {
          const table = file === 'state_5.sqlite' ? 'threads' : 'thread_turns';
          const column = file === 'state_5.sqlite' ? 'id' : 'thread_id';
          expect(db.prepare(`SELECT ${column} FROM ${table} WHERE ${column} IN (?, ?)`)
            .all(native, attemptedNativeId), `${file} must not retain an unregistered fork`).toEqual([]);
        } finally { db.close(); }
      }
    } else {
      const fork = await result;
      const [child] = await h.sql`SELECT session_id, launch_spec FROM harness_shared.adv_sessions WHERE id = ${childId}`;
      expect(child.session_id).toBe(fork.nativeSessionId); expect(child.session_id).not.toBe(native);
      expect(child.launch_spec.nativeFork).toEqual({ advSessionId: parentId, ownerId: 'su-parent', nativeSessionId: native });
      // The launcher resumes this registered UUID in a PTY after its preparing
      // app-server has exited. Exercise that installed CLI, including terminal
      // negotiation, rather than substituting another thread/resume RPC.
      const tui = spawnPty('codex', ['resume', fork.nativeSessionId, 'CHILD_PTY_RESUME_MARKER',
        '--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox',
        '--dangerously-bypass-hook-trust', '-C', root], {
        cwd: root, cols: 120, rows: 30,
        env: { PATH: process.env.PATH!, HOME: process.env.HOME!, CODEX_HOME: childHome, TERM: 'xterm-256color' },
      });
      let output = '', probeTail = '';
      const exited = new Promise<void>(done => tui.onExit(() => done()));
      const data = tui.onData(chunk => {
        output = (output + chunk).slice(-65_536);
        const probes = probeTail + chunk; probeTail = probes.slice(-3);
        if (probes.includes('\x1b[6n')) tui.write('\x1b[1;1R');
      });
      try {
        await vi.waitFor(() => {
          expect(bodies.length, output).toBe(2);
          expect(JSON.stringify(bodies[1])).toContain('PARENT_VISIBLE_HISTORY');
          expect(JSON.stringify(bodies[1])).toContain('CHILD_PTY_RESUME_MARKER');
          expect(output).toContain('ACK');
        }, { timeout: 25_000 });
      } finally {
        tui.kill('SIGTERM');
        const killTimer = setTimeout(() => tui.kill('SIGKILL'), 2000);
        try { await exited; } finally { clearTimeout(killTimer); data.dispose(); }
      }
      const [after] = await h.sql`SELECT * FROM harness_shared.adv_sessions WHERE id = ${parentId}`;
      expect(after).toEqual(before);
      await expect(registerTrackedCodexFork({ workspaceId: workspace, childAdvSessionId: childId,
        childOwnerId: 'su-child', childNativeSessionId: randomUUID(), source: fork.nativeFork })).rejects.toThrow('registration refused');
    }
    if (!startupFailure) expect(methods).toContain('thread/fork');
    expect(methods).not.toContain('turn/start'); expect(calls).toBe(scenario === 'registered' ? 2 : 1);
    expect(readFileSync(prompt, 'utf8')).toBe('Child identity only');
    expect(readFileSync(join(childHome, 'config.toml'), 'utf8')).toBe(config);
  } finally { provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done())); }
}, 90_000);
