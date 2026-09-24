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
import { inspectCarryNativeTurn, inspectCarrySourceRead } from './launch-cost/launch-cost-metrics';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from './inference-gateway/codex-cli-bridge';
import sourceReadTool from './agent-tools/capability/read';
import { captureCompletedCarrySource, recheckCarrySourceSnapshot, captureCarryNativeConfiguration,
  recheckCarryNativeConfiguration, type CarrySourceSnapshot } from './launch-cost/scan-launch-transcripts';

const peers: SuStdioPeer[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  processState.children.clear(); processState.stderr = ''; processState.killFailure = '';
});

async function peer(binary: string, args: string[], env: NodeJS.ProcessEnv = {}, onMessage = (_frame: RpcFrame) => {}, config?: string,
  onReceipt?: (receipt: SuStdioReceipt) => void) {
  const home = mkdtempSync(join(tmpdir(), 'pui-native-protocol-')); homes.push(home);
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
  expect((terminal()!.params as RpcFrame).status).toBe('ready');
}

describe('native JSON-line pipe transport', () => {
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
  });

  it('fails closed before writing if the receipt sink cannot retain the attempt', async () => {
    const p = await peer(process.execPath, ['-e', `
      process.stdin.on('data',()=>process.stdout.write('unexpected-send\\n'));
    `], {}, undefined, undefined, () => { throw new Error('receipt storage unavailable'); });
    await expect(p.request({ method: 'turn/start' })).rejects.toThrow('receipt storage unavailable');
    await expect(p.done).rejects.toThrow('receipt storage unavailable');
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
        text: preparingSource ? '{"sourceSentinel":"cedar-48f6e9a2"}' : '{"offline":true}', inputTokens: 0, outputTokens: 0 });
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
        const response = await p.request({ method: 'turn/start', params: {
          threadId, input: [{ type: 'text', text: 'Offline native receipt fixture.' }],
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
        await recheckCarryNativeConfiguration(p, nativeConfig);
        return { threadId, turnId, threadRead, rpcWrite: writes[0], completed: completed[0] };
      };
      let sourceCompleted: SuStdioReceipt | undefined;
      if (readSource) {
        const prepared = await nativeTurn();
        sourceCompleted = prepared.completed;
        predecessor = await captureCompletedCarrySource(p!, prepared.threadId, prepared.turnId);
        peers.splice(peers.indexOf(p!), 1); p = undefined;
        const byteOffset = predecessor.snapshot.bytes.indexOf(window);
        expect(byteOffset).toBeGreaterThan(0);
        readArgs = { file_path: predecessor.filePath, byte_offset: byteOffset, byte_limit: window.length };
        await recheckCarrySourceSnapshot(predecessor);
        preparingSource = false; events.length = 0; providerCalls.length = 0;
      }
      const { threadId, turnId, threadRead, rpcWrite, completed } = await nativeTurn();
      if (readSource) {
        // Native Codex received the platform result and returned it to the
        // next local provider request, not just a successful tools/list.
        expect(providerCalls[0]?.tools).toContainEqual(expect.objectContaining({ type: 'namespace', name: functionNamespace,
          tools: expect.arrayContaining([expect.objectContaining({ type: 'function', name: platform ? 'tools_invoke' : 'capability_read' })]) }));
        expect(JSON.stringify(providerCalls.at(-1)?.input), JSON.stringify({
          outputs: (providerCalls.at(-1)?.input as Array<Record<string, unknown>>)?.filter(item => item.type === 'function_call_output') }))
          .toContain(window.toString('base64'));
      }
      const evidence = { threadId, turnId, events, threadRead, allowedMcpCalls: readSource
        ? [...(platform ? [{ server: serverName, tool: toolName, arguments: identityArgs }] : []),
          { server: serverName, tool: toolName, arguments: sourceArgs() }] : [] };
      expect(inspectCarryNativeTurn(evidence),
        JSON.stringify({ threadRead, terminal: events.find(frame => frame.method === 'turn/completed') }))
        .toEqual({ status: 'verified', violations: [], missing: [], finalResponse: '{"offline":true}',
          mcpItemIds: platform ? [expect.any(String), expect.any(String)] : readSource ? [expect.any(String)] : [] });
      // Use the captured native frame arrival, not the later thread/read or
      // polling completion time. Full action/history validation above must
      // pass before this terminal response can count as useful even locally.
      const useful = protocolReceipts.filter(r => r.phase === 'received' && r.frame.method === 'item/completed' &&
        (r.frame.params as RpcFrame).threadId === threadId && (r.frame.params as RpcFrame).turnId === turnId &&
        ((r.frame.params as RpcFrame).item as RpcFrame).type === 'agentMessage' &&
        ((r.frame.params as RpcFrame).item as RpcFrame).text === '{"offline":true}');
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
