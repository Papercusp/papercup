/** Installed-client export observations. These reuse the native census fixtures'
 * private homes, loopback refusal and production OMP build. No provider calls. */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { codexGatewayConfigToml } from '@papercusp/orchestrator/codex-gateway-config';
import { nativeBuilds } from '../../../../omp-plugin/build-native.mjs';
import { resolveOnPath, wellKnownBackendBin } from '../../backend-bin-resolve.mjs';
import { bootstrapDescriptionForClient } from '../injection-delivery-coverage';
import { memoryFragmentOffer } from '../session-epoch-ledger';
import { ledgerDir, openDeliveryLedger } from '../../../../../apps/operator/scripts/hooks/inject/delivery-ledger.mjs';
import { codexCliResponsesBody } from '../../inference-gateway/codex-cli-bridge';

export type Descriptor = { name: string; description: string };
export type NativeExport = {
  client: 'codex' | 'claude' | 'omp'; clientVersion: string;
  evidencePlane: 'installed-client-local-request' | 'installed-client-registration';
  descriptors: Descriptor[]; request: Record<string, unknown>; methods: string[];
  clientSettings: { toolSearch?: 'disabled'; descriptionMode?: 'full' | 'default'; maxMcpDescriptionChars?: number };
  stdoutDelivery?: { adapter: 'ptool-stdio'; owner: string; confirmations: object[] };
  stdoutReceipts?: Array<{ stage: string; owner: string; token: string; payloadSha256: string;
    payloadBytes: number; memoryFragments: object[] }>;
  diagnosticsPath: string;
};
export const baselineHash = '986f440eeaf59cf02a400fcd1caf206edae88cc7b04ccd95a91ba29235560ed4';
export const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

export function frozenBootstrap() {
  const bytes = readFileSync(new URL('./r7-native-pre-change.json', import.meta.url));
  if (sha256(bytes) !== baselineHash) throw new Error('native baseline hash mismatch');
  const baseline = JSON.parse(bytes.toString('utf8')) as { tools: Descriptor[] };
  let prefix = baseline.tools[0]!.description;
  for (const tool of baseline.tools.slice(1)) {
    let index = 0;
    while (index < prefix.length && prefix[index] === tool.description[index]) index++;
    prefix = prefix.slice(0, index);
  }
  if (prefix.length !== 19367 || baseline.tools.length !== 55) throw new Error('native baseline population mismatch');
  return { baseline, prefix, contracts: baseline.tools.map(tool => ({ ...tool,
    description: tool.description.slice(prefix.length) })) };
}

export function requestDescriptors(value: unknown): Descriptor[] {
  if (Array.isArray(value)) return value.flatMap(requestDescriptors);
  if (!value || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  // Native clients can name and describe a namespace which contains the actual
  // function declarations. Keep walking after recording that wrapper.
  const own = typeof row.name === 'string' && typeof row.description === 'string'
    ? [{ name: row.name, description: row.description }] : [];
  return [...own, ...Object.values(row).flatMap(requestDescriptors)];
}

/** Reuse the maintained native sandbox's local Responses/Messages exchange.
 * The installed client executes its advertised tool; no inference is sent. */
function sendReceiptTurn(res: ServerResponse, client: 'codex' | 'claude',
  request: Record<string, unknown>, toolName: string, done: boolean): void {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  if (client === 'claude') {
    const name = requestDescriptors(request.tools).find(tool => tool.name.endsWith(toolName))?.name;
    if (!done && !name) throw new Error('Native Claude receipt tool absent from request');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(event('message_start', { message: { id: 'msg_receipt', type: 'message', role: 'assistant',
      model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 } } })
      + event('content_block_start', { index: 0, content_block: done
        ? { type: 'text', text: '' } : { type: 'tool_use', id: 'receipt_call', name, input: {} } })
      + event('content_block_delta', { index: 0, delta: done
        ? { type: 'text_delta', text: 'Receipt observed.' } : { type: 'input_json_delta', partial_json: '{}' } })
      + event('content_block_stop', { index: 0 })
      + event('message_delta', { delta: { stop_reason: done ? 'end_turn' : 'tool_use', stop_sequence: null },
        usage: { output_tokens: 1 } }) + event('message_stop', {}));
    return;
  }
  const tools = [...(Array.isArray(request.tools) ? request.tools : []),
    ...(Array.isArray(request.input) ? request.input.flatMap(item => Array.isArray(item.tools) ? item.tools : []) : [])] as Array<Record<string, unknown>>;
  const namespace = tools.find(tool => tool.type === 'namespace' && Array.isArray(tool.tools)
    && tool.tools.some(child => child.name === toolName));
  const direct = tools.find(tool => tool.type === 'function' && typeof tool.name === 'string'
    && tool.name.endsWith(toolName));
  const executor = tools.find(tool => tool.type === 'namespace' && Array.isArray(tool.tools)
    && tool.tools.some(child => child.type === 'custom' && child.name === 'exec'));
  if (!done && !namespace && !direct && !executor) throw new Error('Native Codex receipt tool absent from request');
  const item = done
    ? { id: 'receipt_done', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Receipt observed.', annotations: [] }] }
    : executor ? { id: 'receipt_exec', type: 'custom_tool_call', call_id: 'receipt_call',
      namespace: executor.name, name: 'exec', status: 'completed', input:
        `const tool = ALL_TOOLS.find(row => row.name.endsWith(${JSON.stringify(toolName)}));
if (!tool) throw new Error('Receipt tool absent from native catalog');
text(await tools[tool.name]({}));` }
      : { id: 'receipt_function', type: 'function_call', call_id: 'receipt_call',
        ...(namespace ? { namespace: namespace.name } : {}), name: direct?.name ?? toolName,
        arguments: '{}', status: 'completed' };
  const response = { ...codexCliResponsesBody({ model: 'gpt-6.1-sol', text: '', inputTokens: 1, outputTokens: 1 }),
    output: [item] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress',
    ...(!done ? executor ? { input: '' } : { arguments: '' } : {}) } })
    + event('response.output_item.done', { output_index: 0, item })
    + event('response.completed', { response }));
}

/** A real pipe consumer between the installed host and the unchanged ptool.
 * Stop reading during the large receipt response, before Node can complete its
 * stdout callback. Retain the request, consumed prefix and child close evidence;
 * a killed host or an absent provider request alone cannot pass this probe. */
function partialReceiptPipe(bridgeArgs: string[], port: string, probePath: string): string {
  return String.raw`import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ${JSON.stringify(bridgeArgs)}, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
const probe = { targetMethod: ${JSON.stringify(port === 'initialize' ? 'initialize' : 'tools/call')},
  pid: child.pid, targetRequest: null, consumedBytes: 0, forwardedBytes: 0, prefix: '',
  cut: false, closed: false, stderr: '', exitCode: null, signal: null };
const save = () => writeFileSync(${JSON.stringify(probePath)}, JSON.stringify(probe), { mode: 0o600 });
let input = '', cleanup;
process.stdin.on('data', chunk => {
  input += chunk.toString('utf8');
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    if (line.trim()) {
      const request = JSON.parse(line);
      if (request.method === probe.targetMethod) probe.targetRequest = request;
    }
  }
  if (!child.stdin.destroyed) child.stdin.write(chunk);
});
process.stdin.on('end', () => child.stdin.end());
child.stdin.on('error', () => {});
process.stdout.on('error', () => child.kill('SIGKILL'));
child.stderr.on('data', chunk => { probe.stderr = (probe.stderr + chunk).slice(-6000); });
child.stdout.on('data', chunk => {
  if (probe.targetRequest && !probe.cut) {
    probe.consumedBytes = chunk.length;
    const prefix = chunk.subarray(0, 1024);
    probe.forwardedBytes = prefix.length;
    probe.prefix = prefix.toString('utf8');
    probe.cut = true;
    process.stdout.write(prefix);
    child.stdout.destroy();
    child.stdin.end();
    save();
    // Cleanup is separate from the measured OS read-end close above.
    cleanup = setTimeout(() => child.kill('SIGKILL'), 500);
  } else if (!probe.cut) process.stdout.write(chunk);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill('SIGKILL'));
child.on('error', error => { probe.stderr += String(error); save(); process.exitCode = 1; });
child.on('close', (code, signal) => {
  clearTimeout(cleanup);
  probe.closed = true; probe.exitCode = code; probe.signal = signal;
  save(); process.stdout.end();
});
save();`;
}

export async function captureNativeMcp(client: NativeExport['client'], tools: Descriptor[],
  instructions?: string, denied: string[] = [],
  options: { claudeDescriptionMode?: 'full' | 'default'; stdioReceipt?: 'memory' | 'corpus';
    stdioPort?: 'initialize' | 'orient' | 'claim' | 'create'; maxProviderExchanges?: number;
    stdioFault?: 'absent-offer' | 'partial-stdout';
    stdioOwner?: string;
    // Let a backend integration supply the production response/offer while
    // retaining this fixture's installed client and real stdout boundary.
    mcpResult?: (method: string, result: Record<string, unknown>, request: Record<string, unknown>) => Promise<Record<string, unknown>>;
    onDiagnostics?: (path: string) => void } = {}): Promise<NativeExport> {
  // OMP's maintained adapter is in-process. A ptool subprocess would measure
  // a different route, so never turn its registration proof into stdout proof.
  if (options.stdioReceipt && (client === 'omp' || !instructions))
    throw new Error('Native stdout receipt profile requires Codex/Claude instructions');
  if (options.stdioFault && !options.stdioReceipt)
    throw new Error('Native stdout fault requires a receipt profile');
  const binary = wellKnownBackendBin(client === 'claude' ? 'claude-code' : client) ?? resolveOnPath(client);
  if (!binary) throw new Error(`Installed ${client} is required for native export evidence`);
  const maxProviderExchanges = options.maxProviderExchanges ?? 8;
  if (!Number.isInteger(maxProviderExchanges) || maxProviderExchanges < 1 || maxProviderExchanges > 32)
    throw new Error('Native provider exchange limit must be an integer from 1 to 32');
  let clientVersion = 'UNKNOWN';
  const clientSettings: NativeExport['clientSettings'] = {};
  const home = mkdtempSync(join(tmpdir(), `${client}-mcp-wire-`));
  // Version launchers can execute Node preloads before reaching the native
  // binary. Give both probes the same private, allowlisted environment;
  // inheriting Vitest loaders here defeats the client isolation below.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: home };
  const versionProbe = { timeoutMs: 5000, elapsedMs: null as number | null,
    environmentScope: 'private-client-home', inheritedNodeOptions: env.NODE_OPTIONS !== undefined };
  // This sibling survives private-home cleanup, including a failing exchange.
  const diagnosticsPath = `${home}.diagnostics.json`;
  const pipeProbePath = `${home}.pipe.json`;
  const receiptOwner = options.stdioOwner ?? `su-native-receipt-${client}`;
  const receiptPort = options.stdioPort ?? 'initialize';
  const receiptOffer = options.stdioReceipt ? { owner: receiptOwner, token: `native-${receiptPort}-${client}`,
    fragments: [memoryFragmentOffer(options.stdioReceipt, `native-${options.stdioReceipt}`, 3, receiptPort, instructions!)] } : null;
  const callReceipt = !!receiptOffer && receiptPort !== 'initialize';
  const responseOffer = options.stdioFault === 'absent-offer' ? null : receiptOffer;
  const methods: string[] = [], captures: Record<string, unknown>[] = [];
  const mcpRequests: Record<string, unknown>[] = [];
  const providerRoutes: string[] = [];
  let failure: string | null = null;
  let invocation: { argv: string[]; environment: Record<string, string | null> } | null = null;
  let child: ReturnType<typeof spawn> | undefined, stderr = '', stdout = '';
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET') {
        res.writeHead(req.url?.includes('/models') ? 200 : 405, { 'content-type': 'application/json' });
        res.end('{"models":[]}'); return;
      }
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const route = new URL(req.url ?? '/', 'http://offline.invalid').pathname;
      if (route === '/mcp' || route === '/api/mcp') {
        mcpRequests.push(body);
        const method = String(body.method); methods.push(method);
        if (body.id === undefined) { res.writeHead(202); res.end(); return; }
        const result = method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} },
            // Call-port canaries must first appear in the tool response;
            // initialization would contaminate the partial-output oracle.
            serverInfo: { name: 'offline-canary', version: '1' }, ...(instructions && !callReceipt ? { instructions } : {}),
            ...(responseOffer && !callReceipt ? { _meta: { 'papercusp/memoryEmission': responseOffer } } : {}) }
          : method === 'tools/list' ? { tools: tools.map(tool => ({ ...tool,
            inputSchema: { type: 'object', properties: {} },
            // This canary only returns a fixed local observation. Leaving its
            // safety unspecified makes Codex require interactive approval.
            ...(receiptOffer ? { annotations: { readOnlyHint: true, destructiveHint: false,
              idempotentHint: true, openWorldHint: false } } : {}),
            ...(receiptOffer ? { _meta: { 'papercusp/servingGeneration': 'native-receipt-fixture-v1' } } : {}) })) }
            : method === 'tools/call' && callReceipt ? {
              content: [{ type: 'text', text: JSON.stringify({ [receiptPort]: instructions }) }],
              ...(responseOffer ? { _meta: { 'papercusp/memoryEmission': responseOffer } } : {}) } : {};
        res.writeHead(200, { 'content-type': 'application/json' });
        const emitted = options.mcpResult ? await options.mcpResult(method, result, body) : result;
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: emitted })); return;
      }
      if (callReceipt && req.url?.includes('/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 })); return;
      }
      if (req.url?.includes('/responses') || Array.isArray(body.tools)) {
        captures.push(body);
        providerRoutes.push(route);
        if (captures.length > maxProviderExchanges) {
          failure = `Native provider exchange limit exceeded (${maxProviderExchanges})`;
          child?.kill('SIGKILL');
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: failure })); return;
        }
        if (callReceipt && client !== 'omp') {
          sendReceiptTurn(res, client, body, tools[0]!.name, methods.includes('tools/call'));
          return;
        }
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"Offline capture complete; no forwarding."}}');
    } catch (error) { if (!res.headersSent) res.writeHead(400); res.end(String(error)); }
  });
  const frameTypes: string[] = [];
  try {
    const versionStarted = performance.now();
    try {
      clientVersion = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: versionProbe.timeoutMs,
        env, cwd: home }).trim();
    } finally { versionProbe.elapsedMs = performance.now() - versionStarted; }
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const bridgeArgs = [fileURLToPath(new URL('../../../../../apps/operator/scripts/ptool.mjs', import.meta.url)),
      tools[0]!.name, '--stdio', '--transport', 'http', '--url', baseURL, '--token-file', join(home, 'mcp-token')];
    let nativeBridgeArgs = bridgeArgs;
    if (options.stdioFault === 'partial-stdout') {
      const wrapper = join(home, 'partial-receipt-pipe.mjs');
      writeFileSync(wrapper, partialReceiptPipe(bridgeArgs, receiptPort, pipeProbePath));
      nativeBridgeArgs = [wrapper];
    }
    if (receiptOffer) {
      writeFileSync(join(home, 'mcp-token'), 'offline-fixture-only', { mode: 0o600 });
      Object.assign(env, { PAPERCUSP_HOME: home, PAPERCUSP_OPERATOR_HOME: home,
        PAPERCUSP_SID: receiptOwner, PAPERCUSP_AGENT: client,
        // The canonical test runner owns this ancestor reader lease. Preserve
        // it in the nested ptool child; never fabricate a lease for a new root.
        ...(process.env.PAPERCUSP_INSTALL_MUTEX_HELD
          ? { PAPERCUSP_INSTALL_MUTEX_HELD: process.env.PAPERCUSP_INSTALL_MUTEX_HELD } : {}) });
    }
    let argv: string[];
    const registrationPath = join(home, 'registrations.json');
    if (client === 'codex') {
      const gateway = codexGatewayConfigToml(null, { gateway: { baseURL, token: 'offline_capture_token_'.repeat(3) } });
      writeFileSync(join(home, 'config.toml'), ['model = "gpt-6.1-sol"', ...gateway.root, ...gateway.tables,
        '[mcp_servers.offline_canary]', ...(receiptOffer
          ? [`command = ${JSON.stringify(process.execPath)}`, `args = ${JSON.stringify(nativeBridgeArgs)}`,
            // Codex filters the MCP child's inherited environment. These are
            // fixture identities and private paths, never account credentials.
            `env = { ${['PAPERCUSP_HOME', 'PAPERCUSP_OPERATOR_HOME', 'PAPERCUSP_SID',
              'PAPERCUSP_AGENT', 'PAPERCUSP_INSTALL_MUTEX_HELD'].filter(key => env[key])
              .map(key => `${key} = ${JSON.stringify(env[key])}`).join(', ')} }`]
          : [`url = "${baseURL}/mcp"`]), 'required = true',
        'startup_timeout_sec = 10', 'tool_timeout_sec = 10'].join('\n'));
      Object.assign(env, { CODEX_HOME: home, OPENAI_API_KEY: 'offline-fixture-only' });
      argv = ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '-C', home,
        ...(callReceipt ? ['--config', 'approval_policy="never"'] : []),
        callReceipt ? `Offline fixture: call ${tools[0]!.name} once then reply OK.` : 'Offline fixture: reply OK. Do not use tools.'];
    } else if (client === 'claude') {
      const path = join(home, 'mcp.json');
      writeFileSync(path, JSON.stringify({ mcpServers: { offline_canary: receiptOffer
        ? { type: 'stdio', command: process.execPath, args: nativeBridgeArgs }
        : { type: 'http', url: `${baseURL}/mcp` } } }));
      const descriptionMode = options.claudeDescriptionMode ?? 'full';
      Object.assign(clientSettings, { toolSearch: 'disabled', descriptionMode });
      if (descriptionMode === 'full') {
        // Compare complete schemas with a fixed ceiling derived from the
        // immutable baseline in BOTH arms. Claude's default description cap
        // is a different observation, retained by its own native canary.
        // The client expands ellipses BEFORE applying its character ceiling.
        // Sizing from raw input can truncate the longest frozen declaration.
        clientSettings.maxMcpDescriptionChars = Math.max(1,
          ...frozenBootstrap().baseline.tools.map(tool => bootstrapDescriptionForClient(client, tool.description).length),
          ...tools.map(tool => bootstrapDescriptionForClient(client, tool.description).length),
          bootstrapDescriptionForClient(client, instructions ?? '').length);
        env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = String(clientSettings.maxMcpDescriptionChars);
      }
      Object.assign(env, { CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_BASE_URL: baseURL,
        ANTHROPIC_API_KEY: 'offline-fixture-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
        // This paired full-schema profile does not establish parity with
        // default deferred ToolSearch or default description truncation.
        ENABLE_TOOL_SEARCH: 'false' });
      argv = ['--print', '--output-format', 'json', '--model', 'claude-haiku-4-5', '--no-session-persistence',
        '--setting-sources', '', '--strict-mcp-config', `--mcp-config=${path}`,
        ...(callReceipt ? [`--allowedTools=mcp__offline_canary__${tools[0]!.name}`] : []),
        ...(denied.length ? [`--disallowedTools=${denied.join(',')}`] : []), '--', 'Offline fixture: reply OK.'];
    } else {
      // A fresh HOME makes the compiled OMP extract its large native addon
      // before emitting any RPC frame. Reuse ONLY the installed version's
      // libraries in our private home; never copy settings or credentials.
      const version = /^omp\/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/.exec(clientVersion)?.[1];
      if (!version) throw new Error(`Unrecognized installed OMP version: ${clientVersion}`);
      const cacheRoots = [join(homedir(), '.omp', 'natives'),
        ...(process.env.XDG_DATA_HOME ? [join(process.env.XDG_DATA_HOME, 'omp', 'natives')] : [])];
      const cached = cacheRoots.map(root => join(root, version)).find(existsSync);
      const libraries = cached ? readdirSync(cached, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.node')) : [];
      if (!cached || !libraries.length) throw new Error(`Installed OMP ${version} native libraries are not prepared`);
      const privateCache = join(home, '.omp', 'natives', version);
      mkdirSync(privateCache, { recursive: true });
      for (const entry of libraries) copyFileSync(join(cached, entry.name), join(privateCache, entry.name), constants.COPYFILE_FICLONE);
      const checkout = fileURLToPath(new URL('../../../../../', import.meta.url));
      const recipe = nativeBuilds(checkout, `${home}/`).find(value => value.format === 'esm');
      if (!recipe) throw new Error('owned OMP build recipe missing');
      await build(recipe);
      const extension = join(home, 'capture.ts');
      // Observe exactly what the production adapter registers in the installed
      // OMP API, then delegate unchanged. dumpTools omits deferred MCP schemas.
      writeFileSync(extension, `import { writeFileSync } from 'node:fs';
import { registerNativeMcp } from './native-extension.mjs';
export default async function(pi) {
  pi.registerProvider('native-export-fixture', {
    api: 'native-export-fixture-api', apiKey: 'local-only', baseUrl: 'http://unused.invalid',
    models: [{ id: 'proof', name: 'Local export proof', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
    streamSimple() { throw new Error('Export census must not request inference'); }
  });
  const rows = [];
  await registerNativeMcp({ on: pi.on.bind(pi), registerTool(tool) {
    rows.push({ name: tool.name, description: tool.description });
    pi.registerTool(tool);
  } }, { papercuspNativeMcp: { version: 1, mode: 'http', servers: {
    offline_canary: { url: ${JSON.stringify(`${baseURL}/mcp`)} }
  } } });
  writeFileSync(${JSON.stringify(registrationPath)}, JSON.stringify(rows));
}`);
      Object.assign(env, { PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: join(home, 'sessions'),
        XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share') });
      argv = ['--mode', 'rpc', '--no-extensions', '--no-skills', '--no-rules', '--no-session',
        '--extension', extension, '--model', 'native-export-fixture/proof'];
    }
    invocation = { argv, environment: Object.fromEntries([
      'HOME', 'CODEX_HOME', 'PAPERCUSP_HOME', 'PAPERCUSP_OPERATOR_HOME', 'PAPERCUSP_SID',
      'PAPERCUSP_AGENT', 'PAPERCUSP_INSTALL_MUTEX_HELD',
    ].map(key => [key, env[key] ?? null])) };
    child = spawn(binary, argv, { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-3000); });
    const running = child;
    if (client === 'omp') {
      let buffer = '', requested = false;
      running.stdout!.setEncoding('utf8');
      running.stdout!.on('data', (chunk: string) => {
        stdout = (stdout + chunk).slice(-3000);
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const frame = JSON.parse(line);
          frameTypes.push(String(frame.type));
          if (frame.type === 'ready' && !requested) {
            requested = true; running.stdin!.write(JSON.stringify({ id: 'export', type: 'get_state' }) + '\n');
          }
          if (frame.type === 'response' && frame.id === 'export') {
            captures.push(frame); running.kill('SIGTERM');
          }
        }
      });
    } else {
      // Codex treats a live stdin as additional input even with a prompt argv.
      // The original native fixture used stdio:'ignore'; preserve that EOF.
      running.stdin!.end();
      running.stdout!.setEncoding('utf8');
      running.stdout!.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-16000); });
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        running.kill('SIGKILL');
        reject(new Error(`${client} native export timed out: ${JSON.stringify({
          methods, frameTypes, captures: captures.length, stdout, stderr,
        })}`));
      }, 25_000);
      running.once('error', error => { clearTimeout(timer); reject(error); });
      running.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (failure) throw new Error(failure);
    if (running.exitCode !== 0 && !captures.length)
      throw new Error(`${client} native export exited without a provider request: ${stderr}`);
    if (!methods.includes('initialize') || !methods.includes('tools/list')) throw new Error(`${client} MCP handshake missing: ${stderr}`);
    const request = callReceipt ? captures.at(-1)
      : captures.find(body => client === 'omp' || JSON.stringify(body).includes(tools[0]!.name));
    if (!request) throw new Error(`${client} native export missing: ${stderr}`);
    const descriptors = client === 'omp' ? JSON.parse(readFileSync(registrationPath, 'utf8')) as Descriptor[]
      : requestDescriptors(request.tools);
    if (client === 'omp') {
      const data = request.data as Record<string, unknown>;
      const prompt = (data.systemPrompt as string[]).join('\n');
      if (request.success !== true || !prompt.includes('xd://mcp__offline_canary_')) throw new Error('OMP mounted route missing');
    }
    const confirmations = receiptOffer
      ? openDeliveryLedger(receiptOwner, env, 'mcp')?.confirmedMemoryDeliveries() ?? [] : [];
    // Retain the production instrument's immutable exact-byte receipt before
    // the private client home is removed. Provider input alone is not a
    // replacement for the stdout terminal event.
    const stdoutReceipts: NativeExport['stdoutReceipts'] = confirmations.map(proof => {
      const { token } = proof as { token: string };
      return JSON.parse(readFileSync(join(ledgerDir(env), `${receiptOwner}.mcp.emissions`,
        `${sha256(token)}.json`), 'utf8'));
    });
    return { client, clientVersion, clientSettings, diagnosticsPath,
      evidencePlane: client === 'omp' ? 'installed-client-registration' : 'installed-client-local-request',
      request, descriptors, methods,
      ...(receiptOffer ? { stdoutDelivery: { adapter: 'ptool-stdio' as const, owner: receiptOwner,
        confirmations }, stdoutReceipts } : {}) };
  } catch (error) {
    failure ??= String(error);
    throw new Error(`${failure}; diagnostics: ${diagnosticsPath}`, { cause: error });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
      child.kill('SIGKILL'); await exited;
    }
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    writeFileSync(diagnosticsPath, JSON.stringify({ client, clientVersion, binary, clientSettings, versionProbe,
      receiptKind: options.stdioReceipt ?? null, receiptPort, stdioFault: options.stdioFault ?? null, maxProviderExchanges,
      stdoutDelivery: receiptOffer ? { adapter: 'ptool-stdio', owner: receiptOwner,
        confirmations: openDeliveryLedger(receiptOwner, { PAPERCUSP_HOME: home }, 'mcp')?.confirmedMemoryDeliveries() ?? [] } : null,
      pipeProbe: existsSync(pipeProbePath) ? JSON.parse(readFileSync(pipeProbePath, 'utf8')) : null,
      failure, invocation, exitCode: child?.exitCode ?? null, signal: child?.signalCode ?? null,
      methods, mcpRequests, providerRoutes, requests: captures, frameTypes, stdout, stderr,
      // Parent environment is measured here; the MCP child's inheritance must
      // be established separately from its actual initialize request metadata.
      environmentScope: 'native-client-parent',
    }, null, 2), { mode: 0o600 });
    options.onDiagnostics?.(diagnosticsPath);
    rmSync(home, { recursive: true, force: true });
  }
}
