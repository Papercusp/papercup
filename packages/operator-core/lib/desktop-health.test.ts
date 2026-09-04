/**
 * desktop-health — P-019 decision logic (fleet-coordination-painpoints).
 *
 * The signal-gatherers are injected so the up/down/present decision is tested
 * without a live desktop, bridge, IPC socket, or PG.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// EI-7760 regression: `resolveDesktopIpcDiscovery` must resolve the discovery file
// for the desktop's OWN configured operator (via ~/.papercusp/desktop-build-target.json),
// not the shared last-writer-wins singleton. Mutable home so each test points
// `homedir()` at its own temp dir (same pattern as endpoint-ipc-discovery.test.ts).
const h = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => h.home || actual.tmpdir() };
});
import { tmpdir } from 'node:os';

import {
  probeDesktop,
  apiPortForTarget,
  resolveDesktopIpcDiscovery,
  resolveDesktopApiPort,
  realIpcConnectable,
  realIpcConnectableForPort,
  realApiRoundTrip,
  realBridgeApiPort,
  type DesktopSignals,
  type LiveBridge,
} from './desktop-health';
import { writeEndpointIpcDiscovery, endpointIpcDiscoveryPath } from './endpoint-ipc-discovery';

const BRIDGE: LiveBridge = { port: 43379, token: 'tok', pid: 4242 };

function signals(over: Partial<DesktopSignals> = {}): DesktopSignals {
  return {
    liveBridges: async () => [BRIDGE],
    bridgeEval: async () => true,
    bridgeApiPort: async () => 3270,
    ipcConnectable: async (port) => ({ state: 'ok', port }),
    apiRoundTrip: async (port) => ({ state: 'ok', port }),
    recentErrorCount: async () => 0,
    ...over,
  };
}

describe('probeDesktop', () => {
  it('reports present:false (not up, no alert) when no desktop is running', async () => {
    const r = await probeDesktop(signals({ liveBridges: async () => [] }));
    expect(r.present).toBe(false);
    expect(r.up).toBe(false);
    expect(r.name).toBe('desktop');
    expect(r.note).toMatch(/not running/i);
  });

  it('is up when the bridge eval AND the IPC socket are both alive', async () => {
    const r = await probeDesktop(signals());
    expect(r.present).toBe(true);
    expect(r.up).toBe(true);
    expect(r.note).toBe('up');
    expect(r.recentErrors).toBe(0);
  });

  it('stays up but surfaces recent error toasts in the note + count', async () => {
    const r = await probeDesktop(signals({ recentErrorCount: async () => 3 }));
    expect(r.up).toBe(true);
    expect(r.recentErrors).toBe(3);
    expect(r.note).toMatch(/3 recent error toasts/);
  });

  it('singularizes one error toast', async () => {
    const r = await probeDesktop(signals({ recentErrorCount: async () => 1 }));
    expect(r.note).toMatch(/1 recent error toast(?!s)/);
  });

  it('is DOWN (present) when the webview eval fails — names the failed signal', async () => {
    const r = await probeDesktop(signals({ bridgeEval: async () => false }));
    expect(r.present).toBe(true);
    expect(r.up).toBe(false);
    expect(r.note).toMatch(/webview eval/);
    expect(r.note).not.toMatch(/ipc socket/);
  });

  it('is DOWN when the IPC socket is unreachable (the Plans-hang class) — names it', async () => {
    const r = await probeDesktop(signals({ ipcConnectable: async (port) => ({ state: 'unreachable', port }) }));
    expect(r.up).toBe(false);
    expect(r.note).toMatch(/ipc socket/);
    expect(r.note).not.toMatch(/webview eval/);
  });

  it('names both failed signals + the error toasts when everything is unhealthy', async () => {
    const r = await probeDesktop(
      signals({
        bridgeEval: async () => false,
        ipcConnectable: async (port) => ({ state: 'unreachable', port }),
        recentErrorCount: async () => 2,
      }),
    );
    expect(r.up).toBe(false);
    expect(r.note).toMatch(/webview eval/);
    expect(r.note).toMatch(/ipc socket/);
    expect(r.note).toMatch(/2 recent error toasts/);
  });

  it('treats a throwing signal as a failed signal (never rejects)', async () => {
    const r = await probeDesktop(
      signals({
        bridgeEval: async () => {
          throw new Error('bridge blew up');
        },
      }),
    );
    expect(r.up).toBe(false);
    expect(r.note).toMatch(/webview eval/);
  });

  it('reports present:false when the liveBridges gatherer itself throws', async () => {
    const r = await probeDesktop(
      signals({
        liveBridges: async () => {
          throw new Error('readdir /tmp failed');
        },
      }),
    );
    expect(r.present).toBe(false);
    expect(r.up).toBe(false);
  });

  // EI-15095 + EI-19357343092509867: several desktops can share one HOME.
  // Each bridge must now carry its own selected API port through the complete
  // eval/IPC/API tuple; aggregate only after those tuple-local checks finish.
  it('is up when ONE of several live bridges evals OK, even if another fails', async () => {
    const otherBridge: LiveBridge = { port: 55555, token: 'tok2', pid: 9999 };
    const r = await probeDesktop(
      signals({
        liveBridges: async () => [otherBridge, BRIDGE],
        bridgeEval: async (b) => b.pid === BRIDGE.pid, // only the "real" bridge evals OK
      }),
    );
    expect(r.present).toBe(true);
    expect(r.up).toBe(true);
    expect(r.note).toBe('up');
  });

  it('never combines bridge A eval with bridge B IPC/API to manufacture UP', async () => {
    const bridgeA: LiveBridge = { port: 45551, token: 'a', pid: 1111 };
    const bridgeB: LiveBridge = { port: 45552, token: 'b', pid: 2222 };
    const r = await probeDesktop(
      signals({
        liveBridges: async () => [bridgeA, bridgeB],
        bridgeEval: async (bridge) => bridge.pid === bridgeA.pid,
        bridgeApiPort: async (bridge) => (bridge.pid === bridgeA.pid ? 3170 : 3070),
        ipcConnectable: async (port) => ({
          state: port === 3070 ? 'ok' : 'unreachable',
          port,
        }),
        apiRoundTrip: async (port) => ({
          state: port === 3070 ? 'ok' : 'unreachable',
          port,
        }),
      }),
    );

    expect(r.up).toBe(false);
    expect(r.note).toMatch(/ipc socket :3170/);
    expect(r.note).toMatch(/api :3170/);
  });

  it('keeps the aggregate UP when one complete bridge-local tuple is healthy', async () => {
    const bridgeA: LiveBridge = { port: 45551, token: 'a', pid: 1111 };
    const bridgeB: LiveBridge = { port: 45552, token: 'b', pid: 2222 };
    const r = await probeDesktop(
      signals({
        liveBridges: async () => [bridgeA, bridgeB],
        bridgeEval: async () => true,
        bridgeApiPort: async (bridge) => (bridge.pid === bridgeA.pid ? 3170 : 3070),
        ipcConnectable: async (port) => ({
          state: port === 3070 ? 'ok' : 'unreachable',
          port,
        }),
        apiRoundTrip: async (port) => ({
          state: port === 3070 ? 'ok' : 'unreachable',
          port,
        }),
      }),
    );

    expect(r.up).toBe(true);
    expect(r.note).toBe('up');
  });

  it('abstains instead of alarming when a healthy legacy bridge has no selected-port metadata', async () => {
    const r = await probeDesktop(signals({ bridgeApiPort: async () => null }));

    expect(r.up).toBe(true);
    expect(r.note).toMatch(/bridge target unresolved, not checked/);
  });

  it('is DOWN only when EVERY live bridge fails its webview eval', async () => {
    const otherBridge: LiveBridge = { port: 55555, token: 'tok2', pid: 9999 };
    const r = await probeDesktop(
      signals({
        liveBridges: async () => [otherBridge, BRIDGE],
        bridgeEval: async () => false,
      }),
    );
    expect(r.up).toBe(false);
    expect(r.note).toMatch(/webview eval/);
    expect(r.note).toMatch(/2 bridges checked/);
  });

  // WI-7355 — the api round-trip. The regression it exists to prevent is the
  // FIRST test here: both pre-existing signals pass while the sidecar serves
  // nothing, which is exactly the state EI-19406226890070872 sat in, unalarmed.
  describe('api round-trip (WI-7355)', () => {
    it('is DOWN when the api target is unreachable even though eval + ipc both pass', async () => {
      const r = await probeDesktop(
        signals({
          bridgeEval: async () => true,
          ipcConnectable: async (port) => ({ state: 'ok', port }),
          apiRoundTrip: async () => ({ state: 'unreachable', port: 3270 }),
        }),
      );
      expect(r.present).toBe(true);
      expect(r.up).toBe(false);
      expect(r.note).toMatch(/api :3270/);
      // The other two signals passed — the note must not smear blame onto them.
      expect(r.note).not.toMatch(/webview eval/);
      expect(r.note).not.toMatch(/ipc socket/);
    });

    it('names the port it actually probed, not a hardcoded one', async () => {
      const r = await probeDesktop(
        signals({ apiRoundTrip: async () => ({ state: 'unreachable', port: 3170 }) }),
      );
      expect(r.note).toMatch(/api :3170/);
    });

    it('names api alongside the other failed signals when everything is down', async () => {
      const r = await probeDesktop(
        signals({
          bridgeEval: async () => false,
          ipcConnectable: async (port) => ({ state: 'unreachable', port }),
          apiRoundTrip: async () => ({ state: 'unreachable', port: 3270 }),
        }),
      );
      expect(r.note).toMatch(/webview eval/);
      expect(r.note).toMatch(/ipc socket/);
      expect(r.note).toMatch(/api :3270/);
    });

    // The false-DOWN guard. This file has four prior false-DOWN regressions
    // (EI-2339 / EI-7760 / EI-15095 / EI-18131725582506957); alarming on a port
    // we only GUESSED would be the fifth.
    it('stays UP when the api target could not be resolved — never alarms on a guess', async () => {
      const r = await probeDesktop(
        signals({ apiRoundTrip: async () => ({ state: 'unresolved', port: 3270 }) }),
      );
      expect(r.up).toBe(true);
      expect(r.note).toMatch(/api target unresolved/);
    });

    it('degrades a THROWING api signal to unresolved, not to DOWN', async () => {
      const r = await probeDesktop(
        signals({
          apiRoundTrip: async () => {
            throw new Error('resolve blew up');
          },
        }),
      );
      expect(r.up).toBe(true);
      expect(r.note).toMatch(/api target unresolved/);
    });

    it('still reports error toasts alongside an unresolved api target', async () => {
      const r = await probeDesktop(
        signals({
          apiRoundTrip: async () => ({ state: 'unresolved', port: 3270 }),
          recentErrorCount: async () => 2,
        }),
      );
      expect(r.up).toBe(true);
      expect(r.note).toMatch(/api target unresolved/);
      expect(r.note).toMatch(/2 recent error toasts/);
    });
  });
});

describe('realBridgeApiPort (EI-19357343092509867 bridge-local target)', () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))));
    servers = [];
  });

  async function serveHealth(body: unknown, onRequest?: (req: http.IncomingMessage, raw: string) => void) {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        onRequest?.(req, raw);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      });
    });
    servers.push(server);
    return new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  }

  it('reads selected_api_port from this bridge authenticated health response', async () => {
    let received: { method?: string; path?: string; token?: string } = {};
    const port = await serveHealth({ selected_api_port: 3170 }, (req, raw) => {
      received = {
        method: req.method,
        path: req.url,
        token: (JSON.parse(raw) as { token?: string }).token,
      };
    });

    await expect(realBridgeApiPort({ port, token: 'bridge-secret', pid: process.pid }, 1000)).resolves.toBe(3170);
    expect(received).toEqual({ method: 'POST', path: '/health', token: 'bridge-secret' });
  });

  it('rejects an invalid selected port instead of guessing', async () => {
    const port = await serveHealth({ selected_api_port: 70_000 });
    await expect(realBridgeApiPort({ port, token: 'bridge-secret', pid: process.pid }, 1000)).resolves.toBeNull();
  });
});

describe('apiPortForTarget (EI-190 mapping, mirrors env_switch.rs)', () => {
  it('maps the bare Vite SPA (:3055, no operator of its own) to the :3070 release operator', () => {
    expect(apiPortForTarget(3055)).toBe(3070);
  });

  it('every other known target is its own API port', () => {
    expect(apiPortForTarget(3270)).toBe(3270);
    expect(apiPortForTarget(3070)).toBe(3070);
    expect(apiPortForTarget(3170)).toBe(3170);
  });
});

describe('resolveDesktopIpcDiscovery (EI-7760: don\'t trust the racy last-writer-wins singleton)', () => {
  const savedPort = process.env.PAPERCUSP_HONO_PORT;

  beforeEach(async () => {
    h.home = await mkdtemp(join(tmpdir(), 'desktop-health-'));
  });

  afterEach(async () => {
    const home = h.home;
    h.home = '';
    await rm(home, { recursive: true, force: true });
    if (savedPort === undefined) delete process.env.PAPERCUSP_HONO_PORT;
    else process.env.PAPERCUSP_HONO_PORT = savedPort;
  });

  async function writeBuildTarget(port: number, name = 'dev') {
    await mkdir(join(h.home, '.papercusp'), { recursive: true });
    await writeFile(join(h.home, '.papercusp', 'desktop-build-target.json'), JSON.stringify({ name, port }), 'utf8');
  }

  async function writeDiscoveryForPort(port: number, socketPath: string) {
    process.env.PAPERCUSP_HONO_PORT = String(port);
    await writeEndpointIpcDiscovery(socketPath);
  }

  it('returns null when nothing has ever been discovered (no build-target, no discovery files)', async () => {
    expect(await resolveDesktopIpcDiscovery()).toBeNull();
  });

  it('defaults to the dev target (:3270) when desktop-build-target.json is absent', async () => {
    await writeDiscoveryForPort(3270, '/tmp/sockets/dev-default.sock');
    const disc = await resolveDesktopIpcDiscovery();
    expect(disc?.socketPath).toBe('/tmp/sockets/dev-default.sock');
  });

  it('THE REGRESSION: resolves the per-port file for the desktop\'s ACTUAL target, ignoring a mismatched legacy singleton', async () => {
    // The desktop is configured for staging (:3170) — write ITS per-port discovery file.
    await writeBuildTarget(3170, 'staging');
    await writeDiscoveryForPort(3170, '/tmp/sockets/staging-live.sock');

    // Some OTHER, unrelated operator (e.g. a different harness dev session on :3070)
    // races to write the SHARED legacy singleton last, pointing somewhere else entirely
    // (and, in the real incident, at a dead pid) — this must NOT be what we resolve.
    await mkdir(join(h.home, '.papercusp'), { recursive: true });
    await writeFile(
      endpointIpcDiscoveryPath(),
      JSON.stringify({ socketPath: '/tmp/sockets/unrelated-other-operator.sock', pid: 999999, startedAt: 1, port: 3070 }),
      'utf8',
    );

    const disc = await resolveDesktopIpcDiscovery();
    expect(disc?.socketPath).toBe('/tmp/sockets/staging-live.sock');
    expect(disc?.socketPath).not.toBe('/tmp/sockets/unrelated-other-operator.sock');
  });

  it('maps the :3055 local Vite target to the :3070 release operator\'s discovery file', async () => {
    await writeBuildTarget(3055, 'local');
    await writeDiscoveryForPort(3070, '/tmp/sockets/release-3070.sock');
    const disc = await resolveDesktopIpcDiscovery();
    expect(disc?.socketPath).toBe('/tmp/sockets/release-3070.sock');
  });

  it('falls back to the legacy singleton when no per-port file exists for the resolved target', async () => {
    await writeBuildTarget(3270, 'dev');
    // No endpoint-ipc.3270.json written — only the legacy singleton (as a pre-EI-190
    // operator would leave it).
    await mkdir(join(h.home, '.papercusp'), { recursive: true });
    await writeFile(
      endpointIpcDiscoveryPath(),
      JSON.stringify({ socketPath: '/tmp/sockets/legacy-fallback.sock', pid: process.pid, startedAt: 1 }),
      'utf8',
    );
    const disc = await resolveDesktopIpcDiscovery();
    expect(disc?.socketPath).toBe('/tmp/sockets/legacy-fallback.sock');
  });

  it('returns null when desktop-build-target.json is corrupt (never throws)', async () => {
    await mkdir(join(h.home, '.papercusp'), { recursive: true });
    await writeFile(join(h.home, '.papercusp', 'desktop-build-target.json'), '{ not json', 'utf8');
    expect(await resolveDesktopIpcDiscovery()).toBeNull();
  });
});

// EI-18131725582506957: a routine operator restart (dev:restart{target:'staging'}, or its
// ~2min coalesced auto-fire) tears the IPC socket down and re-execs it, typically well
// under a second. A probe tick landing in that window must not immediately report the
// desktop DOWN — realIpcConnectable retries once after a short delay before giving up.
describe('realIpcConnectable (EI-18131725582506957: restart-window false-DOWN)', () => {
  const savedPort = process.env.PAPERCUSP_HONO_PORT;
  let servers: net.Server[] = [];

  beforeEach(async () => {
    h.home = await mkdtemp(join(tmpdir(), 'desktop-health-ipc-'));
  });

  afterEach(async () => {
    const home = h.home;
    h.home = '';
    await rm(home, { recursive: true, force: true });
    if (savedPort === undefined) delete process.env.PAPERCUSP_HONO_PORT;
    else process.env.PAPERCUSP_HONO_PORT = savedPort;
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined)))));
    servers = [];
  });

  async function pointBuildTargetAt(socketPath: string, port = 3170) {
    await mkdir(join(h.home, '.papercusp'), { recursive: true });
    await writeFile(join(h.home, '.papercusp', 'desktop-build-target.json'), JSON.stringify({ name: 'staging', port }), 'utf8');
    process.env.PAPERCUSP_HONO_PORT = String(port);
    await writeEndpointIpcDiscovery(socketPath);
  }

  function listenOn(socketPath: string): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((sock) => sock.end());
      srv.once('error', reject);
      srv.listen(socketPath, () => resolve(srv));
    });
  }

  it('recovers when the socket comes back up before the retry — no false DOWN across a restart blip', async () => {
    const sockPath = join(h.home, 'restarting.sock');
    await pointBuildTargetAt(sockPath);
    // Nothing listening yet (first attempt must fail) — start the "restarted operator"
    // listening shortly after, well inside the retry delay.
    setTimeout(() => {
      listenOn(sockPath).then((s) => servers.push(s));
    }, 15);
    const up = await realIpcConnectable(200, 50);
    expect(up).toBe(true);
  });

  it('still reports unreachable when nothing ever comes back up (a genuinely dead operator)', async () => {
    const sockPath = join(h.home, 'never-comes-up.sock');
    await pointBuildTargetAt(sockPath);
    const up = await realIpcConnectable(100, 20);
    expect(up).toBe(false);
  });

  it('is up immediately (no retry delay paid) when the socket is already live', async () => {
    const sockPath = join(h.home, 'already-live.sock');
    await pointBuildTargetAt(sockPath);
    servers.push(await listenOn(sockPath));
    const started = Date.now();
    const up = await realIpcConnectable(500, 5000); // huge retryDelayMs — must NOT be paid
    expect(up).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('strict per-port mode connects only through the selected port advertisement', async () => {
    const sockPath = join(h.home, 'per-port-live.sock');
    await pointBuildTargetAt(sockPath, 3170);
    servers.push(await listenOn(sockPath));

    await expect(realIpcConnectableForPort(3170, 500, 20)).resolves.toEqual({
      state: 'ok',
      port: 3170,
    });
  });

  it('strict per-port mode abstains when only the racy singleton exists', async () => {
    const sockPath = join(h.home, 'singleton-only.sock');
    servers.push(await listenOn(sockPath));
    await mkdir(join(h.home, '.papercusp'), { recursive: true });
    await writeFile(
      endpointIpcDiscoveryPath(),
      JSON.stringify({ socketPath: sockPath, pid: process.pid, startedAt: Date.now(), port: 3070 }),
      'utf8',
    );

    await expect(realIpcConnectableForPort(3170, 100, 20)).resolves.toEqual({
      state: 'unresolved',
      port: 3170,
    });
  });
});

describe('resolveDesktopApiPort (WI-7355: told-us vs guessed)', () => {
  beforeEach(async () => {
    h.home = await mkdtemp(join(tmpdir(), 'desktop-health-apiport-'));
  });
  afterEach(async () => {
    const home = h.home;
    h.home = '';
    await rm(home, { recursive: true, force: true });
  });

  async function writeBuildTarget(port: number, name = 'dev') {
    await mkdir(join(h.home, '.papercusp'), { recursive: true });
    await writeFile(join(h.home, '.papercusp', 'desktop-build-target.json'), JSON.stringify({ name, port }), 'utf8');
  }

  it('is resolved:true when the desktop told us its target', async () => {
    await writeBuildTarget(3270);
    expect(await resolveDesktopApiPort()).toEqual({ apiPort: 3270, resolved: true });
  });

  it('maps the :3055 Vite target to the :3070 release operator it proxies /api to', async () => {
    await writeBuildTarget(3055, 'local');
    expect(await resolveDesktopApiPort()).toEqual({ apiPort: 3070, resolved: true });
  });

  // resolved:false is what keeps an absent/corrupt target file out of the
  // up/down decision — the port is a guess, and this file has four prior
  // false-DOWN regressions.
  it('is resolved:false when the target file is absent', async () => {
    expect(await resolveDesktopApiPort()).toEqual({ apiPort: 3270, resolved: false });
  });

  it('is resolved:false when the target file is corrupt (never throws)', async () => {
    await mkdir(join(h.home, '.papercusp'), { recursive: true });
    await writeFile(join(h.home, '.papercusp', 'desktop-build-target.json'), '{ not json', 'utf8');
    expect(await resolveDesktopApiPort()).toEqual({ apiPort: 3270, resolved: false });
  });

  it('is resolved:false when the target file has no usable port', async () => {
    await mkdir(join(h.home, '.papercusp'), { recursive: true });
    await writeFile(join(h.home, '.papercusp', 'desktop-build-target.json'), JSON.stringify({ name: 'dev' }), 'utf8');
    expect(await resolveDesktopApiPort()).toEqual({ apiPort: 3270, resolved: false });
  });
});

// WI-7355. The whole change rests on one claim: a bare connect() cannot tell a
// serving operator from a stalled one, and only an application-level round-trip
// can. The first test below pins exactly that contrast in one place.
describe('realApiRoundTrip (WI-7355: connectable ≠ serving)', () => {
  let servers: Array<net.Server | http.Server> = [];
  /** Sockets held open by the deliberately-stalling server (see below). */
  let heldSockets: net.Socket[] = [];

  beforeEach(async () => {
    h.home = await mkdtemp(join(tmpdir(), 'desktop-health-api-'));
  });

  afterEach(async () => {
    const home = h.home;
    h.home = '';
    await rm(home, { recursive: true, force: true });
    // `close()` does not fire its callback until every accepted connection is
    // gone — and the whole point of the stalling server below is that it holds
    // one forever. Tear connections down FIRST or this hook hangs to the 60s
    // vitest hook timeout (which is how it failed the first time).
    for (const s of heldSockets) {
      try {
        s.destroy();
      } catch {
        /* already gone */
      }
    }
    heldSockets = [];
    for (const s of servers) (s as http.Server).closeAllConnections?.();
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined)))));
    servers = [];
  });

  async function pointBuildTargetAtPort(port: number) {
    await mkdir(join(h.home, '.papercusp'), { recursive: true });
    await writeFile(join(h.home, '.papercusp', 'desktop-build-target.json'), JSON.stringify({ name: 'dev', port }), 'utf8');
  }

  /** Listen on an ephemeral port; resolves the port actually bound. */
  function listenEphemeral(srv: net.Server | http.Server): Promise<number> {
    return new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port));
    });
  }

  function tcpConnects(port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      const done = (v: boolean) => {
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        resolve(v);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      sock.once('connect', () => {
        clearTimeout(timer);
        done(true);
      });
      sock.once('error', () => {
        clearTimeout(timer);
        done(false);
      });
    });
  }

  it('THE POINT: a listener that ACCEPTS but never answers is `unreachable` here — while a bare connect() calls it up', async () => {
    // Accepts the connection and then does nothing with it, ever: the exact
    // observable a wedged operator presents (EI-19406226890070872).
    const srv = net.createServer((sock) => {
      // Accept and stall — never respond. Hold the socket so the stall is real;
      // afterEach destroys it.
      heldSockets.push(sock);
    });
    servers.push(srv);
    const port = await listenEphemeral(srv);
    await pointBuildTargetAtPort(port);

    // The old signal — passes, and is why the wedge went unalarmed.
    expect(await tcpConnects(port)).toBe(true);
    // The new signal — fails, which is the whole point.
    expect(await realApiRoundTrip(150, 20)).toEqual({ state: 'unreachable', port });
  });

  it('is ok when the operator actually answers', async () => {
    const srv = http.createServer((_req, res) => res.end('{"sha":"deadbeef"}'));
    servers.push(srv);
    const port = await listenEphemeral(srv);
    await pointBuildTargetAtPort(port);
    expect(await realApiRoundTrip(1000, 20)).toEqual({ state: 'ok', port });
  });

  it('is ok on a 404 — an older build without the route is not a liveness failure', async () => {
    const srv = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    servers.push(srv);
    const port = await listenEphemeral(srv);
    await pointBuildTargetAtPort(port);
    expect((await realApiRoundTrip(1000, 20)).state).toBe('ok');
  });

  it('is unreachable on a 5xx — the operator answered, but it is broken', async () => {
    const srv = http.createServer((_req, res) => {
      res.statusCode = 503;
      res.end();
    });
    servers.push(srv);
    const port = await listenEphemeral(srv);
    await pointBuildTargetAtPort(port);
    expect((await realApiRoundTrip(1000, 20)).state).toBe('unreachable');
  });

  it('is unreachable when nothing is listening at all', async () => {
    // Bind then immediately release, so the port is known-free.
    const probe = net.createServer();
    const port = await listenEphemeral(probe);
    await new Promise((r) => probe.close(() => r(undefined)));
    await pointBuildTargetAtPort(port);
    expect(await realApiRoundTrip(150, 20)).toEqual({ state: 'unreachable', port });
  });

  // Same restart-window rationale as realIpcConnectable (EI-18131725582506957):
  // the desktop's target may be :3170, which dev:restart re-execs several times
  // a day, and diffHealth transitions on a single bad tick.
  it('recovers across a restart blip when the operator answers before the retry', async () => {
    const probe = net.createServer();
    const port = await listenEphemeral(probe);
    await new Promise((r) => probe.close(() => r(undefined)));
    await pointBuildTargetAtPort(port);

    setTimeout(() => {
      const srv = http.createServer((_req, res) => res.end('ok'));
      servers.push(srv);
      srv.listen(port, '127.0.0.1');
    }, 15);

    expect((await realApiRoundTrip(300, 120)).state).toBe('ok');
  });

  it('abstains (unresolved) rather than alarming when the desktop never told us its target', async () => {
    // No desktop-build-target.json written — the port would be a guess.
    expect(await realApiRoundTrip(150, 20)).toEqual({ state: 'unresolved', port: 3270 });
  });
});
