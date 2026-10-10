import { it, expect, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';

const homeAllocation = vi.hoisted(() => ({ key: '', path: '' }));
vi.mock('@papercusp/orchestrator/session-launch-dirs', async (original) => {
  const actual = await original<typeof import('@papercusp/orchestrator/session-launch-dirs')>();
  return { ...actual, codexHomeForSessionKey: (key: string | number) =>
    key === homeAllocation.key ? homeAllocation.path : actual.codexHomeForSessionKey(key) };
});

const listen = (s: Server) => new Promise<number>((resolve, reject) => {
  s.once('error', reject); s.listen(0, '127.0.0.1', () => resolve((s.address() as any).port));
});
const stop = (s: Server) => new Promise<void>((resolve, reject) => s.close(e => e ? reject(e) : resolve()));

it('enforces the scoped boundary through the actual launcher and final managed PTY', async () => {
  // The actual sandbox replaces /dev/shm; fixtures must survive that mount.
  const cwd = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'psu-native-boundary-physical-'));
  const resultPath = join(cwd, 'native-result');
  const calls = [0, 0, 0];
  const servers = calls.map((_, i) => createServer((_req, res) => { calls[i]++; res.end(`endpoint-${i}`); }));
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  try {
    const [gateway, operator, forbidden] = await Promise.all(servers.map(listen));
    const codexHome = join(cwd, 'codex-home'); mkdirSync(codexHome);
    const env = hermeticEnv({ PAPERCUSP_AGENT: 'codex', CODEX_HOME: codexHome,
      PAPERCUSP_SID: `test-scoped-native-${process.pid}`, PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_PSU_PTY: '1',
      PAPERCUSP_MCP_PROXY: '0', PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${operator}`,
      PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: `http://127.0.0.1:${gateway}`, token: 'a'.repeat(64) }) });
    const reach = (port: number, extra = '') => `/usr/bin/curl --silent --show-error --fail --max-time 3 ${extra} http://127.0.0.1:${port}`;
    const script = [
      'set -e', `${reach(gateway)} > ${quote(resultPath)}`, `printf '\\n' >> ${quote(resultPath)}`,
      `${reach(operator)} >> ${quote(resultPath)}`, `printf '\\n' >> ${quote(resultPath)}`,
      `if ${reach(forbidden)}; then exit 41; fi`,
      `if ${reach(gateway, "--noproxy '*' ")}; then exit 42; fi`,
      `printf 'BOUNDARY_VERIFIED\\n' >> ${quote(resultPath)}`,
    ].join('\n');
    const launcher = fileURLToPath(new URL('../scripts/psu-launcher.mjs', import.meta.url));
    // This fixture runs the production runWrapper, not a replacement spawn.
    // Native work is only the local shell/socket check, with no model calls.
    const fixture = join(cwd, 'launcher-fixture.mjs');
    writeFileSync(fixture, `import { runWrapper } from ${JSON.stringify(launcher)};\nrunWrapper({wrapperBin:'/bin/sh',args:${JSON.stringify(['-c', script])},cwd:${JSON.stringify(cwd)},preserveCwd:true,envelopeEnv:process.env,reportSessionEndedImpl:async()=>{},onSpawn:()=>{}});\n`);
    const child = spawn(process.execPath, [fixture], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Final native PTY boundary fixture exceeded 20 seconds')); }, 20_000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', c => { clearTimeout(timer); resolve(c); });
    });
    expect(code, output).toBe(0);
    expect(existsSync(resultPath), output).toBe(true);
    expect(readFileSync(resultPath, 'utf8')).toBe('endpoint-0\nendpoint-1\nBOUNDARY_VERIFIED\n');
    expect(calls[0]).toBe(1);
    expect(calls[2]).toBe(0);
  } finally {
    await Promise.all(servers.map(s => s.listening ? stop(s) : Promise.resolve()));
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

it('delivers restored frozen context to installed Codex through the real managed launcher and file-read handler', async () => {
  const fixtureRoot = mkdtempSync('/tmp/psu-native-frozen-context-');
  const cwd = join(fixtureRoot, 'checkout');
  const codexHome = join(cwd, 'codex-home');
  const frozenMarker = `FROZEN_CONTEXT_${randomUUID()}`;
  const roleMarker = `FROZEN_ROLE_${randomUUID()}`;
  const ambientMarker = `AMBIENT_OUTSIDE_${randomUUID()}`;
  const owner = `test-scoped-frozen-${randomUUID()}`;
  const providerCalls: Record<string, unknown>[] = [], reads: unknown[] = [], errors: unknown[] = [];
  const requestPaths: string[] = [];
  const mcpMethods: unknown[] = [];
  const hosts: McpServer[] = [];
  let probe: Client | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let server: Server | undefined;
  try {
  mkdirSync(cwd);
  homeAllocation.key = owner; homeAllocation.path = codexHome;
  const { writeSuCodexHome } = await import('../../../packages/operator-core/lib/role-codex-home');
  const { restoreBenchmarkContext } = await import('../../../packages/operator-core/lib/external-bench/reproducibility/context');
  const { currentProtocolFixture } = await import('../../../packages/operator-core/lib/external-bench/reproducibility/_protocol-test-fixture');
  const { currentBenchAssignmentId } = await import('../../../packages/operator-core/lib/external-bench/current-su');
  const { codexCliResponsesBody, codexCliResponsesCompletionSse } = await import('../../../packages/operator-core/lib/inference-gateway/codex-cli-bridge');
  const sourceRead = (await import('../../../packages/operator-core/lib/agent-tools/capability/read')).default;
  const snapshotRoot = join(fixtureRoot, 'protocol'); mkdirSync(snapshotRoot);
  const snapshot = JSON.stringify({ entries: [{ key: 'permitted:fixture', text: frozenMarker }] });
  for (const name of ['corpus.json', 'memory.json']) writeFileSync(join(snapshotRoot, name), snapshot);
  const config = currentProtocolFixture(owner);
  config.context = { ...config.context, corpusRef: 'corpus.json', memoryRef: 'memory.json',
    corpusHash: createHash('sha256').update(snapshot).digest('hex'), memoryHash: createHash('sha256').update(snapshot).digest('hex') };
  const restored = restoreBenchmarkContext({ snapshotRoot, checkout: cwd, context: config.context,
    binding: { workspaceId: 'native-frozen-private', runId: owner, preregHash: 'a'.repeat(64),
      assignmentId: currentBenchAssignmentId(owner, config.arms[0].id, config.taskIds[0], config.seeds[0]), harnessSlug: 'fixture' } });
  // This server scripts the native protocol only. It is never a provider bill,
  // task-quality measurement, maintained work-item workflow or pilot result.
  server = createServer(async (req, res) => {
    try {
      requestPaths.push(`${req.method} ${req.url}`);
      if (req.url?.startsWith('/mcp')) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const message = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        mcpMethods.push({ method: message?.method, tool: message?.params?.name, path: req.url });
        const host = new McpServer({ name: 'frozen-source-fixture', version: '1' }); hosts.push(host);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        host.registerTool('capability_read', { inputSchema: { file_path: z.string(), byte_offset: z.number(), byte_limit: z.number() },
          annotations: { readOnlyHint: true } }, async args => {
          reads.push(args);
          return await sourceRead.handler(args as never, { projectDir: cwd } as never) as {
            content: Array<{ type: 'text'; text: string }>;
          };
        });
        await host.connect(transport); await transport.handleRequest(req, res, message); return;
      }
      // The real launcher also posts operator lifecycle events. They are
      // distinct from Responses generation and must never advance its script.
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString()); providerCalls.push(request);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (providerCalls.length === 1) {
        // Responses-lite carries the real definitions in an input item. A
        // code-mode model advertises its executor rather than direct MCP calls.
        const tools = [...(request.tools ?? []), ...(request.input ?? []).flatMap(
          (item: Record<string, unknown>) => Array.isArray(item.tools) ? item.tools : [],
        )] as Array<Record<string, unknown>>;
        const namespace = tools.find(entry =>
          entry.type === 'namespace' && (entry.tools as Array<Record<string, unknown>>)?.some(tool => tool.name === 'capability_read'));
        const direct = tools.find(tool => tool.type === 'function' && typeof tool.name === 'string' &&
          tool.name.endsWith('__capability_read'));
        const executor = tools.find(entry => entry.type === 'namespace' &&
          (entry.tools as Array<Record<string, unknown>>)?.some(tool => tool.type === 'custom' && tool.name === 'exec'));
        if (!namespace && !direct && !executor) throw new Error('Installed native runtime did not advertise a frozen-read execution path');
        const readArgs = { file_path: restored.memoryPath, byte_offset: 0, byte_limit: Buffer.byteLength(snapshot) };
        const item = executor ? { id: 'fc_frozen', type: 'custom_tool_call', call_id: 'frozen-read',
          namespace: executor.name, name: 'exec', status: 'completed', input:
            `const frozen = ALL_TOOLS.find(tool => tool.name.endsWith('__capability_read'));\n` +
            `if (!frozen) throw new Error('Frozen read is absent from the actual native executor registry');\n` +
            `text(await tools[frozen.name](${JSON.stringify(readArgs)}));`,
        } : { id: 'fc_frozen', type: 'function_call', call_id: 'frozen-read',
          ...(namespace ? { namespace: namespace.name } : {}),
          name: direct?.name ?? 'capability_read', arguments: JSON.stringify(readArgs), status: 'completed' };
        const body = { ...codexCliResponsesBody({ model: 'gpt-6-sol', text: '', inputTokens: 0, outputTokens: 0 }), output: [item] };
        const event = (type: string, payload: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
        res.end(event('response.output_item.added', { output_index: 0, item: { ...item,
          ...(executor ? { input: '' } : { arguments: '' }), status: 'in_progress' } }) +
          event('response.output_item.done', { output_index: 0, item }) + event('response.completed', { response: body }));
      } else {
        res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6-sol', text: 'FROZEN_NATIVE_RECEIPT', inputTokens: 0, outputTokens: 0 })));
      }
    } catch (error) { errors.push(String(error)); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
    const port = await listen(server);
    const baseURL = `http://127.0.0.1:${port}`;
    const home = writeSuCodexHome({ sessionKey: owner, sid: owner, mcpUrl: `${baseURL}/mcp`, token: 'offline-fixture',
      model: 'gpt-6-sol:medium', promptText: `${roleMarker}\n${restored.contextText}`, headless: true, trustDir: cwd, denyAmbientContext: true });
    expect(home.codexHome).toBe(codexHome);
    probe = new Client({ name: 'native-fixture-preflight', version: '1' });
    await probe.connect(new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`)),
      { timeout: 5_000, signal: AbortSignal.timeout(5_000) });
    expect((await probe.listTools(undefined, { timeout: 5_000, signal: AbortSignal.timeout(5_000) }))
      .tools.map(tool => tool.name)).toEqual(['capability_read']);
    await probe.close(); probe = undefined;
    // The child must read the exact delivered AGENTS file and restored bytes.
    // Keep fixture-only provider and tool choices in CLI overrides, so a
    // replacement of the managed prompt cannot make this assertion pass.
    const overrides = { model_provider: 'frozen_fixture',
      'model_providers.frozen_fixture.name': 'Offline native fixture',
      'model_providers.frozen_fixture.base_url': `${baseURL}/v1`,
      'model_providers.frozen_fixture.wire_api': 'responses',
      'model_providers.frozen_fixture.requires_openai_auth': false,
      'model_providers.frozen_fixture.supports_websockets': false,
      'model_providers.frozen_fixture.request_max_retries': 0,
      'model_providers.frozen_fixture.stream_max_retries': 0,
      'features.apps': false, 'features.hooks': false, web_search: 'disabled' };
    const args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
      ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), 'Read the frozen assignment context.'];
    const env = hermeticEnv({ PAPERCUSP_AGENT: 'codex', CODEX_HOME: codexHome, PAPERCUSP_SID: owner,
      PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_PSU_PTY: '1', PAPERCUSP_MCP_PROXY: '0',
      PAPERCUSP_OPERATOR_URL: baseURL,
      PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL, token: 'a'.repeat(64) }) });
    const launcher = fileURLToPath(new URL('../scripts/psu-launcher.mjs', import.meta.url));
    const fixture = join(cwd, 'launcher-fixture.mjs');
    writeFileSync(fixture, `import { runWrapper } from ${JSON.stringify(launcher)};\nrunWrapper({wrapperBin:'codex',args:${JSON.stringify(args)},cwd:${JSON.stringify(cwd)},preserveCwd:true,envelopeEnv:process.env,reportSessionEndedImpl:async()=>{},onSpawn:()=>{}});\n`);
    writeFileSync(join(snapshotRoot, 'ambient.txt'), ambientMarker);
    child = spawn(process.execPath, [fixture], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout!.on('data', b => { output += b; }); child.stderr!.on('data', b => { output += b; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child!.kill('SIGKILL'); reject(new Error(`Frozen native fixture exceeded 40 seconds: ${output.slice(-2000)}`)); }, 40_000);
      child!.once('error', e => { clearTimeout(timer); reject(e); });
      child!.once('close', c => { clearTimeout(timer); resolve(c); });
    });
    const inputShapes = (value: unknown, path = 'input'): unknown[] => {
      if (typeof value === 'string') {
        const index = value.indexOf('capability_read');
        return [{ path, length: value.length, ...(/\.(type|name|role)$/.test(path) ? { value } : {}), ...(index < 0 ? {} :
          { toolExcerpt: value.slice(Math.max(0, index - 300), index + 500) }) }];
      }
      if (Array.isArray(value)) return value.flatMap((entry, i) => inputShapes(entry, `${path}[${i}]`));
      if (value && typeof value === 'object') return [{ path, keys: Object.keys(value) },
        ...Object.entries(value).filter(([key]) => !['parameters', 'format'].includes(key))
          .flatMap(([key, entry]) => inputShapes(entry, `${path}.${key}`))];
      return [];
    };
    const diagnostics = JSON.stringify({ output: output.slice(-5000), errors, requestPaths, mcpMethods,
      inputShapes: inputShapes(providerCalls[0]?.input),
      providerRequestKeys: providerCalls.map(request => Object.keys(request)),
      toolShapes: (providerCalls[0]?.tools as Array<Record<string, unknown>> | undefined)?.map(tool =>
        ({ type: tool.type, name: tool.name, keys: Object.keys(tool) })) });
    expect(code, diagnostics).toBe(0); expect(errors, diagnostics).toEqual([]);
    expect(providerCalls).toHaveLength(2); expect(reads).toHaveLength(1);
    expect(reads[0]).toEqual({ file_path: restored.memoryPath, byte_offset: 0, byte_limit: Buffer.byteLength(snapshot) });
    expect(JSON.stringify(providerCalls[0])).toContain(roleMarker);
    expect(JSON.stringify(providerCalls[0])).toContain(frozenMarker);
    expect(JSON.stringify(providerCalls)).not.toContain(ambientMarker);
    expect(JSON.stringify(providerCalls[1])).toContain('frozen-read');
    expect(JSON.stringify(providerCalls[1])).toContain(Buffer.from(snapshot).toString('base64'));
    expect(output).toContain('FROZEN_NATIVE_RECEIPT');
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    try {
      await probe?.close();
      await Promise.allSettled(hosts.map(host => host.close()));
      if (server?.listening) await stop(server);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true }); homeAllocation.key = ''; homeAllocation.path = '';
    }
  }
}, 60_000);

it('starts the installed Codex runtime through the actual launcher without inference', async () => {
  const cwd = mkdtempSync('/tmp/psu-native-codex-');
  const codexHome = join(cwd, 'codex-home'); mkdirSync(codexHome);
  const env = hermeticEnv({ PAPERCUSP_AGENT: 'codex', CODEX_HOME: codexHome,
    PAPERCUSP_SID: `test-scoped-codex-${process.pid}`, PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_PSU_PTY: '1',
    PAPERCUSP_MCP_PROXY: '0', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:32002',
    PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: 'http://127.0.0.1:32001', token: 'a'.repeat(64) }) });
  try {
    const launcher = fileURLToPath(new URL('../scripts/psu-launcher.mjs', import.meta.url));
    const fixture = join(cwd, 'launcher-fixture.mjs');
    writeFileSync(fixture, `import { runWrapper } from ${JSON.stringify(launcher)};\nrunWrapper({wrapperBin:'codex',args:['--version'],cwd:${JSON.stringify(cwd)},preserveCwd:true,envelopeEnv:process.env,reportSessionEndedImpl:async()=>{},onSpawn:()=>{}});\n`);
    const child = spawn(process.execPath, [fixture], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Installed Codex PTY fixture exceeded 20 seconds')); }, 20_000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', c => { clearTimeout(timer); resolve(c); });
    });
    expect(code, output).toBe(0);
    expect(output).toMatch(/codex-cli \d+\.\d+/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 30_000);
