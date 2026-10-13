/** Scheduled policy retention (disk-headroom P-004, D-002/D-005).
 * Reuses the policy selector, native process-holder scan and filesystem mutex.
 * The caller returns this receipt from a DBOS step: operation_outputs is the
 * existing Postgres receipt ledger. Free space is an alarm threshold, never a
 * reason to retain expired artifacts. Existing class owners remain delegates.
 */
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
import { openWriterPidsMany, type OpenWriterScan } from '../native-bg-task-ledger';
import { readRegistry } from '../workspace-registry';
import { sampleDiskSnapshots, type DiskSnapshot } from './disk-space-alarm';
import {
  RETENTION_POLICY, compilePolicy, containsClassRoot, deletionClassFor,
  type CompiledPolicy, type RetentionClass,
} from './retention-policy';

export const DISK_RECLAIM_STEP = 'disk-retention-reclaim';
export const DISK_RECLAIM_CRONTAB = '0 12 * * * *';
export const DISK_HEADROOM_BYTES = 100 * 1024 ** 3;
const HOUR = 3_600_000;

export interface RetentionEntry {
  path: string; root: string; classId: string;
  newestWriteMs: number; bytes: number; dev: number; ino: number;
}
export interface ReclaimDelegate {
  classId: string;
  run: (dryRun: boolean) => Promise<{ ok: boolean; detail: unknown }>;
}
export interface DiskReclaimReceipt {
  schemaVersion: 1; id: string; startedAt: string; finishedAt: string; dryRun: boolean;
  complete: boolean;
  /** Unknown for partial runs; a successful run drained every unprotected selected entry. */
  policyExhausted: boolean | null;
  devices: Array<{ path: string; beforeFreeBytes: number | null; afterFreeBytes: number | null; atTarget: boolean | null }>;
  entries: Array<{ path: string; classId: string; status: 'removed' | 'would-remove' | 'protected' | 'changed' | 'failed'; bytes: number; reason?: string }>;
  delegates: Array<{ classId: string; ok: boolean; detail: unknown }>;
  errors: string[];
}
export interface DiskReclaimOptions {
  dryRun?: boolean; home?: string; policy?: readonly RetentionClass[];
  /** Dependency seams also permit an isolated fixture tree; production uses the policy roots. */
  roots?: Array<{ path: string; classId: string }>;
  nowMs?: number; maxEntries?: number; budgetMs?: number;
  sample?: () => Promise<DiskSnapshot[]>;
  scanHolders?: (paths: readonly string[]) => Promise<OpenWriterScan>;
  registeredWorkspaces?: () => string[];
  delegates?: readonly ReclaimDelegate[];
  /** Additional leases are resolved by the runtime before this planner runs. */
  protectedPaths?: readonly string[];
  expectedDevices?: readonly string[];
  /** Production writes to audit_log before an effect and after the completed pass. */
  record?: (phase: string, details: unknown) => Promise<void>;
}

export type ReclaimSql = { unsafe: (query: string, params: unknown[]) => Promise<unknown> };
/** Reuse audit_log; no separate receipt table or retention subsystem. */
export async function writeReclaimAudit(sql: ReclaimSql, workspaceId: string, runId: string, phase: string, details: unknown): Promise<void> {
  await sql.unsafe(
    // Bind serialized JSON as text; a jsonb-typed postgres.js parameter would
    // serialize the string again and store a JSON string instead of an object.
    'INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id) VALUES ($1,$2,$3,$4,$5,$6::text::jsonb,$7)',
    [randomUUID(), Date.now(), 'system:disk-retention', `disk-retention:${phase}`, runId, JSON.stringify(details), workspaceId],
  );
}

async function scanRetentionHolders(paths: readonly string[]): Promise<OpenWriterScan> {
  const status = await readFile('/proc/self/status', 'utf8').catch(() => '');
  const ids = /^NSpid:\s*(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
  // A nested PID namespace cannot prove a host tree unused.
  if (!ids || ids.length !== 1) return { complete: false, byPath: new Map() };
  const control = process.cwd();
  const scan = await openWriterPidsMany([...new Set([...paths, control])], {
    descendants: true, includeCwd: true, failClosed: true, deadlineMs: Date.now() + 30_000,
  });
  if (!scan.byPath.get(control)?.includes(String(process.pid))) scan.complete = false;
  return scan;
}

/** Select by each root's keep rule. Oldest first; do not depend on available bytes (D-005). */
export function selectRetentionEntries(entries: readonly RetentionEntry[], policy: CompiledPolicy, nowMs: number): RetentionEntry[] {
  const groups = new Map<string, RetentionEntry[]>();
  for (const entry of entries) {
    const cls = deletionClassFor(entry.path, policy);
    if (!cls || cls.id !== entry.classId || containsClassRoot(entry.path, policy)) continue;
    const key = `${entry.classId}\0${entry.root}`;
    const group = groups.get(key) ?? [];
    group.push(entry); groups.set(key, group);
  }
  const selected: RetentionEntry[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => b.newestWriteMs - a.newestWriteMs || a.path.localeCompare(b.path));
    const rule = policy.classes.get(group[0]!.classId)!.keep;
    for (let index = 0; index < group.length; index++) {
      const entry = group[index]!;
      const age = nowMs - entry.newestWriteMs;
      if (rule.kind === 'max-age' && age > rule.maxAgeHours * HOUR) selected.push(entry);
      if (rule.kind === 'newest' && (index >= rule.keep || (rule.maxAgeHours !== undefined && age > rule.maxAgeHours * HOUR))) selected.push(entry);
      // Lease classes run through their owning program, never through a generic age delete.
    }
  }
  return selected.sort((a, b) => a.newestWriteMs - b.newestWriteMs || a.path.localeCompare(b.path));
}

function overlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
function message(err: unknown): string { return err instanceof Error ? err.message : String(err); }
function absent(err: unknown): boolean { return (err as NodeJS.ErrnoException)?.code === 'ENOENT'; }

/** Expand policy patterns using the policy's own compiled segment matchers. No symlink traversal. */
async function policyRoots(policy: CompiledPolicy, home: string, errors: string[]): Promise<Array<{ path: string; classId: string }>> {
  const roots: Array<{ path: string; classId: string }> = [];
  for (const cls of policy.classes.values()) {
    if (!cls.enforcers.some((e) => e.kind === 'standing-reclaim' && !e.via)) continue;
    if (cls.keep.kind !== 'max-age' && cls.keep.kind !== 'newest') continue;
    for (const root of policy.roots.filter((r) => r.classId === cls.id)) {
      const literal = root.pattern.replace(/^~(?=\/)/, home).split('/').filter(Boolean);
      let parents = ['/'];
      for (let i = 0; i < literal.length; i++) {
        const next: string[] = [];
        for (const parent of parents) {
          try {
            const names = literal[i]!.includes('*') || literal[i]!.startsWith('re:') ? await readdir(parent) : [literal[i]!];
            for (const name of names) {
              if (!root.segments[i]!.test(name)) continue;
              const path = join(parent, name);
              const s = await lstat(path);
              if (s.isDirectory() && !s.isSymbolicLink()) next.push(path);
            }
          } catch (err) { if (!absent(err)) errors.push(`root:${parent}: ${message(err)}`); }
        }
        parents = next;
      }
      roots.push(...parents.map((path) => ({ path, classId: cls.id })));
    }
  }
  return roots;
}

/** A tree is stale only if EVERY descendant is stale. Capped or unreadable scans refuse deletion. */
async function inspectEntry(path: string, root: string, classId: string, budget: { left: number; deadline: number }): Promise<RetentionEntry> {
  const first = await lstat(path);
  let newestWriteMs = 0, bytes = 0;
  const stack = [path];
  while (stack.length) {
    if (--budget.left < 0 || Date.now() > budget.deadline) throw new Error('incomplete tree scan');
    const current = stack.pop()!;
    const s = await lstat(current);
    if (s.isSymbolicLink() || s.dev !== first.dev) throw new Error('symlink or filesystem boundary');
    newestWriteMs = Math.max(newestWriteMs, s.mtimeMs, s.ctimeMs);
    bytes += s.blocks * 512;
    if (s.isDirectory()) stack.push(...(await readdir(current)).map((name) => join(current, name)));
  }
  return { path, root, classId, newestWriteMs, bytes, dev: first.dev, ino: first.ino };
}

export async function runDiskReclaimOnce(options: DiskReclaimOptions = {}): Promise<DiskReclaimReceipt> {
  const started = options.nowMs ?? Date.now();
  const receipt: DiskReclaimReceipt = {
    schemaVersion: 1, id: randomUUID(), startedAt: new Date(started).toISOString(), finishedAt: '',
    dryRun: options.dryRun ?? false, complete: false, policyExhausted: null, devices: [], entries: [], delegates: [], errors: [],
  };
  const home = options.home ?? homedir();
  const policy = compilePolicy(options.policy ?? RETENTION_POLICY, home);
  const sample = options.sample ?? (() => sampleDiskSnapshots(['/', '/mnt/data']));
  const scan = options.scanHolders ?? scanRetentionHolders;
  const snapshots = async (): Promise<DiskSnapshot[]> => {
    try { return await sample(); } catch (err) { receipt.errors.push(`device sample: ${message(err)}`); return []; }
  };
  const before = await snapshots();
  try {
    await options.record?.('started', receipt);
    await withFsMutex('papercusp-disk-retention', async () => {
      const roots = options.roots ?? await policyRoots(policy, home, receipt.errors);
      // A registered workspace's tool run dirs belong exclusively to scratch-gc.
      const workspaceIds = (options.registeredWorkspaces ?? (() => readRegistry().workspaces.map((x) => x.id)))();
      const protectedPaths = (options.protectedPaths ?? []).map((path) => resolve(path));
      const budget = { left: options.maxEntries ?? 100_000, deadline: Date.now() + (options.budgetMs ?? 60_000) };
      for (const root of roots) {
        const entries: RetentionEntry[] = [];
        try {
          for (const name of await readdir(root.path)) {
            const path = join(root.path, name);
            if (root.classId === 'papercusp-scratch' && workspaceIds.includes(name)) continue;
            if (protectedPaths.some((protectedPath) => overlap(path, protectedPath))) continue;
            // Refuse nested policy roots before walking (e.g. a scratch PG data dir).
            if (!deletionClassFor(path, policy) || containsClassRoot(path, policy)) continue;
            try { entries.push(await inspectEntry(path, root.path, root.classId, budget)); }
            catch (err) { receipt.errors.push(`inspect:${path}: ${message(err)}`); }
          }
        } catch (err) { if (!absent(err)) receipt.errors.push(`list:${root.path}: ${message(err)}`); }
        const selected = selectRetentionEntries(entries, policy, started);
        if (!selected.length) continue;
        const holders = await scan(selected.map((e) => e.path));
        if (!holders.complete) { receipt.errors.push('incomplete process-holder scan'); continue; }
        for (const entry of selected) {
          const outcome: DiskReclaimReceipt['entries'][number] = { path: entry.path, classId: entry.classId, bytes: entry.bytes, status: 'protected' };
          receipt.entries.push(outcome);
          if (holders.byPath.has(entry.path)) { outcome.reason = 'live process'; continue; }
          try {
            // Rescan write activity + identity and process holders immediately before the effect.
            const fresh = await inspectEntry(entry.path, entry.root, entry.classId, budget);
            const freshHolders = await scan([entry.path]);
            if (!freshHolders.complete || freshHolders.byPath.has(entry.path)) { outcome.reason = 'process evidence unavailable or held'; continue; }
            if (fresh.dev !== entry.dev || fresh.ino !== entry.ino || fresh.newestWriteMs !== entry.newestWriteMs) { outcome.status = 'changed'; continue; }
            if (receipt.dryRun) { outcome.status = 'would-remove'; continue; }
            // A restart between this intent and the completion is inspectable.
            // If the audit cannot be written, the effect is refused.
            await options.record?.('remove-intent', entry);
            await rm(entry.path, { recursive: true, force: false });
            outcome.status = 'removed';
            await options.record?.('removed', outcome);
          } catch (err) { outcome.status = 'failed'; outcome.reason = message(err); receipt.errors.push(`remove:${entry.path}: ${message(err)}`); }
        }
      }
      for (const delegate of options.delegates ?? []) {
        try { receipt.delegates.push({ classId: delegate.classId, ...await delegate.run(receipt.dryRun) }); }
        catch (err) { receipt.delegates.push({ classId: delegate.classId, ok: false, detail: message(err) }); }
      }
      for (const cls of policy.classes.values()) {
        if (cls.enforcers.some((e) => e.kind === 'standing-reclaim' && (e.via || cls.keep.kind === 'lease')) &&
            !receipt.delegates.some((e) => e.classId === cls.id)) receipt.errors.push(`missing delegate:${cls.id}`);
      }
    }, { timeoutMs: 1_000 });
  } catch (err) { receipt.errors.push(message(err)); }
  const after = await snapshots();
  const paths = new Set(options.expectedDevices ?? ['/', '/mnt/data']);
  receipt.devices = [...paths].map((path) => {
    const matches = (s: DiskSnapshot) => s.path === path || s.aliases?.includes(path);
    const b = before.find(matches), a = after.find(matches);
    if (!b || !a) receipt.errors.push(`device sample missing:${path}`);
    return { path, beforeFreeBytes: b?.freeBytes ?? null, afterFreeBytes: a?.freeBytes ?? null, atTarget: a ? a.freeBytes >= DISK_HEADROOM_BYTES : null };
  });
  receipt.complete = receipt.errors.length === 0 && receipt.delegates.every((d) => d.ok);
  receipt.policyExhausted = receipt.complete && !receipt.dryRun ? true : null;
  receipt.finishedAt = new Date().toISOString();
  try { await options.record?.('receipt', receipt); }
  catch (err) { receipt.complete = false; receipt.policyExhausted = null; receipt.errors.push(`receipt write:${message(err)}`); }
  return receipt;
}

/** Bounded, enrolled execution of an existing native cleaner. */
async function nativeRetentionCommand(repoRoot: string, command: string, args: string[]) {
  const { managedSpawn } = await import('../task-manager/managed-spawn');
  const launched = await managedSpawn(command, args, {
    class: 'other', title: 'scheduled disk retention delegate', argv: [command, ...args],
    launchedBy: 'system:disk-retention', planSlug: 'disk-headroom-standing-reclaim-2026-10-12',
    runtimeMaxSec: 120, detail: { subsystem: 'storage', operation: 'retention-delegate' },
  }, { spawnOptions: { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] } });
  return new Promise<{ ok: boolean; detail: unknown }>((finish) => {
    let output = '';
    let settled = false;
    const done = (ok: boolean, detail: unknown) => { if (!settled) { settled = true; clearTimeout(timer); finish({ ok, detail }); } };
    const timer = setTimeout(() => { launched.child.kill('SIGKILL'); done(false, { error: 'delegate timeout', taskId: launched.taskId, output }); }, 120_000);
    timer.unref();
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); };
    launched.child.stdout?.on('data', append); launched.child.stderr?.on('data', append);
    launched.child.once('error', (error) => done(false, { error: message(error), taskId: launched.taskId, output }));
    launched.child.once('close', (code) => done(code === 0, { code, taskId: launched.taskId, output }));
  });
}

/** Runtime delegates preserve the owning program's leases and its original receipts. */
export async function runScheduledDiskReclaim(options: Pick<DiskReclaimOptions, 'dryRun'> = {}): Promise<DiskReclaimReceipt> {
  const repoRoot = process.env.PAPERCUSP_INTEGRATION_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const { getOrgPg } = await import('@papercusp/db-org');
  const { activeWorkspaceId } = await import('../workspace-registry');
  const { readRetentionLeases, isLeaseLive, defaultRetentionDir } = await import('../release-cut-reclaim');
  const leaseRead = readRetentionLeases(defaultRetentionDir());
  // Unknown/malformed leases are a hard refusal, rather than disappearing from protection.
  if (leaseRead.errors.length) throw new Error(`retention leases unreadable: ${leaseRead.errors.join('; ')}`);
  const protectedPaths = leaseRead.leases.filter((lease) => isLeaseLive(lease, Date.now())).flatMap((lease) => lease.paths);
  const require = createRequire(import.meta.url);
  const delegates: ReclaimDelegate[] = [
    { classId: 'sidecar-failed-stages', run: async (dryRun) => {
      const owner = require(join(repoRoot, 'papercusp-desktop/bin/lib/sidecar-stage-state.js')) as {
        pruneFailedStages: (options: { all: boolean; dryRun: boolean }) => { errors: unknown[] };
      };
      const detail = owner.pruneFailedStages({ all: true, dryRun });
      return { ok: detail.errors.length === 0, detail };
    } },
    { classId: 'cargo-target-slots', run: (dryRun) => nativeRetentionCommand(repoRoot, '/bin/bash', [
      join(repoRoot, 'papercusp-desktop/bin/reap-private-target-slots.sh'), ...(dryRun ? ['--dry-run'] : []),
    ]) },
    { classId: 'release-cut-worktrees', run: async (dryRun) => {
      const { gatherCutReclaimPlan, executeCutReclaim } = await import('../release-cut-reclaim');
      const { isAutoManagedCutWorktree, RELEASE_RESUME_VERSION_PATHS } = await import('../agent-tools/release/cut');
      const plan = await gatherCutReclaimPlan({
        repoPath: repoRoot, isAutoManaged: isAutoManagedCutWorktree, releaseVersionPaths: RELEASE_RESUME_VERSION_PATHS,
        loadReleases: async () => {
          const { sql } = getOrgPg();
          const rows = await sql<Array<{ version: string; git_sha: string | null; cut_at: Date; published_at: Date | null }>>`
            SELECT version, git_sha, cut_at, published_at FROM harness_shared.releases WHERE workspace_id = ${activeWorkspaceId()}`;
          return rows.map((row) => ({ version: row.version, gitSha: row.git_sha, cutAtMs: new Date(row.cut_at).getTime(), publishedAtMs: row.published_at ? new Date(row.published_at).getTime() : null }));
        },
      });
      const targets = plan.verdicts.filter((v) => v.disposition === 'reclaimable').map((v) => v.path);
      if (dryRun || targets.length === 0) return { ok: plan.failClosed.length === 0, detail: { dryRun, targets, failClosed: plan.failClosed } };
      const detail = await executeCutReclaim(plan, targets);
      return { ok: detail.ok && detail.results.every((r) => r.removed), detail };
    } },
    { classId: 'unregistered-workspaces', run: async () => {
      // Whole-workspace deletion cannot be inferred from absence in the registry:
      // the more-specific policy still protects databases and product stores.
      // The registered workspace collector retains those roots and delegates their
      // explicit disposable children above, rather than deleting protected data.
      const { workspacesRoot } = await import('../workspace-registry');
      const registered = new Set(readRegistry().workspaces.map((w) => w.id));
      const unregistered: string[] = [];
      for (const name of await readdir(workspacesRoot())) {
        if (name.startsWith('.') || registered.has(name)) continue;
        const path = join(workspacesRoot(), name);
        if ((await lstat(path)).isDirectory()) unregistered.push(path);
      }
      return { ok: true, detail: { retainedProtectedRoots: unregistered, reason: 'Workspace database/product descendants remain protected by the written policy; only separately classified disposable children are collected.' } };
    } },
  ];
  let runId = '';
  return runDiskReclaimOnce({ ...options, delegates, protectedPaths, record: async (phase, detail) => {
    if (phase === 'started') runId = (detail as DiskReclaimReceipt).id;
    await writeReclaimAudit(getOrgPg().sql as unknown as ReclaimSql, activeWorkspaceId(), runId, phase, detail);
  } });
}
