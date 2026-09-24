/** Real pipe framing, with opt-in installed-native protocol startup. The test
 * runner owns the subprocess cgroup; only DB-backed enrollment is substituted.
 * Scripted loopback Responses fixtures perform no provider inference. The
 * separately opted-in platform case inherits only this caller's MCP credential;
 * no SU launch, provider credential, or native user interface is needed. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RpcFrame, SuStdioPeer, SuStdioReceipt } from './su-session-stdio-peer';

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
import { processMonotonicClock } from './process-monotonic-clock';
import { inspectCarryNativeTurn, inspectCarrySourceRead, createCarryTrialRecipe, inspectCarryTaskResponse, inspectCarryPreparationResponse,
  inspectCarryRequestPopulation, inspectCarryNativePopulation, type CarryCanonicalUsageRow } from './launch-cost/launch-cost-metrics';
import { captureCarryCanonicalUsagePopulation, captureCarryRequestEvidence } from './launch-cost/scan-launch-transcripts';
import { GatewayRequestTelemetry } from './inference-gateway/request-stage-telemetry';
import * as dbOrg from '@papercusp/db-org';
import * as workspaceRegistry from './workspace-registry';
import { createOrgTestDb } from '../test/_org-test-db';
import { ingestInteractiveUsage } from './interactive-usage/ingest-claude-transcripts';
import { parseCodexChunk, codexSessionIdForFile } from './interactive-usage/ingest-adapters';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from './inference-gateway/codex-cli-bridge';
import sourceReadTool from './agent-tools/capability/read';
import { captureCompletedCarrySource, recheckCarrySourceSnapshot, captureCarryNativeConfiguration,
  captureCarryArtifactManifest, recheckCarryArtifactManifest, captureCarryRuntimeSnapshot, recheckCarryRuntimeSnapshot,
  type CarrySourceSnapshot } from './launch-cost/scan-launch-transcripts';

const peers: SuStdioPeer[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  processState.children.clear(); processState.stderr = ''; processState.killFailure = '';
});

async function peer(binary: string, args: string[], env: NodeJS.ProcessEnv = {}, onMessage = (_frame: RpcFrame) => {}, config?: string,
  onReceipt?: (receipt: SuStdioReceipt) => void, existingHome?: string) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'pui-native-protocol-'));
  if (!existingHome) homes.push(home);
  if (config) writeFileSync(join(home, 'config.toml'), config, { mode: 0o600 });
  const result = await startSuStdioPeer({ binary, args, cwd: home,
    env: { PATH: process.env.PATH, CODEX_HOME: home, PI_CODING_AGENT_DIR: home, ...env },
    workspaceId: 'protocol-test', ownerId: 'su-protocol-test',
    spec: { class: 'test', title: 'PUI native protocol test', launchedBy: 'vitest', argv: [binary, ...args] }, onMessage, onReceipt });
  peers.push(result); return result;
}

async function waitForMcpStartup(events: RpcFrame[], threadId: string, name: string) {
  const terminal = () => events.find(frame => frame.method === 'mcpServer/startupStatus/updated' &&
    (frame.params as RpcFrame).threadId === threadId && (frame.params as RpcFrame).name === name &&
    ['ready', 'failed', 'cancelled'].includes(String((frame.params as RpcFrame).status)));
  await vi.waitFor(() => expect(terminal() !== undefined).toBe(true), { timeout: 15_000 });
  // Native errors may echo a credential or URL. Report only recognized cause
  // labels; the original frame remains private and never enters assertion output.
  const detail = JSON.stringify((terminal()!.params as RpcFrame).error ?? null);
  const causes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'connection refused', 'connection closed',
    'timed out', 'Unauthorized', 'Forbidden', '404', '401', '403', '502', '503', 'parse', 'initialize']
    .filter(label => detail.toLowerCase().includes(label.toLowerCase()));
  expect((terminal()!.params as RpcFrame).status, `MCP startup causes: ${causes.join(', ') || 'unclassified'}`).toBe('ready');
}

describe('native JSON-line pipe transport', () => {
  it('reports a recognized MCP startup cause without echoing private native error text', async () => {
    const failure = [{ method: 'mcpServer/startupStatus/updated', params: { threadId: 'thread', name: 'fixture',
      status: 'failed', error: 'HTTP 401 Unauthorized: Bearer PRIVATE_MARKER at https://private.example/secret' } }];
    const error = await waitForMcpStartup(failure, 'thread', 'fixture').catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Unauthorized, 401');
    expect(error.message).not.toMatch(/PRIVATE_MARKER|private\.example|secret/);
    await expect(waitForMcpStartup([{ method: 'mcpServer/startupStatus/updated', params: {
      threadId: 'thread', name: 'fixture', status: 'failed', error: 'PRIVATE_UNKNOWN_REASON' } }], 'thread', 'fixture'))
      .rejects.toThrow('MCP startup causes: unclassified');
  });

  it('shares an immutable process clock locally while refusing a subprocess clock as the same domain', async () => {
    expect(Object.isFrozen(processMonotonicClock)).toBe(true);
    const receipts: SuStdioReceipt[] = [];
    const clockUrl = new URL('./process-monotonic-clock.ts', import.meta.url).href;
    const child = await peer(process.execPath, ['--input-type=module', '-e', `
      import { processMonotonicClock } from ${JSON.stringify(clockUrl)};
      import { createInterface } from 'node:readline';
      createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({id:request.id,result:{
          clockId:processMonotonicClock.id,atMs:processMonotonicClock.now()
        }}) + String.fromCharCode(10));
      });
    `], {}, undefined, undefined, receipt => receipts.push(receipt));
    const observation = await child.request({ method: 'clock' });
    expect(observation.clockId).toMatch(/^process-monotonic:/);
    expect(observation.clockId).not.toBe(processMonotonicClock.id);
    expect(Number.isFinite(observation.atMs)).toBe(true);
    expect(receipts.every(receipt => receipt.clockId === processMonotonicClock.id)).toBe(true);
  });

  it('captures immutable wire values before consumers mutate them, with one clock across peers', async () => {
    const receipts: SuStdioReceipt[] = [];
    const onReceipt = (value: SuStdioReceipt) => receipts.push(value);
    const command = ['-e', `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line);
        process.stdout.write(JSON.stringify({id:r.id,result:{echo:r.params}})+'\\n'+
          JSON.stringify({method:'notice',params:{value:'original'}})+'\\n');
      });
    `];
    const a = await peer(process.execPath, command, {}, frame => {
      expect(receipts.at(-1)?.phase).toBe('received');
      (frame.params as RpcFrame).value = 'mutated-event';
    }, undefined, onReceipt);
    const b = await peer(process.execPath, command, {}, undefined, undefined, onReceipt);
    const frame = { method: 'turn/start', params: { value: 'original' } };
    const pending = a.request(frame);
    frame.params.value = 'mutated-input';
    const response = await pending;
    (response.echo as RpcFrame).value = 'mutated-response';
    await b.request({ method: 'initialize' });
    await vi.waitFor(() => expect(receipts.filter(r => r.phase === 'received' && r.frame.method === 'notice')).toHaveLength(2));
    expect(new Set(receipts.map(r => r.clockId)).size).toBe(1);
    expect(new Set(receipts.map(r => r.peerId)).size).toBe(2);
    for (const peerId of new Set(receipts.map(r => r.peerId))) {
      const observed = receipts.filter(r => r.peerId === peerId);
      expect(observed.map(r => r.sequence)).toEqual(observed.map((_, index) => index + 1));
      expect(observed[0].phase).toBe('write-started');
      expect(observed.some(r => r.phase === 'write-completed')).toBe(true);
      for (let i = 0; i < observed.length; i++) {
        expect(Number.isFinite(observed[i].atMs)).toBe(true);
        if (i) expect(observed[i].atMs).toBeGreaterThanOrEqual(observed[i - 1].atMs);
      }
    }
    const writes = receipts.filter(r => r.frame.method === 'turn/start');
    expect(writes.map(r => r.phase)).toEqual(['write-started', 'write-completed']);
    expect(writes.map(r => r.frame.params)).toEqual([{ value: 'original' }, { value: 'original' }]);
    expect(receipts.find(r => r.phase === 'received' && (r.frame.result as RpcFrame)?.echo)?.frame.result)
      .toEqual({ echo: { value: 'original' } });
    expect(receipts.filter(r => r.frame.method === 'notice').map(r => r.frame.params))
      .toEqual([{ value: 'original' }, { value: 'original' }]);
    expect(receipts.some(r => /provider|dispatch/.test(r.phase))).toBe(false);
    expect(a.receiptState!()).toMatchObject({ enabled: true, exited: false, sinkFailed: false });
    await a.close(); await b.close();
    for (const p of [a, b]) {
      const state = p.receiptState!();
      expect(state).toMatchObject({ exited: true, pendingWrites: 0, sinkFailed: false });
      expect(state.emitted).toBe(receipts.filter(r => r.peerId === state.peerId).length);
    }
  });

  it('fails closed before writing if the receipt sink cannot retain the attempt', async () => {
    const p = await peer(process.execPath, ['-e', `
      process.stdin.on('data',()=>process.stdout.write('unexpected-send\\n'));
    `], {}, undefined, undefined, () => { throw new Error('receipt storage unavailable'); });
    await expect(p.request({ method: 'turn/start' })).rejects.toThrow('receipt storage unavailable');
    await expect(p.done).rejects.toThrow('receipt storage unavailable');
    expect(p.receiptState!()).toMatchObject({ enabled: true, sinkFailed: true, emitted: 1 });
    await expect(p.request({ method: 'turn/start' })).rejects.toThrow('connection is closed');
  });

  it.each(['write-completed', 'received'] as const)('surfaces receipt failure after a possible send (%s) without replay', async phase => {
    const receipts: SuStdioReceipt[] = [];
    const p = await peer(process.execPath, ['-e', `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>
        process.stdout.write(JSON.stringify({id:JSON.parse(line).id,result:{ack:true}})+'\\n'));
    `], {}, undefined, undefined, value => {
      receipts.push(value);
      if (value.phase === phase) throw new Error(`cannot retain ${phase}`);
    });
    await expect(p.request({ method: 'turn/start' })).rejects.toThrow(`cannot retain ${phase}`);
    await expect(p.done).rejects.toThrow(`cannot retain ${phase}`);
    expect(receipts.filter(r => r.phase === 'write-started')).toHaveLength(1);
    await expect(p.request({ method: 'turn/start' })).rejects.toThrow('connection is closed');
  });

  it('isolates the wire and later receipts from a sink mutating its own frame', async () => {
    const receipts: SuStdioReceipt[] = [];
    const p = await peer(process.execPath, ['-e', `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line);process.stdout.write(JSON.stringify({id:r.id,result:r.params})+'\\n');
      });
    `], {}, undefined, undefined, value => {
      receipts.push(value);
      if (value.phase === 'write-started') (value.frame.params as RpcFrame).value = 'changed-by-sink';
    });
    await expect(p.request({ method: 'turn/start', params: { value: 'wire-value' } })).resolves.toEqual({ value: 'wire-value' });
    expect(receipts.find(r => r.phase === 'write-completed')?.frame.params).toEqual({ value: 'wire-value' });
  });

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
  it('observes the installed native runtime before opening a thread without provider inference', async () => {
    // This fixture observes only the idle core runtime. Freeze its launch
    // without optional shell/plugin startup work; the default native startup
    // was measured spawning git/git-remote-http while the census ran. This
    // configuration is fixture-only, never a production policy change.
    const p = await peer('codex', ['app-server', '-c', 'features.shell_snapshot=false', '-c', 'features.shell_tool=false',
      '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false']);
    await p.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_runtime_inventory_test', version: '1' } } });
    // No thread or inference request. Thread startup legitimately spawns
    // transient children; a frozen live PID tree is not a run admission gate.
    const runtime = await captureCarryRuntimeSnapshot(p.pid()!);
    expect(runtime.rootPid).toBe(p.pid());
    expect(runtime.processes.some(process => process.pid === p.pid())).toBe(true);
    expect(runtime.processes.some(process => /\/codex$/.test(process.executable))).toBe(true);
    expect(runtime.artifacts.some(a => /\/codex$/.test(a.filePath))).toBe(true);
    expect(runtime.processes.every(p => p.mappedFiles.includes(p.executable))).toBe(true);
    await recheckCarryRuntimeSnapshot(runtime);
    expect(runtime.evidenceKind).toBe('observation-only');
  }, 30_000);

  it.each([false, true])('does not mistake accepted output-limit configuration for native enforcement (configured %s)', async configured => {
    const requests: Array<Record<string, unknown>> = [], events: RpcFrame[] = [];
    const requestedLimit = 16;
    // This scripted result intentionally exceeds the proposed bound. Its usage
    // is fixture data, not a measurement of provider tokens or provider limits.
    const reply = 'offline unbounded response '.repeat(256);
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol',
        text: reply, inputTokens: 100, outputTokens: 2048 })));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    let p: SuStdioPeer | undefined;
    try {
      const config = stringifyToml({
        model_provider: 'cache_protocol_probe',
        model_providers: { cache_protocol_probe: { name: 'Local protocol fixture',
          base_url: `http://127.0.0.1:${address.port}/v1`, wire_api: 'responses', requires_openai_auth: false,
          supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 } },
        features: { apps: false, shell_tool: false }, web_search: 'disabled',
        // Neither spelling is a documented Codex output-limit setting. Test
        // the tempting assumption explicitly: a readable config is not proof
        // that the native request contains, or the client enforces, a bound.
        ...(configured ? { model_max_output_tokens: requestedLimit, max_output_tokens: requestedLimit } : {}),
      } as Parameters<typeof stringifyToml>[0]);
      p = await peer('codex', ['app-server'], {}, frame => events.push(frame), config);
      await p.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_cache_output_bound_test', version: '1' } } });
      p.send({ method: 'initialized', params: {} });
      const start = await p.request({ method: 'thread/start', params: { model: 'gpt-6-sol', modelProvider: 'cache_protocol_probe',
        cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'read-only' } });
      const threadId = String((start.thread as RpcFrame).id);
      const turn = await p.request({ method: 'turn/start', params: {
        threadId, input: [{ type: 'text', text: 'Offline native output-bound counterexample.' }],
      } });
      const turnId = String((turn.turn as RpcFrame).id);
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        method: 'turn/completed', params: expect.objectContaining({ threadId,
          turn: expect.objectContaining({ id: turnId, status: 'completed' }) }),
      })), { timeout: 20_000 });
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty('max_output_tokens');
      expect(requests[0]).not.toHaveProperty('max_completion_tokens');
      const threadRead = await p.request({ method: 'thread/read', params: { threadId, includeTurns: true } });
      const trace = inspectCarryNativeTurn({ threadId, turnId, events, threadRead, allowedMcpCalls: [] });
      expect(trace.status).toBe('verified');
      const items = ((threadRead.thread as RpcFrame).turns as RpcFrame[])[0].items as RpcFrame[];
      expect(items.find(item => item.type === 'agentMessage')?.text).toBe(reply);
      // Exact completed output, not just HTTP receipt, falsifies client-side
      // clipping for these settings. No output-bound receipt may be minted.
      expect(reply.length).toBeGreaterThan(requestedLimit * 100);
    } finally {
      try {
        if (p) { await p.close(); peers.splice(peers.indexOf(p), 1); }
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  }, 90_000);

  it.skipIf(process.env.PUI_NATIVE_PLATFORM_MCP !== '1').each([false, true])(
    'resolves the inherited platform caller through native MCP without provider inference (preauthorized %s)', async preauthorized => {
    // Explicit opt-in uses ONLY this session's existing MCP bearer and client.
    // Never copy its provider/auth.json, hooks, instructions, or model routing.
    const inherited = parseToml(readFileSync(join(process.env.CODEX_HOME!, 'config.toml'), 'utf8'));
    const mcp = (inherited.mcp_servers as Record<string, Record<string, unknown>>)['papercusp-su'];
    const url = new URL(String(mcp.url));
    expect(url.searchParams.get('client')).toBe(process.env.PAPERCUSP_SID);
    expect(typeof (mcp.http_headers as Record<string, unknown>)?.Authorization === 'string').toBe(true);
    const events: RpcFrame[] = [], requests: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request = JSON.parse(Buffer.concat(chunks).toString()); requests.push(request);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (requests.length === 1) {
          // Use the name actually advertised by this installed client. A
          // guessed/flattened name is not evidence of a successful MCP call.
          const namespace = request.tools.find((entry: Record<string, unknown>) => entry.type === 'namespace' &&
            (entry.tools as Array<Record<string, unknown>>).some(tool => tool.name === 'tools_invoke'));
          if (!namespace) throw new Error('Native tools_invoke namespace missing');
          const item = { id: 'fc_identity', type: 'function_call', call_id: 'identity-call',
            namespace: namespace.name, name: 'tools_invoke',
            arguments: JSON.stringify({ name: 'coord:whoami', args: {} }), status: 'completed' };
          const body = { ...codexCliResponsesBody({ model: 'gpt-6-sol', text: '', inputTokens: 0, outputTokens: 0 }), output: [item] };
          const event = (type: string, payload: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
          res.end(event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }) +
            event('response.output_item.done', { output_index: 0, item }) + event('response.completed', { response: body }));
        } else {
          res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol',
            text: '{"offline":true}', inputTokens: 0, outputTokens: 0 })));
        }
      } catch { errors.push('Local scripted response failed'); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    let p: SuStdioPeer | undefined;
    try {
      const config = stringifyToml({
        model_provider: 'cache_protocol_probe',
        model_providers: { cache_protocol_probe: { name: 'Local protocol fixture',
          base_url: `http://127.0.0.1:${address.port}/v1`, wire_api: 'responses', requires_openai_auth: false,
          supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 } },
        features: { apps: false, shell_tool: false }, web_search: 'disabled',
        // Filters and native receipts use the original MCP name, whereas the
        // Responses function name is normalized to tools_invoke.
        mcp_servers: { 'papercusp-su': { url: String(mcp.url), http_headers: mcp.http_headers,
          enabled_tools: ['tools:invoke'],
          ...(preauthorized ? { tools: { 'tools:invoke': { approval_mode: 'approve' } } } : {}) } },
      } as Parameters<typeof stringifyToml>[0]);
      p = await peer('codex', ['app-server'], {}, frame => events.push(frame), config);
      await p.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_cache_identity_test', version: '1' } } });
      p.send({ method: 'initialized', params: {} });
      const start = await p.request({ method: 'thread/start', params: { model: 'gpt-6-sol', modelProvider: 'cache_protocol_probe',
        cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'read-only' } });
      const threadId = String((start.thread as RpcFrame).id);
      await waitForMcpStartup(events, threadId, 'papercusp-su');
      const before = await p.request({ method: 'config/read', params: { cwd: homes.at(-1), includeLayers: true } });
      const inventory = await p.request({ method: 'mcpServerStatus/list', params: { threadId, detail: 'toolsAndAuthOnly' } });
      expect(inventory.nextCursor == null).toBe(true);
      const entries = inventory.data as Array<Record<string, unknown>>;
      expect(entries.map(entry => entry.name)).toEqual(['papercusp-su']);
      expect(entries[0].toolsError == null).toBe(true);
      expect(entries[0].authStatus).toBe('bearerToken');
      expect(entries[0].runtimeStatus).toBe('connected');
      expect(Object.keys(entries[0].tools as object), JSON.stringify({ auth: entries[0].authStatus,
        runtime: entries[0].runtimeStatus, names: Object.keys(entries[0].tools as object).filter(name => /invoke/.test(name)) }))
        .toHaveLength(1);
      const response = await p.request({ method: 'turn/start', params: {
        threadId, input: [{ type: 'text', text: 'Offline native identity receipt fixture.' }],
      } });
      const turnId = String((response.turn as RpcFrame).id);
      await vi.waitFor(() => expect(events.some(frame => frame.method === 'turn/completed' &&
        (frame.params as RpcFrame)?.threadId === threadId)).toBe(true), { timeout: 30_000 });
      const threadRead = await p.request({ method: 'thread/read', params: { threadId, includeTurns: true } });
      const trace = inspectCarryNativeTurn({ threadId, turnId, events, threadRead,
        allowedMcpCalls: [{ server: 'papercusp-su', tool: 'tools:invoke', arguments: { name: 'coord:whoami', args: {} } }] });
      const items = ((threadRead.thread as RpcFrame).turns as RpcFrame[])[0].items as RpcFrame[];
      const call = items.find(item => item.type === 'mcpToolCall')!;
      const credential = String((mcp.http_headers as Record<string, unknown>).Authorization).replace(/^Bearer /, '');
      expect(trace.status, JSON.stringify({ missing: trace.missing, violations: trace.violations, call })
        .replaceAll(credential, '[redacted]')).toBe(preauthorized ? 'verified' : 'incomplete');
      if (preauthorized) {
        const content = (call.result as RpcFrame).content as Array<{ type: string; text?: string }>;
        const identities = content.flatMap(block => {
          try { const value = JSON.parse(block.text ?? ''); return value.ownerId ? [value] : []; } catch { return []; }
        });
        expect(identities).toHaveLength(1);
        expect(identities[0].ownerId).toBe(process.env.PAPERCUSP_SID);
        expect(identities[0].workspaceId).toBe(process.env.PAPERCUSP_WORKSPACE);
        expect(JSON.stringify(requests.at(-1)?.input).includes(process.env.PAPERCUSP_SID!)).toBe(true);
      } else {
        expect(call.result).toBeNull();
        expect((call.error as RpcFrame).message).toBe('MCP tool call requires approval, but approval policy is never');
      }
      // Compare as booleans: a failed assertion must never print bearer-bearing
      // native configuration, either on stdout or in the test-run ledger.
      const after = await p.request({ method: 'config/read', params: { cwd: homes.at(-1), includeLayers: true } });
      expect(isDeepStrictEqual(before, after)).toBe(true);
      const afterInventory = await p.request({ method: 'mcpServerStatus/list', params: { threadId, detail: 'toolsAndAuthOnly' } });
      expect(isDeepStrictEqual(inventory, afterInventory)).toBe(true);
      expect(requests).toHaveLength(2);
      expect(errors).toEqual([]);
      console.info('CARRY_NATIVE_IDENTITY_RECEIPT', JSON.stringify({ threadId, turnId, preauthorized,
        ownerId: preauthorized ? process.env.PAPERCUSP_SID : null,
        workspaceId: preauthorized ? process.env.PAPERCUSP_WORKSPACE : null,
        configSha256: createHash('sha256').update(JSON.stringify(before)).digest('hex'),
        toolInventorySha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'),
        nativeAuthStatus: entries[0].authStatus, nativeRuntimeStatus: entries[0].runtimeStatus,
        scriptedRequests: requests.length, providerInference: false }));
    } finally {
      try { if (p) { await p.close(); peers.splice(peers.indexOf(p), 1); } }
      finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    }
  }, 90_000);

  for (const platform of [false, true]) {
  it.skipIf(platform && process.env.PUI_NATIVE_PLATFORM_MCP !== '1').each(platform ? [true] : [false, true])(
    `cross-checks completed native item receipts against persisted history without provider inference (platform ${platform}, source read %s)`, async readSource => {
    const events: RpcFrame[] = [];
    const protocolReceipts: SuStdioReceipt[] = [];
    const recipe = createCarryTrialRecipe(), task = recipe.tasks.find(t => t.id === 'T1')!;
    // Scripted answer tests the controller/native/oracle seam, not model
    // correctness or carried-fact recovery. The source cases below retain
    // their separate attributed byte-window witness.
    const expectedResponse = readSource ? '{"offline":true}' : JSON.stringify(task.expected);
    const fixtureHome = mkdtempSync(join(tmpdir(), 'carry-source-receipt-')); homes.push(fixtureHome);
    let predecessor: CarrySourceSnapshot | undefined;
    const window = Buffer.from('cedar-48f6e9a2');
    let readArgs = { file_path: '', byte_offset: 0, byte_limit: window.length };
    const observedReads: unknown[] = [], httpErrors: unknown[] = [], mcpHosts: McpServer[] = [];
    const providerCalls: Array<Record<string, unknown>> = [];
    const serverName = platform ? 'papercusp-su' : 'cache_receipts';
    const toolName = platform ? 'tools:invoke' : 'capability_read';
    let functionNamespace = 'mcp__cache_receipts';
    const identityArgs = { name: 'coord:whoami', args: {} };
    const sourceArgs = () => platform ? { name: 'capability:read', args: readArgs } : readArgs;
    let privateMcpConfig: string | undefined;
    if (platform) {
      const inherited = parseToml(readFileSync(join(process.env.CODEX_HOME!, 'config.toml'), 'utf8'));
      const mcp = (inherited.mcp_servers as Record<string, Record<string, unknown>>)['papercusp-su'];
      expect(new URL(String(mcp.url)).searchParams.get('client')).toBe(process.env.PAPERCUSP_SID);
      expect(typeof (mcp.http_headers as Record<string, unknown>)?.Authorization === 'string').toBe(true);
      privateMcpConfig = stringifyToml({ mcp_servers: { 'papercusp-su': {
        url: mcp.url, http_headers: mcp.http_headers, enabled_tools: ['tools:invoke'],
        tools: { 'tools:invoke': { approval_mode: 'approve' } },
      } } } as Parameters<typeof stringifyToml>[0]);
    }
    let requests = 0, preparationRequests = 0, preparingSource = readSource;
    const server = createServer(async (req, res) => {
      if (req.url === '/mcp') {
        const host = new McpServer({ name: 'carry-receipt-fixture', version: '1' }); mcpHosts.push(host);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        try {
          expect(req.headers.authorization).toBe('Bearer offline-fixture');
          host.registerTool('capability_read', {
            inputSchema: { file_path: z.string(), byte_offset: z.number(), byte_limit: z.number() },
            annotations: { readOnlyHint: true },
          }, async args => {
            observedReads.push(args);
            // Real platform byte-window writer; only network/auth are fixtures.
            return await sourceReadTool.handler(args as never, { projectDir: fixtureHome } as never) as {
              content: Array<{ type: 'text'; text: string }>;
            };
          });
          await host.connect(transport);
          await transport.handleRequest(req, res);
        } catch (error) {
          httpErrors.push(error);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        }
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      providerCalls.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (preparingSource) preparationRequests++; else requests++;
      if (readSource && !preparingSource && requests <= (platform ? 2 : 1)) {
        if (platform) {
          const namespaces = providerCalls.at(-1)?.tools as Array<Record<string, unknown>>;
          const namespace = namespaces.find(entry => entry.type === 'namespace' &&
            (entry.tools as Array<Record<string, unknown>>).some(tool => tool.name === 'tools_invoke'));
          if (!namespace) { httpErrors.push('Missing native dispatcher namespace'); res.writeHead(500); res.end(); return; }
          functionNamespace = String(namespace.name);
        }
        const identity = platform && requests === 1;
        const item = { id: identity ? 'fc_identity' : 'fc_source', type: 'function_call',
          call_id: identity ? 'identity-call' : 'source-read-call', namespace: functionNamespace,
          name: platform ? 'tools_invoke' : 'capability_read',
          arguments: JSON.stringify(identity ? identityArgs : sourceArgs()), status: 'completed' };
        const body = { ...codexCliResponsesBody({ model: 'gpt-6-sol', text: '', inputTokens: 0, outputTokens: 0 }), output: [item] };
        const event = (type: string, payload: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }) +
          event('response.output_item.done', { output_index: 0, item }) + event('response.completed', { response: body }));
        return;
      }
      // Existing production SSE serializer, scripted local text only. These
      // zero fixture counters are never recorded as real provider usage.
      const body = codexCliResponsesBody({ model: preparingSource ? 'gpt-6-luna' : 'gpt-6-sol',
        text: preparingSource ? JSON.stringify(recipe.sourcePreparation.expectedAcknowledgement) : expectedResponse, inputTokens: 0, outputTokens: 0 });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(codexCliResponsesCompletionSse(body));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    let p: SuStdioPeer | undefined;
    try {
      const overrides = {
        model_provider: 'cache_protocol_probe',
        model_reasoning_effort: 'medium',
        'model_providers.cache_protocol_probe.name': 'Local protocol fixture',
        'model_providers.cache_protocol_probe.base_url': `http://127.0.0.1:${address.port}/v1`,
        'model_providers.cache_protocol_probe.wire_api': 'responses',
        'model_providers.cache_protocol_probe.requires_openai_auth': false,
        'model_providers.cache_protocol_probe.supports_websockets': false,
        'model_providers.cache_protocol_probe.request_max_retries': 0,
        'model_providers.cache_protocol_probe.stream_max_retries': 0,
        'features.apps': false, 'features.shell_tool': false, web_search: 'disabled',
        ...(readSource && !platform ? {
          'mcp_servers.cache_receipts.url': `http://127.0.0.1:${address.port}/mcp`,
          'mcp_servers.cache_receipts.http_headers.Authorization': 'Bearer offline-fixture',
        } : {}),
      };
      const nativeTurn = async () => {
        const expectedModel = preparingSource ? 'gpt-6-luna' : 'gpt-6-sol';
        p = await peer('codex', ['app-server', ...Object.entries(overrides).flatMap(([key, value]) =>
          ['-c', `${key}=${JSON.stringify(value)}`])], {}, frame => events.push(frame), privateMcpConfig,
        receipt => protocolReceipts.push(receipt));
        await p.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_cache_trace_test', version: '1' } } });
        p.send({ method: 'initialized', params: {} });
        const start = await p.request({ method: 'thread/start', params: {
          model: expectedModel, modelProvider: 'cache_protocol_probe', cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'read-only',
        } });
        expect(start.model).toBe(expectedModel);
        const threadId = String((start.thread as RpcFrame).id);
        if (readSource) await waitForMcpStartup(events, threadId, serverName);
        const nativeConfig = await captureCarryNativeConfiguration(p, { threadId, cwd: homes.at(-1)!,
          servers: readSource ? [{ name: serverName, tools: [toolName], authStatus: 'bearerToken' }] : [] });
        const manifest = await captureCarryArtifactManifest({
          protocolRef: 'installed-native-loopback-fixture:no-provider-inference', configuration: nativeConfig,
          dependencyScope: {
            recipeSha256: recipe.sha256,
            roots: [{ role: 'instrument', artifactIds: ['task-and-checker'] },
              { role: 'task', artifactIds: ['recipe-and-response-oracle'] },
              { role: 'seed', artifactIds: ['recipe-and-response-oracle'] },
              { role: 'checker', artifactIds: ['task-and-checker', 'recipe-and-response-oracle'] }],
            nodes: [
              { artifactId: 'task-and-checker', dependsOn: ['peer-executable', 'transport', 'capture', 'recipe-and-response-oracle', 'observation-clock'] },
              { artifactId: 'peer-executable', dependsOn: [] }, { artifactId: 'transport', dependsOn: ['observation-clock'] },
              { artifactId: 'capture', dependsOn: ['recipe-and-response-oracle'] },
              { artifactId: 'recipe-and-response-oracle', dependsOn: [] },
              { artifactId: 'observation-clock', dependsOn: [] },
            ],
            unresolved: ['fixture declares selected imports only; transitive JS and native dependencies are not censused',
              'default-run shell/plugin and transient/unloaded runtime scope remains unmeasured'],
          },
          artifacts: [
            // This is the launched peer's executable, not an assertion that a
            // wrapper's subprocesses or dynamic dependencies were censused.
            { id: 'peer-executable', filePath: `/proc/${p.pid()}/exe`, maxBytes: 512 * 1024 * 1024 },
            { id: 'task-and-checker', filePath: fileURLToPath(import.meta.url), maxBytes: 1024 * 1024 },
            { id: 'transport', filePath: fileURLToPath(new URL('./su-session-stdio-peer.ts', import.meta.url)), maxBytes: 1024 * 1024 },
            { id: 'observation-clock', filePath: fileURLToPath(new URL('./process-monotonic-clock.ts', import.meta.url)), maxBytes: 1024 * 1024 },
            { id: 'capture', filePath: fileURLToPath(new URL('./launch-cost/scan-launch-transcripts.ts', import.meta.url)), maxBytes: 1024 * 1024 },
            { id: 'recipe-and-response-oracle', filePath: fileURLToPath(new URL('./launch-cost/launch-cost-metrics.ts', import.meta.url)), maxBytes: 1024 * 1024 },
          ],
        });
        expect(manifest.evidenceKind).toBe('observation-only');
        expect(manifest.dependencyScope!.evidenceKind).toBe('declaration-only');
        expect(manifest.dependencyScope!.missingRoles).toEqual(['launcher', 'native-runtime', 'scripts', 'source', 'pricing']);
        expect(manifest.configuration.threadId).toBe(threadId);
        const inputText = preparingSource ? recipe.sourcePreparation.prompt : readSource ? 'Offline native receipt fixture.' : task.prompt;
        const response = await p.request({ method: 'turn/start', params: {
          threadId, input: [{ type: 'text', text: inputText }],
        } });
        const turnId = String((response.turn as RpcFrame).id);
        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
          method: 'turn/completed', params: expect.objectContaining({ threadId,
            turn: expect.objectContaining({ id: turnId, status: 'completed' }) }),
        })), { timeout: 20_000 });
        const threadRead = await p.request({ method: 'thread/read', params: { threadId, includeTurns: true } });
        const writes = protocolReceipts.filter(r => r.phase === 'write-started' && r.frame.method === 'turn/start' &&
          (r.frame.params as RpcFrame).threadId === threadId);
        expect(writes).toHaveLength(1);
        const ack = protocolReceipts.find(r => r.phase === 'received' && r.peerId === writes[0].peerId &&
          r.frame.id === writes[0].frame.id);
        expect(((ack?.frame.result as RpcFrame)?.turn as RpcFrame)?.id).toBe(turnId);
        const completed = protocolReceipts.filter(r => r.phase === 'received' && r.frame.method === 'turn/completed' &&
          (r.frame.params as RpcFrame).threadId === threadId && ((r.frame.params as RpcFrame).turn as RpcFrame).id === turnId);
        expect(completed).toHaveLength(1);
        expect(completed[0].atMs).toBeGreaterThanOrEqual(writes[0].atMs);
        // Check the actual native requests, including tool continuations, not
        // a model name in the prompt or scripted assistant self-identification.
        // This is client-side phase provenance only; the local endpoint has no
        // serving account and cannot establish real T5 provider correlation.
        expect(providerCalls.length).toBeGreaterThan(0);
        for (const call of providerCalls) {
          expect(call).toMatchObject({ model: expectedModel, reasoning: { effort: 'medium' } });
          const metadata = JSON.parse((call.client_metadata as Record<string, string>)['x-codex-turn-metadata']);
          expect(metadata).toMatchObject({ thread_id: threadId, turn_id: turnId });
        }
        await recheckCarryArtifactManifest(manifest, p);
        return { threadId, turnId, threadRead, inputText, rpcWrite: writes[0], completed: completed[0] };
      };
      let sourceCompleted: SuStdioReceipt | undefined;
      if (readSource) {
        const prepared = await nativeTurn();
        const preparationTrace = inspectCarryNativeTurn({ threadId: prepared.threadId, turnId: prepared.turnId,
          threadRead: prepared.threadRead, events, allowedMcpCalls: [], expectedInputText: recipe.sourcePreparation.prompt });
        expect(preparationTrace).toMatchObject({ status: 'verified', inputSha256: recipe.sourcePreparation.promptSha256,
          mcpItemIds: [], missing: [], violations: [] });
        expect(inspectCarryPreparationResponse(preparationTrace.finalResponse!)).toMatchObject({
          evidenceKind: 'response-only', matches: true, recipeSha256: recipe.sha256 });
        sourceCompleted = prepared.completed;
        predecessor = await captureCompletedCarrySource(p!, prepared.threadId, prepared.turnId);
        peers.splice(peers.indexOf(p!), 1); p = undefined;
        const byteOffset = predecessor.snapshot.bytes.indexOf(window);
        expect(byteOffset).toBeGreaterThan(0);
        readArgs = { file_path: predecessor.filePath, byte_offset: byteOffset, byte_limit: window.length };
        await recheckCarrySourceSnapshot(predecessor);
        preparingSource = false; events.length = 0; providerCalls.length = 0;
      }
      const { threadId, turnId, threadRead, inputText, rpcWrite, completed } = await nativeTurn();
      if (readSource) {
        // Native Codex received the platform result and returned it to the
        // next local provider request, not just a successful tools/list.
        expect(providerCalls[0]?.tools).toContainEqual(expect.objectContaining({ type: 'namespace', name: functionNamespace,
          tools: expect.arrayContaining([expect.objectContaining({ type: 'function', name: platform ? 'tools_invoke' : 'capability_read' })]) }));
        expect(JSON.stringify(providerCalls.at(-1)?.input), JSON.stringify({
          outputs: (providerCalls.at(-1)?.input as Array<Record<string, unknown>>)?.filter(item => item.type === 'function_call_output') }))
          .toContain(window.toString('base64'));
      }
      const evidence = { threadId, turnId, events, threadRead, expectedInputText: inputText, allowedMcpCalls: readSource
        ? [...(platform ? [{ server: serverName, tool: toolName, arguments: identityArgs }] : []),
          { server: serverName, tool: toolName, arguments: sourceArgs() }] : [] };
      const trace = inspectCarryNativeTurn(evidence);
      expect(trace,
        JSON.stringify({ threadRead, terminal: events.find(frame => frame.method === 'turn/completed') }))
        .toEqual({ status: 'verified', violations: [], missing: [], finalResponse: expectedResponse,
          inputSha256: createHash('sha256').update(inputText).digest('hex'),
          mcpItemIds: platform ? [expect.any(String), expect.any(String)] : readSource ? [expect.any(String)] : [] });
      if (!readSource) {
        expect(JSON.stringify(providerCalls[0].input)).toContain(JSON.stringify(task.prompt).slice(1, -1));
        const responseProof = inspectCarryTaskResponse({ taskId: task.id, response: trace.finalResponse! });
        expect(responseProof).toEqual({ evidenceKind: 'response-only', matches: true,
          taskId: task.id, oracleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          missing: [], violations: [], recipeSha256: recipe.sha256 });
        expect(responseProof).not.toHaveProperty('quality');
      }
      // Use the captured native frame arrival, not the later thread/read or
      // polling completion time. Full action/history validation above must
      // pass before this terminal response can count as useful even locally.
      const useful = protocolReceipts.filter(r => r.phase === 'received' && r.frame.method === 'item/completed' &&
        (r.frame.params as RpcFrame).threadId === threadId && (r.frame.params as RpcFrame).turnId === turnId &&
        ((r.frame.params as RpcFrame).item as RpcFrame).type === 'agentMessage' &&
        ((r.frame.params as RpcFrame).item as RpcFrame).text === expectedResponse);
      expect(useful).toHaveLength(1);
      expect(useful[0].atMs).toBeGreaterThanOrEqual(rpcWrite.atMs);
      expect(completed.atMs).toBeGreaterThanOrEqual(useful[0].atMs);
      expect(new Set(protocolReceipts.map(r => r.clockId)).size).toBe(1);
      if (sourceCompleted) {
        expect(sourceCompleted.peerId).not.toBe(rpcWrite.peerId);
        expect(rpcWrite.atMs).toBeGreaterThanOrEqual(sourceCompleted.atMs);
      }
      // Do not pass rpcWrite as measureCarryArmTiming.firstRequestDispatched:
      // the native engine still owns the later provider send, unobserved here.
      if (readSource) {
        expect(observedReads).toEqual(platform ? [] : [readArgs]);
        if (platform) {
          const items = ((threadRead.thread as RpcFrame).turns as RpcFrame[])[0].items as RpcFrame[];
          const identity = items.filter(item => item.type === 'mcpToolCall' &&
            (item.arguments as RpcFrame).name === 'coord:whoami');
          expect(identity).toHaveLength(1);
          const receipts = ((identity[0].result as RpcFrame).content as Array<{ text?: string }>).flatMap(block => {
            try { const value = JSON.parse(block.text ?? ''); return value.ownerId ? [value] : []; } catch { return []; }
          });
          expect(receipts).toHaveLength(1);
          expect(receipts[0].ownerId).toBe(process.env.PAPERCUSP_SID);
          expect(receipts[0].workspaceId).toBe(process.env.PAPERCUSP_WORKSPACE);
        }
        const sourceRef = `codex:${predecessor!.threadId}/${predecessor!.turnId}@${predecessor!.snapshot.sha256}`;
        expect(inspectCarrySourceRead(evidence, { sourceRef,
          server: serverName, tool: toolName, filePath: predecessor!.filePath,
          byteOffset: readArgs.byte_offset, byteLength: window.length,
          totalBytes: predecessor!.snapshot.completeBytes, sha256: createHash('sha256').update(window).digest('hex') }))
          .toMatchObject({ status: 'verified', missing: [], violations: [], sourceRef });
        await recheckCarrySourceSnapshot(predecessor!);
        expect(threadId).not.toBe(predecessor!.threadId);
      }
      expect(httpErrors).toEqual([]);
      expect(requests).toBe(platform ? 3 : readSource ? 2 : 1);
      expect(preparationRequests).toBe(readSource ? 1 : 0);
      const source = await captureCompletedCarrySource(p!, threadId, turnId);
      expect(source.filePath).toBe((threadRead.thread as RpcFrame).path);
      expect(source.snapshot.completeBytes).toBeGreaterThan(0);
      expect(source.snapshot.highWaterBytes).toBe(source.snapshot.completeBytes);
      await expect(recheckCarrySourceSnapshot(source)).resolves.toBeUndefined();
      if (platform) console.info('CARRY_NATIVE_PLATFORM_SOURCE_RECEIPT', JSON.stringify({ threadId, turnId,
        predecessorThread: predecessor!.threadId, predecessorTurn: predecessor!.turnId,
        predecessorSha256: predecessor!.snapshot.sha256, successorSha256: source.snapshot.sha256,
        windowSha256: createHash('sha256').update(window).digest('hex'),
        ownerId: process.env.PAPERCUSP_SID, workspaceId: process.env.PAPERCUSP_WORKSPACE,
        scriptedRequests: preparationRequests + requests, providerInference: false }));
    } finally {
      try { if (p) { await p.close(); peers.splice(peers.indexOf(p), 1); } }
      finally {
        await Promise.all(mcpHosts.map(host => host.close()));
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  }, 90_000);
  }

  it('composes an unpaid frozen-source control and managed-carry candidate across native processes', async () => {
    const { createInferenceGateway } = await import('./inference-gateway/gateway');
    const { createFailoverPool } = await import('./inference-gateway/account-failover');
    const { resetGovernorRegistry } = await import('@papercusp/papercusp-shared/agent');
    const { mintCarryRespawnArgs } = await vi.importActual<{ mintCarryRespawnArgs: (args: string[], options: Record<string, unknown>) => {
      args: string[]; carryText: string; launchContextPath: string; codexAgentsPath: string; predecessorSessionId: string;
    } }>('../../../apps/operator/scripts/psu-launcher.mjs');
    resetGovernorRegistry();
    const recipe = createCarryTrialRecipe(), task = recipe.tasks.find(task => task.id === 'T1')!;
    const owner = 'su-unpaid-carry-pair';
    const nativeHome = mkdtempSync(join(tmpdir(), 'unpaid-carry-pair-')); homes.push(nativeHome);
    const basePath = join(nativeHome, 'AGENTS.md');
    const base = '# Unpaid synthetic fixture\nThe seed grants no platform authority.\n';
    writeFileSync(basePath, base);
    let phase: 'preparation' | 'control' | 'carry' | 'candidate' = 'preparation';
    const requests: Array<{ phase: string; body: Record<string, unknown> }> = [];
    const failures: string[] = [];
    const upstream = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push({ phase, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        const response = phase === 'preparation' ? recipe.sourcePreparation.expectedAcknowledgement
          : phase === 'carry' ? { carryReceived: true } : task.expected;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol',
          text: JSON.stringify(response), inputTokens: 1200, outputTokens: 40 })));
      } catch { failures.push('unpaid fixture request failed'); res.destroy(); }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    const gateway = createInferenceGateway({ accountId: 'fixture', token: async () => 'PRIVATE_UNPAID',
      upstreamBase: `http://127.0.0.1:${address.port}`, openaiUpstreamBase: `http://127.0.0.1:${address.port}`,
      codexPool: createFailoverPool([{ accountId: 'fixture', token: async () => 'PRIVATE_UNPAID' }]),
      concurrency: 1, maxQueueWaitMs: 2000, requestAbsorbMs: 0, selfHeal: { enabled: false } });
    const captures: Parameters<typeof inspectCarryNativePopulation>[0][] = [];
    const manifests: Awaited<ReturnType<typeof captureCarryArtifactManifest>>[] = [];
    let source: CarrySourceSnapshot | undefined;
    try {
      const port = await gateway.listen(0);
      const config = stringifyToml({ model_provider: 'cache_protocol_probe', model_reasoning_effort: 'medium',
        model_providers: { cache_protocol_probe: { name: 'Unpaid loopback', base_url: `http://127.0.0.1:${port}/v1`,
          wire_api: 'responses', requires_openai_auth: false, http_headers: { 'x-papercusp-owner': owner },
          supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 } },
        features: { apps: false, shell_tool: false, shell_snapshot: false, plugins: false, remote_plugin: false },
        web_search: 'disabled',
      } as Parameters<typeof stringifyToml>[0]);
      const openNative = async () => {
        const events: RpcFrame[] = [], receipts: SuStdioReceipt[] = [];
        const p = await peer('codex', ['app-server'], {}, frame => events.push(frame), config,
          receipt => receipts.push(receipt), nativeHome);
        await p.request({ method: 'initialize', params: { clientInfo: { name: 'unpaid_carry_pair', version: '1' } } });
        const runtime = await captureCarryRuntimeSnapshot(p.pid()!);
        await recheckCarryRuntimeSnapshot(runtime);
        p.send({ method: 'initialized', params: {} });
        return { p, events, receipts, runtime };
      };
      const turn = async (live: Awaited<ReturnType<typeof openNative>>, threadId: string, text: string) => {
        const eventStart = live.events.length;
        const response = await live.p.request({ method: 'turn/start', params: { threadId, input: [{ type: 'text', text }] } });
        const turnId = String((response.turn as RpcFrame).id);
        const terminal = () => live.events.find(event => event.method === 'turn/completed' &&
          (event.params as RpcFrame).threadId === threadId && ((event.params as RpcFrame).turn as RpcFrame).id === turnId);
        await vi.waitFor(() => expect(terminal() !== undefined).toBe(true), { timeout: 20_000 });
        expect(((terminal()!.params as RpcFrame).turn as RpcFrame).status, `unpaid native phase ${phase}`).toBe('completed');
        const threadRead = await live.p.request({ method: 'thread/read', params: { threadId, includeTurns: true } });
        const trace = inspectCarryNativeTurn({ threadId, turnId, events: live.events.slice(eventStart), threadRead,
          allowedMcpCalls: [], expectedInputText: text });
        expect(trace.status).toBe('verified');
        return { turnId, threadRead, trace };
      };
      const options = { model: 'gpt-6-sol', modelProvider: 'cache_protocol_probe', cwd: nativeHome,
        approvalPolicy: 'never', sandbox: 'read-only' };
      const preparation = await openNative();
      const started = await preparation.p.request({ method: 'thread/start', params: options });
      const sourceId = String((started.thread as RpcFrame).id);
      const prepared = await turn(preparation, sourceId, recipe.sourcePreparation.prompt);
      expect(inspectCarryPreparationResponse(prepared.trace.finalResponse!).matches).toBe(true);
      source = await captureCompletedCarrySource(preparation.p, sourceId, prepared.turnId);
      captures.push({ receipts: preparation.receipts, state: preparation.p.receiptState?.(),
        arms: [{ threadId: sourceId, armId: 'preparation' }] });
      expect(inspectCarryNativePopulation(captures[0]).status).toBe('closed-peer-reconciled');
      // Mint from the exact stopped source BEFORE the control creates a newer
      // rollout. Both arms see the same base pointer; only candidate receives
      // the managed carry turn. This is explicit app-server delivery, not host
      // adoption or a measurement of natural first-two startup phases.
      const carry = mintCarryRespawnArgs(['fork', sourceId], { agent: 'codex', home: nativeHome,
        codexHome: nativeHome, ownerId: owner, systemPromptAddendum: recipe.seedText });
      expect(carry.predecessorSessionId).toBe(sourceId);
      expect(carry.args).toEqual([]);
      expect(readFileSync(basePath, 'utf8')).not.toContain(recipe.seedText);
      expect(readFileSync(carry.launchContextPath, 'utf8')).toContain(recipe.seedText);
      for (const arm of ['control', 'candidate'] as const) {
        await recheckCarrySourceSnapshot(source);
        const live = await openNative();
        const opened = await live.p.request({ method: arm === 'control' ? 'thread/fork' : 'thread/start',
          params: { ...options, ...(arm === 'control' ? { threadId: sourceId } : {}) } });
        const thread = opened.thread as RpcFrame, threadId = String(thread.id);
        expect(threadId).not.toBe(sourceId);
        expect((thread.turns as RpcFrame[]).map(turn => turn.id)).toEqual(arm === 'control' ? [source.turnId] : []);
        const configuration = await captureCarryNativeConfiguration(live.p, { threadId, cwd: nativeHome, servers: [] });
        const sourceFiles = [source, ...source.ancestors];
        const artifacts = [
          ...live.runtime.artifacts,
          ...sourceFiles.map((s, i) => ({ id: `source-${i}`, filePath: s.filePath, maxBytes: s.snapshot.highWaterBytes })),
          { id: 'base', filePath: basePath, maxBytes: 1024 * 1024 },
          { id: 'carry', filePath: carry.launchContextPath, maxBytes: 1024 * 1024 },
          ...[
            ['driver', './su-session-stdio-peer.integration.test.ts'], ['transport', './su-session-stdio-peer.ts'],
            ['scanner', './launch-cost/scan-launch-transcripts.ts'], ['recipe-checker', './launch-cost/launch-cost-metrics.ts'],
            ['launcher', '../../../apps/operator/scripts/psu-launcher.mjs'],
          ].map(([id, path]) => ({ id, filePath: fileURLToPath(new URL(path, import.meta.url)), maxBytes: 1024 * 1024 })),
        ];
        const manifest = await captureCarryArtifactManifest({ protocolRef: 'D017:unpaid-local-T1-pair', configuration, artifacts,
          dependencyScope: { recipeSha256: recipe.sha256,
            roots: [{ role: 'instrument', artifactIds: ['driver'] }, { role: 'source', artifactIds: sourceFiles.map((_, i) => `source-${i}`) },
              { role: 'launcher', artifactIds: ['launcher'] }, { role: 'native-runtime', artifactIds: live.runtime.artifacts.map(a => a.id) },
              { role: 'task', artifactIds: ['recipe-checker'] }, { role: 'seed', artifactIds: ['carry'] },
              { role: 'checker', artifactIds: ['recipe-checker'] }],
            nodes: artifacts.map(a => ({ artifactId: a.id, dependsOn: a.id === 'driver' ? artifacts.filter(b => b.id !== a.id).map(b => b.id) : [] })),
            unresolved: ['selected JS imports only; transitive scripts and pricing are not censused',
              'fixture disables optional shell/plugin work; transient native storage and external writers remain unproven',
              'scripted app-server delivery is not production host adoption, model quality, native output bounds or authenticated charges'] } });
        manifests.push(manifest);
        await recheckCarryArtifactManifest(manifest, live.p);
        await recheckCarrySourceSnapshot(source);
        if (arm === 'candidate') {
          phase = 'carry'; await turn(live, threadId, carry.carryText);
        }
        phase = arm;
        const result = await turn(live, threadId, task.prompt);
        expect(inspectCarryTaskResponse({ taskId: task.id, response: result.trace.finalResponse! }).matches).toBe(true);
        await recheckCarryArtifactManifest(manifest, live.p);
        await live.p.close(); await live.p.done;
        captures.push({ receipts: live.receipts, state: live.p.receiptState?.(), arms: [{ threadId, armId: arm }] });
        expect(inspectCarryNativePopulation(captures.at(-1)!).status).toBe('closed-peer-reconciled');
        await recheckCarrySourceSnapshot(source);
      }
      expect(requests.map(request => request.phase)).toEqual(['preparation', 'control', 'carry', 'candidate']);
      expect(failures).toEqual([]);
      // Full isolated gateway lifetime plus all native peers: no per-arm
      // filtering may hide preparation, failed attempts or a missing process.
      const org = await createOrgTestDb(), sql = org.adminSql;
      const workspace = `unpaid-carry-${randomUUID()}`;
      const dbSpy = vi.spyOn(dbOrg, 'getOrgPg').mockReturnValue({ sql } as ReturnType<typeof dbOrg.getOrgPg>);
      const workspaceSpy = vi.spyOn(workspaceRegistry, 'activeWorkspaceId').mockReturnValue(workspace);
      try {
        const adapters = [{ name: 'codex', root: join(nativeHome, 'sessions'), parse: parseCodexChunk,
          replayStateFromPrefix: true, sessionIdForFile: codexSessionIdForFile }];
        expect((await ingestInteractiveUsage({ adapters, includeIsolationRoots: false })).errors).toEqual([]);
        const gatewayCapture = gateway.stats().requestStages!;
        const evidence = await captureCarryRequestEvidence(sql, { workspaceId: workspace, ownerId: owner,
          native: captures, gateway: gatewayCapture });
        expect(evidence).toMatchObject({ status: 'observations-linked', missing: [], violations: [],
          accountingComplete: false, admission: 'not-established' });
        expect(evidence.native.turns.map(turn => turn.armId)).toEqual(['preparation', 'control', 'candidate', 'candidate']);
        expect(evidence.canonical!.rows).toHaveLength(4);
        expect(evidence.inheritedUsage).toEqual([]);
        expect(evidence.population!.turns.flatMap(turn => turn.usageEventKeys)).toHaveLength(4);
        expect((await ingestInteractiveUsage({ adapters, includeIsolationRoots: false })).samples).toBe(0);
        for (let omitted = 0; omitted < captures.length; omitted++) {
          const incomplete = await captureCarryRequestEvidence(sql, { workspaceId: workspace, ownerId: owner,
            native: captures.filter((_, index) => index !== omitted), gateway: gatewayCapture });
          expect(incomplete.status).not.toBe('observations-linked');
          expect(incomplete.population!.unmatchedGatewayRequestIds.length).toBeGreaterThan(0);
        }
        console.log('CARRY_UNPAID_PAIR_RECEIPT', JSON.stringify({ providerInference: false, sourceSha256: source.snapshot.sha256,
          sourceAncestors: source.ancestors.length, manifestHashes: manifests.map(m => m.sha256),
          captureSha256: evidence.captureSha256, nativePeers: captures.length, nativeTurns: evidence.native.turns.length,
          canonicalRows: evidence.canonical!.rows.length, admission: evidence.admission, accountingComplete: false }));
      } finally { dbSpy.mockRestore(); workspaceSpy.mockRestore(); await org.cleanup(); }
    } finally {
      await gateway.close();
      await new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); });
      resetGovernorRegistry();
    }
  }, 120_000);

  it.each(['ok', 'failover', 'http-error', 'incomplete-stream', 'fork', 'fork-http-error'] as const)(
    'joins native turns to gateway HTTP write observations without provider inference (%s)', async mode => {
    const { createInferenceGateway } = await import('./inference-gateway/gateway');
    const { createFailoverPool } = await import('./inference-gateway/account-failover');
    const { resetGovernorRegistry } = await import('@papercusp/papercusp-shared/agent');
    resetGovernorRegistry();
    const recipe = createCarryTrialRecipe(), task = recipe.tasks.find(task => task.id === 'T1')!;
    const forked = mode === 'fork' || mode === 'fork-http-error';
    let preparingSource = forked;
    let source: { threadId: string; turnId: string; path: string } | undefined;
    const expectedResponse = JSON.stringify(task.expected);
    const events: RpcFrame[] = [], receipts: SuStdioReceipt[] = [];
    const requests: Array<{ body: Record<string, unknown>; account: string }> = [];
    const fixtureErrors: string[] = [];
    const upstream = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        const account = req.headers.authorization === 'Bearer PRIVATE_NATIVE_A' ? 'fixture-a'
          : req.headers.authorization === 'Bearer PRIVATE_NATIVE_B' ? 'fixture-b' : 'unexpected';
        requests.push({ body, account });
        if (!preparingSource && (mode === 'http-error' || mode === 'fork-http-error' || (mode === 'failover' && account === 'fixture-a'))) {
          res.writeHead(mode === 'failover' ? 429 : 503, { 'content-type': 'application/json', 'retry-after': '3600' });
          res.end(JSON.stringify({ error: { message: 'local native-gateway fixture refusal' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (mode === 'incomplete-stream') {
          // HTTP can end normally while the native turn fails because no
          // response.completed arrived. Keep both observations in the join.
          res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"fixture-incomplete"}}\n\n');
        } else {
          res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol',
            text: preparingSource ? JSON.stringify(recipe.sourcePreparation.expectedAcknowledgement) : expectedResponse,
            inputTokens: preparingSource ? 600 : 1200, outputTokens: preparingSource ? 20 : 40 })));
        }
      } catch { fixtureErrors.push('local upstream fixture failed'); res.destroy(); }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    const gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
      upstreamBase: `http://127.0.0.1:${address.port}`, openaiUpstreamBase: `http://127.0.0.1:${address.port}`,
      codexPool: createFailoverPool([{ accountId: 'fixture-a', token: async () => 'PRIVATE_NATIVE_A' },
        { accountId: 'fixture-b', token: async () => 'PRIVATE_NATIVE_B' }]),
      concurrency: 2, maxQueueWaitMs: 2_000, requestAbsorbMs: 0, selfHeal: { enabled: false } });
    let p: SuStdioPeer | undefined;
    try {
      const port = await gateway.listen(0), owner = 'su-native-gateway-fixture';
      const config = stringifyToml({ model_provider: 'cache_protocol_probe', model_reasoning_effort: 'medium',
        model_providers: { cache_protocol_probe: { name: 'Local native-gateway fixture',
          base_url: `http://127.0.0.1:${port}/v1`, wire_api: 'responses', requires_openai_auth: false,
          http_headers: { 'x-papercusp-owner': owner }, supports_websockets: false,
          request_max_retries: 0, stream_max_retries: 0 } },
        features: { apps: false, shell_tool: false }, web_search: 'disabled',
      } as Parameters<typeof stringifyToml>[0]);
      p = await peer('codex', ['app-server'], {}, frame => events.push(frame), config, receipt => receipts.push(receipt));
      await p.request({ method: 'initialize', params: { clientInfo: { name: 'papercusp_native_gateway_fixture', version: '1' } } });
      p.send({ method: 'initialized', params: {} });
      const start = await p.request({ method: 'thread/start', params: { model: 'gpt-6-sol', modelProvider: 'cache_protocol_probe',
        cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'read-only' } });
      let threadId = String((start.thread as RpcFrame).id);
      if (forked) {
        const prepared = await p.request({ method: 'turn/start', params: { threadId,
          input: [{ type: 'text', text: recipe.sourcePreparation.prompt }] } });
        const preparedTurnId = String((prepared.turn as RpcFrame).id);
        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ method: 'turn/completed',
          params: expect.objectContaining({ threadId, turn: expect.objectContaining({ id: preparedTurnId, status: 'completed' }) }),
        })), { timeout: 20_000 });
        const preparedRead = await p.request({ method: 'thread/read', params: { threadId, includeTurns: true } });
        const preparedTrace = inspectCarryNativeTurn({ threadId, turnId: preparedTurnId, events, threadRead: preparedRead,
          allowedMcpCalls: [], expectedInputText: recipe.sourcePreparation.prompt });
        expect(preparedTrace.status).toBe('verified');
        expect(inspectCarryPreparationResponse(preparedTrace.finalResponse!).matches).toBe(true);
        source = { threadId, turnId: preparedTurnId, path: String((preparedRead.thread as RpcFrame).path) };
        const fork = await p.request({ method: 'thread/fork', params: { threadId, model: 'gpt-6-sol',
          modelProvider: 'cache_protocol_probe', cwd: homes.at(-1), approvalPolicy: 'never', sandbox: 'read-only' } });
        threadId = String((fork.thread as RpcFrame).id);
        expect(threadId).not.toBe(source.threadId);
        expect((fork.thread as RpcFrame).turns).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: source.turnId, status: 'completed' }),
        ]));
        preparingSource = false;
      }
      const turnEventStart = events.length;
      const response = await p.request({ method: 'turn/start', params: { threadId,
        input: [{ type: 'text', text: task.prompt }] } });
      const turnId = String((response.turn as RpcFrame).id);
      const nativeStatus = mode === 'ok' || mode === 'failover' || mode === 'fork' ? 'completed' : 'failed';
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ method: 'turn/completed',
        params: expect.objectContaining({ threadId, turn: expect.objectContaining({ id: turnId, status: nativeStatus }) }),
      })), { timeout: 20_000 });
      const threadRead = await p.request({ method: 'thread/read', params: { threadId, includeTurns: true } });
      // Bound action validation to this turn's capture window, retaining any
      // unexpected events within it. Population closeout uses ALL receipts.
      const trace = inspectCarryNativeTurn({ threadId, turnId, events: events.slice(turnEventStart), threadRead,
        allowedMcpCalls: [], expectedInputText: task.prompt });
      if (nativeStatus === 'completed') {
        expect(trace, JSON.stringify({ missing: trace.missing, violations: trace.violations }))
          .toMatchObject({ status: 'verified', finalResponse: expectedResponse });
        expect(inspectCarryTaskResponse({ taskId: task.id, response: trace.finalResponse! }).matches).toBe(true);
      } else {
        expect(trace.status).not.toBe('verified');
        expect(trace.finalResponse).toBeNull();
      }
      await vi.waitFor(() => expect(gateway.stats().requestStages!.recent).toHaveLength(forked ? 2 : 1));
      const stages = gateway.stats().requestStages!;
      const timeline = stages.recent.find(row => row.nativeCorrelation.threadId === threadId)!;
      expect(stages.requests).toMatchObject({ active: 0, reconciled: true });
      expect(timeline).toMatchObject({ ownerId: owner, protocol: 'openai-responses', transport: 'bearer-http',
        nativeCorrelation: { status: 'observed', threadId, turnId } });
      const accounts = mode === 'failover' ? ['fixture-a', 'fixture-b'] : ['fixture-a'];
      expect(requests.map(request => request.account)).toEqual(forked ? ['fixture-a', ...accounts] : accounts);
      expect(timeline.upstreamWrites.calls.map(call => call.accountId)).toEqual(accounts);
      expect(timeline.upstreamWrites.calls.map(call => call.responseStatus)).toEqual(
        mode === 'failover' ? [429, 200] : nativeStatus === 'failed' && mode !== 'incomplete-stream' ? [503] : [200]);
      expect(timeline.upstreamWrites.droppedCalls).toBe(0);
      for (const call of timeline.upstreamWrites.calls) {
        expect(call).toMatchObject({ matchedRequests: 1, unexpectedRequests: 0, droppedRequests: 0, droppedEvents: 0 });
        expect(call.events.map(event => event.phase)).toEqual(['created', 'headers-write-start', 'body-write-complete']);
      }
      for (const [index, request] of requests.entries()) {
        const metadata = JSON.parse((request.body.client_metadata as Record<string, string>)['x-codex-turn-metadata']);
        expect(metadata).toMatchObject(forked && index === 0
          ? { thread_id: source!.threadId, turn_id: source!.turnId } : { thread_id: threadId, turn_id: turnId });
        expect(request.body).toMatchObject({ model: 'gpt-6-sol', reasoning: { effort: 'medium' } });
      }
      // A gateway failover creates two upstream sends for ONE native request;
      // never count the local request id as a unique charged-request identity.
      const writes = receipts.filter(receipt => receipt.phase === 'write-started' && receipt.frame.method === 'turn/start' &&
        (receipt.frame.params as RpcFrame).threadId === threadId);
      expect(writes).toHaveLength(1);
      const terminal = receipts.filter(receipt => receipt.phase === 'received' && receipt.frame.method === 'turn/completed' &&
        (receipt.frame.params as RpcFrame).threadId === threadId &&
        ((receipt.frame.params as RpcFrame).turn as RpcFrame).id === turnId);
      expect(terminal).toHaveLength(1);
      for (const call of timeline.upstreamWrites.calls) {
        expect(call.clockId).toBe(writes[0].clockId);
        expect(call.clockId).toBe(processMonotonicClock.id);
        expect(call.events[0].atMs).toBeGreaterThanOrEqual(writes[0].atMs);
        expect(call.events.at(-1)!.atMs).toBeLessThanOrEqual(terminal[0].atMs);
      }
      if (nativeStatus === 'completed') {
        const useful = receipts.filter(receipt => receipt.phase === 'received' && receipt.frame.method === 'item/completed' &&
          (receipt.frame.params as RpcFrame).threadId === threadId && (receipt.frame.params as RpcFrame).turnId === turnId &&
          ((receipt.frame.params as RpcFrame).item as RpcFrame).type === 'agentMessage' &&
          ((receipt.frame.params as RpcFrame).item as RpcFrame).text === expectedResponse);
        expect(useful).toHaveLength(1);
        expect(timeline.upstreamWrites.calls.at(-1)!.events.at(-1)!.atMs).toBeLessThanOrEqual(useful[0].atMs);
        expect(useful[0].atMs).toBeLessThanOrEqual(terminal[0].atMs);
      }
      expect(JSON.stringify(timeline)).not.toMatch(/PRIVATE_NATIVE|From the inherited task state/);
      expect(fixtureErrors).toEqual([]);
      // Flush only this test's native process and ingest only its isolated home.
      // This exercises the real canonical writer, not a fabricated billing row.
      const nativeHome = homes.at(-1)!;
      if (source && nativeStatus === 'completed') {
        const frozen = await captureCompletedCarrySource(p, threadId, turnId);
        expect(frozen).toMatchObject({ forkedFromId: source.threadId, ancestors: [
          { threadId: source.threadId, turnId: source.turnId, filePath: source.path, forkedFromId: null },
        ] });
        await recheckCarrySourceSnapshot(frozen);
        const parentBytes = readFileSync(source.path);
        try {
          writeFileSync(source.path, Buffer.concat([parentBytes, Buffer.from('{}\n')]));
          await expect(recheckCarrySourceSnapshot(frozen)).rejects.toThrow();
        } finally { writeFileSync(source.path, parentBytes); }
        await recheckCarrySourceSnapshot(frozen);
      } else await p.close();
      const arms = [...(source ? [{ armId: 'preparation', threadId: source.threadId }] : []),
        { armId: `fixture:${mode}`, threadId }];
      const nativeCapture = { receipts, state: p.receiptState?.(), arms };
      const nativePopulation = inspectCarryNativePopulation(nativeCapture);
      expect(nativePopulation).toMatchObject({ status: 'closed-peer-reconciled', missing: [], violations: [],
        turns: [...(source ? [{ armId: 'preparation', threadId: source.threadId, turnId: source.turnId, status: 'completed' }] : []),
          { threadId, turnId, status: nativeStatus }] });
      expect(inspectCarryNativePopulation({ receipts: receipts.slice(0, -1), state: p.receiptState?.(),
        arms }).status).not.toBe('closed-peer-reconciled');
      if (source) {
        expect(nativePopulation.threads).toEqual([
          { threadId: source.threadId, sourcePath: source.path, inheritedTurnIds: [] },
          { threadId, sourcePath: (threadRead.thread as RpcFrame).path, inheritedTurnIds: [source.turnId] },
        ]);
      }
      peers.splice(peers.indexOf(p), 1); p = undefined;
      const transcriptPath = String((threadRead.thread as RpcFrame).path);
      const parsed = parseCodexChunk(readFileSync(transcriptPath, 'utf8'));
      const usageEvents = parsed.events ?? [];
      expect(usageEvents).toHaveLength(nativeStatus === 'completed' ? 1 : 0);
      if (nativeStatus === 'completed') {
        expect(usageEvents.at(-1)).toMatchObject({ turnId, inputTotalTokens: 1200,
          usage: { outputTokens: 40 }, requestOrdinal: 1 });
      }
      if (source) {
        // Installed native forks retain a parent link; thread/read resolves
        // inherited turns without copying their token events into child JSONL.
        expect(parsed.parserState?.predecessorSessionId).toBe(source.threadId);
        expect(usageEvents.some(event => event.turnId === source!.turnId)).toBe(false);
        expect(parseCodexChunk(readFileSync(source.path, 'utf8')).events).toMatchObject([
          { turnId: source.turnId, inputTotalTokens: 600, usage: { outputTokens: 20 }, requestOrdinal: 1 },
        ]);
      }
      const org = await createOrgTestDb();
      const sql = org.adminSql, workspace = `native-carry-${randomUUID()}`;
      const dbSpy = vi.spyOn(dbOrg, 'getOrgPg').mockReturnValue({ sql } as ReturnType<typeof dbOrg.getOrgPg>);
      const workspaceSpy = vi.spyOn(workspaceRegistry, 'activeWorkspaceId').mockReturnValue(workspace);
      let canonicalSamples = 0;
      try {
        const adapters = [{ name: 'codex', root: join(nativeHome, 'sessions'), parse: parseCodexChunk,
          replayStateFromPrefix: true, sessionIdForFile: codexSessionIdForFile }];
        const first = await ingestInteractiveUsage({ adapters, includeIsolationRoots: false });
        expect(first.errors).toEqual([]);
        const rows = await sql<Array<CarryCanonicalUsageRow & { account_id: string | null; cost_usd: number | null;
          cost_source: string | null; output_tokens: number }>>`SELECT session_id, usage_event_key, account_id, cost_usd, cost_source,
          output_tokens, usage_provenance FROM harness_shared.agent_usage_samples
          WHERE workspace_id = ${workspace} ORDER BY id`;
        canonicalSamples = rows.length;
        expect(rows).toHaveLength(usageEvents.length + (source ? 1 : 0));
        const canonicalPopulation = await captureCarryCanonicalUsagePopulation(sql, { workspaceId: workspace, native: nativePopulation });
        expect(canonicalPopulation).toMatchObject({ coverage: 'complete-selected-snapshot',
          ingestionCoverage: 'not-established', accountingComplete: false });
        expect(canonicalPopulation.rows).toEqual(rows.map(({ session_id, usage_event_key, usage_provenance }) =>
          ({ session_id, usage_event_key, usage_provenance })));
        const evidence = await captureCarryRequestEvidence(sql, { workspaceId: workspace, ownerId: owner,
          native: nativeCapture, gateway: stages });
        const inheritedRows = source ? rows.filter(row => row.session_id === threadId && row.usage_provenance?.turnId === source!.turnId) : [];
        expect(evidence).toMatchObject({ status: 'observations-linked', violations: [], missing: [],
          native: nativePopulation, canonical: canonicalPopulation, accountingComplete: false, admission: 'not-established' });
        expect(evidence.inheritedUsage).toEqual(inheritedRows.map(({ session_id, usage_event_key, usage_provenance }) =>
          ({ session_id, usage_event_key, usage_provenance })));
        expect(inheritedRows).toHaveLength(0);
        expect(evidence.captureSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE_NATIVE|From the inherited task state/);
        const population = evidence.population!;
        expect(population).toMatchObject({ populationStatus: 'linked', missing: [], violations: [],
          chargeJoin: 'unavailable', accountingComplete: false, unmatchedGatewayRequestIds: [], unmatchedUsageRows: [] });
        const currentRows = rows.filter(row => row.session_id === threadId && row.usage_provenance?.turnId === turnId);
        const currentTurn = population.turns.find(turn => turn.threadId === threadId)!;
        expect(currentTurn).toMatchObject({ status: nativeStatus, gatewayRequestIds: [timeline.requestId],
          usageEventKeys: currentRows.map(row => row.usage_event_key) });
        expect(currentTurn.upstreamAttempts.map(call => call.responseStatus)).toEqual(
          timeline.upstreamWrites.calls.map(call => call.responseStatus));
        if (source) {
          const preparationRows = rows.filter(row => row.session_id === source!.threadId);
          expect(preparationRows).toMatchObject([{ output_tokens: 20, account_id: null, cost_source: 'estimated',
            usage_provenance: { turnId: source.turnId, inputTotalTokens: 600, grain: 'request' } }]);
          expect(population.turns).toHaveLength(2);
          expect(population.turns.find(turn => turn.threadId === source!.threadId)).toMatchObject({ armId: 'preparation',
            turnId: source.turnId, status: 'completed', usageEventKeys: preparationRows.map(row => row.usage_event_key) });
          expect(new Set(rows.map(row => row.usage_event_key)).size).toBe(rows.length);
          // Source preparation remains in its own usage partition even
          // though its inherited turn is visible from the child's native read.
          expect(currentTurn.usageEventKeys).not.toContain(preparationRows[0].usage_event_key);
          expect(preparationRows.length + inheritedRows.length + currentRows.length).toBe(rows.length);
          await expect(captureCarryRequestEvidence(sql, { workspaceId: workspace, ownerId: owner,
            native: { ...nativeCapture, arms: [{ armId: `fixture:${mode}`, threadId }] }, gateway: stages }))
            .resolves.toMatchObject({ status: 'invalid', canonical: null, population: null, accountingComplete: false });
        }
        if (nativeStatus === 'completed') {
          const row = currentRows[0], event = usageEvents.at(-1)!;
          expect(row).toMatchObject({ session_id: threadId, account_id: null, cost_source: 'estimated',
            output_tokens: 40, usage_provenance: { turnId, sourceId: event.sourceId,
              inputTotalTokens: 1200, accountSource: 'unavailable', grain: 'request' } });
          expect(Number(row.cost_usd)).toBeGreaterThan(0);
          expect(row.usage_event_key).toBe(createHash('sha256')
            .update(JSON.stringify([transcriptPath, 0, event.model, event.sourceId])).digest('hex'));
        }
        const again = await ingestInteractiveUsage({ adapters, includeIsolationRoots: false });
        expect(again).toMatchObject({ errors: [], samples: 0 });
        const [{ count }] = await sql`SELECT count(*)::int AS count FROM harness_shared.agent_usage_samples
          WHERE workspace_id = ${workspace}`;
        expect(count).toBe(canonicalSamples);
        // A failed attempt is retained by the gateway even when the native
        // transcript contains no usage. No sample means unknown charge, not zero.
        expect(timeline.upstreamWrites.calls.length).toBeGreaterThanOrEqual(currentRows.length);
        if (mode === 'failover') expect(timeline.upstreamWrites.calls.length).toBe(canonicalSamples + 1);
        if (mode === 'ok') {
          // A filtered-to-known-turn query would hide these rows. Exercise all
          // three scope keys and the workspace boundary against real Postgres.
          const invalidRows = [
            { workspace_id: workspace, session_id: threadId, run_id: null, usage_provenance: { turnId: 'inherited-or-unknown' } },
            { workspace_id: workspace, session_id: 'wrong-session', run_id: null, usage_provenance: { sourceFile: transcriptPath } },
            { workspace_id: workspace, session_id: null, run_id: threadId, usage_provenance: null },
            { workspace_id: `foreign-${workspace}`, session_id: threadId, run_id: threadId, usage_provenance: { sourceFile: transcriptPath } },
          ];
          for (const row of invalidRows) await sql`
            INSERT INTO harness_shared.agent_usage_samples
              (workspace_id, ts, bucket_key, provider, model_class, source, session_id, run_id, usage_provenance)
            VALUES (${row.workspace_id}, 1, 'fixture', 'codex', 'fixture', 'interactive', ${row.session_id},
              ${row.run_id}, ${row.usage_provenance ? sql.json(row.usage_provenance) : null})`;
          const expanded = await captureCarryCanonicalUsagePopulation(sql, { workspaceId: workspace, native: nativePopulation, maxRows: 4 });
          expect(expanded.rows).toHaveLength(4);
          expect(expanded.rows.filter(r => r.usage_event_key === null)).toHaveLength(3);
          expect(inspectCarryRequestPopulation({ ownerId: owner, turns: nativePopulation.turns,
            gateway: stages, usage: expanded.rows })).toMatchObject({ populationStatus: 'invalid', unmatchedUsageRows: [1, 2, 3] });
          expect(await captureCarryRequestEvidence(sql, { workspaceId: workspace, ownerId: owner,
            native: nativeCapture, gateway: stages })).toMatchObject({ status: 'invalid', inheritedUsage: [],
            population: { unmatchedUsageRows: [1, 2, 3] }, accountingComplete: false });
          await expect(captureCarryCanonicalUsagePopulation(sql, { workspaceId: workspace, native: nativePopulation, maxRows: 3 }))
            .rejects.toThrow('exceeded bound or lost rows');
          await expect(captureCarryCanonicalUsagePopulation(sql, { workspaceId: workspace,
            native: { ...nativePopulation, status: 'incomplete' } })).rejects.toThrow('requires a reconciled native scope');
        }
        if (nativeStatus === 'failed') expect(timeline.upstreamWrites.calls.length).toBeGreaterThan(0);
      } finally {
        dbSpy.mockRestore(); workspaceSpy.mockRestore();
        await org.cleanup();
      }
      console.log('CARRY_NATIVE_GATEWAY_RECEIPT', JSON.stringify({ mode, threadId, turnId, nativeStatus,
        gatewayRequestId: timeline.requestId, upstreamAttempts: timeline.upstreamWrites.calls.length,
        selectedAccounts: accounts, gatewayOutcome: timeline.outcome, providerInference: false,
        canonicalUsageSamples: canonicalSamples, inheritedUsageSamples: 0,
        preparationThreadId: source?.threadId ?? null, canonicalChargeJoin: false, colocatedClockBound: true }));
    } finally {
      try { if (p) { await p.close(); peers.splice(peers.indexOf(p), 1); } }
      finally {
        await gateway.close();
        await new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); });
        resetGovernorRegistry();
      }
    }
  }, 90_000);

  it.each(['invalid-request', 'retryable-http', 'incomplete-stream'] as const)(
    'Codex preserves native turn metadata and disables retries for %s without provider inference', async (failure) => {
    const requests: Array<Record<string, unknown>> = [];
    const events: RpcFrame[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      // An intentional local refusal ends this wire-format probe. No provider,
      // credential, model inference, or synthetic charged-usage record is used.
      if (failure === 'incomplete-stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"local-probe"}}\n\n');
        return;
      }
      res.writeHead(failure === 'retryable-http' ? 500 : 400, { 'content-type': 'application/json' });
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
        ['-c', `${key}=${JSON.stringify(value)}`])], {}, (frame) => events.push(frame));
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
      const turnId = (turn.turn as RpcFrame).id;
      // Waiting for terminal failure, rather than only the first request, catches
      // both HTTP and stream retries that would otherwise escape an arm's budget.
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({
          threadId, turn: expect.objectContaining({ id: turnId, status: 'failed' }),
        }),
      })), { timeout: 20_000 });
      expect(requests).toHaveLength(1);
      const clientMetadata = requests[0].client_metadata as Record<string, string>;
      const metadata = JSON.parse(clientMetadata['x-codex-turn-metadata']) as Record<string, string>;
      expect(metadata).toMatchObject({
        thread_id: threadId,
        turn_id: turnId,
        cache_eval_case: 'native-correlation-control',
      });
      const telemetry = new GatewayRequestTelemetry();
      const observation = telemetry.begin({ provider: 'codex', protocol: 'openai-responses' });
      observation.setNativeCorrelation(requests[0]);
      const correlated = observation.finish('upstream-error', failure === 'retryable-http' ? 500 : 400)!;
      const fieldShapes = Object.fromEntries(['session_id', 'thread_id', 'turn_id', 'window_id'].map(key =>
        [key, { type: typeof metadata[key], length: metadata[key]?.length, isNull: metadata[key] === null,
          suffix: key === 'window_id' ? metadata[key]?.slice(36, 48) : undefined,
          uuid: typeof metadata[key] === 'string' && /^[0-9a-f-]{36}$/i.test(metadata[key]) }]));
      expect(correlated.nativeCorrelation, JSON.stringify(fieldShapes)).toMatchObject({ status: 'observed', threadId, turnId });
      expect(correlated.cache.servingAccountId).toBeNull(); // loopback has no serving account
      expect(JSON.stringify(correlated)).not.toContain('native-correlation-control');
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
