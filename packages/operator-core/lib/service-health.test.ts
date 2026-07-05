/**
 * diffHealth — pure transition detector (fleet-coordination-painpoints P-017).
 */
import { describe, it, expect } from 'vitest';
import {
  diffHealth,
  HEALTH_ENDPOINTS,
  probeEndpoint,
  tcpPreflight,
  CONNECT_PREFLIGHT_MS,
  evaluateBgHostTicker,
  evaluateBgHostCodeDrift,
  BG_HOST_STALE_MS,
  type ProbeResult,
} from './service-health';

const r = (name: string, up: boolean): ProbeResult => ({
  name,
  up,
  status: up ? 200 : null,
  latencyMs: 1,
});

describe('diffHealth', () => {
  it('alerts a first-seen DOWN but stays silent on a first-seen UP (no startup spam)', () => {
    const { transitions, next } = diffHealth({}, [r('a', false), r('b', true)]);
    expect(transitions).toEqual([{ name: 'a', to: 'down' }]);
    expect(next).toEqual({ a: false, b: true });
  });

  it('reports only the endpoints that changed (up→down and down→up)', () => {
    const { transitions } = diffHealth({ a: true, b: false, c: true }, [
      r('a', false),
      r('b', true),
      r('c', true),
    ]);
    expect(transitions).toEqual([
      { name: 'a', to: 'down' },
      { name: 'b', to: 'up' },
    ]);
  });

  it('no change → no transitions', () => {
    expect(diffHealth({ a: true }, [r('a', true)]).transitions).toEqual([]);
  });

  // A `present: false` result is a legitimately-absent service (the desktop is
  // not running) — it must never produce a phantom DOWN/recovered (P-019).
  const absent = (name: string): ProbeResult => ({
    name,
    up: false,
    present: false,
    status: null,
    latencyMs: 1,
  });

  it('skips an absent (present:false) service — no transition, drops its state', () => {
    const { transitions, next } = diffHealth({}, [absent('desktop'), r('a', true)]);
    expect(transitions).toEqual([]); // desktop absent → no DOWN; a first-seen-up → silent
    expect(next).toEqual({ a: true }); // desktop not carried forward
  });

  it('a previously-up service going absent does NOT alert and is forgotten', () => {
    const { transitions, next } = diffHealth({ desktop: true }, [absent('desktop')]);
    expect(transitions).toEqual([]);
    expect(next.desktop).toBeUndefined();
  });

  it('a present desktop that is down DOES alert (running but unhealthy)', () => {
    const present: ProbeResult = { name: 'desktop', up: false, present: true, status: null, latencyMs: 1 };
    const { transitions } = diffHealth({ desktop: true }, [present]);
    expect(transitions).toEqual([{ name: 'desktop', to: 'down' }]);
  });
});

describe('HEALTH_ENDPOINTS', () => {
  // EI-188: the retired standalone web app (:3001 — the "old Restart web app",
  // never running in this deployment) must NOT be monitored, or the watchdog
  // re-captures a phantom "web is DOWN" improvement every cycle.
  it('does not monitor the retired web app (:3001)', () => {
    expect(HEALTH_ENDPOINTS.some((e) => e.name === 'web')).toBe(false);
    expect(HEALTH_ENDPOINTS.some((e) => e.url.includes(':3001'))).toBe(false);
  });

  // EI-276: the Restart shop storefront (:4321) is not part of the running stack;
  // probing it re-broadcast a phantom "shop is DOWN" on every restart/deploy and
  // fed the EI-187 CRITICAL. Must NOT be monitored.
  it('does not monitor the retired shop storefront (:4321)', () => {
    expect(HEALTH_ENDPOINTS.some((e) => e.name === 'shop')).toBe(false);
    expect(HEALTH_ENDPOINTS.some((e) => e.url.includes(':4321'))).toBe(false);
  });

  // The live set we DO watch — a guard so a retired surface can't quietly creep
  // back in (any new entry here is a deliberate edit + a failing test to update).
  it('watches exactly the live dev services', () => {
    expect(HEALTH_ENDPOINTS.map((e) => e.name).sort()).toEqual(
      ['code-server', 'operator', 'scout', 'vite'].sort(),
    );
  });

  // EI-6902: vite's dev-server can legitimately take several seconds to answer under
  // this box's typical concurrent build/vitest load — the shared 3000ms default fired
  // a persistent false "vite DOWN" alarm from probe impatience, not an actual outage.
  it('gives vite a more generous probe timeout than the 3000ms default', () => {
    const vite = HEALTH_ENDPOINTS.find((e) => e.name === 'vite');
    expect(vite?.timeoutMs).toBeGreaterThan(3000);
  });
});

describe('probeEndpoint — per-spec timeout override (EI-6902)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("honors a spec's own timeoutMs over the 3000ms default", async () => {
    // A fetch that never settles — probeEndpoint must wait for the SPEC's timeout
    // (not the 3000ms default) before aborting.
    const fetchSpy = vi.fn(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const start = Date.now();
    const result = await probeEndpoint({ name: 'vite', url: 'http://127.0.0.1:3055/', timeoutMs: 20 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(15); // aborted at ~20ms, not ~3000ms
    expect(result).toEqual(expect.objectContaining({ name: 'vite', up: false, status: null }));
  });
});

describe('evaluateBgHostCodeDrift (WI-1867 — stale routines-primary detection)', () => {
  const NOW = 1_700_000_000_000;

  it('hot-path change YOUNGER than the bg-host boot → drift flagged: up stays true (no alarm), note names the restart + the stale symptom', () => {
    const res = evaluateBgHostCodeDrift(NOW - 60 * 60_000, NOW - 10 * 60_000, 'packages/operator-core/lib/harness/routines/loop-fire.ts');
    expect(res.name).toBe('bg-host-code');
    expect(res.up).toBe(true); // drift is a WARNING, never a down-transition (EI-2186: restarts reclaim in-flight spawns)
    expect(res.present).not.toBe(false);
    expect(res.note).toMatch(/CODE DRIFT/);
    expect(res.note).toMatch(/loop-fire\.ts/); // the newest changed file, so the reader sees WHAT drifted
    expect(res.note).toMatch(/~50m AFTER/); // boot 60m ago, change 10m ago
    expect(res.note).toMatch(/systemctl --user restart papercup-bg-host\.service/);
    expect(res.note).toMatch(/doesn't take effect/); // the exact symptom an agent greps for
  });

  it('hot-path change OLDER than the boot → current, no drift language', () => {
    const res = evaluateBgHostCodeDrift(NOW - 10 * 60_000, NOW - 60 * 60_000, 'x.ts');
    expect(res.up).toBe(true);
    expect(res.note).toMatch(/code current/);
    expect(res.note).not.toMatch(/DRIFT/);
  });

  it('unknown boot time or change time → present:false (fail-soft, never a fabricated drift)', () => {
    expect(evaluateBgHostCodeDrift(null, NOW).present).toBe(false);
    expect(evaluateBgHostCodeDrift(NOW, null).present).toBe(false);
    expect(evaluateBgHostCodeDrift(null, null).note).toMatch(/unknown/);
  });

  it('a missing newest-file name still reports drift (the name is cosmetic)', () => {
    const res = evaluateBgHostCodeDrift(NOW - 60_000, NOW, null);
    expect(res.note).toMatch(/CODE DRIFT/);
  });

  it('drift is floored at ~1m so a seconds-level drift never rounds to "~0m"', () => {
    const res = evaluateBgHostCodeDrift(NOW - 10_000, NOW - 5_000, 'abc');
    expect(res.note).toMatch(/~1m AFTER/);
  });
});

describe('evaluateBgHostTicker (EI-1832 — bg-host DBOS ticker liveness)', () => {
  const NOW = 1_700_000_000_000;

  it('a recent tick → up, with the last-tick age + "ticker alive" in the note', () => {
    const res = evaluateBgHostTicker(NOW - 30_000, NOW);
    expect(res.name).toBe('bg-host-ticker');
    expect(res.up).toBe(true);
    expect(res.note).toMatch(/last routine tick 30s ago/);
    expect(res.note).toMatch(/ticker alive/);
  });

  it('a fire older than the stale window → DOWN, naming the bg-host (NOT :3070, do not restart operator)', () => {
    const res = evaluateBgHostTicker(NOW - 45 * 60_000, NOW); // 45m — the 2026-06-20 incident
    expect(res.up).toBe(false);
    expect(res.note).toMatch(/no routine has fired in 45m/);
    expect(res.note).toMatch(/FROZEN/);
    expect(res.note).toMatch(/NOT the :3070 operator/);
    expect(res.note).toMatch(/do NOT dev:restart/);
  });

  it('exactly at the threshold is still up; one ms past it is down (boundary)', () => {
    expect(evaluateBgHostTicker(NOW - BG_HOST_STALE_MS, NOW).up).toBe(true);
    expect(evaluateBgHostTicker(NOW - BG_HOST_STALE_MS - 1, NOW).up).toBe(false);
  });

  it('no fired routine (null) → present:false, liveness UNKNOWN (never alarms a fresh/idle install)', () => {
    const res = evaluateBgHostTicker(null, NOW);
    expect(res.present).toBe(false);
    expect(res.note).toMatch(/unknown/);
  });

  it('a future timestamp (clock skew) clamps to age 0 — up, never a negative age', () => {
    const res = evaluateBgHostTicker(NOW + 5_000, NOW);
    expect(res.up).toBe(true);
    expect(res.note).toMatch(/tick 0s ago/);
  });

  it('an UNKNOWN (present:false) ticker result is SKIPPED by diffHealth — no phantom transition', () => {
    const unknown = evaluateBgHostTicker(null, NOW);
    const { transitions, next } = diffHealth({ 'bg-host-ticker': true }, [unknown]);
    expect(transitions).toEqual([]); // present:false → skipped (no phantom alarm)
    expect(next['bg-host-ticker']).toBeUndefined(); // forgotten, not alerted
  });

  it('a real ticker DOWN DOES alert via diffHealth, like any service', () => {
    const down = evaluateBgHostTicker(NOW - 60 * 60_000, NOW); // 1h frozen
    const { transitions } = diffHealth({ 'bg-host-ticker': true }, [down]);
    expect(transitions).toEqual([{ name: 'bg-host-ticker', to: 'down' }]);
  });
});

// ---------------------------------------------------------------------------
// probeSubstrateSidecar — WI-895 discrimination (2026-07-03): "no sidecar
// spawned by this process" must read present:false (like flag-off / unknown
// ticker), NEVER a phantom DOWN; a socket that exists but fails healthz IS a
// real DOWN, with path provenance in the note.
// ---------------------------------------------------------------------------
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { probeSubstrateSidecar } from './service-health';
import { closeSubstrateIpcClient } from './sync/hyperbee/substrate-ipc-client';
import { SUBSTRATE_SOCKET_ENV } from './sync/hyperbee/substrate-socket-path';

vi.mock('@papercusp/flags/server', () => ({
  getFlag: vi.fn(async () => true), // SUBSTRATE_SIDECAR ON for every probe test
  onFlagChange: vi.fn(() => () => {}), // listener registration in the module graph — no-op
}));

describe('probeSubstrateSidecar (WI-895 — not-spawned vs truly-dead discrimination)', () => {
  const sockPath = path.join(os.tmpdir(), `pc-probe-${process.pid}-${Math.floor(Math.random() * 1e6)}.sock`);
  let envBefore: string | undefined;

  beforeEach(() => {
    envBefore = process.env[SUBSTRATE_SOCKET_ENV];
    process.env[SUBSTRATE_SOCKET_ENV] = sockPath;
    closeSubstrateIpcClient(); // fresh singleton per test — it caches the socket path
  });
  afterEach(() => {
    if (envBefore === undefined) delete process.env[SUBSTRATE_SOCKET_ENV];
    else process.env[SUBSTRATE_SOCKET_ENV] = envBefore;
    closeSubstrateIpcClient();
    fs.rmSync(sockPath, { force: true });
  });

  it('flag ON + NO socket at the resolved path → present:false "not spawned", NOT a DOWN', async () => {
    const res = await probeSubstrateSidecar(1500);
    expect(res.up).toBe(true); // fail-soft: unknown/not-applicable is never DOWN
    expect(res.present).toBe(false);
    expect(res.note).toMatch(/no sidecar spawned by this process/);
    expect(res.note).toContain(sockPath); // path provenance — the 49989 specimen's missing clue
    // And diffHealth must skip it (no phantom transition), like the unknown ticker.
    const { transitions } = diffHealth({ 'substrate-sidecar': true }, [res]);
    expect(transitions).toEqual([]);
  });

  it('flag ON + socket answers healthz → UP with path provenance', async () => {
    const conns = new Set<net.Socket>();
    const server = net.createServer((conn) => {
      conns.add(conn);
      conn.on('close', () => conns.delete(conn));
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const req = JSON.parse(line) as { id: number };
          conn.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } })}\n`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(sockPath, () => resolve());
    });
    try {
      const res = await probeSubstrateSidecar(3000);
      expect(res.up).toBe(true);
      expect(res.present).not.toBe(false);
      expect(res.note).toContain(sockPath);
    } finally {
      // The probe's singleton client holds its connection open — close it and
      // destroy server-side conns FIRST, else server.close() waits forever.
      closeSubstrateIpcClient();
      for (const c of conns) c.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('flag ON + socket file EXISTS but nothing listens → real DOWN with the TRUE dial error, fast', async () => {
    // A stale socket file with no listener = the "sidecar died, file left behind"
    // shape — this one IS a fault worth alarming on.
    const stale = net.createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      stale.once('error', reject);
      stale.listen(sockPath, () => resolve());
    });
    await new Promise<void>((resolve) => stale.close(() => resolve())); // closes listener…
    // net's close() unlinks the socket file; recreate the FILE to simulate the stale leftover.
    if (!fs.existsSync(sockPath)) fs.writeFileSync(sockPath, '');
    const started = Date.now();
    const res = await probeSubstrateSidecar(4000);
    expect(res.up).toBe(false);
    expect(res.note).toMatch(/ECONNREFUSED|ENOTSOCK|Connection/);
    expect(res.note).toContain(sockPath);
    expect(Date.now() - started).toBeLessThan(4000); // no masked 5s connect timer
  });
});
