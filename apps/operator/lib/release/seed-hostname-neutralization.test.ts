/**
 * EI-20040763522089574 — the seed cut must never write SSTs stamped with the build box's
 * hostname.
 *
 * The decision is a pure function precisely so these cases can be exercised without
 * spawning a sandbox, on any platform, including the ones the rule REFUSES.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_NEUTRAL_BUILD_HOSTNAME,
  SEED_UTS_MARKER_ENV,
  buildBwrapArgv,
  findExecutableOnPath,
  planHostnameNeutralization,
} from './seed-hostname-neutralization.js';

/**
 * A SYNTHETIC stand-in for "some build box's real hostname". ⚠ Never paste the actual
 * one here: this is shipped source, and the identity-lint leg of the green checkpoint
 * reds `main` for the whole fleet on a bare build-box literal. (I tripped that hook
 * writing this very file — the irony is the point, so it is written down: a fix for an
 * identity leak is exactly when you are most tempted to paste the identity.)
 * The assertions only need a value that is NOT the neutral one.
 */
const BOX = 'some-build-box-hostname';
const NEUTRAL = DEFAULT_NEUTRAL_BUILD_HOSTNAME;

function plan(over: Partial<Parameters<typeof planHostnameNeutralization>[0]> = {}) {
  return planHostnameNeutralization({
    wantCorestore: true,
    platform: 'linux',
    markerSet: false,
    currentHostname: BOX,
    neutralHostname: NEUTRAL,
    bwrapPath: '/usr/bin/bwrap',
    ...over,
  });
}

describe('seed hostname neutralization (EI-20040763522089574)', () => {
  it('re-execs under bwrap when a corestore is cut on linux', () => {
    const p = plan();
    expect(p.kind).toBe('re-exec');
    if (p.kind !== 're-exec') return;
    expect(p.bwrapPath).toBe('/usr/bin/bwrap');
    expect(p.neutralHostname).toBe(NEUTRAL);
  });

  it('does NOTHING when no corestore is cut — the reuse/no-corestore legs write no SST', () => {
    // This is what keeps the rule from being a platform outage: mac-vm-build.sh defaults
    // PAPERCUSP_SEED_REUSE_CORESTORE=auto, which resolves to reuse whenever a committed
    // corestore exists, so macOS normally lands here rather than in the refusal below.
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const p = plan({ wantCorestore: false, platform, bwrapPath: null });
      expect(p.kind).toBe('proceed');
    }
  });

  it('proceeds once inside the namespace (no infinite re-exec)', () => {
    const p = plan({ markerSet: true, currentHostname: NEUTRAL });
    expect(p.kind).toBe('proceed');
  });

  it('REFUSES when the marker is set by hand but the hostname was never neutralized', () => {
    // The bypass worth closing: exporting the marker to "skip the sandbox" would
    // otherwise ship a stamped seed while reporting success.
    const p = plan({ markerSet: true, currentHostname: BOX });
    expect(p.kind).toBe('refuse');
    if (p.kind !== 'refuse') return;
    expect(p.message).toContain(SEED_UTS_MARKER_ENV);
    expect(p.message).toContain(BOX);
  });

  it('REFUSES to cut on a platform with no UTS namespaces, naming the reuse remedy', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const p = plan({ platform });
      expect(p.kind).toBe('refuse');
      if (p.kind !== 'refuse') continue;
      expect(p.message).toContain('--reuse-corestore');
      expect(p.message).toContain(platform);
    }
  });

  it('REFUSES on linux when bwrap is absent rather than cutting a stamped seed', () => {
    const p = plan({ bwrapPath: null });
    expect(p.kind).toBe('refuse');
    if (p.kind !== 'refuse') return;
    expect(p.message).toContain('bwrap');
    // It must also close the door it just described, or the reader's next move is the bypass.
    expect(p.message).toContain(SEED_UTS_MARKER_ENV);
  });

  it('CONTROL: the same inputs that refuse for a cut are accepted when nothing is cut', () => {
    // Guards against a rule that refuses everything — which would pass every assertion
    // above while making the cutter useless.
    expect(plan({ platform: 'darwin' }).kind).toBe('refuse');
    expect(plan({ platform: 'darwin', wantCorestore: false }).kind).toBe('proceed');
  });

  describe('buildBwrapArgv', () => {
    it('unshares UTS ONLY, keeps the filesystem, and never unshares the network', () => {
      const argv = buildBwrapArgv({
        bwrapPath: '/usr/bin/bwrap',
        neutralHostname: NEUTRAL,
        execPath: '/usr/bin/node',
        argv: ['/repo/cut-seed-cli.ts', '--out', '/seed'],
      });
      expect(argv.slice(0, 6)).toEqual(['--dev-bind', '/', '/', '--unshare-uts', '--hostname', NEUTRAL]);
      // The cut needs PG + the operator over localhost; unsharing the net would break it
      // in a way that looks like an unrelated connectivity failure.
      expect(argv).not.toContain('--unshare-net');
      expect(argv).not.toContain('--unshare-all');
      // The command must survive intact, or the re-exec silently cuts something else.
      expect(argv.slice(6)).toEqual(['/usr/bin/node', '/repo/cut-seed-cli.ts', '--out', '/seed']);
    });
  });

  describe('findExecutableOnPath', () => {
    it('returns the first executable match and null when nothing matches', () => {
      const found = findExecutableOnPath('bwrap', {
        pathEnv: '/nope:/usr/bin:/usr/local/bin',
        isExecutable: (p) => p === '/usr/bin/bwrap',
      });
      expect(found).toBe('/usr/bin/bwrap');
      expect(
        findExecutableOnPath('bwrap', { pathEnv: '/nope:/also-nope', isExecutable: () => false }),
      ).toBeNull();
    });

    it('ignores empty PATH segments instead of probing the cwd', () => {
      const probed: string[] = [];
      findExecutableOnPath('bwrap', {
        pathEnv: ':/usr/bin:',
        isExecutable: (p) => {
          probed.push(p);
          return false;
        },
      });
      expect(probed).toEqual(['/usr/bin/bwrap']);
    });
  });
});
