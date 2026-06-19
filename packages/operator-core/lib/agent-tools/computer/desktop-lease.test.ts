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
} from './desktop-lease';
import type { SandboxDesktop } from './desktop-provisioner';

function fakeDesktop(n: number): SandboxDesktop & { released: () => number } {
  let releases = 0;
  return {
    display: `:${n}`,
    number: n,
    width: 1024,
    height: 768,
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
});
