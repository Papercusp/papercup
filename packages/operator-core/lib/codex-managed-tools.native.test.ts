/** Installed-client tool census at the real request boundary; no paid inference. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexGatewayConfigToml } from '@papercusp/orchestrator/codex-gateway-config';
import { resolveOnPath, wellKnownBackendBin } from './backend-bin-resolve.mjs';

declare module 'vitest' {
  interface TaskMeta {
    nativeToolSurface?: unknown;
  }
}

const managedTool = 'managed_surface_canary';

async function captureSurface(features: Record<string, boolean>) {
  const codex = wellKnownBackendBin('codex') ?? resolveOnPath('codex');
  if (!codex) throw new Error('Installed Codex is required for native-tool removal evidence');
  const home = mkdtempSync(join(tmpdir(), 'codex-managed-surface-'));
  const captures: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(req.url?.includes('/models') ? 200 : 405, { 'content-type': 'application/json' });
      res.end('{"models":[]}');
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
      if (req.url?.includes('/responses')) captures.push(body);
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
    'model = "gpt-6.1-sol"', ...gateway.root, ...gateway.tables,
    '[features]', ...Object.entries(features).map(([key, value]) => `${key} = ${value}`),
    '[mcp_servers.managed_surface]', `url = "${baseURL}/mcp"`, 'required = true',
    'startup_timeout_sec = 10', 'tool_timeout_sec = 10',
  ].join('\n'));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: 'offline-fixture-only' };
  delete env.CODEX_API_KEY;
  delete env.PAPERCUSP_SCOPED_INFERENCE_GATEWAY;
  let stderr = '';
  const child = spawn(codex, ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '-C', home,
    'Offline census: reply OK. Do not use tools.'], { env, cwd: home, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-3000); });
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
    expect(JSON.stringify(request), stderr).toContain(managedTool);
    return { version: execFileSync(codex, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(), names };
  } finally {
    child.kill('SIGTERM');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

describe('Codex managed replacement installed-client census', () => {
  it('measures native shell removal while retaining the managed MCP surface', async ({ task }) => {
    const baseline = await captureSurface({ code_mode_host: false });
    const restricted = await captureSurface({ code_mode_host: false, shell_tool: false });
    console.info('CODEX_MANAGED_TOOL_SURFACE', JSON.stringify({ baseline, restricted }));
    task.meta.nativeToolSurface = { baseline, restricted };
    expect(baseline.names).toContain('exec_command');
    expect(restricted.names).not.toContain('exec_command');
    expect(restricted.names).not.toContain('write_stdin');
  }, 60_000);

  it('records remaining native tools after the measured feature switches are disabled', async ({ task }) => {
    const features = { code_mode_host: false, shell_tool: false, view_image: false,
      sleep_tool: false, computer_use: false, browser_use: false, multi_agent: false,
      goals: false, image_generation: false };
    const restricted = await captureSurface(features);
    task.meta.nativeToolSurface = { features, restricted };
    // Keep the observed residue in the ledger: disabling flags is not proof
    // that an unrelated native tool disappeared.
    expect(restricted.names).not.toContain('exec_command');
    expect(restricted.names).not.toContain('write_stdin');
    expect(restricted.names).not.toContain('view_image');
    expect(restricted.names).not.toContain('sleep');
  }, 30_000);
});
