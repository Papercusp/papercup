/**
 * Capability-exec sandbox argv (agent-capability-confinement-2026-06-13 P-022/D-008).
 *
 * bwrap cannot run on this dev box (unprivileged userns is AppArmor-restricted), so
 * the wrap's behavior is pinned at the ARGV level via the injectable `bwrapWorks` /
 * `homeDir` / `bwrapBinary` seam — end-to-end validation is the owner's arming step
 * on a bwrap-capable host. These tests pin: fail-open both ways (flag-off,
 * bwrap-unavailable → raw), the containment argv (cwd-writable, credential masking,
 * process-namespace isolation), the deny-all-egress lever, and credential-list
 * parity with the fleet sandbox.
 */
import { describe, it, expect } from 'vitest';
import { FLEET_SANDBOX_DENY_READ } from '@papercusp/orchestrator';
import {
  buildCapabilitySandboxCommand,
  CAPABILITY_SANDBOX_MASK_DIRS,
  type BuildSandboxOpts,
} from './exec-sandbox';

const CMD = ['/usr/bin/bash', '-c', 'echo hi'];
const CWD = '/proj/work';
const base: Omit<BuildSandboxOpts, 'enabled'> = { bwrapWorks: true, homeDir: '/home/op', bwrapBinary: 'bwrap' };

describe('buildCapabilitySandboxCommand — fail-open', () => {
  it('flag OFF → raw command, not sandboxed (reason flag-off)', () => {
    const d = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: false });
    expect(d.sandboxed).toBe(false);
    expect(d.reason).toBe('flag-off');
    expect(d.binary).toBe('/usr/bin/bash');
    expect(d.argv).toEqual(['-c', 'echo hi']);
  });

  it('flag ON but bwrap unavailable → raw command, not sandboxed (reason bwrap-unavailable)', () => {
    const d = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: true, bwrapWorks: false });
    expect(d.sandboxed).toBe(false);
    expect(d.reason).toBe('bwrap-unavailable');
    expect(d.binary).toBe('/usr/bin/bash');
    expect(d.argv).toEqual(['-c', 'echo hi']);
  });
});

describe('buildCapabilitySandboxCommand — wrapped argv (flag ON + bwrap works)', () => {
  const d = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: true });

  it('spawns bwrap, sandboxed, no reason', () => {
    expect(d.sandboxed).toBe(true);
    expect(d.reason).toBeNull();
    expect(d.binary).toBe('bwrap');
  });

  it('mounts a read-only root, a writable cwd at its real path, and chdirs there', () => {
    const a = d.argv;
    expect(seq(a, ['--ro-bind', '/', '/'])).toBe(true);
    expect(seq(a, ['--bind', CWD, CWD])).toBe(true);
    expect(seq(a, ['--chdir', CWD])).toBe(true);
    expect(seq(a, ['--tmpfs', '/tmp'])).toBe(true);
  });

  it('isolates process namespaces + dies with the parent', () => {
    for (const f of ['--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--die-with-parent']) {
      expect(d.argv).toContain(f);
    }
  });

  it('masks every credential dir with a tmpfs at the resolved home path', () => {
    for (const dir of CAPABILITY_SANDBOX_MASK_DIRS) {
      expect(seq(d.argv, ['--tmpfs', `/home/op/${dir}`])).toBe(true);
    }
  });

  it('ends with `-- <cmd>` so the wrapped command runs last', () => {
    const dashIdx = d.argv.lastIndexOf('--');
    expect(dashIdx).toBeGreaterThan(0);
    expect(d.argv.slice(dashIdx + 1)).toEqual(CMD);
  });

  it('does NOT unshare the network by default (fs/credential containment, egress shared — domain-allowlist is the follow-up)', () => {
    expect(d.argv).not.toContain('--unshare-net');
  });
});

describe('buildCapabilitySandboxCommand — deny-all-egress lever', () => {
  it('denyAllEgress:true adds --unshare-net', () => {
    const d = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: true, denyAllEgress: true });
    expect(d.argv).toContain('--unshare-net');
  });
  it('denyAllEgress:false omits --unshare-net', () => {
    const d = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: true, denyAllEgress: false });
    expect(d.argv).not.toContain('--unshare-net');
  });
});

describe('credential-mask parity with the fleet sandbox', () => {
  it('CAPABILITY_SANDBOX_MASK_DIRS mirrors FLEET_SANDBOX_DENY_READ (home-relative)', () => {
    // The fleet list is `~/`-prefixed; strip it and compare the home-relative set.
    const fleetRel = FLEET_SANDBOX_DENY_READ.map((p) => p.replace(/^~\//, '')).sort();
    expect([...CAPABILITY_SANDBOX_MASK_DIRS].sort()).toEqual(fleetRel);
  });
});

/** True if `needle` appears as a contiguous subsequence of `hay`. */
function seq(hay: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((n, j) => hay[i + j] === n)) return true;
  }
  return false;
}
