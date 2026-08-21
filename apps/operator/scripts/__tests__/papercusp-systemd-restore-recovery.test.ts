import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(__dirname, '..', 'systemd', 'papercusp-systemd-restore-recovery.sh');

interface StubOptions {
  failStart?: string;
}

async function runRecovery(scope: 'user' | 'system' | 'both' = 'user', options: StubOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'papercusp-systemd-restore-recovery-'));
  const binDir = join(dir, 'bin');
  const logPath = join(dir, 'systemctl.log');
  await mkdir(binDir);
  await writeFile(
    join(binDir, 'systemctl'),
    `#!/usr/bin/env bash
set -u
scope=system
if [[ "$1" == "--user" ]]; then scope=user; shift; fi
printf '%s %s\\n' "$scope" "$*" >> "$SYSTEMCTL_LOG"
case "$1" in
  daemon-reload|reset-failed) exit 0 ;;
  list-unit-files)
    cat <<'EOF'
papercusp-db-backup.timer enabled enabled
healthy.timer enabled enabled
runtime.timer enabled-runtime enabled
disabled.timer disabled enabled
EOF
    exit 0
    ;;
  is-active)
    unit="$3"
    case "$unit" in
      healthy.timer) exit 0 ;;
      *) exit 3 ;;
    esac
    ;;
  start)
    [[ "$2" == '${options.failStart ?? ''}' ]] && exit 1
    exit 0
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );

  const args = scope === 'user' ? [] : ['--scope', scope];
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      SYSTEMCTL_LOG: logPath,
    },
  });
  const log = await readFile(logPath, 'utf8');
  await rm(dir, { recursive: true, force: true });
  return { result, log };
}

describe('papercusp-systemd-restore-recovery.sh', () => {
  it('reloads and clears failures, then starts only enabled inactive timers', async () => {
    const { result, log } = await runRecovery();

    expect(result.status).toBe(0);
    expect(log).toContain('user daemon-reload\n');
    expect(log).toContain('user reset-failed\n');
    expect(log).toContain('user start papercusp-db-backup.timer\n');
    expect(log).toContain('user start runtime.timer\n');
    expect(log).not.toContain('start healthy.timer');
    expect(log).not.toContain('start disabled.timer');
    expect(log.indexOf('user daemon-reload\n')).toBeLessThan(log.indexOf('user reset-failed\n'));
    expect(log.indexOf('user reset-failed\n')).toBeLessThan(log.indexOf('user start papercusp-db-backup.timer\n'));
  });

  it('uses the system manager only when explicitly requested', async () => {
    const { result, log } = await runRecovery('system');

    expect(result.status).toBe(0);
    expect(log).toContain('system daemon-reload\n');
    expect(log).toContain('system reset-failed\n');
    expect(log).toContain('system start papercusp-db-backup.timer\n');
    expect(log).not.toContain('user ');
  });

  it('continues the sweep but fails loudly when one enabled timer cannot start', async () => {
    const { result, log } = await runRecovery('user', { failStart: 'papercusp-db-backup.timer' });

    expect(result.status).not.toBe(0);
    expect(log).toContain('user start papercusp-db-backup.timer\n');
    expect(log).toContain('user start runtime.timer\n');
    expect(result.stderr).toContain('could not start systemd --user timer papercusp-db-backup.timer');
  });

  it('recovers both managers and preserves a failure from either scope', async () => {
    const { result, log } = await runRecovery('both', { failStart: 'papercusp-db-backup.timer' });

    expect(result.status).not.toBe(0);
    expect(log).toContain('user daemon-reload\n');
    expect(log).toContain('system daemon-reload\n');
    expect(log).toContain('system start runtime.timer\n');
  });
});
