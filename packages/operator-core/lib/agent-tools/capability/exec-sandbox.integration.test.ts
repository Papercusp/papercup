/**
 * REAL bwrap + srt exec validation for the capability-exec sandbox
 * (agent-capability-confinement-2026-06-13 P-022/D-008, WI-608).
 *
 * Unlike exec-sandbox.test.ts (argv-level, host-independent), this SPAWNS through
 * the decision the builder returns and asserts real OS containment: the command
 * runs, the cwd is writable, /tmp is an ephemeral tmpfs, existing credential paths
 * read empty, MISSING credential paths are skipped (the fail-closed bug WI-608
 * fixed), and the deny-all-egress lever drops the network namespace.
 *
 * SKIPS where bwrap cannot sandbox (`capabilityBwrapWorks() === false`: most CI,
 * any host without the AppArmor userns grant) — so it proves containment on capable
 * hosts without ever failing a fail-open host. On Ubuntu 24.04 a capable host needs
 * an AppArmor profile granting `/usr/bin/bwrap` the `userns` permission.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { srtBinOnPath } from '@papercusp/orchestrator';
import {
  buildCapabilitySandboxCommand,
  capabilityBwrapWorks,
  capabilitySrtSettingsPathForCwd,
  type BuildSandboxOpts,
} from './exec-sandbox';

const BWRAP_OK = capabilityBwrapWorks();
const SRT_BIN = srtBinOnPath();
const d = BWRAP_OK ? describe : describe.skip;

// NOT under /tmp: the bwrap argv does `--tmpfs /tmp`, which would shadow a cwd or
// fake-home placed there. /var/tmp is bound read-only from the host and only the
// specific cwd is re-bound writable, so it survives.
const ROOT = `/var/tmp/wi608-exec-sandbox-it-${process.pid}`;
const WORK = join(ROOT, 'work');
const FAKE_HOME = join(ROOT, 'home');

function run(cmd: string[], cwd: string, opts: BuildSandboxOpts) {
  const decision = buildCapabilitySandboxCommand({ cmd, cwd }, opts);
  // Mirror the real handler (bash-jobs.spawnShell): cwd is set via the spawn
  // OPTIONS, not just bwrap's `--chdir`. srt confines fs but does not chdir, so
  // it relies on the spawn cwd exactly like the operator does.
  const r = spawnSync(decision.binary, decision.argv, { encoding: 'utf8', timeout: 20_000, cwd });
  return { decision, r, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

d('exec-sandbox — REAL bwrap exec (host is bwrap-capable)', () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    mkdirSync(join(FAKE_HOME, '.ssh'), { recursive: true });
    writeFileSync(join(FAKE_HOME, '.ssh', 'id_rsa'), 'TOP_SECRET_PRIVATE_KEY');
    writeFileSync(join(FAKE_HOME, '.npmrc'), '//registry.npmjs.org/:_authToken=NPM_TOKEN_SECRET');
    // .aws / .gnupg / .config/gcloud / .papercusp intentionally ABSENT → must be skipped.
  });
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

  it('runs the command, cwd is writable, /tmp ephemeral, masks existing creds, SKIPS missing ones (no fail-close)', () => {
    const script = [
      'echo PWD=$(pwd)',
      'echo written > inside.txt && echo CWD_WRITE_OK',
      'echo TMP_ENTRIES=$(ls -A /tmp | wc -l)',
      `echo SSH_ENTRIES=$(ls -A ${FAKE_HOME}/.ssh | wc -l)`,
      `echo SSH_READ=$(cat ${FAKE_HOME}/.ssh/id_rsa 2>&1)`,
      `echo NPMRC_READ=$(cat ${FAKE_HOME}/.npmrc 2>&1)`,
      `test -e ${FAKE_HOME}/.aws && echo AWS_PRESENT || echo AWS_ABSENT`,
    ].join('; ');
    const { decision, r, out } = run(['/bin/sh', '-c', script], WORK, {
      enabled: true,
      srtBin: null, // pin the bwrap-fallback path
      homeDir: FAKE_HOME,
      bwrapBinary: '/usr/bin/bwrap',
    });
    expect(decision.mode).toBe('bwrap');
    // The whole point: a missing ~/.config/gcloud etc. must NOT abort the command.
    expect(r.status).toBe(0);
    expect(out).toContain(`PWD=${WORK}`);
    expect(out).toContain('CWD_WRITE_OK');
    expect(existsSync(join(WORK, 'inside.txt'))).toBe(true); // write reached the host cwd
    expect(out).toContain('TMP_ENTRIES=0'); // /tmp is a fresh tmpfs inside the sandbox
    expect(out).toContain('SSH_ENTRIES=0'); // ~/.ssh masked (tmpfs reads empty)
    expect(out).not.toContain('TOP_SECRET_PRIVATE_KEY'); // secret not readable
    expect(out).not.toContain('NPM_TOKEN_SECRET'); // ~/.npmrc masked via /dev/null
    expect(out).toContain('AWS_ABSENT'); // missing mask target skipped, not fatal
  });

  it('the host root is READ-ONLY (a write outside the cwd is refused)', () => {
    const { r, out } = run(['/bin/sh', '-c', 'echo x > /etc/wi608-should-fail 2>&1; echo DONE'], WORK, {
      enabled: true,
      srtBin: null,
      homeDir: FAKE_HOME,
      bwrapBinary: '/usr/bin/bwrap',
    });
    expect(out).toContain('DONE');
    expect(out).toMatch(/Read-only file system|Permission denied/);
    expect(existsSync('/etc/wi608-should-fail')).toBe(false);
  });

  it('deny-all-egress drops the network namespace (only lo, no host interfaces)', () => {
    // Read interfaces from /proc/net/dev — `--proc /proc` remounts a fresh, NETNS-LOCAL
    // procfs, so it reflects the new namespace. (NOT /sys/class/net: /sys is bound
    // read-only from the host root and would show the host's interfaces even here.)
    // A fresh netns has exactly: 2 header lines + loopback = 3 lines.
    const { r, out } = run(['/bin/sh', '-c', 'echo IFACE_LINES=$(wc -l < /proc/net/dev)'], WORK, {
      enabled: true,
      srtBin: null,
      homeDir: FAKE_HOME,
      bwrapBinary: '/usr/bin/bwrap',
      denyAllEgress: true,
    });
    expect(r.status).toBe(0);
    expect(out).toContain('IFACE_LINES=3');
  });

  (SRT_BIN ? it : it.skip)('srt-preferred path: srt actually wraps + runs the command', () => {
    const settingsPath = capabilitySrtSettingsPathForCwd(WORK);
    const { decision, r, out } = run(['/bin/sh', '-c', 'echo SRT_RAN_IN=$(pwd)'], WORK, {
      enabled: true,
      srtBin: SRT_BIN,
      srtSettingsPath: settingsPath,
      homeDir: FAKE_HOME,
      bwrapBinary: '/usr/bin/bwrap',
    });
    expect(decision.mode).toBe('srt');
    expect(r.status).toBe(0);
    expect(out).toContain(`SRT_RAN_IN=${WORK}`);
  });
});
