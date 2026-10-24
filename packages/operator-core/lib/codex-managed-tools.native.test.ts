/** Installed-client tool census at the real request boundary; no paid inference. */
import { execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexGatewayConfigToml, codexManagedFeaturesToml } from '@papercusp/orchestrator/codex-gateway-config';
import type { CapabilityPolicyRequest } from '@papercusp/orchestrator/managed-capability-policy';
import { resolveOnPath, wellKnownBackendBin } from './backend-bin-resolve.mjs';
import { nativeToolInventory } from '../../../libs/papercusp/packages/orchestrator/src/managed-capability-client-inventory';

declare module 'vitest' {
  interface TaskMeta {
    nativeToolSurface?: unknown;
  }
}

const managedTool = 'managed_surface_canary';
const nestedSurfaceMarker = 'CODEX_NESTED_TOOL_SURFACE';

function spawnCensusProcess(command: string, args: string[], options: SpawnOptions) {
  const child = spawn(command, args, {
    ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'],
  });
  // The npm launcher can exit while a plugin-fetch child still owns stderr and
  // writes to CODEX_HOME. Retain close from spawn time, including error paths.
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  return { child, closed };
}

async function stopCensusProcess({ child, closed }: ReturnType<typeof spawnCensusProcess>) {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  } else {
    child.kill('SIGKILL');
  }
  await closed;
}

async function captureSurface(features: Record<string, boolean>, captureNested = true, model = 'gpt-6.1-sol',
  capabilityPolicy?: Omit<CapabilityPolicyRequest, 'client'>) {
  const codex = wellKnownBackendBin('codex') ?? resolveOnPath('codex');
  if (!codex) throw new Error('Installed Codex is required for native-tool removal evidence');
  const catalogJson = execFileSync(codex, ['debug', 'models'], { encoding: 'utf8', timeout: 5000 });
  const catalog = JSON.parse(catalogJson);
  const selectedModel = catalog.models.find((entry: { slug: string }) => entry.slug === model);
  expect(selectedModel, `Installed catalog must contain ${model}`).toBeDefined();
  const measuredModel = selectedModel.slug;
  const home = mkdtempSync(join(tmpdir(), 'codex-managed-surface-'));
  const catalogPath = join(home, 'installed-models.json');
  writeFileSync(catalogPath, catalogJson);
  const captures: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(req.url?.includes('/models') ? 200 : 405, { 'content-type': 'application/json' });
      res.end(catalogJson);
      return;
    }
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/mcp') {
        if (body.id === undefined) { res.writeHead(202); res.end(); return; }
        const result = body.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'managed-surface', version: '1' } }
          : body.method === 'tools/list'
            ? { tools: [{ name: managedTool, description: 'Offline managed tool canary.', inputSchema: { type: 'object', properties: {} } }] }
            : {};
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        return;
      }
      if (req.url?.includes('/responses')) {
        captures.push(body);
        if (captureNested) {
          const first = captures.length === 1;
          const item = first
            ? { id: 'nested_surface_call', type: 'custom_tool_call', namespace: 'functions', name: 'exec',
              call_id: 'call_nested_surface', status: 'completed', input:
                `text({ marker: ${JSON.stringify(nestedSurfaceMarker)}, tools: ALL_TOOLS.map(tool => ({ name: tool.name, callable: typeof tools[tool.name] })) });` }
            : { id: 'nested_surface_done', type: 'message', role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text: 'Census complete.', annotations: [] }] };
          const response = { id: `surface_response_${captures.length}`, object: 'response', created_at: 1,
            status: 'completed', model: measuredModel, output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const event of [
            { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
            { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response },
          ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          res.end();
          return;
        }
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"type":"invalid_request_error","message":"Offline tool census complete; no forwarding."}}');
    } catch (error) {
      res.writeHead(400); res.end(String(error));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const gateway = codexGatewayConfigToml(null, { gateway: { baseURL, token: 'offline_surface_token_'.repeat(3) } });
  writeFileSync(join(home, 'config.toml'), [
    `model = ${JSON.stringify(measuredModel)}`, `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    ...gateway.root, ...gateway.tables,
    ...(capabilityPolicy ? codexManagedFeaturesToml({ capabilityPolicy, disableMemories: false }) : ['[features]']),
    ...Object.entries(features).map(([key, value]) => `${key} = ${value}`),
    '[mcp_servers.managed_surface]', `url = "${baseURL}/mcp"`, 'required = true',
    'startup_timeout_sec = 10', 'tool_timeout_sec = 10',
  ].join('\n'));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: 'offline-fixture-only' };
  delete env.CODEX_API_KEY;
  delete env.PAPERCUSP_SCOPED_INFERENCE_GATEWAY;
  let stderr = '';
  const census = spawnCensusProcess(codex, ['--no-daemon', 'exec', '--skip-git-repo-check', '--ephemeral', '--json', '-C', home,
    'Offline census: reply OK. Do not use tools.'], { env, cwd: home });
  const { child } = census;
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-3000); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Tool census timed out: ${stderr}`)); }, 25_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    expect(captures.length, stderr).toBeGreaterThan(0);
    const request = captures[0]!;
    const names: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== 'object') return;
      const row = value as Record<string, unknown>;
      if (typeof row.name === 'string') names.push(row.name);
      Object.values(row).forEach(walk);
    };
    walk(request.tools);
    const nestedTools: { name: string; callable: string }[] = [];
    const readNested = (value: unknown): void => {
      if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
        try { readNested(JSON.parse(value)); } catch { /* Other output strings are not the census. */ }
        return;
      }
      if (Array.isArray(value)) { value.forEach(readNested); return; }
      if (!value || typeof value !== 'object') return;
      const row = value as Record<string, unknown>;
      if (row.marker === nestedSurfaceMarker && Array.isArray(row.tools)) {
        nestedTools.push(...row.tools as { name: string; callable: string }[]);
        return;
      }
      Object.values(row).forEach(readNested);
    };
    // Read the tool's output returned by the real client, never the injected call
    // or a copy of the expected names. The next provider request carries it.
    for (const captured of captures.slice(1)) {
      for (const item of Array.isArray(captured.input) ? captured.input : []) {
        if (item.type === 'custom_tool_call_output' && item.call_id === 'call_nested_surface') readNested(item.output);
      }
    }
    if (captureNested) {
      expect(nestedTools, `No code-mode census output; advertised tools: ${names.join(', ')}; ${stderr}`).not.toHaveLength(0);
      expect(nestedTools.every(tool => tool.callable === 'function')).toBe(true);
      expect(nestedTools.some(tool => tool.name.includes(managedTool))).toBe(true);
    }
    expect(JSON.stringify({ request, nestedTools }), `Advertised tools: ${names.join(', ')}; ${stderr}`).toContain(managedTool);
    return { version: execFileSync(codex, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(), names,
      requestKeys: Object.keys(request), executedOuterNames: captureNested ? ['exec'] : [],
      catalog: { source: 'installed-codex-debug-models', sha256: createHash('sha256').update(catalogJson).digest('hex'),
        model: selectedModel.slug, toolMode: selectedModel.tool_mode ?? 'direct',
        applyPatchToolType: selectedModel.apply_patch_tool_type },
      nestedNames: nestedTools.map(tool => tool.name),
      hasNativeExecution: [...names, ...nestedTools.map(tool => tool.name)]
        .some(name => name === 'exec_command' || name === 'write_stdin') };
  } finally {
    await stopCensusProcess(census);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

describe('Codex managed replacement installed-client census', () => {
  it('uses admitted production config to remove native shell while preserving callable MCP', async ({ task }) => {
    const observedVersion = execFileSync(wellKnownBackendBin('codex') ?? resolveOnPath('codex')!,
      ['--version'], { encoding: 'utf8', timeout: 5000 }).trim().match(/\d+\.\d+\.\d+/)?.[0];
    const policy: Omit<CapabilityPolicyRequest, 'client'> = {
      surface: 'launch', clientVersions: { codex: observedVersion! },
      readiness: [{ family: 'shell-ssh-interpreters', cutoverReady: true, openGapIds: [] }],
      cutoverStaging: { 'shell-ssh-interpreters': 'full' },
      adoption: [{ client: 'codex', family: 'shell-ssh-interpreters',
        managedPathProven: true, nativeBypassRefused: true, atClientVersion: observedVersion }],
      matrix: [{ client: 'codex', family: 'shell-ssh-interpreters',
        allScenariosPassed: true, declaredScenarioCount: 7, unmet: [] }],
    };
    const features = { code_mode: true, code_mode_host: true };
    const retained = await captureSurface(features, true, 'gpt-6.1-sol', { ...policy, cutoverStaging: {} });
    const removed = await captureSurface(features, true, 'gpt-6.1-sol', policy);
    const drift = await captureSurface(features, true, 'gpt-6.1-sol', { ...policy,
      clientVersions: { codex: 'unvalidated-client-version' } });
    task.meta.nativeToolSurface = { retained, removed, drift };
    expect(retained.nestedNames).toContain('exec_command');
    expect(removed.nestedNames).not.toContain('exec_command');
    expect(removed.nestedNames).not.toContain('write_stdin');
    expect(drift.nestedNames).toContain('exec_command');
    // captureSurface also verifies that the actual inner MCP catalog is callable.
  }, 90_000);

  it.runIf(process.platform !== 'win32')('stops a home writer that outlives its client before cleanup', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-census-lifecycle-'));
    const marker = join(home, 'writer');
    const writer = `const fs = require('node:fs');
      const write = () => { fs.mkdirSync(${JSON.stringify(home)}, { recursive: true });
        fs.writeFileSync(${JSON.stringify(marker)}, 'active'); };
      write(); setInterval(write, 1); process.send('ready'); process.disconnect();`;
    const parent = `const { spawn } = require('node:child_process');
      const writer = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}],
        { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      writer.once('message', () => process.exit(0));`;
    const census = spawnCensusProcess(process.execPath, ['-e', parent], { cwd: home });
    let closed = false;
    void census.closed.then(() => { closed = true; });
    try {
      await once(census.child, 'exit');
      expect(existsSync(marker)).toBe(true);
      expect(closed, 'descendant still holds the client stderr after parent exit').toBe(false);
      await stopCensusProcess(census);
      expect(closed).toBe(true);
      rmSync(home, { recursive: true, force: true });
      expect(existsSync(home)).toBe(false);
    } finally {
      await stopCensusProcess(census);
      rmSync(home, { recursive: true, force: true });
    }
  }, 5000);

  it('records the outer code-mode surface and the actual callable inner catalog', async ({ task }) => {
    const codeMode = await captureSurface({ code_mode: true, code_mode_host: true }, true, 'gpt-6.1-sol');
    const codeModeRestricted = await captureSurface({ code_mode: true, code_mode_host: true, shell_tool: false }, true, 'gpt-6.1-sol');
    task.meta.nativeToolSurface = { codeMode, codeModeRestricted };
    const managedOnly = await captureSurface({ code_mode: true, code_mode_host: true, shell_tool: false,
      view_image: false, sleep_tool: false, computer_use: false, browser_use: false,
      multi_agent: false, goals: false, image_generation: false });
    const inventory = nativeToolInventory({ client: 'codex', clientVersion: codeMode.version,
      nativeNames: [...codeMode.names, ...codeMode.executedOuterNames, ...codeMode.nestedNames]
        .filter(name => name !== 'multi_agent_v1'),
      managedNames: [managedTool] });
    task.meta.nativeToolSurface = { codeMode, codeModeRestricted, managedOnly, inventory };
    expect(codeMode.nestedNames).toContain('exec_command');
    expect(codeMode.nestedNames).toContain('apply_patch');
    expect(codeModeRestricted.nestedNames).not.toContain('exec_command');
    expect(codeModeRestricted.nestedNames).not.toContain('write_stdin');
    expect(codeMode.hasNativeExecution).toBe(true);
    expect(codeModeRestricted.hasNativeExecution).toBe(false);
    expect(inventory.rows.every(row => row.gap === null || row.gap === 'client-version-drift' ||
      row.gap === 'native-parity-unverified')).toBe(true);
    expect(inventory.rows.find(row => row.nativeName === 'clock__curr_time')).toMatchObject({
      family: null, disposition: 'unsupported-gap', gap: 'native-parity-unverified', cutoverReady: false,
    });
    expect(codeMode.nestedNames).not.toEqual(managedOnly.nestedNames);
    expect(managedOnly.names).not.toContain('exec_command');
    expect(managedOnly.names).not.toContain('write_stdin');
    expect(managedOnly.nestedNames).not.toContain('exec_command');
    expect(managedOnly.nestedNames).not.toContain('write_stdin');
  }, 60_000);
  it('measures native shell removal while retaining the managed MCP surface', async ({ task }) => {
    const baseline = await captureSurface({ code_mode: true, code_mode_host: true });
    const restricted = await captureSurface({ code_mode: true, code_mode_host: true, shell_tool: false });
    console.info('CODEX_MANAGED_TOOL_SURFACE', JSON.stringify({ baseline, restricted }));
    task.meta.nativeToolSurface = { baseline, restricted };
    expect(baseline.nestedNames).toContain('exec_command');
    expect(restricted.nestedNames).not.toContain('exec_command');
    expect(restricted.nestedNames).not.toContain('write_stdin');
  }, 60_000);

  it('records remaining native tools after the measured feature switches are disabled', async ({ task }) => {
    const features = { code_mode: true, code_mode_host: true, shell_tool: false, view_image: false,
      sleep_tool: false, computer_use: false, browser_use: false, multi_agent: false,
      goals: false, image_generation: false };
    const restricted = await captureSurface(features);
    task.meta.nativeToolSurface = { features, restricted };
    // Keep the observed residue in the ledger: disabling flags is not proof
    // that an unrelated native tool disappeared.
    expect(restricted.nestedNames).not.toContain('exec_command');
    expect(restricted.nestedNames).not.toContain('write_stdin');
    expect(restricted.nestedNames).not.toContain('view_image');
    expect(restricted.nestedNames).not.toContain('sleep');
  }, 30_000);
});
