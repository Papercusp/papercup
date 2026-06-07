/**
 * Unit tests for the Tier-3 bench fleet lifecycle (P-010): provision order,
 * manifest-backed anti-billing-leak, destroy-on-failure, and the crash sweeper.
 * Fake driver + fake exec — no cloud, no SSH, no tar.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeploymentDriver, Frame } from '@papercusp/deployment-driver';
import type { RemoteExec } from '../remote-exec';
import { provisionBenchFleet, sweepLeftoverBenchFrames } from './bench-frames';

function fakeDriver(calls: string[], opts: { failProvisionAt?: number; failTeardownIds?: string[] } = {}): DeploymentDriver {
  let n = 0;
  return {
    target: 'fake-cloud',
    placement: 'remote',
    async provision(config, ctx): Promise<Frame> {
      n++;
      if (opts.failProvisionAt === n) throw new Error(`provision ${n} exploded`);
      const id = `srv_${n}`;
      calls.push(`provision:${ctx.harnessSlug}:${id}`);
      return { id, target: 'fake-cloud', placement: 'remote', host: `10.0.0.${n}`, region: config.region };
    },
    async install() {
      throw new Error('bench fleet must not use driver.install (harness-shaped)');
    },
    async join() {
      throw new Error('bench fleet must not use driver.join');
    },
    async teardown(frame) {
      if (opts.failTeardownIds?.includes(frame.id)) throw new Error(`teardown of ${frame.id} refused`);
      calls.push(`teardown:${frame.id}`);
    },
  };
}

function fakeExec(calls: string[], label: string): RemoteExec {
  return {
    async runScript(script: string) {
      calls.push(`run:${label}:${script.includes('bench-bootstrap') ? 'bootstrap' : script.slice(0, 24)}`);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async copyFile(_local: string, remote: string) {
      calls.push(`scp:${label}:${remote}`);
    },
  };
}

function baseOpts(calls: string[], manifestPath: string) {
  return {
    repoRoot: '/fake/repo',
    log: () => {},
    manifestPath,
    sshWait: { attempts: 2, delayMs: 1, sleep: async () => {} },
    makeRemoteExec: (target: { host: string }) => fakeExec(calls, target.host),
    packTarball: async (_r: string, outPath: string) => {
      calls.push('pack');
      return { outPath, bytes: 7 };
    },
  };
}

describe('provisionBenchFleet', () => {
  it('packs once, provisions each spec, installs over SSH, and teardownAll destroys + clears the manifest', async () => {
    const calls: string[] = [];
    const tmp = mkdtempSync(join(tmpdir(), 'bench-frames-test-'));
    const manifestPath = join(tmp, 'frames.json');
    const fleet = await provisionBenchFleet({
      driver: fakeDriver(calls),
      specs: [
        { label: 'A', region: 'nyc' },
        { label: 'B', region: 'dal', firewall: true },
      ],
      ...baseOpts(calls, manifestPath),
    });

    expect(calls.filter((c) => c === 'pack')).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('provision:'))).toHaveLength(2);
    // Tarball staged + bootstrap run on each frame.
    expect(calls.filter((c) => c.startsWith('scp:'))).toHaveLength(2);
    // Frames recorded in the manifest while alive (the anti-leak record).
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Array<{ id: string }>;
    expect(manifest.map((m) => m.id).sort()).toEqual(['srv_1', 'srv_2']);
    // The firewalled spec is carried on the frame handle.
    expect(fleet.frames.find((f) => f.spec.label === 'B')?.firewall).toBe(true);

    await fleet.teardownAll();
    expect(calls.filter((c) => c.startsWith('teardown:'))).toHaveLength(2);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual([]);
  });

  it('a mid-fleet provision failure destroys what already came up, then rethrows', async () => {
    const calls: string[] = [];
    const tmp = mkdtempSync(join(tmpdir(), 'bench-frames-test-'));
    const manifestPath = join(tmp, 'frames.json');
    await expect(
      provisionBenchFleet({
        driver: fakeDriver(calls, { failProvisionAt: 2 }),
        specs: [{ label: 'A' }, { label: 'B' }],
        ...baseOpts(calls, manifestPath),
      }),
    ).rejects.toThrow('provision 2 exploded');
    // Frame 1 was up → destroyed; manifest is clean again.
    expect(calls).toContain('teardown:srv_1');
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual([]);
  });

  it('a frame whose teardown fails STAYS in the manifest (next run sweeps it)', async () => {
    const calls: string[] = [];
    const tmp = mkdtempSync(join(tmpdir(), 'bench-frames-test-'));
    const manifestPath = join(tmp, 'frames.json');
    const fleet = await provisionBenchFleet({
      driver: fakeDriver(calls, { failTeardownIds: ['srv_1'] }),
      specs: [{ label: 'A' }, { label: 'B' }],
      ...baseOpts(calls, manifestPath),
    });
    await fleet.teardownAll(); // srv_1 refuses, srv_2 destroys
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Array<{ id: string }>;
    expect(manifest.map((m) => m.id)).toEqual(['srv_1']);
  });
});

describe('sweepLeftoverBenchFrames', () => {
  it('destroys manifest leftovers for this driver target and clears them', async () => {
    const calls: string[] = [];
    const tmp = mkdtempSync(join(tmpdir(), 'bench-frames-test-'));
    const manifestPath = join(tmp, 'frames.json');
    // Seed a crashed-run manifest: one entry for this target, one foreign.
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify([
        { id: 'srv_9', target: 'fake-cloud', label: 'stale', createdAt: 'x' },
        { id: 'other_1', target: 'other-cloud', label: 'foreign', createdAt: 'x' },
      ]),
    );
    const swept = await sweepLeftoverBenchFrames({
      driver: fakeDriver(calls),
      log: () => {},
      manifestPath,
    });
    expect(swept).toBe(1);
    expect(calls).toContain('teardown:srv_9');
    // The foreign-target entry is untouched.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Array<{ id: string }>;
    expect(manifest.map((m) => m.id)).toEqual(['other_1']);
    expect(existsSync(manifestPath)).toBe(true);
  });
});
