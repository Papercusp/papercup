/**
 * desktop-sandbox-live.test.ts — P-010 / D-015, executed rather than modelled.
 *
 * The unit suite asserts the SHAPE of the argv. That is necessary and not sufficient: every
 * claim in D-015 is about what the kernel does with those mounts, and a mount plan can be
 * perfectly well-formed and still hand the app an empty /tmp. So this file runs the argv the
 * real builder emits against a real Xvfb and asks the app.
 *
 * EVERY assertion here is paired with a CONTROL that must fail, because the dangerous
 * outcome is a green that means nothing: with `--unshare-net` OFF, an app reaches the
 * display via the abstract socket whether or not we bound the filesystem one, so a test that
 * forgets net isolation "passes" while proving the opposite of what it claims.
 *
 * GUARDED: PAPERCUSP_COMPUTER_LIVE=1 plus the X tooling, so a normal run SKIPS it.
 *   PAPERCUSP_COMPUTER_LIVE=1 npx vitest run lib/agent-tools/computer/desktop-sandbox-live.test.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { X11_SOCKET_DIR, a11yBusSocketPath, buildDesktopSandboxCommand } from './desktop-sandbox';

function hasBin(bin: string): boolean {
  try {
    return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}
const liveEnabled =
  process.env.PAPERCUSP_COMPUTER_LIVE === '1' &&
  ['Xvfb', 'xdotool', 'xdpyinfo', 'bwrap', 'dbus-daemon', 'python3'].every(hasBin);

const DISPLAY_NUM = 187;
const DISPLAY = `:${DISPLAY_NUM}`;

/** Run argv, returning exit status + merged output. Never throws. */
function run(bin: string, argv: string[], timeout = 30_000): { status: number | null; out: string } {
  const r = spawnSync(bin, argv, { encoding: 'utf8', timeout, env: { ...process.env, DISPLAY } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/**
 * The builder's real argv, with `cmd` as the payload — so these tests can never drift from
 * what the provisioner actually launches. `strip` removes one mount for a control.
 */
function sandboxArgv(
  cmd: string[],
  over: { a11yBusPath?: string | null; denyNetwork?: boolean } = {},
): string[] {
  const d = buildDesktopSandboxCommand(
    { cmd, display: DISPLAY, a11yBusPath: over.a11yBusPath ?? null },
    { enabled: true, bwrapWorks: true, denyNetwork: over.denyNetwork ?? true },
  );
  expect(d.sandboxed).toBe(true);
  return d.argv;
}

/** Drop a `--flag A B` triple from an argv — used to build the negative controls. */
function withoutMount(argv: string[], flag: string, dest: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 2] === dest) {
      i += 2;
      continue;
    }
    out.push(argv[i]!);
  }
  return out;
}

describe.skipIf(!liveEnabled)('P-010 desktop sandbox — LIVE (real Xvfb, real bwrap)', () => {
  let xvfb: ReturnType<typeof spawnSync> | null = null;
  let xvfbPid = 0;
  let busDir = '';
  let busAddress: string | null = null;

  beforeAll(() => {
    rmSync(`/tmp/.X${DISPLAY_NUM}-lock`, { force: true });
    const child = spawnSync('sh', [
      '-c',
      `Xvfb ${DISPLAY} -screen 0 800x600x24 -nolisten tcp >/dev/null 2>&1 & echo $!`,
    ], { encoding: 'utf8' });
    xvfbPid = Number.parseInt((child.stdout ?? '').trim(), 10);
    for (let i = 0; i < 60; i++) {
      if (spawnSync('xdpyinfo', ['-display', DISPLAY], { stdio: 'ignore' }).status === 0) break;
      spawnSync('sleep', ['0.25']);
    }
    expect(spawnSync('xdpyinfo', ['-display', DISPLAY], { stdio: 'ignore' }).status).toBe(0);

    // A real filesystem-backed bus, the same `unix:tmpdir=/tmp` shape P-007 provisions.
    busDir = mkdtempSync(join(tmpdir(), 'p010-bus-'));
    const conf = join(busDir, 'bus.conf');
    writeFileSync(
      conf,
      `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>
</busconfig>`,
    );
    const printed = spawnSync('dbus-daemon', [`--config-file=${conf}`, '--print-address', '--fork'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    busAddress = (printed.stdout ?? '').trim() || null;
  }, 120_000);

  afterAll(() => {
    // Kill by the pid we captured, never by name — a pattern kill on this shared box has
    // twice taken out a peer's Xvfb.
    if (xvfbPid > 0) spawnSync('kill', [String(xvfbPid)]);
    const busPath = a11yBusSocketPath(busAddress);
    if (busPath) spawnSync('sh', ['-c', `fuser -k ${busPath} 2>/dev/null || true`]);
    if (busDir) rmSync(busDir, { recursive: true, force: true });
    rmSync(`/tmp/.X${DISPLAY_NUM}-lock`, { force: true });
  });

  it('THE D-015 CASE: a net-isolated sandboxed app still reaches the display', () => {
    const argv = sandboxArgv(['xdpyinfo'], { denyNetwork: true });
    const got = run('bwrap', argv);
    expect(got.status).toBe(0);
    expect(got.out).toContain('dimensions');

    // CONTROL — the identical run with ONLY the X socket bind removed. `--unshare-net` has
    // already destroyed the abstract socket, so this is the configuration D-015 measured at
    // "Can't open display". If this ever passes, the test above proves nothing.
    const blinded = withoutMount(argv, '--ro-bind', X11_SOCKET_DIR);
    const control = run('bwrap', blinded);
    expect(control.status).not.toBe(0);
    expect(control.out.toLowerCase()).toContain('unable to open display');
  }, 120_000);

  it('a real GUI app maps a window through the sandbox, net-isolated', () => {
    const argv = sandboxArgv(['xterm', '-T', 'p010-probe', '-e', 'sleep 20'], { denyNetwork: true });
    const child = spawnSync('sh', [
      '-c',
      `bwrap ${argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')} >/dev/null 2>&1 & echo $!`,
    ], { encoding: 'utf8', env: { ...process.env, DISPLAY } });
    const pid = Number.parseInt((child.stdout ?? '').trim(), 10);
    try {
      let found = '';
      for (let i = 0; i < 40; i++) {
        const s = run('xdotool', ['search', '--name', 'p010-probe']);
        if (s.status === 0 && s.out) { found = s.out; break; }
        spawnSync('sleep', ['0.25']);
      }
      // A mapped window is the end-to-end proof: the app started, connected, and drew.
      expect(found).not.toBe('');
    } finally {
      if (pid > 0) spawnSync('kill', [String(pid)]);
    }
  }, 120_000);

  it('carries the a11y bus socket into the sandbox — and cannot without the bind', () => {
    const busPath = a11yBusSocketPath(busAddress);
    expect(busPath).toBeTruthy(); // the fixture itself must be a FILESYSTEM bus (D-015)

    // A real connect(), NOT `test -S`. Statting the socket only proves a directory entry is
    // visible; what an a11y client actually needs is to CONNECT, and the two can differ (a
    // mount can expose the inode while the connect is refused). Asserting the weaker thing
    // was a gap in this test's first version.
    const CONNECT = `import socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
try:
    s.connect(sys.argv[1]); print("CONNECT_OK")
except Exception as e: print("CONNECT_FAIL",e)`;
    const argv = sandboxArgv(['python3', '-c', CONNECT, busPath!], {
      a11yBusPath: busPath,
      denyNetwork: true,
    });
    expect(run('bwrap', argv).out).toContain('CONNECT_OK');

    // CONTROL: same run, bus bind dropped → the private /tmp hides it. This is the silent
    // failure D-015 warns about: nothing crashes, observation just degrades to pixels.
    const blinded = withoutMount(argv, '--bind', busPath!);
    expect(run('bwrap', blinded).out).not.toContain('CONNECT_OK');
  }, 120_000);

  it('the AT-SPI bus under /run stays connectable through the read-only root bind', () => {
    // The bus P-007 publishes as AT_SPI_BUS is NOT the /tmp session bus — measured, it is
    // `unix:path=/run/user/1000/at-spi/bus_<display>`. It is carried by `--ro-bind / /`
    // rather than an explicit bind, and a read-only MOUNT does not block connect() to a
    // socket inode. Pinned here because "read-only mount ⇒ no socket connect" is a very
    // natural wrong assumption, and acting on it would add a pointless rw bind over /run.
    const probeDir = '/run/user/1000';
    const sock = `${probeDir}/p010-live-probe.sock`;
    const listener = spawnSync('sh', [
      '-c',
      `python3 -c 'import socket,os,sys,time,threading
p=sys.argv[1]
try: os.unlink(p)
except FileNotFoundError: pass
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.bind(p); s.listen(1)
threading.Thread(target=lambda:[s.accept() for _ in iter(int,1)],daemon=True).start()
time.sleep(15)' ${sock} & echo $!`,
    ], { encoding: 'utf8' });
    const pid = Number.parseInt((listener.stdout ?? '').trim(), 10);
    try {
      spawnSync('sleep', ['1']);
      const argv = sandboxArgv(
        ['python3', '-c', 'import socket,sys\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)\ns.connect(sys.argv[1])\nprint("CONNECT_OK")', sock],
        { denyNetwork: true },
      );
      expect(run('bwrap', argv).out).toContain('CONNECT_OK');
    } finally {
      if (pid > 0) spawnSync('kill', [String(pid)]);
      rmSync(sock, { force: true });
    }
  }, 120_000);

  it('the confinement is REAL: host root is read-only and credentials are masked', () => {
    // Writing outside the private surfaces must fail…
    const write = run('bwrap', sandboxArgv(['sh', '-c', 'touch /usr/local/p010-should-fail']));
    expect(write.status).not.toBe(0);

    // …while the private /tmp and HOME are writable, or the desktop would be useless.
    expect(run('bwrap', sandboxArgv(['sh', '-c', 'touch /tmp/p010-ok && echo WROTE'])).out).toContain('WROTE');

    // …and /tmp really is PRIVATE: a file the host has must not be visible inside.
    writeFileSync('/tmp/p010-host-marker', 'host');
    try {
      expect(run('bwrap', sandboxArgv(['test', '-f', '/tmp/p010-host-marker'])).status).not.toBe(0);
    } finally {
      rmSync('/tmp/p010-host-marker', { force: true });
    }
  }, 120_000);
});
