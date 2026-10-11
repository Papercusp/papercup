/**
 * scripts/lib/run-in-isolated-netns.sh — runs a command (the operator e2e Playwright run)
 * in its own network namespace so host interface churn cannot abort Chromium loads with
 * net::ERR_NETWORK_CHANGED (WI-6554700010008480).
 *
 * Mode and fallback cases run everywhere. The isolation cases need bwrap + pasta + an
 * AppArmor userns grant for bwrap; they are skipped (not passed) where the namespace
 * cannot be built, and the skip reason says so.
 */
import { mkdtempSync, rmSync, symlinkSync, existsSync, readlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');
const WRAPPER = join(REPO_ROOT, 'scripts/lib/run-in-isolated-netns.sh');

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map(s => new Promise<void>(done => s.close(() => done()))));
});

function wrap(cmd: string[], env: Record<string, string | undefined> = {}) {
  const res = spawnSync(WRAPPER, ['--', ...cmd], {
    env: { ...process.env, PAPERCUSP_E2E_NETNS: undefined, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A PATH holding only the named host tools — everything else (bwrap, pasta) is absent. */
function restrictedPath(tools: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'netns-path-'));
  dirs.push(dir);
  for (const tool of tools) {
    const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (!found) throw new Error(`test needs host tool ${tool}`);
    symlinkSync(found, join(dir, tool));
  }
  return dir;
}

const HOST_NETNS = readlinkSync('/proc/self/ns/net');

const probe = spawnSync(WRAPPER, ['--', 'true'], {
  env: { ...process.env, PAPERCUSP_E2E_NETNS: 'required' },
  encoding: 'utf8',
  timeout: 60_000,
});
const ISOLATION_AVAILABLE = probe.status === 0;
const isolationSkipReason = ISOLATION_AVAILABLE
  ? ''
  : `namespace unavailable on this host (exit ${probe.status}): ${probe.stderr.trim().split('\n').pop()}`;

describe('run-in-isolated-netns.sh — modes and fallback', () => {
  it('refuses a call without -- and a command', () => {
    expect(spawnSync(WRAPPER, ['true'], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync(WRAPPER, ['--'], { encoding: 'utf8' }).status).toBe(2);
  });

  it('refuses an unknown mode', () => {
    const r = wrap(['true'], { PAPERCUSP_E2E_NETNS: 'sometimes' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('must be auto, required or off');
  });

  it('off runs the command directly, in the host namespace', () => {
    const r = wrap(['bash', '-c', 'readlink /proc/self/ns/net; exit 5'], { PAPERCUSP_E2E_NETNS: 'off' });
    expect(r.status).toBe(5);
    expect(r.stdout.trim()).toBe(HOST_NETNS);
    expect(r.stderr).toContain('RUN_IN_ISOLATED_NETNS isolated=0 mode=off reason=disabled');
  });

  it('auto runs the command unisolated, and says why, when bwrap is missing', () => {
    const path = restrictedPath(['bash', 'readlink']);
    const r = wrap(['bash', '-c', 'readlink /proc/self/ns/net; exit 6'], { PATH: path });
    expect(r.status).toBe(6);
    expect(r.stdout.trim()).toBe(HOST_NETNS);
    expect(r.stderr).toContain('RUN_IN_ISOLATED_NETNS isolated=0 mode=auto reason=bwrap-missing');
  });

  it('required refuses with 97 and never starts the command when isolation is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'netns-marker-'));
    dirs.push(dir);
    const marker = join(dir, 'ran');
    const path = restrictedPath(['bash', 'touch']);
    const r = wrap(['touch', marker], { PATH: path, PAPERCUSP_E2E_NETNS: 'required' });
    expect(r.status).toBe(97);
    expect(r.stderr).toContain('reason=bwrap-missing');
    expect(existsSync(marker)).toBe(false);
  });
});

describe.skipIf(!ISOLATION_AVAILABLE)(`run-in-isolated-netns.sh — isolation ${isolationSkipReason}`, () => {
  it('runs the command in a different network namespace holding only loopback and one tap interface', () => {
    const host = spawnSync('ip', ['-o', 'link', 'show'], { encoding: 'utf8' }).stdout.trim().split('\n');
    // Calibration: the comparison means something only if the host has more than that.
    expect(host.length).toBeGreaterThan(2);
    const r = wrap(['bash', '-c', 'readlink /proc/self/ns/net; ip -o link show']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('RUN_IN_ISOLATED_NETNS isolated=1 mode=auto reason=namespace');
    const [netns, ...links] = r.stdout.trim().split('\n');
    expect(netns).not.toBe(HOST_NETNS);
    expect(links).toHaveLength(2);
    expect(links.some(l => /^\d+: lo:/.test(l))).toBe(true);
  }, 60_000);

  it('starts the command only after the namespace addresses settle (no tentative address left)', () => {
    const r = wrap(['ip', '-o', 'addr', 'show']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(' inet ');
    expect(r.stdout).not.toContain('tentative');
  }, 60_000);

  it('reaches a service bound on the host loopback via 127.0.0.1', async () => {
    const server = createServer((_req, res) => res.end('host-loopback-ok'));
    servers.push(server);
    const port = await new Promise<number>(done =>
      server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)),
    );
    // Async spawn: the server lives in this process, so the event loop must keep serving.
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>(done => {
      const child = spawn(WRAPPER, ['--', process.execPath, '-e',
        `fetch("http://127.0.0.1:${port}/").then(r => r.text()).then(t => process.stdout.write(t), e => { console.error(e); process.exit(9); })`,
      ], { env: { ...process.env, PAPERCUSP_E2E_NETNS: 'required' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', c => { stdout += c; });
      child.stderr.on('data', c => { stderr += c; });
      child.on('close', code => done({ code, stdout, stderr }));
    });
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toBe('host-loopback-ok');
  }, 60_000);

  it("passes the caller's stdin and inherited fd 3 through, and leaks none of its own fds", () => {
    // Playwright drives Chromium over inherited fds 3/4 (--remote-debugging-pipe); a
    // non-interactive shell would otherwise hand the background sandbox /dev/null as stdin.
    const res = spawnSync('bash', ['-c',
      `exec 3< <(echo from-fd3); echo from-stdin | "${WRAPPER}" -- bash -c 'cat; cat <&3; ls /proc/self/fd | sort -n | tr "\\n" " "'`,
    ], { env: { ...process.env, PAPERCUSP_E2E_NETNS: 'required' }, encoding: 'utf8', timeout: 60_000 });
    expect(res.status, res.stderr).toBe(0);
    const [stdin, fd3, fds] = res.stdout.split('\n');
    expect(stdin).toBe('from-stdin');
    expect(fd3).toBe('from-fd3');
    // 0-2, the inherited 3, and the descriptor `ls` opens on /proc/self/fd itself.
    expect(fds.trim().split(' ').map(Number).filter(fd => fd > 3)).toHaveLength(1);
  }, 60_000);

  it('forwards SIGTERM to the command and returns its exit code', async () => {
    const out = await new Promise<{ code: number | null; stdout: string }>(done => {
      const child = spawn(WRAPPER, ['--', 'bash', '-c',
        'trap "echo GOT_TERM; exit 42" TERM; echo READY; while :; do sleep 0.1; done',
      ], { env: { ...process.env, PAPERCUSP_E2E_NETNS: 'required' } });
      let stdout = '';
      child.stdout.on('data', c => {
        stdout += c;
        if (stdout.includes('READY') && !stdout.includes('GOT_TERM')) child.kill('SIGTERM');
      });
      child.on('close', code => done({ code, stdout }));
    });
    expect(out.stdout).toContain('GOT_TERM');
    expect(out.code).toBe(42);
  }, 60_000);

  // Opt-in: churning a host interface would itself disturb peers' unisolated browsers.
  const churnOptIn = process.env.PAPERCUSP_NETNS_CHURN_PROBE === '1'
    && spawnSync('sudo', ['-n', 'true']).status === 0;
  it.skipIf(!churnOptIn)('hears none of the host interface churn (PAPERCUSP_NETNS_CHURN_PROBE=1, sudo -n)', async () => {
    const iface = `pcns${process.pid % 100000}`;
    const child = spawn(WRAPPER, ['--', 'timeout', '8', 'ip', 'monitor', 'address', 'link'], {
      env: { ...process.env, PAPERCUSP_E2E_NETNS: 'required' },
    });
    let nsEvents = '';
    let started = false;
    child.stdout.on('data', c => { nsEvents += c; });
    child.stderr.on('data', c => { if (String(c).includes('isolated=1')) started = true; });
    const closed = new Promise<void>(done => child.on('close', () => done()));
    while (!started) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 500));
    try {
      for (let i = 0; i < 3; i++) {
        spawnSync('sudo', ['-n', 'ip', 'link', 'add', iface, 'type', 'dummy']);
        spawnSync('sudo', ['-n', 'ip', 'addr', 'add', '198.18.250.1/32', 'dev', iface]);
        spawnSync('sudo', ['-n', 'ip', 'link', 'del', iface]);
      }
    } finally {
      spawnSync('sudo', ['-n', 'ip', 'link', 'del', iface]);
    }
    await closed;
    expect(nsEvents).not.toContain(iface);
  }, 60_000);
});
