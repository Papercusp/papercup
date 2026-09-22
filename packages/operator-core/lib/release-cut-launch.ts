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
 * release-local.sh never mutates a remote tag or creates a GitHub Release — the signed
 * artifacts on disk are the deliverable. Every launch is bound to one exact superproject
 * SHA, which the cutter verifies before any write. `handoff` collects the local paths +
 * sha256 for the owner to upload.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS } from './systemd-scope';

/** Transient systemd unit for the detached cut. Distinct from DEPLOY_UNIT /
 *  the checkpoint unit — a cut, a deploy and a green-checkpoint touch different trees and
 *  may run concurrently, so they must NOT share a mutually-exclusive unit name. */
export const CUT_UNIT = 'papercup-release-cut';
export const CUT_LOG = `/tmp/${CUT_UNIT}.log`;
/** Written "DONE:<exit-code>" by the detached wrapper when release-local.sh finishes —
 *  the authoritative completion signal a cut has no external event (unlike deploy). */
export const CUT_DONE = `/tmp/${CUT_UNIT}.done`;
/** Written when the detached wrapper starts. If the unit later disappears without a
 *  DONE sentinel, this marker distinguishes an interrupted cut from a never-launched one. */
export const CUT_STARTED = `/tmp/${CUT_UNIT}.started`;

export type Channel = 'stable' | 'beta' | 'alpha';
export const CHANNELS: readonly Channel[] = ['stable', 'beta', 'alpha'] as const;
// Semver-ish: X.Y.Z with an optional -prerelease suffix (e.g. 0.0.8, 1.2.3-rc.1).
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const SOURCE_SHA_RE = /^[0-9a-f]{40}$/;

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
export function cutStartedFor(platform?: Platform): string {
  return platform ? `/tmp/${CUT_UNIT}-${platform}.started` : CUT_STARTED;
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
export function isValidSourceSha(sha: string): boolean {
  return SOURCE_SHA_RE.test(sha);
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

/** Runtime-only identity and retry controls for a release cut. The owner identity
 * is deliberately never persisted in the tree: the finished-byte identity audit
 * needs it as a search literal, but writing it into release source would create
 * the exact leak that audit is meant to catch. */
export interface CutRuntimeEnv {
  ownerName: string;
  ownerEmail?: string;
  /** Explicit retry-only fast path: reuse a seed already cut in this isolated root. */
  reuseSeed?: boolean;
  /** The CANONICAL papercusp-desktop checkout, so release-local.sh can write the
   *  version bump back to it (WI-10001570). The cutter derives its own ROOT from
   *  where the script lives, so a cut launched against an isolated worktree bumps
   *  only that throwaway checkout — whose .git is an INDEPENDENT clone, not a
   *  linked worktree. With the publish/push leg deleted under LOCAL-only there is
   *  then no route back at all and the bump dies with the worktree, which is how
   *  0.0.18 shipped while every canonical manifest still read 0.0.17. This is the
   *  one place that knows BOTH roots, so it is where they get connected. */
  canonicalDesktopRoot?: string;
  /** Override for the sparse-seed head-snapshot deadline, in ms.
   *
   *  cut-seed-cli already honours PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS, so a MANUAL
   *  `bin/release-local.sh` run has always had this lever — a plain shell passes the
   *  whole environment down. A cut launched through `release:cut` did not, because the
   *  env below is an explicit allowlist rendered onto a `systemd-run` command: any name
   *  not named here is dropped. That asymmetry left the release path with NO way to widen
   *  the deadline, so the only remedies a scan overrun offered were a FULL seed or
   *  quiescing the operator (a fleet-affecting outage) — neither of which is necessary
   *  (EI-23917342543376581). Carrying it restores parity with the manual path. */
  headSnapshotTimeoutMs?: number;
}

function requiredOwnerName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(
      'release_owner_name_required — pass the human owner name at run time so the finished-byte identity audit can certify the cut',
    );
  }
  return trimmed;
}

/** Shell-safe single-quoted literal. Owner names may contain apostrophes; interpolating
 * them directly into the systemd wrapper would otherwise corrupt the command. */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

/** Pure: the env the detached cut runs release-local.sh with — LOCAL-only ENFORCED
 *  (PAPERCUSP_PUBLISH_GITHUB=0, never publish to GitHub) plus the requested optional
 *  platform legs. Exported for unit testing. */
export function buildCutEnv(
  legs: CutLegs,
  expectedSourceSha: string,
  runtime: CutRuntimeEnv,
  platform?: Platform,
): Record<string, string> {
  const env: Record<string, string> = {
    PAPERCUSP_PUBLISH_GITHUB: '0',
    PAPERCUSP_EXPECTED_SOURCE_SHA: expectedSourceSha,
    PAPERCUSP_RELEASE_OWNER_NAME: requiredOwnerName(runtime.ownerName),
    // A release cut may execute a frozen exact-source dependency-generation
    // script while using current orchestration fixes. Force that older script's
    // already-supported independent-copy path too: otherwise its historical
    // same-filesystem default can hardlink a predecessor generation, and
    // platform packaging then shares mutable inodes across Linux and Darwin.
    DEPENDENCY_GENERATION_FORCE_COPY: '1',
    // D-186: a desktop release never consumes npm-install-safe's immutable
    // dependency generation. Exact-source retries execute the frozen cutter,
    // so the current launcher must carry this invariant across that boundary;
    // relying only on the current release-local.sh would silently restore the
    // multi-GB copy whenever `root` selects an older frozen worktree.
    PAPERCUSP_SKIP_DEP_GENERATION: '1',
    // This is the desktop release cutter. release-local.sh otherwise auto-enables
    // Android whenever a sibling mobile checkout + SDK happen to exist, which makes
    // an explicitly Linux/macOS/Windows cut depend on ambient fourth-product state.
    // Mobile has its own release rail; declare the desktop-only scope explicitly.
    PAPERCUSP_SKIP_MOBILE: '1',
  };
  const ownerEmail = runtime.ownerEmail?.trim();
  if (ownerEmail) env.PAPERCUSP_RELEASE_OWNER_EMAIL = ownerEmail;
  // Absent => release-local.sh skips the writeback rather than guessing a path.
  // It is a no-op when the cut already runs in the canonical checkout, so passing
  // it unconditionally is safe.
  const canonicalDesktopRoot = runtime.canonicalDesktopRoot?.trim();
  if (canonicalDesktopRoot) {
    env.PAPERCUSP_RELEASE_CANONICAL_DESKTOP_ROOT = canonicalDesktopRoot;
  }
  if (runtime.reuseSeed) env.PAPERCUSP_SKIP_SEED_CUT = '1';
  // Only a usable positive integer is forwarded: cut-seed-cli REFUSES a malformed value,
  // and failing the whole cut on a stray override would be worse than ignoring it.
  const headSnapshotTimeoutMs = runtime.headSnapshotTimeoutMs;
  if (Number.isSafeInteger(headSnapshotTimeoutMs) && (headSnapshotTimeoutMs as number) > 0) {
    env.PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS = String(headSnapshotTimeoutMs);
  }
  // A platform leg still runs the shared release-local collector. Non-Linux legs
  // must consume the already-successful Linux bytes through its existing,
  // provenance-checked salvage path; otherwise a Windows/macOS/arm64 retry
  // silently rebuilds Linux before reaching its requested leg.
  if (platform && platform !== 'linux') env.PAPERCUSP_REUSE_LINUX = '1';
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
  expectedSourceSha: string,
  pathEnv: string,
  runtime: CutRuntimeEnv,
  platform?: Platform,
  orchestratorRoot?: string,
): string[] {
  const env = buildCutEnv(legs, expectedSourceSha, runtime, platform);
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${shellSingleQuote(v)}`)
    .join(' ');
  const unit = cutUnitFor(platform);
  const log = cutLogFor(platform);
  const done = cutDoneFor(platform);
  const started = cutStartedFor(platform);
  // A first pass writes these version fields before cutting the seed. A retry
  // validates that exact residue in release:cut, then restores only those files
  // so release-local.sh starts from a clean provenance baseline and reapplies the
  // same idempotent bump while preserving the ignored completed seed.
  const resumeReset = runtime.reuseSeed
    ? 'git restore -- package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json && '
    : '';
  // The selected root owns the exact target bytes and artifact paths, while the
  // current tooling root owns retry orchestration. Invoking the selected root's
  // frozen cutter would make every release repair in the current cutter inert.
  // `bash -c` sets $0 to the frozen target entrypoint; the sourced script sees
  // its current path through BASH_SOURCE[0] and deliberately keeps both roots.
  const targetEntrypoint = path.join(root, 'bin', 'release-local.sh');
  const orchestratorEntrypoint = path.join(orchestratorRoot ?? root, 'bin', 'release-local.sh');
  const cutterInvocation =
    `bash -c 'source "$1" "$2" "$3"' ` +
    `${shellSingleQuote(targetEntrypoint)} ${shellSingleQuote(orchestratorEntrypoint)} ` +
    `${shellSingleQuote(version)} ${shellSingleQuote(channel)}`;
  const inner = `rm -f ${done}; printf 'STARTED:%s\\n' "$(date +%s)" > ${started}; ` + `${resumeReset}${envPrefix} ${cutterInvocation} > ${log} 2>&1; ` + `echo "DONE:$?" > ${done}`;
  return [
    '--user',
    ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
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
  /** Exact 40-char superproject commit this cut is authorized to package. */
  expectedSourceSha: string;
  runtime: CutRuntimeEnv;
  legs?: CutLegs;
  /** papercusp-desktop root (default desktopRoot()). */
  root?: string;
  /** Current papercusp-desktop tooling root. The selected `root` still owns all
   * target bytes and artifact paths; only orchestration is sourced from here. */
  orchestratorRoot?: string;
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
  const orchestratorRoot = opts.orchestratorRoot ?? desktopRoot();
  const legs = opts.legs ?? {};
  const argv = buildCutArgv(
    root,
    opts.version,
    opts.channel,
    legs,
    opts.expectedSourceSha,
    process.env.PATH ?? '',
    opts.runtime,
    opts.platform,
    orchestratorRoot,
  );
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

export type CutStateKind = 'idle' | 'running' | 'done' | 'failed' | 'interrupted';

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
 * cleared the moment a new cut begins). The started marker is written by the detached
 * wrapper before the builder runs, so an inactive unit with that marker but no DONE
 * sentinel is an interrupted cut, not an idle host. Precedence: unit-active ⇒ running;
 * else sentinel ⇒ done/failed by exit code; else started marker ⇒ interrupted; else idle.
 */
export function readCutStatus(deps: ReadCutStatusDeps = {}): CutStatus {
  const exists = deps.existsSync ?? ((p: string) => fs.existsSync(p));
  const read = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const active = deps.isUnitActive ?? defaultIsUnitActive;
  const unit = cutUnitFor(deps.platform);
  const logPath = cutLogFor(deps.platform);
  const donePath = cutDoneFor(deps.platform);
  const startedPath = cutStartedFor(deps.platform);

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
  const startedSeen = exists(startedPath);
  const logTail = exists(logPath) ? tailLines(read(logPath), 40) : null;

  let state: CutStateKind;
  if (running) state = 'running';
  else if (doneSeen) state = exitCode === 0 ? 'done' : 'failed';
  else if (startedSeen) state = 'interrupted';
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
  /** Every root actually scanned: targetRoot + the cargo target_directory when relocated
   *  (the linux leg's bundles land there, not under src-tauri/target — WI-4243). */
  scannedRoots: string[];
  found: boolean;
  artifacts: HandoffArtifact[];
  /** latest.json manifest path(s). */
  manifests: string[];
  /** build-provenance.json path(s). */
  provenance: string[];
  /** UPDATER artifacts (isUpdaterArtifact) missing their `.sig` — a hand-off blocker
   *  (the updater can't verify them). */
  unsignedNames: string[];
  /** NON-updater artifacts (dmg / exe / msi / .bin slices / deb) without a `.sig` —
   *  informational only, NOT a blocker: these aren't updater-feed artifacts, so a missing
   *  minisign sig is expected (WI-4243: the old blanket blocker false-alarmed on dmgs). */
  unsignedInfoNames: string[];
}

/** Installer/updater artifact extensions the cut produces across the three platforms. */
const ARTIFACT_EXTS = ['.AppImage', '.deb', '.dmg', '.app.tar.gz', '.exe', '.msi', '.nsis.zip'] as const;
/** Inno Setup disk-spanning payload slices (`X-setup-1.bin`): the Windows Server installer
 *  exceeds Inno's single-file limit, so its setup.exe reads sibling .bin slices — they are
 *  shippable artifacts the owner MUST upload next to the setup.exe (WI-4243). */
const INNO_SLICE_RE = /-setup-\d+\.bin$/;

export function isReleaseArtifact(name: string): boolean {
  return ARTIFACT_EXTS.some((e) => name.endsWith(e)) || INNO_SLICE_RE.test(name);
}

/** The tauri-UPDATER feed artifact types — the ones whose minisign `.sig` the updater
 *  actually verifies. Everything else (dmg, deb, setup.exe, msi, .bin slices) installs
 *  through OS-native paths, so a missing .sig there is informational, never a blocker. */
const UPDATER_EXTS = ['.app.tar.gz', '.AppImage', '.nsis.zip'] as const;

export function isUpdaterArtifact(name: string): boolean {
  return UPDATER_EXTS.some((e) => name.endsWith(e));
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

/** The cargo `target_directory` for this checkout — mirrors release-local.sh's own
 *  CARGO_TARGET_ROOT derivation (its line ~713) exactly: `cargo metadata` at src-tauri,
 *  null when unresolvable. On a stock checkout this IS src-tauri/target; on a relocated
 *  one (CARGO_TARGET_DIR, e.g. ~/.cargo-target on the dev box) the linux leg's bundles
 *  live ONLY here — the root the old single-root walk missed (WI-4243). */
export function defaultCargoTargetRoot(root: string): string | null {
  try {
    const out = execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
      cwd: path.join(root, 'src-tauri'),
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });
    const td = (JSON.parse(out) as { target_directory?: string }).target_directory;
    return td && td.length > 0 ? td : null;
  } catch {
    return null;
  }
}

export interface CollectHandoffDeps {
  exists?: (p: string) => boolean;
  listFiles?: (dir: string) => string[];
  fileSize?: (p: string) => number;
  sha256?: (p: string) => string;
  /** Read a build-provenance.json (utf8). */
  readFile?: (p: string) => string;
  /** Resolve the cargo target_directory for the desktop root (null ⇒ skip that root). */
  cargoTargetRoot?: (root: string) => string | null;
  /** Canonicalize a path for root de-duplication (src-tauri/target is often a symlink
   *  to the relocated cargo target dir — same tree, two spellings). */
  realpath?: (p: string) => string;
}

/**
 * Collect the LOCAL hand-off set for `version` from the cut output (RELEASE-RUNBOOK §5):
 * every installer/updater artifact + whether its `.sig` is present, plus the latest.json
 * manifests and build-provenance.json files, with each artifact's sha256. Scans BOTH
 * `src-tauri/target` AND the cargo target_directory when relocated (the linux leg).
 * Artifacts are found two ways (WI-4243):
 *   1. walk: version-named installers inside a bundle/ dir (P-009 `*_<version>_*` parity);
 *   2. provenance: every artifact a version-matching build-provenance.json records —
 *      this is what catches the mac updater tarballs (`Papercusp GUI.app.tar.gz` carries
 *      NO version in its filename, so the walk's name filter can never see it).
 * Pure over injectable fs deps (unit-testable against a fake tree). Does NOT touch
 * GitHub — the caller hands these paths to the owner.
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
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const cargoRoot = deps.cargoTargetRoot ?? defaultCargoTargetRoot;
  const real =
    deps.realpath ??
    ((p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    });

  // Roots to scan: src-tauri/target + the cargo target_directory when it's a DIFFERENT
  // tree (realpath-compared — on the dev box src-tauri/target symlinks elsewhere while
  // the linux leg writes to ~/.cargo-target; on a stock checkout they're one tree).
  const scannedRoots: string[] = [];
  const seenReal = new Set<string>();
  for (const r of [targetRoot, cargoRoot(root)]) {
    if (!r || !exists(r)) continue;
    const rp = real(r);
    if (seenReal.has(rp)) continue;
    seenReal.add(rp);
    scannedRoots.push(r);
  }

  const empty: HandoffResult = {
    version,
    targetRoot,
    scannedRoots,
    found: false,
    artifacts: [],
    manifests: [],
    provenance: [],
    unsignedNames: [],
    unsignedInfoNames: [],
  };
  if (scannedRoots.length === 0) return empty;

  const files = scannedRoots.flatMap((r) => list(r));
  const sigs = new Set(files.filter((f) => f.endsWith('.sig')));
  const artifacts: HandoffArtifact[] = [];
  const manifests: string[] = [];
  const provenance: string[] = [];
  const collected = new Set<string>();

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
    if (collected.has(f)) continue;
    collected.add(f);
    artifacts.push({ path: f, name, bytes: size(f), sha256: sha(f), signed: sigs.has(`${f}.sig`) });
  }

  // Pass 2 (WI-4243): trust each version-matching build-provenance.json for artifacts the
  // name filter can't see (the versionless mac `<App>.app.tar.gz` updater tarballs).
  // Provenance `name`s are OUT_DIR-relative subpaths (post-WI-4243 emitter) — resolve
  // against the provenance's own dir; for pre-fix basename-only provenance, fall back to
  // a unique-basename match among the walked files under that root.
  const byBase = new Map<string, string[]>();
  for (const f of files) {
    const b = path.basename(f);
    const arr = byBase.get(b);
    if (arr) arr.push(f);
    else byBase.set(b, [f]);
  }
  for (const provPath of provenance) {
    let prov: { version?: string; artifacts?: { name?: unknown }[] };
    try {
      prov = JSON.parse(readFile(provPath)) as typeof prov;
    } catch {
      continue;
    }
    if (prov?.version !== version || !Array.isArray(prov.artifacts)) continue;
    const provDir = path.dirname(provPath);
    for (const a of prov.artifacts) {
      if (typeof a?.name !== 'string' || a.name.length === 0) continue;
      let f: string | null = path.join(provDir, a.name);
      if (!exists(f)) {
        const candidates = (byBase.get(path.basename(a.name)) ?? []).filter(
          (c) => c.startsWith(`${provDir}${path.sep}`) && !c.endsWith('.sig'),
        );
        f = candidates.length === 1 ? candidates[0]! : null;
      }
      if (!f || collected.has(f)) continue;
      collected.add(f);
      artifacts.push({
        path: f,
        name: a.name,
        bytes: size(f),
        sha256: sha(f),
        signed: sigs.has(`${f}.sig`) || exists(`${f}.sig`),
      });
    }
  }

  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  manifests.sort();
  provenance.sort();
  const unsigned = artifacts.filter((a) => !a.signed);
  const unsignedNames = unsigned.filter((a) => isUpdaterArtifact(a.name)).map((a) => a.name);
  const unsignedInfoNames = unsigned.filter((a) => !isUpdaterArtifact(a.name)).map((a) => a.name);

  return {
    version,
    targetRoot,
    scannedRoots,
    found: artifacts.length > 0,
    artifacts,
    manifests,
    provenance,
    unsignedNames,
    unsignedInfoNames,
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

/**
 * The subtree holding release MACHINERY — the scripts that PERFORM a cut.
 *
 * A cut tree mixes two things that are governed differently. WHAT is being shipped
 * (product source) is deliberately pinned to an exact sha by an isolated cut root —
 * resolveCutRoot refuses auto-managed checkouts precisely so the tree cannot move
 * mid-build — so drift there is CORRECT and must never be reported as a fault. The
 * machinery performing the ship is the opposite: a bug in it corrupts the release
 * process no matter which version is being shipped, so a frozen root silently
 * re-executes whatever release bugs its pin carried.
 *
 * Only the second kind is a hazard, which is why this check is scoped to a subtree
 * rather than to the tree as a whole.
 */
export const RELEASE_TOOLING_SUBTREE = 'bin';

/** Runs git in `repo`. `ok` reflects the EXIT STATUS, which is the answer itself for
 * predicates like `merge-base --is-ancestor` that communicate through exit code and
 * write nothing to stdout. */
export type GitRunner = (repo: string, args: string[]) => { ok: boolean; stdout: string };

export interface ReleaseToolingDrift {
  /** `behind` ⇒ subject is an ancestor of reference, so a differing file is genuinely
   * superseded. `diverged` ⇒ the pins are unrelated or the subject is ahead, which a
   * deliberate pin can legitimately produce. `unknown` ⇒ NOT MEASURED — never clean. */
  state: 'current' | 'behind' | 'diverged' | 'unknown';
  staleFiles: string[];
  subjectPin?: string;
  referencePin?: string;
  detail?: string;
}

function defaultGitRunner(repo: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1 << 20,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/**
 * Compare the release machinery in an isolated cut root against the INTEGRATION
 * BRANCH's pin of the same submodule.
 *
 * The reference is deliberately NOT a checkout path. It used to be `desktopRoot()`,
 * which resolves from `cwd` — and release:cut runs inside the :3070 operator, whose
 * cwd is the release checkout at green main. That is routinely the very sha a stale
 * cut root is pinned to, so the comparison read stale-vs-stale as 'current' and the
 * check was vacuous in exactly the case it exists for (WI-10002449, caught by a live
 * probe against the real paused root after every unit test was green). A cut root is a
 * linked worktree sharing the canonical .git, so the branch ref is readable from the
 * root itself and needs no path guess.
 *
 * The stale-file list is DERIVED from git rather than compared against a hand-kept
 * roster of "release-critical scripts" — such a roster rots silently, and a file
 * missing from it reads exactly like a file that did not change.
 */
export function releaseToolingDrift(args: {
  subjectDesktopRoot: string;
  /** Default PAPERCUSP_INTEGRATION_BRANCH, else the same default release-config uses. */
  integrationBranch?: string;
  git?: GitRunner;
}): ReleaseToolingDrift {
  const { subjectDesktopRoot } = args;
  const git = args.git ?? defaultGitRunner;
  const branch = args.integrationBranch ?? process.env.PAPERCUSP_INTEGRATION_BRANCH ?? 'staging';
  const superproject = path.dirname(subjectDesktopRoot);
  const submodule = path.basename(subjectDesktopRoot);

  const subject = git(subjectDesktopRoot, ['rev-parse', 'HEAD']);
  const subjectPin = subject.ok ? subject.stdout.trim() : '';
  if (!subjectPin) {
    return { state: 'unknown', staleFiles: [], detail: `could not resolve HEAD in ${subjectDesktopRoot}` };
  }
  const reference = git(superproject, ['rev-parse', `${branch}:${submodule}`]);
  const referencePin = reference.ok ? reference.stdout.trim() : '';
  if (!referencePin) {
    return {
      state: 'unknown',
      staleFiles: [],
      subjectPin,
      detail: `could not resolve the ${branch} branch's pin of ${submodule} from ${superproject}`,
    };
  }
  if (subjectPin === referencePin) {
    return { state: 'current', staleFiles: [], subjectPin, referencePin };
  }

  // A cut root's submodule is typically a STANDALONE clone that has never fetched the
  // newer pin, while the shared superproject store (<common-dir>/modules/<submodule>)
  // holds both. Every later question needs BOTH commits readable in ONE store: an
  // unreadable object makes `diff` answer with an empty file list, byte-identical to
  // "nothing drifted" — the reading that would wave a stale root straight through.
  const common = git(superproject, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const candidates = [
    ...(common.ok && common.stdout.trim() ? [path.join(common.stdout.trim(), 'modules', submodule)] : []),
    subjectDesktopRoot,
  ];
  const store = candidates.find((repo) =>
    [subjectPin, referencePin].every((pin) => git(repo, ['cat-file', '-e', `${pin}^{commit}`]).ok),
  );
  if (!store) {
    return {
      state: 'unknown',
      staleFiles: [],
      subjectPin,
      referencePin,
      detail: `no object store holds both ${subjectPin.slice(0, 12)} and ${referencePin.slice(0, 12)} (tried ${candidates.join(', ')})`,
    };
  }

  const diff = git(store, [
    'diff',
    '--name-only',
    subjectPin,
    referencePin,
    '--',
    RELEASE_TOOLING_SUBTREE,
  ]);
  if (!diff.ok) {
    return { state: 'unknown', staleFiles: [], subjectPin, referencePin, detail: 'git diff failed' };
  }
  const staleFiles = diff.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();

  const behind = git(store, ['merge-base', '--is-ancestor', subjectPin, referencePin]).ok;
  return { state: behind ? 'behind' : 'diverged', staleFiles, subjectPin, referencePin };
}

export interface PreflightDeps {
  exists?: (p: string) => boolean;
  isUnitActive?: (unit: string) => boolean;
  /** HOME for resolving the signing key (default process.env.HOME). */
  home?: string;
  /** Override the release-tooling staleness probe (tests inject; default compares the
   * cut root against its integration branch's pin of the same submodule). */
  releaseToolingDrift?: (subjectDesktopRoot: string) => ReleaseToolingDrift;
}

/**
 * Pure-ish preflight: verify the cut CAN run cleanly before firing the ~35-min build —
 * the signing key, the runtime dependency used by release-local.sh's pre-build
 * migration lint, release-local.sh + the three verify scripts (RELEASE-RUNBOOK §2–4)
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

  // release-local.sh invokes scripts/lint-migrations.mjs before it installs or
  // repairs dependencies. A source-only checkout therefore passes the old
  // existence checks, launches the detached cut, and fails immediately when
  // Node resolves @papercusp/operator-core. Refuse that predictable failure
  // before spending a cut unit. The entrypoint is the exact package export
  // imported by the migration lint, so this also catches a partially materialized
  // node_modules tree rather than only checking that the directory exists.
  const migrationLintEntrypoint = path.join(
    root,
    '..',
    'node_modules',
    '@papercusp',
    'operator-core',
    'lib',
    'util',
    'cli-entry.ts',
  );
  const migrationLintReady = exists(migrationLintEntrypoint);
  checks.push({
    name: 'migration-lint-dependencies',
    ok: migrationLintReady,
    detail: migrationLintReady
      ? migrationLintEntrypoint
      : 'missing ' + migrationLintEntrypoint +
        ' — release-local.sh runs migration lint before dependency preparation; materialize node_modules for the release checkout',
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

  // Every check above asks whether a file EXISTS. None asks what it CONTAINS, so a
  // root frozen weeks ago with superseded release scripts satisfied all of them and
  // returned go:true (WI-10002449). An isolated cut root is frozen on purpose, so the
  // fix cannot be "refuse anything behind canonical" — it has to separate the product
  // source being pinned from the machinery doing the pinning.
  // Only ask git about a tree that IS a checkout. A linked worktree carries `.git` as a
  // file rather than a directory, so existsSync covers both shapes. Without this the
  // probe would shell out against any path at all and report the resulting failure as
  // drift state 'unknown' — true, but paid for with two spawned processes per preflight.
  const defaultDrift = (subjectDesktopRoot: string): ReleaseToolingDrift =>
    exists(path.join(subjectDesktopRoot, '.git'))
      ? releaseToolingDrift({ subjectDesktopRoot })
      : {
          state: 'unknown',
          staleFiles: [],
          detail: `${path.join(subjectDesktopRoot, '.git')} not found — cut root is not a git checkout, so its release machinery cannot be dated`,
        };
  const drift = (deps.releaseToolingDrift ?? defaultDrift)(root);
  const shortPin = (pin: string | undefined) => (pin ? pin.slice(0, 12) : '?');
  const namedFiles = drift.staleFiles.slice(0, 6).join(', ') + (drift.staleFiles.length > 6 ? ', …' : '');
  let toolingOk = true;
  let toolingWarnOnly: boolean | undefined;
  let toolingDetail: string;
  switch (drift.state) {
    case 'current':
      toolingDetail = drift.detail ?? `release machinery matches the canonical checkout (${shortPin(drift.subjectPin)})`;
      break;
    case 'behind':
      if (drift.staleFiles.length > 0) {
        toolingOk = false;
        toolingDetail =
          `cut root's release machinery is STALE — ${drift.staleFiles.length} file(s) under papercusp-desktop/${RELEASE_TOOLING_SUBTREE} ` +
          `are superseded (root ${shortPin(drift.subjectPin)} is an ancestor of canonical ${shortPin(drift.referencePin)}): ${namedFiles}. ` +
          'This cut would re-execute those superseded scripts and rebuild any release bug they carried. ' +
          're-pin the cut root with setup-release-checkout.sh against a commit carrying the fixes, then re-run preflight';
      } else {
        toolingDetail = `root is behind canonical but no file under papercusp-desktop/${RELEASE_TOOLING_SUBTREE} differs — product-source drift only, which an isolated pin is supposed to have`;
      }
      break;
    case 'diverged':
      if (drift.staleFiles.length > 0) {
        toolingOk = false;
        toolingWarnOnly = true;
        toolingDetail =
          `cut root's release machinery DIVERGES from canonical (${drift.staleFiles.length} file(s): ${namedFiles}), but root ` +
          `${shortPin(drift.subjectPin)} is not an ancestor of canonical ${shortPin(drift.referencePin)} — confirm this pin is deliberate`;
      } else {
        toolingDetail = 'root diverges from canonical but its release machinery is identical';
      }
      break;
    case 'unknown':
    default:
      toolingOk = false;
      toolingWarnOnly = true;
      toolingDetail = `could NOT verify release-machinery freshness (${drift.detail ?? 'no detail'}) — treat as UNMEASURED, not as clean`;
      break;
  }
  checks.push({
    name: 'release-tooling-current',
    ok: toolingOk,
    detail: toolingDetail,
    ...(toolingWarnOnly ? { warnOnly: true } : {}),
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

// ─── Abort a leg (WI-4233) ──────────────────────────────────────────────────────

export interface AbortLegResult {
  stopped: boolean;
  unit: string;
  reason?: string;
}

export interface AbortLegDeps {
  /** `systemctl --user stop <unit>` by default; throws on failure. Injectable for tests. */
  stopUnit?: (unit: string) => void;
}

/** Stop ONE platform leg's detached unit (best-effort — a leg that already finished or
 *  was never started simply reports stopped:false with the systemctl error, not a throw).
 *  Its log/done files are left in place for post-mortem; the next op:run-leg for the same
 *  platform clears the done sentinel itself (buildCutArgv's `rm -f`). */
export function abortLeg(platform: Platform, deps: AbortLegDeps = {}): AbortLegResult {
  const unit = cutUnitFor(platform);
  const stop =
    deps.stopUnit ??
    ((u: string) => {
      execFileSync('systemctl', ['--user', 'stop', u], { stdio: 'ignore' });
    });
  try {
    stop(unit);
    return { stopped: true, unit };
  } catch (err) {
    return { stopped: false, unit, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ─── BUILD_SHA gate (WI-4233) — one honest sha, readable by every leg ──────────
//
// release-local.sh derives BUILD_SHA ONCE, centrally, per P-003/EI-8914 — the single
// source of truth threaded into every leg of a WHOLE cut. A fleet-split cut breaks that:
// 3 agents on 3 machines each firing their own `release-local.sh` invocation (or, before
// op:run-leg existed, raw bash around it) can each land on a DIFFERENT short sha if the
// shared tree moves between invocations (git-sync commits on a schedule) — precisely the
// confusion the 0.0.8 drive hit (BUILD_SHA history: c1d5520 → 7302dd9-dirty → b0124…,
// tracked ad hoc over coord messages because there was no shared, readable gate). The
// functions below give every leg ONE place to read (or, for the first caller, establish)
// the sha this release is cutting against, instead of re-deriving it independently and
// hoping the tree didn't move.

export interface BuildShaInfo {
  sha: string;
  dirty: boolean;
}

export interface DeriveBuildShaDeps {
  gitShortHead?: (root: string) => string;
  gitDirty?: (root: string) => boolean;
}

/** Mirrors release-local.sh's own BUILD_SHA derivation exactly (short head sha of `root`,
 *  marked dirty if EITHER `root` or its parent — the monorepo superproject, since the
 *  sidecar is built from apps/operator — has uncommitted changes; over-reporting dirty is
 *  the safe direction, same comment as release-local.sh). Lets op:gate-status report the
 *  same honest value release-local.sh would derive, without having to run it. */
export function deriveBuildSha(root: string = desktopRoot(), deps: DeriveBuildShaDeps = {}): BuildShaInfo {
  const head =
    deps.gitShortHead ??
    ((r: string) => {
      try {
        return execFileSync('git', ['-C', r, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      } catch {
        return '';
      }
    });
  const dirty =
    deps.gitDirty ??
    ((r: string) => {
      try {
        return execFileSync('git', ['-C', r, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
      } catch {
        return false;
      }
    });
  const sha = head(root);
  const isDirty = dirty(root) || dirty(path.join(root, '..'));
  return { sha, dirty: isDirty };
}

/** Shared gate file path for (version, channel) — one per release attempt. `/tmp` is
 *  shared only within a single box; a genuinely cross-MACHINE fleet-split (a VM leg) still
 *  needs the sha relayed in (mirrors how release-local.sh already passes BUILD_SHA into
 *  the VM legs, since their rsynced trees have no .git to self-derive from) — this gate is
 *  the LOCAL-box coordination point for legs/agents sharing this host. */
export function gatePath(version: string, channel: Channel): string {
  return `/tmp/papercup-release-gate-${version}-${channel}.json`;
}

export interface ReleaseGate {
  version: string;
  channel: Channel;
  buildSha: string;
  dirty: boolean;
  derivedAt: string;
  derivedBy: string;
}

export interface GateStatusDeps {
  /** Desktop root whose BUILD_SHA should establish a new gate. */
  root?: string;
  exists?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
  /** Exclusive create (like `fs.writeFileSync(p, data, { flag: 'wx' })`) — MUST throw if
   *  `p` already exists, so a race between two first-callers still converges on one
   *  writer. */
  writeFileSyncExclusive?: (p: string, data: string) => void;
  derive?: (root?: string) => BuildShaInfo;
}

/**
 * Read the shared release gate for (version, channel), establishing it (deriving +
 * writing) if this is the first caller. Every subsequent call — from any leg, any agent,
 * on this box — reads back the SAME buildSha instead of each independently re-deriving one
 * that may have drifted if the tree moved (git-sync) between calls. `created:true` tells
 * the caller they were the one who established it (so a leg script can log "I set the
 * gate" vs "I'm matching an existing gate").
 */
export function readOrCreateGate(
  version: string,
  channel: Channel,
  actor: string,
  deps: GateStatusDeps = {},
): { gate: ReleaseGate; created: boolean } {
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const read = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const derive = deps.derive ?? ((root?: string) => deriveBuildSha(root));
  const p = gatePath(version, channel);

  if (exists(p)) {
    return { gate: JSON.parse(read(p)) as ReleaseGate, created: false };
  }

  const { sha, dirty } = derive(deps.root);
  const gate: ReleaseGate = { version, channel, buildSha: sha, dirty, derivedAt: new Date().toISOString(), derivedBy: actor };
  const write = deps.writeFileSyncExclusive ?? ((path_: string, data: string) => fs.writeFileSync(path_, data, { flag: 'wx' }));
  try {
    write(p, JSON.stringify(gate, null, 2));
    return { gate, created: true };
  } catch {
    // Lost the create race to a peer's near-simultaneous first call — their write is
    // authoritative; read it back rather than returning our own (potentially different)
    // derivation.
    return { gate: JSON.parse(read(p)) as ReleaseGate, created: false };
  }
}
