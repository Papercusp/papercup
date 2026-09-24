#!/usr/bin/env node
/**
 * GATING guard: a tracked systemd drop-in must actually be INSTALLED on a host
 * that runs the unit it belongs to.
 *
 * WHY (D-002/D-004 of substrate-observability-bug-wave-2026-08-26): a drop-in can be
 * written, committed, documented and unit-tested while never being symlinked into
 * ~/.config/systemd/user/, and NOTHING notices. The unit keeps running its old
 * configuration and every artifact around it reads as healthy.
 *
 * Measured instance that motivated this guard (2026-08-26): papercup-bg-host.service.d/
 * 95-bundled-entry.conf replaces the base unit's `npx tsx bin/hono-host.ts` entry — which
 * reads the LIVE shared checkout, so a peer's mid-edit state can crash-loop the DBOS
 * routines / git-sync / substrate primary — with a pre-built bundle. It was committed
 * 2026-08-25, shipped with bundle-host.sh, a README install section AND a dedicated
 * vitest, and was absent from the unit's live DropInPaths a full day later. Three
 * separate components had already been written assuming it was active:
 *   - bghost-watchdog.mjs      ("a successful boot takes 4-5 min (ExecStartPre esbuild bundle)")
 *   - check-host-bundle-builds.mjs ("bundle-host.sh — which runs as the service's ExecStartPre")
 *   - bghost-bundled-entry.test.ts (asserts the install instructions are well-formed)
 * Not one of them could observe the host, so all three were green.
 *
 * NOT the first instance either: 94-embed-sidecar-enable.conf's own header documents the
 * same class for a different fix — "the sidecar the fix shipped was simply never turned on
 * where it mattered." That is why this guard is scoped to the whole tracked systemd
 * directory rather than to one unit.
 *
 * WHY THIS IS NOT A VITEST: the fact being asserted lives in systemd, not in the repo, so
 * it is unobservable from CI by construction. Pinning repo text to other repo text is what
 * the existing test already does and is exactly the failure this replaces (D-004). This is
 * rung 3 of CLAUDE.md's derive/pin/attest ladder: reconcile against the runtime.
 *
 * SCOPE, stated so a reader does not over-trust a pass: user-scope `*.service.d/*.conf`
 * drop-ins, plus the Diodon/zeitgeist lifecycle on a host with an active graphical
 * session. Root-owned system units installed by `sudo install` (per the README's
 * user-manager-watchdog section) are a different mechanism and are NOT covered here.
 *
 * Usage:
 *   node scripts/check-systemd-dropins-installed.mjs           # gate (exit 1 on missing)
 *   node scripts/check-systemd-dropins-installed.mjs --list    # print the measured population
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const systemdDir = join(repoRoot, 'apps', 'operator', 'scripts', 'systemd');
const listOnly = process.argv.includes('--list');

/** Run systemctl --user, returning stdout, or null when the call fails. */
function systemctlUser(args) {
  try {
    return execFileSync('systemctl', ['--user', ...args], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 15_000,
    });
  } catch {
    return null;
  }
}

/**
 * Is there a user systemd manager to talk to at all?
 *
 * `is-system-running` exits NON-ZERO for healthy-but-degraded states, so its exit code
 * cannot be the probe — only the ABSENCE of output means we could not reach a manager.
 * Getting this backwards would make the guard skip on every box that has any failed
 * unit, which is precisely the host where it most needs to run.
 */
function userSystemdAvailable() {
  try {
    execFileSync('systemctl', ['--user', 'is-system-running'], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 15_000,
    });
    return true;
  } catch (err) {
    const out = `${err?.stdout ?? ''}`.trim();
    return out.length > 0;
  }
}

function showProperty(unit, property) {
  const out = systemctlUser(['show', unit, `--property=${property}`, '--value']);
  return out === null ? null : out.trim();
}

function installedSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink() && existsSync(path);
  } catch {
    return false;
  }
}

/** Collect tracked drop-ins as { unit, confPath, confName }. */
function trackedDropIns() {
  if (!existsSync(systemdDir)) return [];
  const found = [];
  for (const entry of readdirSync(systemdDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.service.d')) continue;
    const unit = entry.name.slice(0, -2); // "foo.service.d" -> "foo.service"
    const dir = join(systemdDir, entry.name);
    for (const conf of readdirSync(dir)) {
      if (!conf.endsWith('.conf')) continue;
      found.push({ unit, confName: conf, confPath: join(dir, conf) });
    }
  }
  return found.sort((a, b) => `${a.unit}/${a.confName}`.localeCompare(`${b.unit}/${b.confName}`));
}

const dropIns = trackedDropIns();

if (dropIns.length === 0) {
  console.log('systemd drop-in install check: no tracked *.service.d/*.conf found — nothing to verify.');
  process.exit(0);
}

if (!userSystemdAvailable()) {
  // Loud, not silent: a skip must never read like a pass. Exit 0 so CI (which has no
  // user systemd session) is not broken by an environment fact.
  console.log(
    `systemd drop-in install check: SKIPPED — no user systemd manager reachable.\n` +
      `  ${dropIns.length} tracked drop-in(s) were NOT verified. This check only means anything on a host that runs these units.`,
  );
  process.exit(0);
}

const missing = [];
const installed = [];
const unitAbsent = [];

for (const { unit, confName, confPath } of dropIns) {
  const loadState = showProperty(unit, 'LoadState');
  if (loadState === null) {
    unitAbsent.push({ unit, confName, reason: 'systemctl show failed' });
    continue;
  }
  if (loadState === 'not-found') {
    unitAbsent.push({ unit, confName, reason: 'unit not present in user scope' });
    continue;
  }
  const dropInPaths = showProperty(unit, 'DropInPaths') ?? '';
  const loadedNames = new Set(dropInPaths.split(/\s+/).filter(Boolean).map((p) => basename(p)));
  if (loadedNames.has(confName)) installed.push({ unit, confName });
  else missing.push({ unit, confName, confPath });
}

if (listOnly) {
  console.log('=== tracked systemd drop-ins (measured population) ===');
  for (const d of installed) console.log(`  INSTALLED    ${d.unit}  ${d.confName}`);
  for (const d of missing) console.log(`  MISSING      ${d.unit}  ${d.confName}`);
  for (const d of unitAbsent) console.log(`  UNIT-ABSENT  ${d.unit}  ${d.confName}  (${d.reason})`);
  console.log(
    `\ninstalled=${installed.length} missing=${missing.length} unit-absent=${unitAbsent.length}`,
  );
  process.exit(0);
}

if (unitAbsent.length > 0) {
  console.log(
    `systemd drop-in install check: ${unitAbsent.length} drop-in(s) skipped — their unit is not on this host:`,
  );
  for (const d of unitAbsent) console.log(`  - ${d.unit} / ${d.confName} (${d.reason})`);
}

if (missing.length > 0) {
  console.error(
    `\n❌ ${missing.length} tracked systemd drop-in(s) are NOT loaded by the unit they belong to.\n` +
      `   The unit is running WITHOUT the configuration this repo believes it has.\n`,
  );
  for (const { unit, confName, confPath } of missing) {
    const rel = confPath.slice(repoRoot.length + 1);
    console.error(`  ${unit}  <-  ${confName}`);
    console.error(`     tracked at: ${rel}`);
    console.error(`     install:    mkdir -p ~/.config/systemd/user/${unit}.d \\`);
    console.error(`                 && ln -sfn "${confPath}" ~/.config/systemd/user/${unit}.d/${confName} \\`);
    console.error(`                 && systemctl --user daemon-reload`);
    console.error(
      `     then verify: systemctl --user show ${unit} --property=DropInPaths --value | tr ' ' '\\n' | grep ${confName}\n`,
    );
  }
  console.error(
    `   A drop-in that changes ExecStart/ExecStartPre does not take effect until the unit RESTARTS.\n` +
      `   Check the drop-in's own header for whether it is safe to restart, and whether it needs a\n` +
      `   raised TimeoutStartSec before activation.\n`,
  );
  process.exit(1);
}

// WI-10003011: Diodon can remain running yet stop recording after Zeitgeist
// restarts. The unit dependency makes the client restart too; this host check
// catches an absent link, stale loaded unit, or a revived competing XDG
// autostart before the next user session silently loses clipboard history.
if (existsSync('/usr/bin/diodon') && showProperty('graphical-session.target', 'ActiveState') === 'active') {
  const service = 'diodon-managed.service';
  const servicePath = join(homedir(), '.config', 'systemd', 'user', service);
  const autostartPath = join(homedir(), '.config', 'autostart', 'diodon-autostart.desktop');
  const issues = [];
  if (!installedSymlink(servicePath)) issues.push(`missing installed service symlink: ${servicePath}`);
  if (!installedSymlink(autostartPath)) issues.push(`missing XDG autostart override symlink: ${autostartPath}`);
  else if (!/^Hidden=true$/m.test(readFileSync(autostartPath, 'utf8')))
    issues.push('XDG autostart override does not disable the competing Diodon launch');
  if (showProperty(service, 'FragmentPath') !== servicePath) issues.push('managed Diodon unit file is not loaded');
  if (showProperty(service, 'UnitFileState') !== 'enabled') issues.push('managed Diodon unit is not enabled');
  if (showProperty(service, 'ActiveState') !== 'active') issues.push('managed Diodon unit is not active');
  if (showProperty(service, 'NeedDaemonReload') !== 'no') issues.push('managed Diodon unit needs daemon-reload');
  if (showProperty(service, 'Restart') !== 'on-failure') issues.push('managed Diodon crash recovery is disabled');
  if (showProperty('zeitgeist.service', 'Restart') !== 'on-failure')
    issues.push('Zeitgeist crash recovery is disabled');
  for (const [unit, property, value] of [
    [service, 'BindsTo', 'zeitgeist.service'],
    [service, 'PartOf', 'zeitgeist.service'],
    [service, 'After', 'zeitgeist.service'],
    ['zeitgeist.service', 'Wants', service],
  ]) {
    if (!(showProperty(unit, property) ?? '').split(/\s+/).includes(value))
      issues.push(`${unit} does not have ${property}=${value}`);
  }
  if (issues.length > 0) {
    console.error(`❌ Diodon/zeitgeist lifecycle is not installed or active:\n  - ${issues.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('✓ Diodon/zeitgeist lifecycle check: managed service active and autostart override installed.');
}

console.log(
  `✓ systemd drop-in install check: all ${installed.length} tracked drop-in(s) for units present on this host are loaded.`,
);
process.exit(0);
