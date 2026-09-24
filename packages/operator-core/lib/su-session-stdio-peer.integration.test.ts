/** Real pipe framing, with opt-in installed-native protocol startup. The test
 * runner owns the subprocess cgroup; only DB-backed enrollment is substituted.
 * No model prompt, credential, SU launch, or native user interface is needed. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcFrame, SuStdioPeer } from './su-session-stdio-peer';

const NEVER_EMIT_MARKER = 'never-emit-me';

const processState = vi.hoisted(() => ({ children: new Map<string, ChildProcess>(), stderr: '', killFailure: '' }));
vi.mock('./task-manager/managed-spawn', () => ({ managedSpawn: async (binary: string, args: string[], _spec: unknown, options: { spawnOptions: object }) => {
  const child = spawn(binary, args, options.spawnOptions);
  const taskId = randomUUID(); processState.children.set(taskId, child);
  child.stderr?.on('data', (chunk) => { processState.stderr = (processState.stderr + chunk).slice(-1000); });
  return { child, taskId };
} }));
vi.mock('./task-manager/control', () => ({ killTask: async (taskId: string) => {
  processState.children.get(taskId)?.kill('SIGKILL');
  return processState.killFailure ? { ok: false, error: 'command_failed', detail: processState.killFailure } : { ok: true };
} }));
vi.mock('../../../apps/operator/scripts/psu-launcher.mjs', () => ({ startSupervisorBeat: vi.fn() }));
import { startSuStdioPeer } from './su-session-stdio-peer';

const peers: SuStdioPeer[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  processState.children.clear(); processState.stderr = ''; processState.killFailure = '';
});

async function peer(binary: string, args: string[], env: NodeJS.ProcessEnv = {}, onMessage = (_frame: RpcFrame) => {}) {
  const home = mkdtempSync(join(tmpdir(), 'pui-native-protocol-')); homes.push(home);
  const result = await startSuStdioPeer({ binary, args, cwd: home,
    env: { PATH: process.env.PATH, CODEX_HOME: home, PI_CODING_AGENT_DIR: home, ...env },
    workspaceId: 'protocol-test', ownerId: 'su-protocol-test',
    spec: { class: 'test', title: 'PUI native protocol test', launchedBy: 'vitest', argv: [binary, ...args] }, onMessage });
  peers.push(result); return result;
}

describe('native JSON-line pipe transport', () => {
  it('preserves the tracked teardown cause while redacting credentials', async () => {
    const secret = NEVER_EMIT_MARKER;
    const p = await peer(process.execPath, ['-e', `
      setInterval(()=>{},1000);
      process.stdin.on('data',line=>process.stdout.write(JSON.stringify({id:JSON.parse(line).id,result:{ready:true}})+'\\n'));
    `], { PUI_TEST_SECRET: secret });
    await p.request({ method: 'initialize' });
    processState.killFailure = `Unit pc-test.scope not loaded; credential=${secret}`;
    try {
      const failure = await p.close().catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('Unit pc-test.scope not loaded');
      expect((failure as Error).message).not.toContain(secret);
    } finally {
      peers.splice(peers.indexOf(p), 1);
      await p.done;
    }
  });

  it('separates responses, notifications and server requests across fragmented writes', async () => {
    const events: RpcFrame[] = [];
    const p = await peer(process.execPath, ['-e', `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line); const frames=JSON.stringify({id:r.id,result:{ack:true}})+'\\n'+
          JSON.stringify({method:'item/started',params:{id:'tool'}})+'\\n'+
          JSON.stringify({id:'server-request',method:'ask',params:{}})+'\\n';
        process.stdout.write(frames.slice(0,8));setTimeout(()=>process.stdout.write(frames.slice(8)),5);
      });
    `], {}, (frame) => events.push(frame));
    await expect(p.request({ method: 'turn/start' })).resolves.toEqual({ ack: true });
    await vi.waitFor(() => expect(events).toEqual([
      { method: 'item/started', params: { id: 'tool' } }, { id: 'server-request', method: 'ask', params: {} },
    ]));
  });

  it('reports native refusal and unknown delivery without sending again', async () => {
    const p = await peer(process.execPath, ['-e', `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line); if(r.type==='refuse') process.stdout.write(JSON.stringify({type:'response',id:r.id,success:false,error:'refused'})+'\\n');
      });
    `]);
    await expect(p.request({ type: 'refuse' })).rejects.toThrow('refused');
    await expect(p.request({ type: 'unknown' }, 40)).rejects.toThrow('delivery is unknown');
  });

  it('fails outstanding requests when a peer emits corrupt protocol', async () => {
    const p = await peer(process.execPath, ['-e', "process.stdin.once('data',()=>process.stdout.write('not json\\n'))"]);
    await expect(p.request({ method: 'initialize' })).rejects.toThrow();
    await expect(p.done).rejects.toThrow();
  });

  it('retains a bounded startup diagnostic and redacts credentials split across stderr writes', async () => {
    const secret = NEVER_EMIT_MARKER;
    const p = await peer(process.execPath, ['-e', `
      process.stdin.once('data',()=>{
        const secret=process.env.PUI_TEST_SECRET;
        process.stderr.write('x'.repeat(20000)+'\\nNative config refused\\nAuthorization: Bearer '+secret.slice(0,12));
        setTimeout(()=>process.stderr.write(secret.slice(12)+'\\n',()=>process.exit(7)),5);
      });
    `], { PUI_TEST_SECRET: secret });
    const failure = await p.request({ method: 'initialize' }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('Native config refused');
    expect(message).toContain('[redacted]');
    expect(message).not.toContain(secret);
    expect(message.length).toBeLessThanOrEqual(3000);
    await expect(p.done).rejects.toThrow('Native config refused');
  });
});

describe.skipIf(process.env.PUI_NATIVE_PROTOCOL !== '1')('installed native protocol startup', () => {
  it('Codex preserves native turn metadata on a loopback Responses request without provider inference', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      // An intentional local refusal ends this wire-format probe. No provider,
      // credential, model inference, or synthetic charged-usage record is used.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'local protocol probe complete', type: 'invalid_request_error' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    let p: SuStdioPeer | undefined;
    try {
      const overrides = {
        model_provider: 'cache_protocol_probe',
        'model_providers.cache_protocol_probe.name': 'Local protocol fixture',
        'model_providers.cache_protocol_probe.base_url': `http://127.0.0.1:${address.port}/v1`,
        'model_providers.cache_protocol_probe.wire_api': 'responses',
        'model_providers.cache_protocol_probe.requires_openai_auth': false,
        'model_providers.cache_protocol_probe.supports_websockets': false,
        'model_providers.cache_protocol_probe.request_max_retries': 0,
        'model_providers.cache_protocol_probe.stream_max_retries': 0,
        'features.apps': false,
        'features.shell_tool': false,
        web_search: 'disabled',
      };
      p = await peer('codex', ['app-server', ...Object.entries(overrides).flatMap(([key, value]) =>
        ['-c', `${key}=${JSON.stringify(value)}`])]);
      await p.request({ method: 'initialize', params: {
        clientInfo: { name: 'papercusp_cache_protocol_test', version: '1' },
        capabilities: { experimentalApi: true },
      } });
      p.send({ method: 'initialized', params: {} });
      const started = await p.request({ method: 'thread/start', params: {
        model: 'gpt-6-sol', modelProvider: 'cache_protocol_probe',
        cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'read-only',
      } });
      const threadId = (started.thread as RpcFrame).id;
      const turn = await p.request({ method: 'turn/start', params: {
        threadId, input: [{ type: 'text', text: 'Offline wire-format probe; the local endpoint will refuse.' }],
        responsesapiClientMetadata: { cache_eval_case: 'native-correlation-control' },
      } });
      await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 20_000 });
      const clientMetadata = requests[0].client_metadata as Record<string, string>;
      const metadata = JSON.parse(clientMetadata['x-codex-turn-metadata']) as Record<string, string>;
      expect(metadata).toMatchObject({
        thread_id: threadId,
        turn_id: (turn.turn as RpcFrame).id,
        cache_eval_case: 'native-correlation-control',
      });
    } finally {
      try {
        if (p) { await p.close(); peers.splice(peers.indexOf(p), 1); }
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  }, 90_000);

  it('Codex accepts the SU launch flags and app-server handshake', async () => {
    const p = await peer('codex', ['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', 'app-server']);
    let init: RpcFrame;
    try { init = await p.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_pui', version: '1' } } }); }
    catch (error) { throw new Error(`${String(error)}; native startup diagnostic: ${processState.stderr}`); }
    expect(init).toHaveProperty('userAgent');
    p.send({ method: 'initialized', params: {} });
    const started = await p.request({ method: 'thread/start', params: { cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'danger-full-access' } });
    expect(started).toMatchObject({ thread: { id: expect.any(String) }, model: expect.any(String) });
    // A real id exists before the first turn creates its rollout. Readiness
    // must not be presented as persisted exact-resume support in this window.
    await expect(p.request({ method: 'thread/resume', params: { threadId: (started.thread as RpcFrame).id } }))
      .rejects.toThrow('no rollout found');
    const servers = await p.request({ method: 'mcpServerStatus/list', params: {} });
    expect(Array.isArray(servers.data)).toBe(true);
  }, 90_000);

  it('OMP exposes its assigned session and tool catalog through RPC', async () => {
    const p = await peer('omp', ['--mode', 'rpc', '--no-title', '--no-extensions', '--no-skills', '--no-lsp', '--no-session']);
    let state: RpcFrame;
    try { state = await p.request({ type: 'get_state' }); }
    catch (error) { throw new Error(`${String(error)}; native startup diagnostic: ${processState.stderr}`); }
    expect(state).toMatchObject({ sessionId: expect.any(String), model: { id: expect.any(String) }, dumpTools: expect.any(Array) });
    await expect(p.request({ type: 'abort' })).resolves.toEqual({});
  }, 90_000);
});
