/** Shared installed OMP fixture for focused preflight and production lifecycle proof. */
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { composeOmpCapabilityTools, type CapabilityPolicyRequest } from '@papercusp/orchestrator/managed-capability-policy';
import { invoke } from '@papercusp/orchestrator';
import { resumeArgsFor, roleLaunchArgs, suLaunchArgs } from '../../../apps/operator/scripts/psu-launcher.mjs';
import { resumeCommandFor } from '../lib/events/await/wake-executor';
import { resolveOnPath, wellKnownBackendBin } from '../lib/backend-bin-resolve.mjs';
import { retainIsolatedNativeTaskDiagnostics, withIsolatedNativeLaunchDiagnostics } from './isolated-integration-proof';
import { ompLifecycleProvider } from './omp-managed-native-provider';

const root = resolve(import.meta.dirname, '../../..');
const privateMcpUrl = process.env.OMP_MANAGED_PRIVATE_MCP_URL;
const nativeTools = ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'task', 'todo', 'web_search'];
export const admitted: CapabilityPolicyRequest = {
  client: 'omp', surface: 'launch', clientVersions: { omp: '18.0.3' }, ompNativeTools: nativeTools,
  readiness: [{ family: 'shell-ssh-interpreters', cutoverReady: true, openGapIds: [] }],
  cutoverStaging: { 'shell-ssh-interpreters': 'full' },
  adoption: [{ client: 'omp', family: 'shell-ssh-interpreters', managedPathProven: true,
    nativeBypassRefused: true, atClientVersion: '18.0.3' }],
  matrix: [{ client: 'omp', family: 'shell-ssh-interpreters', allScenariosPassed: true,
    declaredScenarioCount: 7, unmet: [] }],
};

export async function measureLifecycle(url: string, token: string, policy: CapabilityPolicyRequest, lifecycle: boolean,
  { viaInvoke = false, expectRestricted = true,
    evidenceDir = process.env.STAGING_FIRST_HTTP_EVIDENCE_DIR } = {}) {
  expect(evidenceDir, 'Native command diagnostics require retained evidence').toBeTruthy();
  const omp = wellKnownBackendBin('omp') ?? resolveOnPath('omp');
  expect(omp, 'Installed OMP is required').toBeTruthy();
  const version = execFileSync(omp!, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  const home = mkdtempSync(join(tmpdir(), 'omp-managed-lifecycle-'));
  const extension = join(home, 'provider.ts');
  const sessions = join(home, 'sessions');
  const resultPath = join(home, 'result.json');
  writeFileSync(extension, ompLifecycleProvider, { mode: 0o600 });
  const mcpUrl = new URL(url);
  mcpUrl.searchParams.set('tools', 'tools:invoke');
  const tokenFile = join(home, 'mcp-token');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: {
    papercusp: { type: 'stdio', command: process.execPath,
      args: [join(root, 'apps/operator/scripts/ptool.mjs'), 'tools:invoke', '--stdio',
        '--url', mcpUrl.href, '--token-file', tokenFile] },
  } }), { mode: 0o600 });
  const env = { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    PI_CODING_AGENT_DIR: home, PI_CONFIG_DIR: home, OMP_PROOF_RESULT: resultPath };
  const common = ['--mode', 'json', '--no-title', '--no-extensions', '--no-skills', '--no-rules',
    '--extension', extension, '--model', 'surface-fixture/proof', '--thinking', 'off',
    '--auto-approve', '--session-dir', sessions];
  const selection = ['--tools', nativeTools.join(',')];
  const observations: { surface: string; version: string; names: string[]; hasNativeExecution: boolean;
    nativeRefused: boolean; managedCalls: number; managedRefusal: boolean; managedPath: string }[] = [];
  let transcript: string | undefined;
  try {
    const surfaces = viaInvoke ? ['invoke'] as const
      : lifecycle ? ['launch', 'resume', 'wake'] as const : ['launch'] as const;
    for (const surface of surfaces) {
      const prompt = 'OMP managed ' + surface + ' proof';
      let args: string[];
      if (surface === 'invoke') {
        // The original selection still contains bash. Only invoke() may
        // compose the admitted restriction on this real process boundary.
        args = [...selection, '-p'];
      } else if (surface === 'launch') {
        const toolArgs = (argv: (string | undefined)[]) => {
          const index = argv.indexOf('--tools');
          const selected = index < 0 ? selection : argv.slice(index, index + 2);
          expect(selected).not.toContain(undefined);
          return selected.filter((arg): arg is string => arg !== undefined);
        };
        const su = toolArgs(suLaunchArgs('omp', { capabilityPolicy: policy }).args);
        expect(toolArgs(roleLaunchArgs('omp', { capabilityPolicy: policy }).args)).toEqual(su);
        expect(composeOmpCapabilityTools(selection, policy)).toEqual(su);
        args = [...su, '-p', prompt];
      } else if (surface === 'resume') {
        args = resumeArgsFor({ agent: 'omp', ompThreadId: transcript!, role: 'worker' }, {
          capabilityPolicy: policy, env: {},
        }).args;
        args = composeOmpCapabilityTools([...selection, ...args], policy);
        args.push('-p', prompt);
      } else {
        const wake = resumeCommandFor({ agent: 'omp', sessionId: null, ompThreadId: transcript! },
          prompt, null, policy);
        expect(wake?.promptViaPty).toBe(false);
        args = composeOmpCapabilityTools([...selection, ...wake!.args], { ...policy, surface: 'wake' });
      }
      let result: { stdout: string; stderr: string };
      let observedResult: typeof result | undefined;
      result = await withIsolatedNativeLaunchDiagnostics(evidenceDir!, async () => {
      if (surface === 'invoke') {
        const stateDir = join(home, '.papercusp');
        const logDir = join(stateDir, 'logs');
        const harnessDir = join(home, 'harness');
        mkdirSync(logDir, { recursive: true });
        mkdirSync(join(harnessDir, 'blueprints', 'base', 'prompts'), { recursive: true });
        writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ timeouts: { reviewer: 30 } }));
        const logs: string[] = [];
        const invoked = await invoke({ harnessDir, projectDir: home, stateDir, logDir, phase: 'staging',
          agentBackend: 'omp', claudeCmd: [omp!, ...common, ...args].join(' '), dept: '',
          log: line => logs.push(line) }, 'reviewer', [], { capabilityPolicy: policy,
          inlinePrompt: prompt, cwd: home, extraEnv: Object.fromEntries(Object.entries({ ...env,
            OMP_PROOF_SURFACE: surface }).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
        observedResult = { stdout: readFileSync(invoked.jsonlPath, 'utf8'),
          stderr: readFileSync(invoked.jsonlPath.replace(/\.jsonl$/, '.err'), 'utf8') };
        expect(invoked.exitCode, JSON.stringify({ logs, stderr: observedResult.stderr })).toBe(0);
        return observedResult;
      } else {
        const execution = promisify(execFile)(omp!, [...common, ...args], {
          cwd: home, env: { ...env, OMP_PROOF_SURFACE: surface }, timeout: 30_000,
          killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
        });
        // OMP reads piped stdin before the positional prompt.
        execution.child.stdin?.end();
        return await execution;
      }
      }, async outcome => {
        if (outcome.status !== 'rejected') return;
        const error = outcome.error as { code?: unknown; signal?: unknown; stdout?: string; stderr?: string };
        const sources = { stdout: join(home, 'stdout.log'), stderr: join(home, 'stderr.log') };
        writeFileSync(sources.stdout, error?.stdout ?? outcome.result?.stdout ?? observedResult?.stdout ?? '', { mode: 0o600 });
        writeFileSync(sources.stderr, error?.stderr ?? outcome.result?.stderr ?? observedResult?.stderr ?? '', { mode: 0o600 });
        retainIsolatedNativeTaskDiagnostics(evidenceDir!, { client: 'omp', surface, version,
          state: 'failed', exitCode: error?.code ?? null, signal: error?.signal ?? null,
          expectRestricted, error: String(outcome.error) }, sources);
      }, async result => {
      expect(result.stderr).not.toMatch(/Invalid tool names/);
      const measured = JSON.parse(readFileSync(resultPath, 'utf8'));
      if (privateMcpUrl && process.env.STAGING_FIRST_HTTP_EVIDENCE_DIR) {
        appendFileSync(join(process.env.STAGING_FIRST_HTTP_EVIDENCE_DIR, 'managed-tool-replies.ndjson'),
          JSON.stringify({ surface, version, replies: measured.replies }) + '\n', { mode: 0o600 });
      }
      const reply = (kind: string) => measured.replies.find((row: { toolCallId: string }) =>
        row.toolCallId === surface + '_' + kind);
      expect(reply('managed'), JSON.stringify(measured)).toBeDefined();
      expect(JSON.stringify(reply('managed')), JSON.stringify({ names: measured.names,
        dispatcher: measured.dispatcher, stderr: result.stderr.slice(-2000) })).toContain('OMP_MANAGED_OK');
      expect(JSON.stringify(reply('refusal'))).toMatch(/unknown|not.found|not.available|not.registered|unsupported/i);
      const native = reply('native');
      if (expectRestricted) {
        expect(measured.names).not.toContain('bash');
        expect(native?.isError, JSON.stringify(native)).toBe(true);
        expect(JSON.stringify(native)).not.toContain('OMP_NATIVE_ESCAPE');
      } else {
        expect(measured.names).toContain('bash');
        expect(JSON.stringify(native)).toContain('OMP_NATIVE_ESCAPE');
      }
      if (surface === 'resume' || surface === 'wake')
        expect(JSON.stringify(measured.messages)).toContain('OMP managed launch proof');
      observations.push({ surface, version, names: measured.names,
        hasNativeExecution: native?.isError !== true && JSON.stringify(native).includes('OMP_NATIVE_ESCAPE'),
        nativeRefused: native?.isError === true, managedCalls: 1, managedRefusal: true,
        managedPath: privateMcpUrl ? 'production-capability-bash' : 'local-mcp-preflight' });
      const files = readdirSync(sessions, { recursive: true }).map(String).filter(name => name.endsWith('.jsonl'));
      expect(files, 'One persisted native session must survive all lifecycle processes').toHaveLength(1);
      const next = join(sessions, files[0]!);
      if (transcript) expect(next).toBe(transcript);
      transcript = next;
      });
    }
    return observations;
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Cheap native MCP preflight before paying for private API/PG setup. */
export async function localPreflight(evidenceDir: string) {
  const requests: { method: string; rpc?: string; generation?: string }[] = [];
  const server = createServer(async (req, res) => {
    const request: { method: string; rpc?: string; generation?: string } = { method: req.method ?? '' };
    requests.push(request);
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (req.headers.authorization !== 'Bearer local-only') { res.writeHead(401).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let message;
    try { message = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { res.writeHead(400).end(); return; }
    request.rpc = message.method;
    request.generation = message.params?._meta?.['papercusp/servingGeneration'];
    if (message.id == null) { res.writeHead(202).end(); return; }
    const tool = { name: 'tools:invoke', description: 'Local preflight dispatcher',
      _meta: { 'papercusp/servingGeneration': 'serving-generation-v1:omp-preflight' },
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } },
        required: ['name', 'args'] } };
    const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'omp-local-preflight', version: '1' } }
      : message.method === 'tools/list' ? { tools: [tool] }
      : request.generation !== tool._meta['papercusp/servingGeneration']
        ? { isError: true, content: [{ type: 'text', text: 'stale_tool_contract' }] }
      : message.params?.arguments?.name === 'capability:bash'
        ? { content: [{ type: 'text', text: 'OMP_MANAGED_OK' }] }
        : { isError: true, content: [{ type: 'text', text: 'unknown tool negative control' }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address() as { port: number };
    try {
      const url = 'http://127.0.0.1:' + address.port + '/api/mcp';
      // The retained-native control exercises OMP's real bash before paying
      // for the private build; restricted-only preflight never covered it.
      const retained = await measureLifecycle(url, 'local-only', { ...admitted, cutoverStaging: {} }, false,
        { expectRestricted: false, evidenceDir });
      const lifecycle = await measureLifecycle(url, 'local-only', admitted, true, { evidenceDir });
      const invoked = await measureLifecycle(url, 'local-only', admitted, false, { viaInvoke: true, evidenceDir });
      const calls = requests.filter(request => request.rpc === 'tools/call');
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(request => request.generation === 'serving-generation-v1:omp-preflight')).toBe(true);
      return { retained, lifecycle, invoked };
    } catch (error) {
      throw new Error('Native MCP preflight failed: ' + String(error)
        + '; requests=' + JSON.stringify(requests), { cause: error });
    }
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}
