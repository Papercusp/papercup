/**
 * Rig-state preflight for the P-505 physical drill
 * (physical-drill-iteration-speed-2026-09-29 P-003, plan R-5).
 *
 * Every check here is a P-505 guard-rail fact turned into an executable
 * refusal. Each one names a rig fault that has already cost a full 18-26 min
 * physical run, and each is a read-only question that answers in seconds. The
 * probe runs `physical-drill-producer rig-preflight` before its first rig ssh,
 * so a known-bad rig is refused with the check's name instead of discovered
 * mid-phase.
 *
 * Nothing here mutates the rig. A check that cannot be evaluated FAILS (the
 * reason says so): an unmeasured guard rail is not a passed one.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { listCommsTrust, type CommsTrustEntry } from '../../trust/comms-trust';
import { PHASE_D_TIER_HOLD_NOTE_PREFIX, PHASE_D_TIER_HOLD_TIER, PHASE_D_WORKSPACE } from './physical-drill-phase-d';
import { readPhysicalPhaseEMode } from './physical-drill-phase-e';

export const PHYSICAL_DRILL_PREFLIGHT_SCHEMA = 'hive-git-physical-rig-preflight/v1' as const;

/** Stable check ids. They appear in refusals, facts' recheck commands and `--check`. */
export const PHYSICAL_DRILL_PREFLIGHT_CHECKS = [
  'drill-source-committed',
  'canary-mode-baseline',
  'vm-trust-hold-ready',
  'vm-payload-current',
  'hosts-answering',
] as const;
export type PhysicalDrillPreflightCheckId = (typeof PHYSICAL_DRILL_PREFLIGHT_CHECKS)[number];

/** Greppable refusal marker the probe and the scenario logs key on. */
export const PHYSICAL_DRILL_PREFLIGHT_FAILED = 'PHYSICAL_PREFLIGHT_FAILED' as const;

/** The pot-git module family the VM stages from HEAD via `git archive`. */
export const DRILL_SOURCE_DIR = 'packages/operator-core/lib/sync/pot-git' as const;
/** The Phase D module whose HEAD must carry the live-file-lock fix (WI-10003741). */
export const DRILL_PHASE_D_SOURCE = `${DRILL_SOURCE_DIR}/physical-drill-phase-d.ts` as const;
/** Lock owner prefix `dirtyPhysicalPhaseDWorktree` takes; absent in HEAD = the VM runs the pre-fix Phase D. */
export const DRILL_PHASE_D_LOCK_OWNER_MARKER = 'p505-phase-d:' as const;

/** The canary's recorded original mode (bridged since 2026-07-17; fact guard-rail:p505-phase-e-baseline-and-exit-trap). */
export const DRILL_CANARY_BASELINE_MODE = 'bridged' as const;

/** The VM ssh target comes from the probe (`PCUSP_VM_SSH`); this module hardcodes no host or home path. */
export const DRILL_VM_SSH_ENV = 'PCUSP_VM_SSH' as const;
/** Expanded by the VM's own shell: compose-rig-sidecar-current.sh pushes to ~/rig-sidecar-current there. */
export const DRILL_VM_PAYLOAD_DIR_DEFAULT = '"$HOME/rig-sidecar-current"' as const;
export const DRILL_OWNER_PORT = 3070 as const;
const HARNESS_SU_REL = 'harness/blueprints/base/prompts/su.md';

export type PhysicalDrillPreflightResult = {
  check: PhysicalDrillPreflightCheckId;
  ok: boolean;
  /** Why it failed, or what it confirmed. */
  reason: string;
};

export type PhysicalDrillPreflightReport = {
  schemaVersion: typeof PHYSICAL_DRILL_PREFLIGHT_SCHEMA;
  ok: boolean;
  checks: PhysicalDrillPreflightCheckId[];
  results: PhysicalDrillPreflightResult[];
  firstFailure: PhysicalDrillPreflightResult | null;
  elapsedMs: number;
  observedAt: string;
};

/** Parsed output of the single read-only VM ssh round-trip. */
export type VmPayloadProbe = {
  /** `serveSha256` / `harnessSuSha256` from the VM payload's BUILD-STAMP.txt ('' when absent). */
  stampServeSha256: string;
  stampHarnessSuSha256: string;
  /** Actual hashes of the VM payload's serve.mjs and harness su.md ('' when unreadable). */
  serveSha256: string;
  harnessSuSha256: string;
  /** HTTP status of the VM owner's /api/health ('000' when it did not answer). */
  ownerHealthStatus: string;
};

export type TowerComposedStamp = { serveSha256: string; harnessSuSha256: string; composedAt: string };

export type PhysicalDrillPreflightDeps = {
  listTrust?: () => Promise<CommsTrustEntry[]>;
  readCanaryMode?: () => Promise<{ mode: string; source: string }>;
  /** Porcelain status lines for uncommitted/untracked paths under `dir` (repo-relative). */
  gitStatus?: (dir: string) => Promise<string[]>;
  /** The HEAD blob of a repo-relative path, or null when HEAD has no such path. */
  readHeadFile?: (path: string) => Promise<string | null>;
  probeVm?: () => Promise<VmPayloadProbe>;
  readTowerStamp?: () => Promise<TowerComposedStamp | null>;
  towerHealthStatus?: () => Promise<number>;
  nowMs?: () => number;
};

export type PhysicalDrillPreflightOptions = {
  checks?: readonly PhysicalDrillPreflightCheckId[];
  /** The VM device's GitHub user. Unknown ⇒ every trust row is held to the VM rule (conservative). */
  vmGithubUserId?: number | null;
  expectedCanaryMode?: string;
};

// ── pure evaluations (one per check; null = satisfied) ──────────────────────

/** Uncommitted drill source means the VM (which stages HEAD) runs different code from the tower. */
export function drillSourceViolation(statusLines: readonly string[], headPhaseD: string | null): string | null {
  const dirty = statusLines
    .map((line) => line.slice(3).trim())
    .map((path) => (path.includes(' -> ') ? path.split(' -> ')[1]! : path))
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'));
  if (dirty.length > 0) {
    return (
      `uncommitted drill source (the VM stages HEAD via git archive, so it would run different code): ` +
      `${dirty.join(', ')} — wait for git-sync or fire git-sync:run, then re-run`
    );
  }
  if (headPhaseD === null) return `HEAD has no ${DRILL_PHASE_D_SOURCE}`;
  if (!headPhaseD.includes(DRILL_PHASE_D_LOCK_OWNER_MARKER)) {
    return (
      `HEAD ${DRILL_PHASE_D_SOURCE} lacks the Phase D dirt lock (owner '${DRILL_PHASE_D_LOCK_OWNER_MARKER}<runId>', ` +
      `WI-10003741); a VM git-sync would sweep the planted file`
    );
  }
  return null;
}

/** A crashed run leaves the canary in legacy; the next run would record legacy as the "original" and never restore bridged. */
export function canaryModeViolation(read: { mode: string; source: string }, expected: string): string | null {
  if (read.mode === expected) return null;
  return (
    `canary hello-world-3-pot mode is '${read.mode}' (source ${read.source}), expected baseline '${expected}' — ` +
    `a prior Phase E did not restore it; set it back with phase-e-mode-ensure ${expected} <run-id>`
  );
}

/**
 * Phase D can only hold the VM author below steer when (a) no earlier hold is
 * still in place — a leftover would be snapshotted as the "prior" row and the
 * restore would lose steer for good — and (b) the VM user's row is not
 * gate-only, which `holdPhysicalPhaseDBelowSteer` refuses mid-phase because it
 * cannot restore a NULL tier exactly.
 */
export function trustHoldViolation(
  entries: readonly CommsTrustEntry[],
  vmGithubUserId: number | null,
  nowMs: number,
): string | null {
  const leftover = entries.filter(
    (entry) => entry.tier === PHASE_D_TIER_HOLD_TIER && (entry.note ?? '').startsWith(PHASE_D_TIER_HOLD_NOTE_PREFIX),
  );
  if (leftover.length > 0) {
    const described = leftover.map((entry) => {
      const run = (entry.note ?? '').slice(PHASE_D_TIER_HOLD_NOTE_PREFIX.length).trim().split(';')[0] || 'unknown run';
      const expiry =
        entry.expiresAtMs == null
          ? 'no expiry'
          : entry.expiresAtMs > nowMs
            ? `expires ${new Date(entry.expiresAtMs).toISOString()}`
            : `lapsed ${new Date(entry.expiresAtMs).toISOString()}`;
      return `github user ${entry.githubUserId} held at '${entry.tier}' by ${run} (${expiry})`;
    });
    return (
      `a Phase D below-steer hold was never restored: ${described.join('; ')} — run phase-d-tier-restore on that ` +
      `run's phase-d-tier-hold.json, or put the prior comms-trust row back, before another hold snapshots it as "prior"`
    );
  }
  const gateOnly = entries.filter(
    (entry) => entry.tier === null && (vmGithubUserId === null || entry.githubUserId === vmGithubUserId),
  );
  if (gateOnly.length > 0) {
    return (
      `gate-only comms-trust row for github user ${gateOnly.map((entry) => entry.githubUserId).join(', ')}` +
      `${vmGithubUserId === null ? ' (VM user unknown, so every row is checked)' : ''}: Phase D cannot hold ` +
      `a NULL tier and restore it exactly — give the row an explicit tier first`
    );
  }
  return null;
}

/** The VM must run the payload the tower last composed, and that payload must be internally consistent. */
export function vmPayloadViolation(vm: VmPayloadProbe, tower: TowerComposedStamp | null): string | null {
  if (!vm.stampServeSha256 || !vm.stampHarnessSuSha256) {
    return 'VM payload BUILD-STAMP.txt is missing or lacks serveSha256/harnessSuSha256 — recompose with compose-rig-sidecar-current.sh';
  }
  if (vm.serveSha256 !== vm.stampServeSha256) {
    return `VM serve.mjs (${vm.serveSha256 || 'unreadable'}) differs from its BUILD-STAMP (${vm.stampServeSha256})`;
  }
  if (vm.harnessSuSha256 !== vm.stampHarnessSuSha256) {
    return (
      `VM harness su.md (${vm.harnessSuSha256 || 'unreadable'}) differs from its BUILD-STAMP ` +
      `(${vm.stampHarnessSuSha256}) — current code against a stale harness (WI-10003486)`
    );
  }
  if (!tower) {
    return 'no tower-composed BUILD-STAMP to compare against — run compose-rig-sidecar-current.sh so the expected build is known';
  }
  if (vm.stampServeSha256 !== tower.serveSha256 || vm.stampHarnessSuSha256 !== tower.harnessSuSha256) {
    return (
      `VM payload is not the build the tower last composed (${tower.composedAt || 'unknown time'}): ` +
      `serve ${vm.stampServeSha256.slice(0, 12)} vs ${tower.serveSha256.slice(0, 12)}, ` +
      `harness ${vm.stampHarnessSuSha256.slice(0, 12)} vs ${tower.harnessSuSha256.slice(0, 12)} — push the composed payload`
    );
  }
  return null;
}

export function hostsViolation(towerStatus: number, vmOwnerStatus: string): string | null {
  const down: string[] = [];
  if (towerStatus !== 200) down.push(`tower :${DRILL_OWNER_PORT}/api/health answered ${towerStatus || 'nothing'}`);
  if (vmOwnerStatus !== '200') down.push(`VM owner :${DRILL_OWNER_PORT}/api/health answered ${vmOwnerStatus || 'nothing'}`);
  return down.length > 0 ? `${down.join('; ')} — start the owner before a run` : null;
}

// ── default gatherers (read-only) ───────────────────────────────────────────

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.env.PAPERCUSP_REPO_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

async function defaultGitStatus(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', REPO_ROOT, 'status', '--porcelain=v1', '--untracked-files=all', '--', dir],
    { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.split('\n').filter((line) => line.length > 3);
}

async function defaultReadHeadFile(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', REPO_ROOT, 'show', `HEAD:${path}`], {
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** One ssh, read-only: the VM payload's stamp, its actual hashes, and the owner's health status. */
export function vmPayloadProbeCommand(payloadDir?: string): string {
  const d = payloadDir ? `'${payloadDir.replace(/'/g, `'\\''`)}'` : DRILL_VM_PAYLOAD_DIR_DEFAULT;
  return [
    `grep -E '^(serveSha256|harnessSuSha256)=' ${d}/BUILD-STAMP.txt 2>/dev/null | sed 's/^/stamp./'`,
    `printf 'serve=%s\\n' "$(shasum -a 256 ${d}/serve.mjs 2>/dev/null | awk '{print $1}')"`,
    `printf 'harness=%s\\n' "$(shasum -a 256 ${d}/${HARNESS_SU_REL} 2>/dev/null | awk '{print $1}')"`,
    `printf 'health=%s\\n' "$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:${DRILL_OWNER_PORT}/api/health)"`,
  ].join('; ');
}

export function parseVmPayloadProbe(stdout: string): VmPayloadProbe {
  const fields = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return {
    stampServeSha256: fields.get('stamp.serveSha256') ?? '',
    stampHarnessSuSha256: fields.get('stamp.harnessSuSha256') ?? '',
    serveSha256: fields.get('serve') ?? '',
    harnessSuSha256: fields.get('harness') ?? '',
    ownerHealthStatus: fields.get('health') || '000',
  };
}

async function defaultProbeVm(): Promise<VmPayloadProbe> {
  const vm = process.env[DRILL_VM_SSH_ENV];
  if (!vm) throw new Error(`${DRILL_VM_SSH_ENV} is unset; the probe passes the VM ssh target`);
  const payloadDir = process.env.PCUSP_RIG_SIDECAR_DIR || undefined;
  const { stdout } = await execFileAsync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no', vm, vmPayloadProbeCommand(payloadDir)],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return parseVmPayloadProbe(stdout);
}

export function parseBuildStamp(text: string): TowerComposedStamp {
  const value = (key: string) => text.match(new RegExp(`^${key}=(\\S+)`, 'm'))?.[1] ?? '';
  return {
    serveSha256: value('serveSha256'),
    harnessSuSha256: value('harnessSuSha256'),
    composedAt: text.match(/composedAt=(\S+)/)?.[1] ?? '',
  };
}

async function defaultReadTowerStamp(): Promise<TowerComposedStamp | null> {
  const out =
    process.env.PCUSP_RIG_COMPOSE_OUT ||
    join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'papercusp', 'rig-sidecar-current');
  try {
    return parseBuildStamp(await readFile(join(out, 'BUILD-STAMP.txt'), 'utf8'));
  } catch {
    return null;
  }
}

async function defaultTowerHealthStatus(): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${DRILL_OWNER_PORT}/api/health`, { signal: AbortSignal.timeout(5_000) });
    return response.status;
  } catch {
    return 0;
  }
}

// ── runner ──────────────────────────────────────────────────────────────────

export async function runPhysicalDrillPreflight(
  options: PhysicalDrillPreflightOptions = {},
  deps: PhysicalDrillPreflightDeps = {},
): Promise<PhysicalDrillPreflightReport> {
  const started = Date.now();
  const now = deps.nowMs ?? Date.now;
  const checks = options.checks && options.checks.length > 0 ? [...options.checks] : [...PHYSICAL_DRILL_PREFLIGHT_CHECKS];
  const vmGithubUserId = options.vmGithubUserId ?? null;
  const expectedMode = options.expectedCanaryMode ?? DRILL_CANARY_BASELINE_MODE;
  // vm-payload-current and hosts-answering share ONE ssh round-trip.
  let vmProbe: Promise<VmPayloadProbe> | null = null;
  const probeVm = () => (vmProbe ??= (deps.probeVm ?? defaultProbeVm)());

  const evaluate: Record<PhysicalDrillPreflightCheckId, () => Promise<string | null>> = {
    'drill-source-committed': async () =>
      drillSourceViolation(
        await (deps.gitStatus ?? defaultGitStatus)(DRILL_SOURCE_DIR),
        await (deps.readHeadFile ?? defaultReadHeadFile)(DRILL_PHASE_D_SOURCE),
      ),
    'canary-mode-baseline': async () =>
      canaryModeViolation(await (deps.readCanaryMode ?? (() => readPhysicalPhaseEMode()))(), expectedMode),
    'vm-trust-hold-ready': async () =>
      trustHoldViolation(await (deps.listTrust ?? (() => listCommsTrust(PHASE_D_WORKSPACE)))(), vmGithubUserId, now()),
    'vm-payload-current': async () =>
      vmPayloadViolation(await probeVm(), await (deps.readTowerStamp ?? defaultReadTowerStamp)()),
    'hosts-answering': async () => {
      const [tower, vm] = await Promise.all([
        (deps.towerHealthStatus ?? defaultTowerHealthStatus)(),
        probeVm().then((probe) => probe.ownerHealthStatus),
      ]);
      return hostsViolation(tower, vm);
    },
  };

  const results = await Promise.all(
    checks.map(async (check): Promise<PhysicalDrillPreflightResult> => {
      try {
        const violation = await evaluate[check]();
        return { check, ok: violation === null, reason: violation ?? 'ok' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { check, ok: false, reason: `could not be evaluated (an unmeasured guard rail is not a pass): ${message}` };
      }
    }),
  );
  const firstFailure = results.find((result) => !result.ok) ?? null;
  return {
    schemaVersion: PHYSICAL_DRILL_PREFLIGHT_SCHEMA,
    ok: firstFailure === null,
    checks,
    results,
    firstFailure,
    elapsedMs: Date.now() - started,
    observedAt: new Date(now()).toISOString(),
  };
}

export const PHYSICAL_DRILL_PREFLIGHT_USAGE =
  `usage: physical-drill-producer rig-preflight [--check <${PHYSICAL_DRILL_PREFLIGHT_CHECKS.join('|')}>]... ` +
  '[--vm-github-user-id <n>]';

export function parsePhysicalDrillPreflightArgs(args: readonly string[]): PhysicalDrillPreflightOptions {
  const checks: PhysicalDrillPreflightCheckId[] = [];
  let vmGithubUserId: number | null = null;
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (flag === '--check' && (PHYSICAL_DRILL_PREFLIGHT_CHECKS as readonly string[]).includes(value ?? '')) {
      checks.push(value as PhysicalDrillPreflightCheckId);
    } else if (flag === '--vm-github-user-id' && /^[1-9][0-9]{0,11}$/.test(value ?? '')) {
      vmGithubUserId = Number(value);
    } else {
      throw new Error(PHYSICAL_DRILL_PREFLIGHT_USAGE);
    }
  }
  return { checks, vmGithubUserId };
}

/**
 * The producer's `rig-preflight` mode: the report on success; on refusal an
 * error whose FIRST line is `PHYSICAL_PREFLIGHT_FAILED <check>: <reason>` (the
 * CLI prints it to stderr and exits 1), followed by any further failures.
 */
export async function physicalDrillPreflightMode(
  args: readonly string[],
  deps: PhysicalDrillPreflightDeps = {},
): Promise<PhysicalDrillPreflightReport> {
  const report = await runPhysicalDrillPreflight(parsePhysicalDrillPreflightArgs(args), deps);
  if (!report.ok) {
    throw new Error(
      report.results
        .filter((result) => !result.ok)
        .map((result) => `${PHYSICAL_DRILL_PREFLIGHT_FAILED} ${result.check}: ${result.reason}`)
        .join('\n'),
    );
  }
  return report;
}
