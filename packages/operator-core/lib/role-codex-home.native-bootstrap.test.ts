/** Offline native account/read contract: no real credentials or model calls. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexGatewayConfigToml, codexManagedFeaturesToml } from '@papercusp/orchestrator/codex-gateway-config';
import { resolveOnPath } from './backend-bin-resolve.mjs';

const codex = resolveOnPath('codex');

async function readNativeAccount(home: string): Promise<{ result?: unknown; error?: { message?: string } }> {
  const env = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  const child = spawn(codex!, ['app-server', '--listen', 'stdio://'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.resume();
  try {
    return await new Promise((resolve, reject) => {
      let carry = '';
      const timer = setTimeout(() => reject(new Error('native account/read fixture exceeded 20s')), 20_000);
      const finish = (value?: { result?: unknown; error?: { message?: string } }, error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve(value!);
      };
      child.on('error', (error) => finish(undefined, error));
      child.on('exit', (code) => finish(undefined, new Error(`native app-server exited ${code} before account/read`)));
      child.stdout.on('data', (chunk: string) => {
        carry += chunk;
        let end: number;
        while ((end = carry.indexOf('\n')) >= 0) {
          const line = carry.slice(0, end);
          carry = carry.slice(end + 1);
          let reply: { id?: number; result?: unknown; error?: { message?: string } };
          try { reply = JSON.parse(line); } catch { continue; }
          if (reply.id === 1) {
            if (reply.error) { finish(reply); return; }
            child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ id: 2, method: 'account/read', params: { refreshToken: false } }) + '\n');
          } else if (reply.id === 2) finish(reply);
        }
      });
      child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'papercusp-bootstrap-regression', version: '1' },
        capabilities: { experimentalApi: true },
      } }) + '\n');
    });
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

describe('native gateway account bootstrap', () => {
  it.runIf(Boolean(codex))('does not consult the default ChatGPT workspace when the gateway owns auth', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-native-account-'));
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"offline workspace discovery fixture"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600,
      email: 'fixture@example.invalid', 'https://api.openai.com/auth': {
        chatgpt_account_id: 'default-fixture', chatgpt_plan_type: 'pro',
      } })}.fixture`;
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: token, id_token: token, refresh_token: 'fixture-refresh', account_id: 'default-fixture',
    } }));
    const gateway = codexGatewayConfigToml(null, { gatewayOn: true });
    // The fixture tests mandatory account discovery, not optional plugin catalogs.
    const config = [`chatgpt_base_url = "http://127.0.0.1:${port}"`, ...gateway.root,
      ...codexManagedFeaturesToml({ headless: true }), ...gateway.tables].join('\n');
    try {
      writeFileSync(join(home, 'config.toml'), config);
      const routed = await readNativeAccount(home);
      expect(routed.error).toBeUndefined();
      expect(routed.result).toMatchObject({ account: null, requiresOpenaiAuth: false });
      expect(requests).toEqual([]);
      // Check legacy omission separately: do not mistake explicit hardening for
      // proof of the original timeout's root cause on a client that defaults false.
      writeFileSync(join(home, 'config.toml'), config.replace('requires_openai_auth = false', ''));
      const legacy = await readNativeAccount(home);
      expect(legacy.error).toBeUndefined();
      expect(legacy.result).toMatchObject({ account: null, requiresOpenaiAuth: false });
      expect(requests).toEqual([]);
      // Positive control: making the same provider depend on the ambient login
      // must exercise the deliberately unavailable workspace-discovery endpoint.
      writeFileSync(join(home, 'config.toml'), config.replace('requires_openai_auth = false', 'requires_openai_auth = true'));
      const bound = await readNativeAccount(home);
      expect(bound.error?.message).toContain('workspace routing discovery');
      expect(requests.length).toBeGreaterThan(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
