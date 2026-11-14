// @vitest-environment node
/** Real Codex thread startup, local MCP only, no model turn or paid inference. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveOnPath, wellKnownBackendBin } from '../../../packages/operator-core/lib/backend-bin-resolve.mjs';
import { withManagedCodexStartupConfig } from '../scripts/psu-pty-host.mjs';

// Longer than the observed 30s native default; within proxy recovery's 90s.
const handshakeDelayMs = 35_000;

it.each(['old-budget', 'managed-budget'])('required MCP startup survives delayed initialize: %s', async mode => {
  const codex = wellKnownBackendBin('codex') ?? resolveOnPath('codex');
  expect(codex, 'Installed Codex is required for this native regression').toBeTruthy();
  const home = mkdtempSync(join(tmpdir(), 'codex-mcp-startup-'));
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let initializeCalls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    const reply = () => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} },
          serverInfo: { name: 'delayed-startup-fixture', version: '1' } }
        : rpc.method === 'tools/list' ? { tools: [] } : {} }));
    };
    if (rpc.method === 'initialize') {
      initializeCalls++;
      const timer = setTimeout(() => { timers.delete(timer); reply(); }, handshakeDelayMs);
      timers.add(timer);
    } else reply();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(home, 'config.toml'), [
    'check_for_update_on_startup = false', 'model = "gpt-6.1-sol"',
    '[features]', 'plugins = false', 'shell_snapshot = false',
    '[mcp_servers.papercusp-su]', `url = "http://127.0.0.1:${port}/mcp"`,
    'required = true', 'startup_timeout_sec = 30',
  ].join('\n'));
  // A retained home still has the old value. The production spawn adapter
  // must override it, including on carry-respawn, before Codex reads it.
  const args = withManagedCodexStartupConfig({ command: codex!,
    args: [...(mode === 'old-budget' ? ['-c', 'mcp_servers.papercusp-su.startup_timeout_sec=30'] : []),
      '--no-daemon', 'app-server', '--listen', 'stdio://'],
    env: { PAPERCUSP_AGENT: 'codex' } });
  const child = spawn(codex!, args, { cwd: home,
    env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: 'offline-fixture-only' },
    stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let stderr = '', buffer = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
  child.stdin.on('error', () => {});
  try {
    const result = await new Promise<{ result?: { thread?: { id?: string } }; error?: { message?: string } }>((resolve, reject) => {
      const timer = setTimeout(() => finish(undefined, new Error(`Native startup timed out: ${stderr}`)), 70_000);
      const finish = (value?: Parameters<typeof resolve>[0], error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve(value!);
      };
      child.once('error', error => finish(undefined, error));
      child.once('exit', code => finish(undefined, new Error(`Native startup exited ${code}: ${stderr}`)));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let frame;
          try { frame = JSON.parse(line); } catch { continue; }
          if (frame.id === 1) {
            if (frame.error) { finish(frame); return; }
            child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ id: 2, method: 'thread/start', params: {
              cwd: home, model: 'gpt-6.1-sol', approvalPolicy: 'never', sandbox: 'danger-full-access', ephemeral: true,
            } }) + '\n');
          } else if (frame.id === 2) finish(frame);
        }
      });
      child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'mcp_startup_regression', version: '1' },
      } }) + '\n');
    });
    expect(initializeCalls).toBeGreaterThan(0);
    if (mode === 'old-budget') {
      expect(result.error?.message).toMatch(/required MCP servers failed to initialize.*timed out handshaking/s);
    } else {
      expect(result.error, stderr).toBeUndefined();
      expect(result.result?.thread?.id).toBeTruthy();
    }
  } finally {
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    } else child.kill('SIGKILL');
    await closed;
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}, 90_000);
