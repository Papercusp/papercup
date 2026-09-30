/**
 * desktop-lease.test.ts — per-hive desktop lifecycle (ensure/env/release),
 * driven through the injectable provisioner seam so no real Xvfb is spawned.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureHiveDesktop,
  hiveDesktop,
  desktopEnvForHive,
  releaseHiveDesktop,
  leasedHiveDesktops,
  releaseAllHiveDesktops,
  __setProvisionerForTests,
  __resetProvisioner,
  leaseCapabilities,
  reapDeadHiveDesktops,
} from './desktop-lease';
import type { SandboxDesktop } from './desktop-provisioner';
import { NO_GL_STRATEGY } from '../../desktop/gl-strategy';

function fakeDesktop(n: number): SandboxDesktop & { released: () => number } {
  let releases = 0;
  return {
    display: `:${n}`,
    number: n,
    width: 1024,
    height: 768,
    // No live X server here, so no GL was measured — the honest zero value.
    gl: NO_GL_STRATEGY,
    // WI-1223202: nothing was probed at all here, so it was certainly not probed inside a
    // sandbox. `false` is the honest value, not a placeholder.
    glProbeSandboxed: false,
    // WI-1105361: this fake spawned no apps, so there is nothing to diagnose. Empty is
    // the honest answer; a fabricated "alive" row would assert a process that never was.
    appDiagnostics: () => [],
    // P-005: a fake desktop enrols nothing — the honest "unenrolled" value.
    taskId: null,
    // P-012: the default local backend. No `endpoint` and no `credentials` follow from
    // it — Xvfb runs `-nolisten tcp` — and the leasing path under test is backend-blind
    // by design (D-021 keeps every driver surface X-bound), so a lease test has no
    // reason to prefer one backend over the other.
    xServer: 'xvfb',
    release: async () => {
      releases += 1;
    },
    released: () => releases,
  };
}

afterEach(async () => {
  await releaseAllHiveDesktops();
  __resetProvisioner();
});

describe('per-hive desktop lease', () => {
  it('provisions once per hive and caches (idempotent ensure)', async () => {
    const provision = vi.fn(async () => fakeDesktop(110));
    __setProvisionerForTests(provision);

    const a = await ensureHiveDesktop('hive-x');
    const b = await ensureHiveDesktop('hive-x');
    expect(a).toBe(b);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(hiveDesktop('hive-x')).toBe(a);
  });

  it('coalesces concurrent ensure() calls onto one provision', async () => {
    const provision = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return fakeDesktop(111);
    });
    __setProvisionerForTests(provision);

    const [a, b, c] = await Promise.all([
      ensureHiveDesktop('hive-y'),
      ensureHiveDesktop('hive-y'),
      ensureHiveDesktop('hive-y'),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('desktopEnvForHive returns the lease env, or {} when none', async () => {
    __setProvisionerForTests(async () => fakeDesktop(112));
    expect(desktopEnvForHive('hive-z')).toEqual({}); // not leased yet
    await ensureHiveDesktop('hive-z');
    expect(desktopEnvForHive('hive-z')).toEqual({
      PAPERCUSP_COMPUTER_DISPLAY: ':112',
      PAPERCUSP_COMPUTER_WIDTH: '1024',
      PAPERCUSP_COMPUTER_HEIGHT: '768',
    });
  });

  it('releaseHiveDesktop tears the desktop down and clears the lease', async () => {
    const desk = fakeDesktop(113);
    __setProvisionerForTests(async () => desk);
    await ensureHiveDesktop('hive-r');
    expect(leasedHiveDesktops()).toEqual(['hive-r']);

    await releaseHiveDesktop('hive-r');
    expect(desk.released()).toBe(1);
    expect(hiveDesktop('hive-r')).toBeUndefined();
    expect(desktopEnvForHive('hive-r')).toEqual({});

    await releaseHiveDesktop('hive-r'); // idempotent
    expect(desk.released()).toBe(1);
  });

  it('releaseAllHiveDesktops tears down every lease', async () => {
    const d1 = fakeDesktop(114);
    const d2 = fakeDesktop(115);
    const queue = [d1, d2];
    __setProvisionerForTests(async () => queue.shift()!);
    await ensureHiveDesktop('h1');
    await ensureHiveDesktop('h2');
    expect(leasedHiveDesktops().sort()).toEqual(['h1', 'h2']);

    await releaseAllHiveDesktops();
    expect(d1.released()).toBe(1);
    expect(d2.released()).toBe(1);
    expect(leasedHiveDesktops()).toEqual([]);
  });

  // WI-10004206: a dead lease stayed in the map (and its row `ready`) until something
  // happened to call ensure for that hive, so every reader in between was offered it.
  it('reapDeadHiveDesktops releases only the leases whose desktop is gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let deadAlive = true;
    const dead = { ...fakeDesktop(116), isAlive: () => deadAlive };
    const live = { ...fakeDesktop(117), isAlive: () => true };
    const queue: SandboxDesktop[] = [dead, live];
    __setProvisionerForTests(async () => queue.shift()!);
    await ensureHiveDesktop('h-dead');
    await ensureHiveDesktop('h-live');

    expect(await reapDeadHiveDesktops()).toEqual([]);
    deadAlive = false;
    expect(await reapDeadHiveDesktops()).toEqual(['h-dead']);
    expect(dead.released()).toBe(1);
    expect(live.released()).toBe(0);
    expect(leasedHiveDesktops()).toEqual(['h-live']);
    expect(warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('the desktop is gone')))
      .toEqual(['[desktop-lease] pot=h-dead display=:116: the desktop is gone — releasing its lease']);
    warn.mockRestore();
  });
});

/**
 * EI-22074168424155872 — the capabilities the lease MIRRORS into the registry.
 *
 * These run against the pure derivation rather than the mirror, because the mirror
 * swallows every failure by design ("inventory only"): a wrong capability there is
 * silent, is served to other processes as a measurement, and is discovered — if at
 * all — as a confusing refusal from `computer:observe` in a different process hours
 * later. Six separate agents triaging that refusal each named "the provisioner's
 * recorded startA11yBus outcome" as the decisive evidence and none could obtain it,
 * because `a11y` was declared on DesktopCapabilities and never written.
 */
describe('leaseCapabilities (registry mirror)', () => {
  it('reports gl from the LADDER VERDICT, not from the presence of its result object', () => {
    const desktop = fakeDesktop(120);

    // The control that pins the bug: `gl` is always a GlStrategy object — the
    // negative verdict is the frozen NO_GL_STRATEGY — so object-truthiness is
    // `true` here and cannot express "this desktop has no GL" at all.
    expect(Boolean(desktop.gl)).toBe(true);
    expect(desktop.gl.tier).toBe('none');
    expect(leaseCapabilities(desktop).gl).toBe(false);
  });

  it('reports gl true for both tiers the ladder can positively conclude', () => {
    for (const tier of ['hardware', 'software'] as const) {
      const desktop = { ...fakeDesktop(121), gl: { ...NO_GL_STRATEGY, id: 'native' as const, tier } };
      expect(leaseCapabilities(desktop).gl).toBe(true);
    }
  });

  it('records a11y false for a screenshot-only desktop — a legal state, not an error', () => {
    expect(leaseCapabilities(fakeDesktop(122)).a11y).toBe(false);
  });

  it('records a11y true when the provisioner brought a bus up', () => {
    const desktop = {
      ...fakeDesktop(123),
      a11y: {
        sessionBus: 'unix:path=/tmp/dbus-fake',
        a11yBus: 'unix:path=/run/user/1000/at-spi/bus_123',
        env: {},
        release: () => {},
      },
    };
    expect(leaseCapabilities(desktop).a11y).toBe(true);
  });
});
