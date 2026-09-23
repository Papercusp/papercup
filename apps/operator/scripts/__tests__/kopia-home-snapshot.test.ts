import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = process.env.KOPIA_HOME_SNAPSHOT_SCRIPT ?? join(homedir(), '.config/kopia/home-snapshot.sh');
const SERVICE = resolve(__dirname, '..', 'systemd', 'kopia-home-snapshot.service');
const testIfInstalled = existsSync(SCRIPT) ? it : it.skip;

describe('kopia-home-snapshot bounded execution contract', () => {
  it('keeps the checked-in systemd unit bounded and installs exact-PID cleanup', () => {
    const unit = readFileSync(SERVICE, 'utf8');

    expect(unit).toContain('MemoryAccounting=yes');
    expect(unit).toContain('MemoryHigh=8G');
    expect(unit).toContain('MemoryMax=12G');
    expect(unit).toContain('MemorySwapMax=0');
    expect(unit).toContain('TimeoutStopSec=30s');
    expect(unit).toContain('ExecStopPost=%h/.config/kopia/home-snapshot.sh --cleanup');
  });

  testIfInstalled('passes bash syntax validation without starting a snapshot', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })).not.toThrow();
  });

  it('binds no-change freshness to an atomic, source-specific verification marker', () => {
    const snapshot = readFileSync(SCRIPT, 'utf8');
    const healthcheck = readFileSync(resolve(__dirname, '..', 'systemd', 'kopia-healthcheck.sh'), 'utf8');

    expect(snapshot).toContain('VM_VERIFY_MARKER="${KOPIA_VM_VERIFY_MARKER:-$LOG_DIR/macos-vm-verified}"');
    expect(snapshot).toContain("printf 'verified_at=%s\\n' \"$(date +%s)\"");
    expect(snapshot).toContain("printf 'source=%s\\n' \"$source\"");
    expect(snapshot).toContain('write_vm_verification_marker "${VM_SRCS[0]}"');
    expect(healthcheck).toContain('vm_verification_epoch');
    expect(healthcheck).toContain('no new snapshot row was required');
    expect(healthcheck).toContain('no recent successful no-change verification was recorded');
  });

  testIfInstalled('cleanup kills a matching Kopia PID and refuses a reused/non-Kopia PID', () => {
    const root = mkdtempSync(join(tmpdir(), 'kopia-home-snapshot-cleanup-'));
    const stateDir = join(root, 'state');
    const procRoot = join(root, 'proc');
    const exactPid = '4242';
    const reusedPid = '4343';
    const fakeKopia = join(root, 'kopia');
    const fakeOther = join(root, 'other');
    const sudoStub = join(root, 'sudo-stub.sh');
    const killLog = join(root, 'kill.log');
    const pidFile = join(stateDir, 'home-snapshot.kopia.pid');

    try {
      mkdirSync(stateDir);
      mkdirSync(join(procRoot, exactPid), { recursive: true });
      mkdirSync(join(procRoot, reusedPid), { recursive: true });
      writeFileSync(fakeKopia, 'fixture');
      writeFileSync(fakeOther, 'fixture');
      symlinkSync(fakeKopia, join(procRoot, exactPid, 'exe'));
      symlinkSync(fakeOther, join(procRoot, reusedPid, 'exe'));
      writeFileSync(
        join(procRoot, exactPid, 'cmdline'),
        Buffer.from(`${fakeKopia}\0snapshot\0create\0--parallel=1\0`),
      );
      writeFileSync(join(procRoot, reusedPid, 'cmdline'), Buffer.from(`${fakeOther}\0sleep\0`));
      writeFileSync(
        sudoStub,
        '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >>"$KOPIA_TEST_KILL_LOG"\n',
      );
      chmodSync(sudoStub, 0o755);

      const env = {
        ...process.env,
        KOPIA_HOME_SNAPSHOT_LOG_DIR: stateDir,
        KOPIA_HOME_SNAPSHOT_PROC_ROOT: procRoot,
        KOPIA_HOME_SNAPSHOT_SUDO: sudoStub,
        KOPIA_HOME_SNAPSHOT_BIN: fakeKopia,
        KOPIA_TEST_KILL_LOG: killLog,
      };

      writeFileSync(pidFile, `${exactPid}\n`);
      const killed = spawnSync('bash', [SCRIPT, '--cleanup'], { encoding: 'utf8', env });
      expect(killed.status).toBe(0);
      expect(readFileSync(killLog, 'utf8')).toContain(`-KILL ${exactPid}`);
      expect(existsSync(pidFile)).toBe(false);

      writeFileSync(pidFile, `${reusedPid}\n`);
      const refused = spawnSync('bash', [SCRIPT, '--cleanup'], { encoding: 'utf8', env });
      expect(refused.status).toBe(0);
      expect(readFileSync(killLog, 'utf8')).not.toContain(`-KILL ${reusedPid}`);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  testIfInstalled('cleanup kills a ROOT-owned Kopia child whose /proc exe link the user unit cannot read', () => {
    // WI-10002636: the Kopia child runs as root, and /proc/<pid>/exe of a root process is
    // unreadable to the user unit, so the unprivileged readlink returns nothing and the match
    // never succeeded for the child this cleanup exists to kill. The user-visible proc dir
    // below has a readable cmdline but NO exe; only the sudo path (a root-view mirror)
    // resolves the link, exactly like the real /proc.
    const root = mkdtempSync(join(tmpdir(), 'kopia-home-snapshot-rootview-'));
    const stateDir = join(root, 'state');
    const procRoot = join(root, 'proc');
    const rootViewProcRoot = join(root, 'proc-as-root');
    const rootPid = '5252';
    const reusedRootPid = '5353';
    const fakeKopia = join(root, 'kopia');
    const fakeOther = join(root, 'other');
    const sudoStub = join(root, 'sudo-stub.sh');
    const killLog = join(root, 'kill.log');
    const pidFile = join(stateDir, 'home-snapshot.kopia.pid');
    const killLogText = () => (existsSync(killLog) ? readFileSync(killLog, 'utf8') : '');

    try {
      mkdirSync(stateDir);
      writeFileSync(fakeKopia, 'fixture');
      writeFileSync(fakeOther, 'fixture');
      for (const [pid, target, argv] of [
        [rootPid, fakeKopia, `${fakeKopia}\0snapshot\0create\0--parallel=1\0`],
        [reusedRootPid, fakeOther, `${fakeOther}\0sleep\0`],
      ] as const) {
        mkdirSync(join(procRoot, pid), { recursive: true });
        mkdirSync(join(rootViewProcRoot, pid), { recursive: true });
        writeFileSync(join(procRoot, pid, 'cmdline'), Buffer.from(argv));
        symlinkSync(target, join(rootViewProcRoot, pid, 'exe'));
      }
      // Models `sudo -n`: strips its flags, resolves readlink against the root view of /proc,
      // and logs every other command (the kill) instead of running it.
      writeFileSync(
        sudoStub,
        [
          '#!/usr/bin/env bash',
          '[ "$1" = -n ] && shift',
          '[ "$1" = -- ] && shift',
          'if [ "$1" = readlink ]; then',
          '  shift',
          '  args=()',
          '  for a in "$@"; do args+=("${a/#"$KOPIA_TEST_PROC_ROOT"/"$KOPIA_TEST_ROOT_VIEW"}"); done',
          '  exec readlink "${args[@]}"',
          'fi',
          'printf \'%s\\n\' "$*" >>"$KOPIA_TEST_KILL_LOG"',
          '',
        ].join('\n'),
      );
      chmodSync(sudoStub, 0o755);

      const env = {
        ...process.env,
        KOPIA_HOME_SNAPSHOT_LOG_DIR: stateDir,
        KOPIA_HOME_SNAPSHOT_PROC_ROOT: procRoot,
        KOPIA_HOME_SNAPSHOT_SUDO: sudoStub,
        KOPIA_HOME_SNAPSHOT_BIN: fakeKopia,
        KOPIA_TEST_KILL_LOG: killLog,
        KOPIA_TEST_PROC_ROOT: procRoot,
        KOPIA_TEST_ROOT_VIEW: rootViewProcRoot,
      };

      writeFileSync(pidFile, `${rootPid}\n`);
      expect(spawnSync('bash', [SCRIPT, '--cleanup'], { encoding: 'utf8', env }).status).toBe(0);
      expect(killLogText()).toContain(`-KILL ${rootPid}`);
      expect(existsSync(pidFile)).toBe(false);

      writeFileSync(pidFile, `${reusedRootPid}\n`);
      expect(spawnSync('bash', [SCRIPT, '--cleanup'], { encoding: 'utf8', env }).status).toBe(0);
      expect(killLogText()).not.toContain(`-KILL ${reusedRootPid}`);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
