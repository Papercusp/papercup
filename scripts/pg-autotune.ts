#!/usr/bin/env tsx
/**
 * pg-autotune — apply HOST-SCALED PostgreSQL server settings to a NATIVE PG.
 *
 * The embedded Postgres that ships with the desktop autoadjusts at boot (its
 * `-c` flags are fed from resource-profile in apps/operator/bin/serve.ts). A
 * NATIVE PostgreSQL (a dev box or a dedicated server, where PG is a system
 * service we don't launch) can't be tuned that way — so this script is its arm:
 * it derives the SAME knobs from the SAME source of truth
 * (`@papercusp/resource-profile` → deriveDatabaseTuning), writes them to a
 * non-destructive `conf.d` drop-in, restarts PG, and verifies it came back up —
 * rolling the drop-in back automatically if it didn't.
 *
 * Nothing is hardcoded for one machine: the numbers come from detected cores +
 * RAM, so the same command does the right thing on a laptop and on a 128-core
 * server.
 *
 *   npx tsx scripts/pg-autotune.ts            # --print: show derived settings, change nothing
 *   npx tsx scripts/pg-autotune.ts --apply    # write the drop-in + restart PG + verify
 *
 * Flags:
 *   --apply                 actually write + restart (default is print-only)
 *   --confd   <dir>         conf.d directory (default /etc/postgresql/18/main/conf.d)
 *   --service <unit>        systemd unit to restart (default postgresql@18-main.service)
 *   --port    <n>           port to verify against (default 5432)
 *
 * Requires passwordless sudo for the write + restart (writes a postgres-owned
 * file and restarts a system service). A restart briefly drops all connections;
 * pooled clients reconnect.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  databaseTuningToSettings,
  deriveDatabaseTuning,
  detectResourceSignals,
} from '@papercusp/resource-profile';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const opt = (f: string, d: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const apply = has('--apply');
const confDir = opt('--confd', '/etc/postgresql/18/main/conf.d');
const service = opt('--service', 'postgresql@18-main.service');
const port = opt('--port', '5432');
const dropIn = join(confDir, '10-papercusp-autotune.conf');

// Native PG = a dedicated DB (embeddedPg:false) → the textbook PGTune fractions.
const signals = detectResourceSignals({ embeddedPg: false });
const tuning = deriveDatabaseTuning(signals);
const settings = databaseTuningToSettings(tuning);
const gib = (signals.totalMemBytes / 1024 ** 3).toFixed(0);

const sleep = (ms: number) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SAB unavailable — skip the wait */
  }
};
const sudo = (file: string, ...a: string[]) =>
  execFileSync('sudo', ['-n', file, ...a], { encoding: 'utf8' });
const psql = (q: string): string | null => {
  try {
    return execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-p', port, '-tAc', q], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null; // wedged / unreachable — best-effort
  }
};

console.log(`host: ${signals.cores} cores, ${gib} GiB RAM — tuning NATIVE PG (dedicated)`);
const liveMax = psql('show max_connections');
const liveSb = psql('show shared_buffers');
if (liveMax) console.log(`current (live):  max_connections=${liveMax}  shared_buffers=${liveSb ?? '?'}`);
else console.log('current (live):  <unreachable — PG is wedged or down>');

// Persist pg_stat_statements so a FRESH host re-provision keeps query telemetry.
// Today it lives only in a manual conf.d/20 drop-in, which survives deploys but
// NOT a fresh provision — so re-running this script (the provision arm) silently
// drops query stats. Bake it into the managed drop-in instead. Union with whatever
// is already loaded so we never DROP a lib another mechanism added. shared_preload_
// libraries is postmaster-level (needs a restart), which --apply already does.
// (infra-perf-reliability-audit-round4 P-020.)
const livePreload = psql('show shared_preload_libraries') ?? '';
const preloadLibs = Array.from(
  new Set(
    [...livePreload.split(','), 'pg_stat_statements'].map((s) => s.trim()).filter(Boolean),
  ),
);
const preloadValue = `'${preloadLibs.join(',')}'`;

console.log('derived (target):');
for (const [k, v] of Object.entries(settings)) console.log(`  ${k} = ${v}`);
console.log(`  shared_preload_libraries = ${preloadValue}`);

if (!apply) {
  console.log('\n--print only. Re-run with --apply to write the drop-in and restart PG.');
  process.exit(0);
}

const content =
  [
    '# Managed by scripts/pg-autotune.ts — host-scaled PostgreSQL tuning.',
    '# Derived from detected cores/RAM via @papercusp/resource-profile.',
    '# Additive override (read after postgresql.conf); delete + restart to revert.',
    `# Host: ${signals.cores} cores, ${gib} GiB RAM.`,
    '',
  ].join('\n') +
  [
    ...Object.entries(settings).map(([k, v]) => `${k} = ${v}`),
    `shared_preload_libraries = ${preloadValue}`,
  ].join('\n') +
  '\n';

const tmp = join(tmpdir(), 'papercusp-autotune.conf');
writeFileSync(tmp, content, 'utf8');

const rollback = () => {
  console.error('rolling back the drop-in and restarting on the prior config…');
  try {
    sudo('rm', '-f', dropIn);
  } catch {
    /* ignore */
  }
  try {
    sudo('systemctl', 'restart', service);
  } catch {
    /* ignore */
  }
};

console.log(`\nwriting ${dropIn}`);
sudo('cp', tmp, dropIn);
sudo('chown', 'postgres:postgres', dropIn);
sudo('chmod', '644', dropIn);

console.log(`restarting ${service} (brief connection drop)…`);
try {
  sudo('systemctl', 'restart', service);
} catch (e) {
  console.error(`restart command failed: ${(e as Error).message}`);
  rollback();
  process.exit(1);
}

// Verify PG accepts connections again with the new config.
let up = false;
for (let i = 0; i < 30; i++) {
  if (psql('select 1') === '1') {
    up = true;
    break;
  }
  sleep(1000);
}
if (!up) {
  console.error('PG did not accept connections within 30s after restart.');
  rollback();
  process.exit(1);
}

const newMax = psql('show max_connections');
const newSb = psql('show shared_buffers');
console.log(`\n✓ applied. now live:  max_connections=${newMax}  shared_buffers=${newSb}`);
if (newMax !== settings.max_connections) {
  console.error(
    `WARNING: live max_connections=${newMax} != target ${settings.max_connections} ` +
      `(another conf.d file or an ALTER SYSTEM override may win).`,
  );
}

const newPreload = psql('show shared_preload_libraries') ?? '';
if (newPreload.includes('pg_stat_statements')) {
  console.log(`✓ shared_preload_libraries now live: ${newPreload}`);
} else {
  console.error(
    `WARNING: shared_preload_libraries=${newPreload || '<empty>'} does not include ` +
      `pg_stat_statements — query telemetry will not be collected (a later conf.d ` +
      `file or ALTER SYSTEM may override the drop-in).`,
  );
}
