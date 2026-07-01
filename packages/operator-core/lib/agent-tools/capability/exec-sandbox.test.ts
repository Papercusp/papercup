/**
 * Capability-exec sandbox argv (agent-capability-confinement-2026-06-13 P-022/D-008).
 *
 * The wrap's behavior is pinned at the ARGV level via the injectable `bwrapWorks` /
 * `homeDir` / `bwrapBinary` / `maskExists` seam (so it is host-independent); the REAL
 * bwrap + srt exec paths are validated end-to-end by `exec-sandbox.integration.test.ts`
 * on a bwrap-capable host. These tests pin: fail-open both ways (flag-off,
 * bwrap-unavailable → raw), the containment argv (cwd-writable, credential masking,
 * process-namespace isolation), skipping a nonexistent mask target (else bwrap
 * fail-CLOSES under the ro-root), the deny-all-egress lever, and credential-list
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
// srtBin:null pins the BWRAP-fallback path deterministically (the srt-preferred
// path is exercised separately); without it the result would depend on whether
// `srt` happens to be on the test host's PATH.
const base: Omit<BuildSandboxOpts, 'enabled'> = {
  bwrapWorks: true,
  srtBin: null,
  homeDir: '/home/op',
  bwrapBinary: 'bwrap',
  // The fake homeDir's credential paths don't exist on the test host; pin "all
  // present" so the mask-argv assertions below stay deterministic. The skip-missing
  // behavior is covered by its own block.
  maskExists: () => true,
};

describe('buildCapabilitySandboxCommand — fail-open', () => {
  it('flag OFF → raw command, not sandboxed (reason flag-off, mode raw)', () => {
    const d = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: false });
    expect(d.sandboxed).toBe(false);
    expect(d.mode).toBe('raw');
    expect(d.reason).toBe('flag-off');
    expect(d.binary).toBe('/usr/bin/bash');
    expect(d.argv).toEqual(['-c', 'echo hi']);
  });

  it('flag ON but bwrap unavailable → raw (srt rests on bwrap too, so neither can sandbox here)', () => {
    // bwrapWorks:false; srt is intentionally present to prove it is NOT used when
    // the underlying bubblewrap can't sandbox (a failing srt would NOT be fail-open).
    const d = buildCapabilitySandboxCommand(
      { cmd: CMD, cwd: CWD },
      { ...base, enabled: true, bwrapWorks: false, srtBin: '/usr/bin/srt', srtSettingsPath: '/tmp/s.json' },
    );
    expect(d.sandboxed).toBe(false);
    expect(d.mode).toBe('raw');
    expect(d.reason).toBe('bwrap-unavailable');
    expect(d.binary).toBe('/usr/bin/bash');
  });
});

describe('buildCapabilitySandboxCommand — srt preferred (P-033 egress allowlist)', () => {
  const d = buildCapabilitySandboxCommand(
    { cmd: CMD, cwd: CWD },
    { ...base, enabled: true, srtBin: '/opt/srt', srtSettingsPath: '/tmp/srt-settings.json' },
  );

  it('when srt is present (and bwrap works), srt wraps the command — mode srt, binary = srt', () => {
    expect(d.sandboxed).toBe(true);
    expect(d.mode).toBe('srt');
    expect(d.reason).toBeNull();
    expect(d.binary).toBe('/opt/srt');
  });

  it('passes the settings file via -s and runs the command via -c (srt egress-allowlist proxy + fs sandbox)', () => {
    expect(d.argv[0]).toBe('-s');
    expect(d.argv[1]).toBe('/tmp/srt-settings.json');
    expect(d.argv[2]).toBe('-c');
    // The inner shell clears no_proxy (so egress routes through srt's proxy) and
    // execs the original command, single-quote escaped (no injection).
    const inner = d.argv[3];
    expect(inner).toContain("exec '/usr/bin/bash' '-c' 'echo hi'");
    expect(inner).toContain('no_proxy');
  });

  it('falls back to bwrap when srt is absent even though bwrap works (mode bwrap)', () => {
    const b = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: true, srtBin: null });
    expect(b.mode).toBe('bwrap');
    expect(b.binary).toBe('bwrap');
  });
});

describe('buildCapabilitySandboxCommand — wrapped argv (flag ON + bwrap works)', () => {
  const d = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: true });

  it('spawns bwrap, sandboxed, no reason (mode bwrap — srt absent)', () => {
    expect(d.sandboxed).toBe(true);
    expect(d.mode).toBe('bwrap');
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

  it('orders `--tmpfs /tmp` BEFORE the cwd bind (else a cwd under /tmp is shadowed → bwrap --chdir fails)', () => {
    // Regression guard: a `--tmpfs /tmp` applied AFTER `--bind cwd cwd` mounts an
    // empty tmpfs OVER a cwd that lives under /tmp (e.g. TMPDIR=/tmp/pcv → a mkdtemp
    // working dir), so bwrap aborts with `Can't chdir … No such file or directory`.
    // The tmpfs must come first so the cwd bind lands on top of it and survives.
    // (Presence alone is not enough — the earlier assertions don't pin order.)
    const tmpfsIdx = seqIndex(d.argv, ['--tmpfs', '/tmp']);
    const bindIdx = seqIndex(d.argv, ['--bind', CWD, CWD]);
    expect(tmpfsIdx).toBeGreaterThanOrEqual(0);
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    expect(tmpfsIdx).toBeLessThan(bindIdx);
  });

  it('isolates process namespaces + dies with the parent', () => {
    for (const f of ['--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--die-with-parent']) {
      expect(d.argv).toContain(f);
    }
  });

  it('masks credential DIRS with a tmpfs at the resolved home path', () => {
    for (const dir of ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.papercusp']) {
      expect(CAPABILITY_SANDBOX_MASK_DIRS).toContain(dir);
      expect(seq(d.argv, ['--tmpfs', `/home/op/${dir}`])).toBe(true);
    }
  });

  it('masks the credential FILE ~/.npmrc with --ro-bind /dev/null (a tmpfs over a file no-ops → would leak the token)', () => {
    expect(CAPABILITY_SANDBOX_MASK_DIRS).toContain('.npmrc');
    expect(seq(d.argv, ['--ro-bind', '/dev/null', '/home/op/.npmrc'])).toBe(true);
    // …and NOT a tmpfs (the bug this guards against).
    expect(seq(d.argv, ['--tmpfs', '/home/op/.npmrc'])).toBe(false);
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

describe('buildCapabilitySandboxCommand — skip a nonexistent mask target (fail-OPEN, not fail-closed)', () => {
  // bwrap can't create a mount point under the ro-root (`Can't mkdir …: Read-only
  // file system`), so binding a credential path that doesn't exist would abort the
  // whole command. A missing path has no secret to mask, so it must be skipped.
  it('omits --tmpfs / --ro-bind for mask paths that do not exist on the host', () => {
    // Only ~/.ssh + ~/.npmrc exist; the rest are missing and must be skipped.
    const present = new Set(['/home/op/.ssh', '/home/op/.npmrc']);
    const d = buildCapabilitySandboxCommand(
      { cmd: CMD, cwd: CWD },
      { ...base, enabled: true, maskExists: (abs) => present.has(abs) },
    );
    expect(d.mode).toBe('bwrap');
    // present → masked
    expect(seq(d.argv, ['--tmpfs', '/home/op/.ssh'])).toBe(true);
    expect(seq(d.argv, ['--ro-bind', '/dev/null', '/home/op/.npmrc'])).toBe(true);
    // missing → NOT bound (no --tmpfs / --ro-bind referencing them at all)
    for (const missing of ['/home/op/.aws', '/home/op/.gnupg', '/home/op/.config/gcloud', '/home/op/.papercusp']) {
      expect(d.argv).not.toContain(missing);
    }
  });

  it('skips ALL mask targets when none exist (still a valid sandbox, just no credential overlays)', () => {
    const d = buildCapabilitySandboxCommand(
      { cmd: CMD, cwd: CWD },
      { ...base, enabled: true, maskExists: () => false },
    );
    expect(d.sandboxed).toBe(true);
    expect(d.mode).toBe('bwrap');
    for (const dir of CAPABILITY_SANDBOX_MASK_DIRS) {
      expect(d.argv).not.toContain(`/home/op/${dir}`);
    }
    // The core containment (ro-root, writable cwd, ns isolation) is unaffected.
    expect(seq(d.argv, ['--ro-bind', '/', '/'])).toBe(true);
    expect(seq(d.argv, ['--bind', CWD, CWD])).toBe(true);
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
  return seqIndex(hay, needle) >= 0;
}

/** Start index of `needle` as a contiguous subsequence of `hay`, or -1 if absent. */
function seqIndex(hay: string[], needle: string[]): number {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((n, j) => hay[i + j] === n)) return i;
  }
  return -1;
}
