/**
 * WI-710 — proxy-bypass regression guard.
 *
 * Root incident (WI-679): the whole cc-hook class calls the ALWAYS-localhost
 * operator via python `urllib.request.urlopen`, which by default honors the
 * process env's `http_proxy`/`https_proxy`/`ALL_PROXY` (account egress
 * proxies). When those got set in the env, the localhost POST routed through
 * the egress proxy instead of going direct → the proxy can't reach
 * 127.0.0.1 → 502 → every hook's fail-open path swallowed it SILENTLY (file
 * locks, coord-inbox push, activity reporting, the bash resource gate, the
 * statusline all went dead for ~10h with no error surfaced anywhere).
 *
 * The fix is `urllib.request.install_opener(urllib.request.build_opener(
 * urllib.request.ProxyHandler({})))` (or the equivalent local-`_opener`
 * form `pretooluse-locks-acquire.sh` uses) — an EMPTY ProxyHandler mapping
 * means "never consult any proxy env var", so every local operator call
 * routes direct regardless of what's in the environment.
 *
 * This file has TWO layers of guard, matching WI-710's own request:
 *   1. STATIC (exhaustive, cheap, catches every hook by construction —
 *      including a hook added in the future): every `.sh` file under this
 *      dir that calls `urllib.request.urlopen(` against the operator must
 *      also contain a `ProxyHandler({})` bypass. This test is what would
 *      have caught `workitem-verify-nudge.sh` shipping without the fix
 *      (the one real gap this audit found — see the WI-710 comment thread).
 *   2. LIVE (proves the MECHANISM, not just the string's presence): drives
 *      one representative hook (`posttooluse-activity-report.sh`, SYNC mode)
 *      against a REAL local "operator" server with `http_proxy`/`https_proxy`
 *      pointed at a REAL local "evil proxy" server that 502s everything —
 *      reproducing the exact WI-679 failure shape. Asserts the request
 *      reaches the operator directly and NEVER touches the evil proxy. A
 *      negative-control test (an unprotected urllib call, no bypass) proves
 *      the evil-proxy fixture genuinely intercepts — so the positive
 *      result is a real signal, not an artifact of the fixture doing nothing.
 *
 *      IMPORTANT test-harness note: these live tests spawn the child process
 *      ASYNCHRONOUSLY (`child_process.spawn` + a Promise, never `spawnSync`).
 *      `spawnSync` blocks the WHOLE Node event loop until the child exits —
 *      so if this same process is also running the in-process "operator"/
 *      "evil proxy" HTTP servers the child needs to connect back to, a
 *      `spawnSync` call starves those servers' event handlers and every
 *      request the child makes just hangs until ITS OWN timeout fires,
 *      producing a false failure that looks like "the bypass doesn't work"
 *      when the real cause is the test harness deadlocking on itself. Async
 *      `spawn` keeps the event loop free so the servers can actually answer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

const HOOKS_DIR = join(__dirname, '..');

describe('cc-hooks — WI-710 static proxy-bypass guard', () => {
  it('every hook that urlopen()s the local operator installs a ProxyHandler({}) bypass', () => {
    const files = fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.sh'));
    // Sanity: didn't glob an empty/wrong directory (would make the loop below
    // vacuously pass and hide every real gap).
    expect(files.length).toBeGreaterThanOrEqual(8);
    const missing: string[] = [];
    for (const f of files) {
      const content = fs.readFileSync(join(HOOKS_DIR, f), 'utf8');
      if (!content.includes('urllib.request.urlopen(')) continue; // doesn't call the operator via urllib
      if (!content.includes('ProxyHandler({})')) missing.push(f);
    }
    expect(missing).toEqual([]);
  });
});

// ── Live mechanism proof ────────────────────────────────────────────────
function listenEphemeral(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}
function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

interface RunResult { status: number | null; stdout: string; stderr: string }

/** Async child-process runner — see the file header for why this must NOT be `spawnSync`. */
function runAsync(command: string, args: string[], opts: { input?: string; env: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: opts.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

describe('cc-hooks — WI-710 live proxy-bypass mechanism proof', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) {
      try { await cleanups.pop()!(); } catch { /* best-effort */ }
    }
  });

  it('negative control: an UNPROTECTED urllib call DOES get intercepted by http_proxy (proves the fixture is real)', async () => {
    let proxyHits = 0;
    // The evil proxy 502s everything — reproducing the real WI-679 symptom.
    const { server: evilProxy, port: proxyPort } = await listenEphemeral((_req, res) => {
      proxyHits += 1;
      res.writeHead(502);
      res.end('Bad Gateway');
    });
    cleanups.push(() => closeServer(evilProxy));

    const script = `
import urllib.request
req = urllib.request.Request('http://127.0.0.1:1/x', method='POST', data=b'{}')
try:
    urllib.request.urlopen(req, timeout=5)
    print('UNEXPECTED_SUCCESS')
except Exception as e:
    print('FAILED:' + type(e).__name__)
`;
    const r = await runAsync('python3', ['-c', script], {
      env: { ...process.env, http_proxy: `http://127.0.0.1:${proxyPort}`, https_proxy: `http://127.0.0.1:${proxyPort}` },
    });

    // An unprotected urllib call routed the localhost:1 POST through the evil
    // proxy instead — the proxy saw it (proving interception) and the call
    // failed (a 502 raises HTTPError, matching the real bug's failure shape).
    expect(proxyHits).toBeGreaterThan(0);
    expect(r.stdout).toContain('FAILED:');
  }, 15000);

  it('posttooluse-activity-report.sh (SYNC mode) reaches the operator DIRECTLY, never touching an evil http_proxy', async () => {
    let operatorHits = 0;
    let proxyHits = 0;
    const { server: operator, port: operatorPort } = await listenEphemeral((_req, res) => {
      operatorHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }));
    });
    cleanups.push(() => closeServer(operator));
    const { server: evilProxy, port: proxyPort } = await listenEphemeral((_req, res) => {
      proxyHits += 1;
      res.writeHead(502);
      res.end('Bad Gateway');
    });
    cleanups.push(() => closeServer(evilProxy));

    const home = fs.mkdtempSync(join(os.tmpdir(), 'wi710-home-'));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
    fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
    fs.writeFileSync(join(home, '.papercusp', 'su-agent-id'), 'test-agent\n');

    const ACTIVITY_HOOK = join(HOOKS_DIR, 'posttooluse-activity-report.sh');
    const editPayload = {
      tool_name: 'Edit',
      tool_input: { file_path: '/x/y.ts', old_string: 'a', new_string: 'b' },
      tool_use_id: 't', session_id: 's', cwd: '/x',
    };
    const r = await runAsync('bash', [ACTIVITY_HOOK], {
      input: JSON.stringify(editPayload),
      env: {
        ...process.env,
        HOME: home,
        PAPERCUSP_SID: 'sid-wi710',
        PAPERCUSP_ACTIVITY_SYNC: '1', // synchronous, so the POST completes before the process exits
        PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${operatorPort}`,
        // The exact WI-679 condition: an egress proxy set in the env.
        http_proxy: `http://127.0.0.1:${proxyPort}`,
        https_proxy: `http://127.0.0.1:${proxyPort}`,
      },
    });

    expect(r.status).toBe(0); // hook never blocks the tool regardless
    expect(operatorHits).toBe(1); // reached the real local operator...
    expect(proxyHits).toBe(0); // ...and NEVER touched the evil proxy — the bypass works.
  }, 15000);
});
