/**
 * WI-10004231: a vmcall.sh timeout must say WHICH side was slow.
 *
 * Same-box PDS run 8 (2026-09-30): vmcall.sh killed its mcp-call child at its 30s
 * deadline (07:29:54Z), yet the VM's own tool_invocations row shows the call was
 * dispatched at 07:29:55.035Z and answered in 15ms. Nothing recorded when the
 * request left the client, so "the client never got the request out" and "the
 * operator sat on it" produced the same MCP_RESULT_TIMEOUT line, and the run could
 * not be attributed without a re-run.
 *
 * The fix: mcp-call.mjs stamps the epoch-ms at which it hands the request to fetch
 * into PAPERCUSP_MCP_CALL_SENT_MARKER, and vmcall.sh folds that stamp into its
 * timeout line. These tests run the REAL vmcall.sh (with a stub child) and the REAL
 * mcp-call.mjs (against an in-test HTTP server). Nothing reaches a live operator.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'vm-rig', 'vmcall.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('repo root not found');
}

const root = repoRoot();
const VMCALL = join(root, 'papercusp-desktop', 'bin', 'vm-rig', 'vmcall.sh');
const MCP_CALL = join(root, 'scripts', 'mcp-call.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'vmcall-attribution-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} did not exit within ${timeoutMs}ms; stderr: ${stderr}`));
    }, timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** A stand-in for mcp-call.mjs that vmcall.sh runs as its bounded child. */
function stub(name: string, body: string): string {
  const path = join(scratch, `${name}.mjs`);
  writeFileSync(path, body);
  return path;
}

function vmcall(stubPath: string): Promise<Run> {
  return run('bash', [VMCALL, 'dev:dogfood_substrate_status', '{}'], {
    ...process.env,
    HOME: scratch,
    PAPERCUSP_HONO_PORT: '1', // skip port discovery; the stub never dials it
    PCUSP_VM_NODE: process.execPath,
    PCUSP_MCP_CALL: stubPath,
    PCUSP_VM_CALL_TIMEOUT_SEC: '2',
  });
}

const SENT_THEN_HANG = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.PAPERCUSP_MCP_CALL_SENT_MARKER, String(Date.now()) + '\\n');
setTimeout(() => {}, 60_000);
`;
const HANG_BEFORE_SEND = `setTimeout(() => {}, 60_000);\n`;
const ANSWER = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.PAPERCUSP_MCP_CALL_SENT_MARKER, String(Date.now()) + '\\n');
process.stdout.write('{"ok":true}\\n');
`;

describe('vmcall.sh timeout attribution (WI-10004231)', () => {
  it('names a SERVER-side timeout when the request left the client, keeping the greppable prefix', async () => {
    const r = await vmcall(stub('sent-then-hang', SENT_THEN_HANG));
    expect(r.status, r.stderr).toBe(124);
    // Callers grep this exact prefix (hive-git-physical-scenario.sh replays on it).
    expect(r.stderr).toContain('MCP_RESULT_TIMEOUT: MCP call did not complete within 2s; ');
    expect(r.stderr).toMatch(/request sent [0-2]s after start; the operator did not answer/);
    expect(r.stderr).not.toContain('request never sent');
  });

  it('names a CLIENT-side timeout when the child never reached its POST', async () => {
    const r = await vmcall(stub('hang-before-send', HANG_BEFORE_SEND));
    expect(r.status, r.stderr).toBe(124);
    expect(r.stderr).toContain('MCP_RESULT_TIMEOUT: MCP call did not complete within 2s; ');
    expect(r.stderr).toContain('request never sent: the client did not reach its POST within the budget');
  });

  it('leaves a successful call unchanged', async () => {
    const r = await vmcall(stub('answer', ANSWER));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('{"ok":true}');
    expect(r.stderr).not.toContain('MCP_RESULT_TIMEOUT');
  });
});

describe('mcp-call.mjs stamps the send time before its request arrives (WI-10004231)', () => {
  it('writes PAPERCUSP_MCP_CALL_SENT_MARKER no later than the server receives the POST', async () => {
    const home = join(scratch, 'mcp-home');
    mkdirSync(join(home, '.papercusp'), { recursive: true });
    writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
    const marker = join(scratch, 'sent-marker');

    let receivedAt: number | null = null;
    const server = createServer((req, res) => {
      receivedAt ??= Date.now();
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let id: unknown = 1;
        try {
          id = JSON.parse(body).id;
        } catch {
          // keep default id
        }
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // --port pins the call to the test server: a pinned call never falls back to
      // the canonical operator or the MCP proxy.
      await run(
        process.execPath,
        [MCP_CALL, 'dev:dogfood_substrate_status', '{}', '--port', String(port), '--client', 'vmcall-attribution-test'],
        { ...process.env, HOME: home, PAPERCUSP_MCP_CALL_SENT_MARKER: marker },
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(receivedAt, 'the stub server never received the request').not.toBeNull();
    expect(existsSync(marker), 'mcp-call.mjs did not write the send marker').toBe(true);
    const sentAt = Number(readFileSync(marker, 'utf8').trim());
    expect(Number.isFinite(sentAt) && sentAt > 0).toBe(true);
    expect(sentAt).toBeLessThanOrEqual(receivedAt!);
  });
});
