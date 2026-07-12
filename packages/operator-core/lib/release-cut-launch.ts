/**
 * release-cut-launch — the agent-facing LOCAL desktop-release cutter's launch +
 * status + hand-off primitives (desktop-update-center-and-release-tooling P-5 Unit B).
 *
 * The `release:cut` MCP tool wraps these. Why a separate module (mirrors
 * release-deploy-launch.ts / release-checkpoint-launch.ts): a cut is a ~35–60 min heavy
 * tri-platform build — it MUST run DETACHED (survive a compaction / TUI relaunch /
 * operator restart, exactly like the deploy lever), so the tool can only fire-and-poll,
 * never await a child. Keeping the pure builders (argv, env, status parse, hand-off
 * collection) here makes them unit-testable WITHOUT firing a real cut (inject the
 * spawn / fs seams) and keeps the tool file thin — the codebase's standing convention
 * for these launch levers.
 *
 * ⛔ LOCAL-only (papercusp-desktop/RELEASE-RUNBOOK.md → "Releases are LOCAL-only";
 * owner directive 2026-07-08). The cut is fired with PAPERCUSP_PUBLISH_GITHUB=0 so
 * release-local.sh SKIPS its (superseded) tag-push + GitHub-Release steps — the signed
 * artifacts on disk are the deliverable. `handoff` collects the local paths + sha256 for
 * the owner to upload; this lever NEVER pushes a tag or creates a GitHub Release.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Transient systemd unit for the detached cut. Distinct from DEPLOY_UNIT /
 *  the checkpoint unit — a cut, a deploy and a green-checkpoint touch different trees and
 *  may run concurrently, so they must NOT share a mutually-exclusive unit name. */
export const CUT_UNIT = 'papercup-release-cut';
export const CUT_LOG = `/tmp/${CUT_UNIT}.log`;
/** Written "DONE:<exit-code>" by the detached wrapper when release-local.sh finishes —
 *  the authoritative completion signal a cut has no external event (unlike deploy). */
export const CUT_DONE = `/tmp/${CUT_UNIT}.done`;

export type Channel = 'stable' | 'beta' | 'alpha';
export const CHANNELS: readonly Channel[] = ['stable', 'beta', 'alpha'] as const;
// Semver-ish: X.Y.Z with an optional -prerelease suffix (e.g. 0.0.8, 1.2.3-rc.1).
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

// ─── Per-leg (fleet-split) support (WI-4233) ───────────────────────────────────
//
// The 0.0.8 cut ran as a fleet-split: 3 agents, 3 platform legs (linux+core /
// mac / windows), each sequenced on a shared BUILD_SHA. Because op:run only
// ever modeled ONE whole-cut detached unit, every leg had to be fired via raw
// bash around this orchestrator — losing op:status polling, the detached
// systemd unit, and the audit trail (see the cut.ts module doc). The
// functions below let each leg run through its OWN unit/log/done triple
// (`cutUnitFor`/`cutLogFor`/`cutDoneFor`) so N agents can each op:run-leg /
// op:status / op:abort-leg their own platform independently, while a single
// whole-cut (`platform` omitted) keeps behaving exactly as before.

export type Platform = 'linux' | 'mac' | 'windows' | 'arm64';
export const PLATFORMS: readonly Platform[] = ['linux', 'mac', 'windows', 'arm64'] as const;

/** Per-leg unit name; `platform` omitted ⇒ the legacy whole-cut unit (CUT_UNIT), so every
 *  existing whole-cut call site (op:run/status with no platform) is unaffected. */
export function cutUnitFor(platform?: Platform): string {
  return platform ? `${CUT_UNIT}-${platform}` : CUT_UNIT;
}
export function cutLogFor(platform?: Platform): string {
  return platform ? `/tmp/${CUT_UNIT}-${platform}.log` : CUT_LOG;
}
export function cutDoneFor(platform?: Platform): string {
  return platform ? `/tmp/${CUT_UNIT}-${platform}.done` : CUT_DONE;
}

/** Map a single platform leg to the `CutLegs` flags release-local.sh reads (WITH_MAC=1 /
 *  WITH_WINDOWS=1 / WITH_ARM64=1). 'linux' needs no flag — release-local.sh always builds
 *  the linux leg unconditionally; a linux-only leg is just the no-extra-flags base run. */
export function legsForPlatform(platform: Platform): CutLegs {
  switch (platform) {
    case 'mac':
      return { mac: true };
    case 'windows':
      return { windows: true };
    case 'arm64':
      return { arm64: true };
    case 'linux':
      return {};
  }
}

export function isValidVersion(v: string): boolean {
  return VERSION_RE.test(v);
}
export function isValidChannel(c: string): c is Channel {
  return (CHANNELS as readonly string[]).includes(c);
}

/** Integration tree root (mirrors release-deploy-launch.integrationRoot). */
export function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}
/** The papercusp-desktop submodule root — where bin/release-local.sh + src-tauri live.
 *  Overridable (PAPERCUSP_DESKTOP_ROOT) for a non-standard checkout layout. */
export function desktopRoot(): string {
  return process.env.PAPERCUSP_DESKTOP_ROOT ?? path.join(integrationRoot(), 'papercusp-desktop');
}

export interface CutLegs {
  mac?: boolean;
  windows?: boolean;
  arm64?: boolean;
}

/** Pure: the env the detached cut runs release-local.sh with — LOCAL-only ENFORCED
 *  (PAPERCUSP_PUBLISH_GITHUB=0, never publish to GitHub) plus the requested optional
 *  platform legs. Exported for unit testing. */
export function buildCutEnv(legs: CutLegs): Record<string, string> {
  const env: Record<string, string> = { PAPERCUSP_PUBLISH_GITHUB: '0' };
  if (legs.mac) env.WITH_MAC = '1';
  if (legs.windows) env.WITH_WINDOWS = '1';
  if (legs.arm64) env.WITH_ARM64 = '1';
  return env;
}

/** Pure: the full `systemd-run` argv for the detached LOCAL cut. Mirrors
 *  release-deploy-launch.buildSystemdRunArgv (PATH passthrough so the transient unit
 *  doesn't depend on the systemd-manager env). The inner command clears a stale DONE
 *  sentinel, runs the cut logging to CUT_LOG, then records the real exit code in
 *  CUT_DONE. Exported for unit testing the command construction. */
export function buildCutArgv(
  root: string,
  version: string,
  channel: Channel,
  legs: CutLegs,
  pathEnv: string,
  platform?: Platform,
): string[] {
  const env = buildCutEnv(legs);
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}='${v}'`)
    .join(' ');
  const unit = cutUnitFor(platform);
  const log = cutLogFor(platform);
  const done = cutDoneFor(platform);
  const inner = `rm -f ${done}; ` + `${envPrefix} bin/release-local.sh '${version}' '${channel}' > ${log} 2>&1; ` + `echo "DONE:$?" > ${done}`;
  return [
    '--user',
    '--collect',
    `--unit=${unit}`,
    `--working-directory=${root}`,
    `--setenv=PATH=${pathEnv}`,
    'bash',
    '-c',
    inner,
  ];
}

export type SpawnLike = typeof spawn;

export interface LaunchCutOpts {
  version: string;
  channel: Channel;
  legs?: CutLegs;
  /** papercusp-desktop root (default desktopRoot()). */
  root?: string;
  /** Fire ONE platform leg on its own unit/log/done (WI-4233 fleet-split support) instead
   *  of the legacy whole-cut unit. Omitted ⇒ unchanged whole-cut behavior. */
  platform?: Platform;
}

export interface LaunchCutResult {
  launched: boolean;
  unit: string;
  version: string;
  channel: Channel;
  legs: CutLegs;
  /** systemd-run argv actually run (or that would be run). */
  argv: string[];
  logPath: string;
  donePath: string;
  /** Present on a launch failure (e.g. the unit already exists ⇒ a cut is in flight). */
  reason?: string;
}

/**
 * Fire the LOCAL cut as a DETACHED transient systemd unit (survives a compaction /
 * relaunch of THIS operator — a 35–60 min build cannot be an awaited child). Returns
 * once systemd-run has accepted/refused the unit; the cut's OUTCOME is read later via
 * readCutStatus (the DONE sentinel + log), not by this caller.
 *
 * `spawnFn` is injectable so the tool handler is unit-testable without launching anything.
 */
export function launchDetachedCut(opts: LaunchCutOpts, spawnFn: SpawnLike = spawn): Promise<LaunchCutResult> {
  const root = opts.root ?? desktopRoot();
  const legs = opts.legs ?? {};
  const argv = buildCutArgv(root, opts.version, opts.channel, legs, process.env.PATH ?? '', opts.platform);
  return new Promise<LaunchCutResult>((resolve) => {
    const base: LaunchCutResult = {
      launched: false,
      unit: cutUnitFor(opts.platform),
      version: opts.version,
      channel: opts.channel,
      legs,
      argv,
      logPath: cutLogFor(opts.platform),
      donePath: cutDoneFor(opts.platform),
    };
    let stderr = '';
    const child = spawnFn('systemd-run', argv);
    child.stderr?.on('data', (d: unknown) => (stderr += String(d)));
    child.on('error', (e: unknown) => {
      resolve({ ...base, launched: false, reason: e instanceof Error ? e.message : String(e) });
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({ ...base, launched: true });
      } else {
        resolve({
          ...base,
          launched: false,
          reason: `systemd-run exited ${code} (a cut may already be in flight): ${stderr.trim().slice(0, 200)}`,
        });
      }
    });
  });
}

// ─── Status (poll a detached cut) ──────────────────────────────────────────────

export type CutStateKind = 'idle' | 'running' | 'done' | 'failed';

export interface CutStatus {
  state: CutStateKind;
  running: boolean;
  /** The cut's exit code once the DONE sentinel exists (null while running / idle). */
  exitCode: number | null;
  /** Last lines of the cut log (null if no log yet). */
  logTail: string | null;
  logPath: string;
  donePath: string;
}

export interface ReadCutStatusDeps {
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
  /** Whether the transient unit is currently active (systemctl --user is-active). */
  isUnitActive?: (unit: string) => boolean;
  /** Read ONE platform leg's status (WI-4233) instead of the legacy whole-cut unit. */
  platform?: Platform;
}

/** Default: `systemctl --user is-active <unit>` → true only on exit 0 ("active"). */
export function defaultIsUnitActive(unit: string): boolean {
  try {
    const out = execFileSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).trim();
    return out === 'active' || out === 'activating';
  } catch {
    // Non-zero exit = inactive/failed/unknown unit → not running.
    return false;
  }
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/**
 * Read the current cut status. READ-ONLY. The DONE sentinel is authoritative for
 * completion (the launch `rm -f`s it at start, so a stale sentinel from a prior cut is
 * cleared the moment a new cut begins). Precedence: unit-active ⇒ running; else sentinel
 * ⇒ done/failed by exit code; else ⇒ idle.
 */
export function readCutStatus(deps: ReadCutStatusDeps = {}): CutStatus {
  const exists = deps.existsSync ?? ((p: string) => fs.existsSync(p));
  const read = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const active = deps.isUnitActive ?? defaultIsUnitActive;
  const unit = cutUnitFor(deps.platform);
  const logPath = cutLogFor(deps.platform);
  const donePath = cutDoneFor(deps.platform);

  const running = active(unit);
  let exitCode: number | null = null;
  let doneSeen = false;
  if (exists(donePath)) {
    const m = read(donePath).trim().match(/^DONE:(-?\d+)/);
    if (m) {
      exitCode = Number(m[1]);
      doneSeen = true;
    }
  }
  const logTail = exists(logPath) ? tailLines(read(logPath), 40) : null;

  let state: CutStateKind;
  if (running) state = 'running';
  else if (doneSeen) state = exitCode === 0 ? 'done' : 'failed';
  else state = 'idle';

  return { state, running, exitCode, logTail, logPath, donePath };
}

// ─── Hand-off (collect the LOCAL deliverable) ──────────────────────────────────

export interface HandoffArtifact {
  path: string;
  name: string;
  bytes: number;
  sha256: string;
  /** True iff a sibling `<artifact>.sig` (minisign) exists — the updater signature. */
  signed: boolean;
}

export interface HandoffResult {
  version: string;
  targetRoot: string;
  found: boolean;
  artifacts: HandoffArtifact[];
  /** latest.json manifest path(s). */
  manifests: string[];
  /** build-provenance.json path(s). */
  provenance: string[];
  /** Artifacts missing their `.sig` — a hand-off blocker (updater can't verify). */
  unsignedNames: string[];
}

/** Installer/updater artifact extensions the cut produces across the three platforms. */
const ARTIFACT_EXTS = ['.AppImage', '.deb', '.dmg', '.app.tar.gz', '.exe', '.msi', '.nsis.zip'] as const;

export function isReleaseArtifact(name: string): boolean {
  return ARTIFACT_EXTS.some((e) => name.endsWith(e));
}

// Cargo/target build-intermediate dirs to prune from the walk (target/ is huge; the
// bundles live only under `**/bundle/**`, latest.json + build-provenance.json near them).
const PRUNE_DIRS = new Set(['deps', 'build', '.fingerprint', 'incremental', 'examples', 'node_modules']);

/** Default recursive file list under `dir`, pruning cargo build-intermediate subtrees. */
export function defaultListFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (PRUNE_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

export function defaultSha256(p: string): string {
  // Shell out to sha256sum (matches release-local.sh) — streams large (multi-GB) artifacts
  // without reading them wholesale into memory.
  return execFileSync('sha256sum', [p], { encoding: 'utf8', maxBuffer: 1 << 20 }).trim().split(/\s+/)[0];
}

export interface CollectHandoffDeps {
  exists?: (p: string) => boolean;
  listFiles?: (dir: string) => string[];
  fileSize?: (p: string) => number;
  sha256?: (p: string) => string;
}

/**
 * Collect the LOCAL hand-off set for `version` from the cut output under
 * `src-tauri/target` (RELEASE-RUNBOOK §5): every version-scoped installer/updater
 * artifact + whether its `.sig` is present, plus the latest.json manifests and
 * build-provenance.json files, with each artifact's sha256. Version-scoping mirrors the
 * cut's own P-009 `*_<version>_*` collection. Pure over injectable fs deps (unit-testable
 * against a fake tree). Does NOT touch GitHub — the caller hands these paths to the owner.
 */
export function collectHandoff(
  version: string,
  opts: { root?: string } = {},
  deps: CollectHandoffDeps = {},
): HandoffResult {
  const root = opts.root ?? desktopRoot();
  const targetRoot = path.join(root, 'src-tauri', 'target');
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const list = deps.listFiles ?? defaultListFiles;
  const size = deps.fileSize ?? ((p: string) => fs.statSync(p).size);
  const sha = deps.sha256 ?? defaultSha256;

  const empty: HandoffResult = {
    version,
    targetRoot,
    found: false,
    artifacts: [],
    manifests: [],
    provenance: [],
    unsignedNames: [],
  };
  if (!exists(targetRoot)) return empty;

  const files = list(targetRoot);
  const sigs = new Set(files.filter((f) => f.endsWith('.sig')));
  const artifacts: HandoffArtifact[] = [];
  const manifests: string[] = [];
  const provenance: string[] = [];

  for (const f of files) {
    const name = path.basename(f);
    if (name === 'latest.json') {
      manifests.push(f);
      continue;
    }
    if (name === 'build-provenance.json') {
      provenance.push(f);
      continue;
    }
    // Only actual installers, inside a bundle/ dir, scoped to this version (P-009 parity).
    if (!f.includes(`${path.sep}bundle${path.sep}`)) continue;
    if (!isReleaseArtifact(name)) continue;
    if (!name.includes(version)) continue;
    artifacts.push({ path: f, name, bytes: size(f), sha256: sha(f), signed: sigs.has(`${f}.sig`) });
  }

  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  manifests.sort();
  provenance.sort();
  const unsignedNames = artifacts.filter((a) => !a.signed).map((a) => a.name);

  return {
    version,
    targetRoot,
    found: artifacts.length > 0,
    artifacts,
    manifests,
    provenance,
    unsignedNames,
  };
}

// ─── Preflight (READ-ONLY go/no-go before a cut) ───────────────────────────────

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** true ⇒ ok:false is only a WARNING (cut can still proceed), not a hard blocker. */
  warnOnly?: boolean;
}

export interface PreflightResult {
  go: boolean;
  desktopRoot: string;
  checks: PreflightCheck[];
  /** Hard blockers (ok:false && !warnOnly) — go is false iff this is non-empty. */
  blockers: string[];
}

export interface PreflightDeps {
  exists?: (p: string) => boolean;
  isUnitActive?: (unit: string) => boolean;
  /** HOME for resolving the signing key (default process.env.HOME). */
  home?: string;
}

/**
 * Pure-ish preflight: verify the cut CAN run cleanly before firing the ~35-min build —
 * the signing key, release-local.sh + the three verify scripts (RELEASE-RUNBOOK §2–4)
 * that compose under this cut, and that no cut is already in flight. Requested optional
 * legs (mac/windows) add an informational reminder that their build VM must be up. No
 * heavy work, no GitHub, no mutation.
 */
export function preflightCut(
  legs: CutLegs = {},
  opts: { root?: string; platform?: Platform } = {},
  deps: PreflightDeps = {},
): PreflightResult {
  const root = opts.root ?? desktopRoot();
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const active = deps.isUnitActive ?? defaultIsUnitActive;
  const home = deps.home ?? process.env.HOME ?? '';
  const unit = cutUnitFor(opts.platform);

  const checks: PreflightCheck[] = [];

  const cutter = path.join(root, 'bin', 'release-local.sh');
  checks.push({
    name: 'cutter',
    ok: exists(cutter),
    detail: exists(cutter) ? cutter : `missing ${cutter} — is PAPERCUSP_DESKTOP_ROOT correct?`,
  });

  const keyFile = path.join(home, '.papercusp', 'signing', 'papercusp.key');
  checks.push({
    name: 'signing-key',
    ok: exists(keyFile),
    detail: exists(keyFile)
      ? keyFile
      : `missing ${keyFile} — updater artifacts can't be minisign-signed (bin/setup-signing-key.sh)`,
  });

  for (const script of ['verify-provenance.sh', 'vm-preflight.sh', 'install-and-relaunch-verify.sh']) {
    const p = path.join(root, 'bin', script);
    checks.push({
      name: `verify:${script}`,
      ok: exists(p),
      detail: exists(p) ? p : `missing ${p} — the RELEASE-RUNBOOK verify step can't compose`,
      warnOnly: true, // the cut itself can run; verify is a downstream ship-gate
    });
  }

  const inFlight = active(unit);
  checks.push({
    name: 'no-cut-in-flight',
    ok: !inFlight,
    detail: inFlight
      ? `a cut is already running (unit ${unit}) — poll release:cut{op:status${opts.platform ? `,platform:'${opts.platform}'` : ''}} instead of starting a second`
      : 'no cut in flight',
  });

  if (legs.mac) {
    checks.push({
      name: 'leg:mac',
      ok: true,
      detail: 'WITH_MAC requested — the mac build VM must be up (SSH :2222) or this leg fails ~35 min in',
      warnOnly: true,
    });
  }
  if (legs.windows) {
    checks.push({
      name: 'leg:windows',
      ok: true,
      detail: 'WITH_WINDOWS requested — the Windows build VM must be up (SSH :2223) or this leg fails',
      warnOnly: true,
    });
  }

  const blockers = checks.filter((c) => !c.ok && !c.warnOnly).map((c) => `${c.name}: ${c.detail}`);
  return { go: blockers.length === 0, desktopRoot: root, checks, blockers };
}
