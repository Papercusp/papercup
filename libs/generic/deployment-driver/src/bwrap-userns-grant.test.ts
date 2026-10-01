import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BWRAP_USERNS_GRANT_FUNCTION,
  BWRAP_USERNS_PROBE_ARGS,
  bwrapUsernsAppArmorProfileLines,
  bwrapUsernsGrantShellLines,
} from './bwrap-userns-grant';

const MARKER = '# Managed by a test (WI-10004636).';

// Runs the RENDERED function in bash against a scratch AppArmor directory, a scratch sysctl file,
// a fake bwrap and a fake apparmor_parser that logs its argv. Nothing touches the real host.
function harness(opts: { parserExit?: number } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'bwrap-grant-'));
  const aaDir = path.join(tmp, 'apparmor.d');
  mkdirSync(aaDir);
  const sysctl = path.join(tmp, 'apparmor_restrict_unprivileged_userns');
  const bwrap = path.join(tmp, 'bwrap');
  writeFileSync(bwrap, '#!/bin/sh\n', { mode: 0o755 });
  const bin = path.join(tmp, 'bin');
  mkdirSync(bin);
  const parserLog = path.join(tmp, 'parser.log');
  writeFileSync(
    path.join(bin, 'apparmor_parser'),
    `#!/bin/sh\necho "$@" >> '${parserLog}'\nexit ${opts.parserExit ?? 0}\n`,
  );
  chmodSync(path.join(bin, 'apparmor_parser'), 0o755);
  const script = path.join(tmp, 'run.sh');
  writeFileSync(
    script,
    ['set -euo pipefail', ...bwrapUsernsGrantShellLines(MARKER), `${BWRAP_USERNS_GRANT_FUNCTION} "$@"`, 'echo DONE'].join('\n'),
  );
  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', [script, aaDir, sysctl, bwrap], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });
  const profile = path.join(aaDir, 'bwrap');
  const parserCalls = () => (existsSync(parserLog) ? readFileSync(parserLog, 'utf8').trim().split('\n') : []);
  return { tmp, aaDir, sysctl, bwrap, profile, run, parserCalls };
}

describe('bwrapUsernsGrantShellLines (WI-10004636)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const make = (opts?: { parserExit?: number }) => {
    const h = harness(opts);
    dirs.push(h.tmp);
    return h;
  };

  it('changes nothing on a kernel without the userns restriction', () => {
    const h = make();
    const r = h.run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DONE');
    expect(existsSync(h.profile)).toBe(false);
    expect(h.parserCalls()).toEqual([]);
  });

  it('writes the marker-tagged scoped profile and loads it on a restricted kernel', () => {
    const h = make();
    writeFileSync(h.sysctl, '1\n');
    const r = h.run();
    expect(r.status).toBe(0);
    expect(readFileSync(h.profile, 'utf8')).toBe(
      [MARKER, ...bwrapUsernsAppArmorProfileLines(h.bwrap)].join('\n') + '\n',
    );
    expect(h.parserCalls()).toEqual([`-r ${h.profile}`]);
  });

  it('rewrites its own profile on a re-run (every boot re-runs the bootstrap)', () => {
    const h = make();
    writeFileSync(h.sysctl, '1\n');
    expect(h.run().status).toBe(0);
    expect(h.run().status).toBe(0);
    expect(h.parserCalls()).toHaveLength(2);
    expect(readFileSync(h.profile, 'utf8').startsWith(MARKER)).toBe(true);
  });

  it("leaves someone else's <aa_dir>/bwrap alone", () => {
    const h = make();
    writeFileSync(h.sysctl, '1\n');
    writeFileSync(h.profile, 'profile foreign /usr/bin/bwrap {}\n');
    expect(h.run().status).toBe(0);
    expect(readFileSync(h.profile, 'utf8')).toBe('profile foreign /usr/bin/bwrap {}\n');
    expect(h.parserCalls()).toEqual([]);
  });

  it('skips when another profile already attaches to the bwrap binary', () => {
    const h = make();
    writeFileSync(h.sysctl, '1\n');
    writeFileSync(path.join(h.aaDir, 'other'), `profile other ${h.bwrap} flags=(unconfined) {\n}\n`);
    expect(h.run().status).toBe(0);
    expect(existsSync(h.profile)).toBe(false);
  });

  it('removes a profile the parser rejects and still returns 0', () => {
    const h = make({ parserExit: 1 });
    writeFileSync(h.sysctl, '1\n');
    const r = h.run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DONE');
    expect(r.stderr).toContain('WARN: AppArmor rejected the bwrap userns profile');
    expect(existsSync(h.profile)).toBe(false);
  });

  it('refuses a marker that would break the single-quoted shell literal', () => {
    expect(() => bwrapUsernsGrantShellLines("it's")).toThrow(/single quote/);
  });
});

describe('BWRAP_USERNS_PROBE_ARGS', () => {
  // The probe must create every namespace Codex's sandbox creates, or it can pass on a host where
  // Codex still fails.
  it('unshares the user, pid and net namespaces and runs from /', () => {
    expect(BWRAP_USERNS_PROBE_ARGS).toEqual(
      expect.arrayContaining(['--unshare-user', '--unshare-pid', '--unshare-net']),
    );
    const i = BWRAP_USERNS_PROBE_ARGS.indexOf('--chdir');
    expect(BWRAP_USERNS_PROBE_ARGS[i + 1]).toBe('/');
    expect(BWRAP_USERNS_PROBE_ARGS.at(-1)).toBe('true');
  });
});
