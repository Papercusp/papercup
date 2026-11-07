/** Installed-client export observations. These reuse the native census fixtures'
 * private homes, loopback refusal and production OMP build. No provider calls. */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { codexGatewayConfigToml } from '@papercusp/orchestrator/codex-gateway-config';
import { nativeBuilds } from '../../../../omp-plugin/build-native.mjs';
import { resolveOnPath, wellKnownBackendBin } from '../../backend-bin-resolve.mjs';
import { bootstrapDescriptionForClient } from '../injection-delivery-coverage';

export type Descriptor = { name: string; description: string };
export type NativeExport = {
  client: 'codex' | 'claude' | 'omp'; clientVersion: string;
  evidencePlane: 'installed-client-local-request' | 'installed-client-registration';
  descriptors: Descriptor[]; request: Record<string, unknown>; methods: string[];
  clientSettings: { toolSearch?: 'disabled'; descriptionMode?: 'full' | 'default'; maxMcpDescriptionChars?: number };
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

export async function captureNativeMcp(client: NativeExport['client'], tools: Descriptor[],
  instructions?: string, denied: string[] = [],
  options: { claudeDescriptionMode?: 'full' | 'default' } = {}): Promise<NativeExport> {
  const binary = wellKnownBackendBin(client === 'claude' ? 'claude-code' : client) ?? resolveOnPath(client);
  if (!binary) throw new Error(`Installed ${client} is required for native export evidence`);
  const clientVersion = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  const clientSettings: NativeExport['clientSettings'] = {};
  const home = mkdtempSync(join(tmpdir(), `${client}-mcp-wire-`));
  const methods: string[] = [], captures: Record<string, unknown>[] = [];
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
      if (req.url === '/mcp') {
        const method = String(body.method); methods.push(method);
        if (body.id === undefined) { res.writeHead(202); res.end(); return; }
        const result = method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} },
            serverInfo: { name: 'offline-canary', version: '1' }, ...(instructions ? { instructions } : {}) }
          : method === 'tools/list' ? { tools: tools.map(tool => ({ ...tool,
            inputSchema: { type: 'object', properties: {} } })) } : {};
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return;
      }
      if (req.url?.includes('/responses') || Array.isArray(body.tools)) captures.push(body);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"Offline capture complete; no forwarding."}}');
    } catch (error) { res.writeHead(400); res.end(String(error)); }
  });
  let child: ReturnType<typeof spawn> | undefined, stderr = '', stdout = '';
  const frameTypes: string[] = [];
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: home };
    let argv: string[];
    const registrationPath = join(home, 'registrations.json');
    if (client === 'codex') {
      const gateway = codexGatewayConfigToml(null, { gateway: { baseURL, token: 'offline_capture_token_'.repeat(3) } });
      writeFileSync(join(home, 'config.toml'), ['model = "gpt-6.1-sol"', ...gateway.root, ...gateway.tables,
        '[mcp_servers.offline_canary]', `url = "${baseURL}/mcp"`, 'required = true',
        'startup_timeout_sec = 10', 'tool_timeout_sec = 10'].join('\n'));
      Object.assign(env, { CODEX_HOME: home, OPENAI_API_KEY: 'offline-fixture-only' });
      argv = ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '-C', home, 'Offline fixture: reply OK. Do not use tools.'];
    } else if (client === 'claude') {
      const path = join(home, 'mcp.json');
      writeFileSync(path, JSON.stringify({ mcpServers: { offline_canary: { type: 'http', url: `${baseURL}/mcp` } } }));
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
      running.stdout!.resume();
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
    if (!methods.includes('initialize') || !methods.includes('tools/list')) throw new Error(`${client} MCP handshake missing: ${stderr}`);
    const request = captures.find(body => client === 'omp' || JSON.stringify(body).includes(tools[0]!.name));
    if (!request) throw new Error(`${client} native export missing: ${stderr}`);
    const descriptors = client === 'omp' ? JSON.parse(readFileSync(registrationPath, 'utf8')) as Descriptor[]
      : requestDescriptors(request.tools);
    if (client === 'omp') {
      const data = request.data as Record<string, unknown>;
      const prompt = (data.systemPrompt as string[]).join('\n');
      if (request.success !== true || !prompt.includes('xd://mcp__offline_canary_')) throw new Error('OMP mounted route missing');
    }
    return { client, clientVersion, clientSettings,
      evidencePlane: client === 'omp' ? 'installed-client-registration' : 'installed-client-local-request',
      request, descriptors, methods };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
      child.kill('SIGKILL'); await exited;
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}
