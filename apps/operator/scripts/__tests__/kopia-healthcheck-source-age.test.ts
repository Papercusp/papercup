import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SOURCE_SCRIPT = resolve(__dirname, '..', 'systemd', 'kopia-healthcheck.sh');
const CACHE_BOOTSTRAP = resolve(__dirname, '..', 'systemd', 'kopia-cache-bootstrap.sh');
const tempDirs: string[] = [];

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function snapshotTime(ageSeconds: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    })
      .formatToParts(new Date(Date.now() - ageSeconds * 1000))
      .map((part) => [part.type, part.value]),
  );
  return parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute + ':' + parts.second + ' ' + parts.timeZoneName;
}

function sourceBlock(source: string, time: string): string[] {
  return [
    'jdoe@host:' + source,
    '  ' + time + ' abc123 1 GB drwxr-xr-x files:1 dirs:1',
  ];
}

function runHealthcheck(dumpSnapshotAgeSeconds: number) {
  const root = mkdtempSync(join(tmpdir(), 'kopia-healthcheck-source-age-'));
  tempDirs.push(root);

  const home = join(root, 'home');
  const dumpDir = join(root, 'db-dumps');
  const scriptDir = join(root, 'script');
  const fakeBin = join(root, 'bin');
  const logDir = join(root, 'logs');
  const stateDir = join(root, 'state');
  const fakeKopia = join(fakeBin, 'kopia');
  const testScript = join(scriptDir, 'kopia-healthcheck.sh');
  const alertStub = join(root, 'alert-stub.sh');
  const alertLog = join(root, 'alert.log');

  for (const path of [home, dumpDir, scriptDir, fakeBin, logDir, stateDir, join(home, 'macos-vm')]) {
    mkdirSync(path, { recursive: true });
  }

  const now = Math.floor(Date.now() / 1000);
  writeFileSync(
    join(dumpDir, 'STATUS.json'),
    JSON.stringify({ lastSuccessEpoch: now - 10 * 60 }),
  );

  const unrelated = join(root, 'unrelated-source');
  const allSources = [
    ...sourceBlock(unrelated, snapshotTime(60)),
    '',
    ...sourceBlock(dumpDir, snapshotTime(dumpSnapshotAgeSeconds)),
  ].join('\n');
  const homeListing = sourceBlock(home, snapshotTime(60)).join('\n');
  const vmListing = sourceBlock(join(home, 'macos-vm'), snapshotTime(60)).join('\n');

  writeFileSync(
    fakeKopia,
    [
      '#!/usr/bin/env bash',
      'if [ "$1" != "snapshot" ] || [ "$2" != "list" ]; then exit 2; fi',
      'case "$3" in',
      '  --all) printf %s\\n ' + shellQuote(allSources) + ' ;;',
      '  "$PAPERCUSP_HOST_PG_DUMP_DIR") printf %s\\n ' + shellQuote(sourceBlock(dumpDir, snapshotTime(dumpSnapshotAgeSeconds)).join('\n')) + ' ;;',
      '  "$HOME") printf %s\\n ' + shellQuote(homeListing) + ' ;;',
      '  "$HOME/macos-vm") printf %s\\n ' + shellQuote(vmListing) + ' ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n') + '\n',
  );
  chmodSync(fakeKopia, 0o755);

  const fakeSudo = join(fakeBin, 'sudo');
  writeFileSync(
    fakeSudo,
    '#!/usr/bin/env bash\nif [ "$1" = "-n" ]; then shift; fi\nexec "$@"\n',
  );
  chmodSync(fakeSudo, 0o755);

  writeFileSync(alertStub, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$TEST_ALERT_LOG"\n');
  chmodSync(alertStub, 0o755);

  const source = readFileSync(SOURCE_SCRIPT, 'utf8');
  const kopiaReferences = source.match(/\/usr\/bin\/kopia/g) ?? [];
  if (kopiaReferences.length === 0) throw new Error('healthcheck no longer calls the expected absolute Kopia path');
  writeFileSync(
    testScript,
    source.replaceAll('/usr/bin/kopia', shellQuote(fakeKopia)),
  );
  chmodSync(testScript, 0o755);
  writeFileSync(join(scriptDir, 'kopia-cache-bootstrap.sh'), readFileSync(CACHE_BOOTSTRAP, 'utf8'));

  const result = spawnSync('/usr/bin/env', ['bash', testScript], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: home,
      TZ: 'America/New_York',
      PATH: fakeBin + ':' + (process.env.PATH ?? '/usr/bin:/bin'),
      PAPERCUSP_HOST_PG_DUMP_DIR: dumpDir,
      KOPIA_HEALTHCHECK_LOG_DIR: logDir,
      HEALTHCHECK_STATE_DIR: stateDir,
      ODDSMITH_DISCOVERY: join(root, 'missing-oddsmith.json'),
      KOPIA_VM_VERIFY_MARKER: join(root, 'missing-vm-marker'),
      BACKUP_ALERT_CMD: alertStub,
      TEST_ALERT_LOG: alertLog,
      MAX_SNAP_AGE_S: '3600',
    },
  });

  return {
    result,
    log: readFileSync(join(logDir, 'healthcheck.log'), 'utf8'),
    alertLog: existsSync(alertLog) ? readFileSync(alertLog, 'utf8') : '',
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Kopia healthcheck dump-source recency', () => {
  it('fails when a fresh unrelated source masks a stale db-dumps source', () => {
    const run = runHealthcheck(3 * 60 * 60);
    const evidence = [run.result.stdout, run.result.stderr, run.log].join('\n');

    expect(run.result.status, evidence).toBe(1);
    expect(evidence).toContain('Postgres dump source snapshot is STALE');
    expect(evidence).toContain('ALARM SUPPRESSED');
    expect(run.alertLog).toBe('');
  });

  it('stays green when the exact db-dumps source has a recent complete snapshot', () => {
    const run = runHealthcheck(10 * 60);

    expect(run.result.status, [run.result.stdout, run.result.stderr, run.log].join('\n')).toBe(0);
    expect(run.log).toContain('OK: dump ');
    expect(run.alertLog).toBe('');
  });
});
