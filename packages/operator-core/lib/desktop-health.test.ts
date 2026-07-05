/**
 * desktop-health — P-019 decision logic (fleet-coordination-painpoints).
 *
 * The signal-gatherers are injected so the up/down/present decision is tested
 * without a live desktop, bridge, IPC socket, or PG.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

import { probeDesktop, apiPortForTarget, resolveDesktopIpcDiscovery, type DesktopSignals, type LiveBridge } from './desktop-health';
import { writeEndpointIpcDiscovery, endpointIpcDiscoveryPath } from './endpoint-ipc-discovery';

const BRIDGE: LiveBridge = { port: 43379, token: 'tok', pid: 4242 };

function signals(over: Partial<DesktopSignals> = {}): DesktopSignals {
  return {
    liveBridge: async () => BRIDGE,
    bridgeEval: async () => true,
    ipcConnectable: async () => true,
    recentErrorCount: async () => 0,
    ...over,
  };
}

describe('probeDesktop', () => {
  it('reports present:false (not up, no alert) when no desktop is running', async () => {
    const r = await probeDesktop(signals({ liveBridge: async () => null }));
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
    const r = await probeDesktop(signals({ ipcConnectable: async () => false }));
    expect(r.up).toBe(false);
    expect(r.note).toMatch(/ipc socket/);
    expect(r.note).not.toMatch(/webview eval/);
  });

  it('names both failed signals + the error toasts when everything is unhealthy', async () => {
    const r = await probeDesktop(
      signals({
        bridgeEval: async () => false,
        ipcConnectable: async () => false,
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

  it('reports present:false when the liveBridge gatherer itself throws', async () => {
    const r = await probeDesktop(
      signals({
        liveBridge: async () => {
          throw new Error('readdir /tmp failed');
        },
      }),
    );
    expect(r.present).toBe(false);
    expect(r.up).toBe(false);
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
