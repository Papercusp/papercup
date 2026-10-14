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
import { mapWithConcurrency } from '../gym/concurrency';
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
  scan?: { inspectedNodes: number; retainedRecentTrees: number; stoppedAtRoot: string | null; incompleteRoots?: string[] };
}
export interface DiskReclaimOptions {
  dryRun?: boolean; home?: string; policy?: readonly RetentionClass[];
  /** Dependency seams also permit an isolated fixture tree; production uses the policy roots. */
  roots?: Array<{ path: string; classId: string }>;
  /** Inspection bounds apply independently to each policy root; an incomplete root cannot starve another. */
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

export type ReclaimSql = Pick<import('postgres').Sql, 'unsafe'>;
/** Read an exact receipt, or the latest real pass, from the existing workspace audit ledger. */
export async function readReclaimReceipt(sql: ReclaimSql, workspaceId: string, id?: string): Promise<DiskReclaimReceipt | null> {
  const rows = await sql.unsafe(
    `SELECT details FROM harness_shared.audit_log
      WHERE workspace_id = $1 AND action = 'disk-retention:receipt'
        AND jsonb_typeof(details) = 'object' AND details->>'schemaVersion' = '1'
        AND details->>'id' = subject
        ${id ? 'AND subject = $2' : "AND details->>'dryRun' = 'false'"}
      ORDER BY ts DESC, id DESC LIMIT 1`,
    id ? [workspaceId, id] : [workspaceId],
  ) as Array<{ details: DiskReclaimReceipt }>;
  return rows[0]?.details ?? null;
}
export function reclaimReceiptHref(id: string): string {
  return `/settings/storage?reclaim=${encodeURIComponent(id)}`;
}
/** Reuse audit_log; no separate receipt table or retention subsystem. */
export async function writeReclaimAudit(sql: ReclaimSql, workspaceId: string, runId: string, phase: string, details: unknown): Promise<void> {
  await sql.unsafe(
    // Bind serialized JSON as text; a jsonb-typed postgres.js parameter would
    // serialize the string again and store a JSON string instead of an object.
    'INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id) VALUES ($1,$2,$3,$4,$5,$6::text::jsonb,$7)',
    [randomUUID(), Date.now(), 'system:disk-retention', `disk-retention:${phase}`, runId, JSON.stringify(details), workspaceId],
  );
}

const RETENTION_HOLDER_SCAN_MS = 30_000;
const incompleteHolders = (): OpenWriterScan => ({ complete: false, byPath: new Map() });

/** The existing async scanner needs host-wide read access before it can prove absence. */
export async function scanRetentionHolders(paths: readonly string[], deps: {
  readStatus?: () => Promise<string>;
  uid?: () => number;
  scan?: typeof openWriterPidsMany;
  privileged?: (paths: readonly string[], control: string) => Promise<OpenWriterScan>;
} = {}): Promise<OpenWriterScan> {
  const status = await (deps.readStatus ?? (() => readFile('/proc/self/status', 'utf8')))().catch(() => '');
  const ids = /^NSpid:\s*(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
  // A nested PID namespace cannot prove a host tree unused.
  if (!ids || ids.length !== 1) return incompleteHolders();
  const control = process.cwd();
  const wanted = [...new Set([...paths, control])];
  const scan = (deps.uid ?? (() => process.getuid?.() ?? -1))() === 0
    ? await (deps.scan ?? openWriterPidsMany)(wanted, {
      descendants: true, includeCwd: true, failClosed: true, deadlineMs: RETENTION_HOLDER_SCAN_MS,
    })
    : await (deps.privileged ?? scanPrivilegedRetentionHolders)(wanted, control).catch(incompleteHolders);
  if (!scan.byPath.get(control)?.includes(String(process.pid))) scan.complete = false;
  return scan;
}

async function scanPrivilegedRetentionHolders(paths: readonly string[], control: string): Promise<OpenWriterScan> {
  const repoRoot = process.env.PAPERCUSP_INTEGRATION_ROOT ?? process.cwd();
  const require = createRequire(join(repoRoot, 'package.json'));
  // Reuse the scanner from canonical source; the elevated child only reads /proc.
  // Both namespaces and the ORIGINAL caller's PID are positive controls.
  const worker = `
    import { readFile } from 'node:fs/promises';
    const paths = JSON.parse(process.argv[1]);
    const status = await readFile('/proc/self/status', 'utf8');
    const ids = /^NSpid:\\s*(.+)$/m.exec(status)?.[1]?.trim().split(/\\s+/);
    if (!ids || ids.length !== 1) process.exit(2);
    const { openWriterPidsMany } = await import(process.argv[2]);
    const result = await openWriterPidsMany(paths, {
      descendants: true, includeCwd: true, failClosed: true, deadlineMs: ${RETENTION_HOLDER_SCAN_MS},
    });
    process.stdout.write(JSON.stringify({ complete: result.complete, byPath: [...result.byPath] }));
  `;
  const result = await nativeRetentionCommand(repoRoot, '/usr/bin/sudo', [
    '-n', process.execPath, '--import', require.resolve('tsx/esm'), '--input-type=module', '-e', worker,
    '--', JSON.stringify(paths), join(repoRoot, 'packages/operator-core/lib/native-bg-task-ledger.ts'),
  ], { stdoutOnly: true, outputLimit: 1024 * 1024, timeoutMs: RETENTION_HOLDER_SCAN_MS + 1_000 });
  if (!result.ok || !result.detail || typeof result.detail !== 'object' ||
      !('output' in result.detail) || typeof result.detail.output !== 'string') return incompleteHolders();
  try {
    const parsed: unknown = JSON.parse(result.detail.output);
    if (!parsed || typeof parsed !== 'object' || !('complete' in parsed) || typeof parsed.complete !== 'boolean' ||
        !('byPath' in parsed) || !Array.isArray(parsed.byPath)) return incompleteHolders();
    const byPath = new Map<string, string[]>();
    for (const row of parsed.byPath) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !paths.includes(row[0]) ||
          !Array.isArray(row[1]) || !row[1].every((pid: unknown) => typeof pid === 'string' && /^\d+$/.test(pid))) return incompleteHolders();
      byPath.set(row[0], row[1]);
    }
    return { complete: parsed.complete && byPath.get(control)?.includes(String(process.pid)) === true, byPath };
  } catch { return incompleteHolders(); }
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
interface RetentionScanBudget {
  left: number; deadline: number;
  progress: NonNullable<DiskReclaimReceipt['scan']>;
}
async function inspectEntry(path: string, root: string, classId: string, budget: RetentionScanBudget, retainAfterMs?: number): Promise<RetentionEntry | null> {
  const first = await lstat(path);
  let newestWriteMs = 0, bytes = 0;
  const stack = [path];
  while (stack.length) {
    if (Date.now() > budget.deadline) throw new Error('incomplete tree scan');
    const current = stack.pop()!;
    const s = current === path ? first : await lstat(current);
    if (s.isSymbolicLink() || s.dev !== first.dev) throw new Error('symlink or filesystem boundary');
    newestWriteMs = Math.max(newestWriteMs, s.mtimeMs, s.ctimeMs);
    // A single recent write proves a max-age tree ineligible. Its remaining
    // descendants cannot change that verdict, so leave them unwalked. Count
    // policies still need the exact newest write across the whole tree.
    if (retainAfterMs !== undefined && newestWriteMs >= retainAfterMs) {
      budget.progress.retainedRecentTrees++;
      return null;
    }
    // Only unresolved stale-tree nodes consume the deep-inspection count.
    // Cheap, conclusive retain checks remain bounded by the shared deadline.
    if (--budget.left < 0) throw new Error('incomplete tree scan');
    budget.progress.inspectedNodes++;
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
      const progress = receipt.scan = { inspectedNodes: 0, retainedRecentTrees: 0, stoppedAtRoot: null as string | null, incompleteRoots: [] as string[] };
      for (const root of roots) {
        const budget = { left: options.maxEntries ?? 100_000, deadline: Date.now() + (options.budgetMs ?? 60_000), progress };
        const budgetExpired = () => budget.left <= 0 || Date.now() >= budget.deadline;
        // Each root gets the same inspection allowance. Holder scans retain
        // their own native deadline; effect waits do not spend that allowance.
        const outsideInspectionBudget = async <T>(operation: () => Promise<T>): Promise<T> => {
          const pausedAt = Date.now();
          try { return await operation(); }
          finally { budget.deadline += Math.max(0, Date.now() - pausedAt); }
        };
        let budgetStopped = false;
        const stopAtBudget = (root: string) => {
          if (!progress.incompleteRoots.length) receipt.errors.push('incomplete tree scan: retention scan budget exhausted');
          progress.stoppedAtRoot ??= root;
          if (!progress.incompleteRoots.includes(root)) progress.incompleteRoots.push(root);
          budgetStopped = true;
        };
        if (budgetExpired()) { stopAtBudget(root.path); continue; }
        let entries: RetentionEntry[] = [];
        const keep = policy.classes.get(root.classId)?.keep;
        const retainAfterMs = keep?.kind === 'max-age' ? started - keep.maxAgeHours * HOUR : undefined;
        try {
          const inspected = await mapWithConcurrency(await readdir(root.path), 16, async (name) => {
            if (budgetStopped) return null;
            if (budgetExpired()) { stopAtBudget(root.path); return null; }
            const path = join(root.path, name);
            if (root.classId === 'papercusp-scratch' && workspaceIds.includes(name)) return null;
            if (protectedPaths.some((protectedPath) => overlap(path, protectedPath))) return null;
            // Refuse nested policy roots before walking (e.g. a scratch PG data dir).
            if (!deletionClassFor(path, policy) || containsClassRoot(path, policy)) return null;
            try {
              return await inspectEntry(path, root.path, root.classId, budget, retainAfterMs);
            }
            catch (err) {
              if (budgetExpired()) { stopAtBudget(root.path); return null; }
              receipt.errors.push(`inspect:${path}: ${message(err)}`);
              return null;
            }
          });
          entries = inspected.filter((entry): entry is RetentionEntry => entry !== null);
        } catch (err) { if (!absent(err)) receipt.errors.push(`list:${root.path}: ${message(err)}`); }
        // An incomplete class census cannot establish oldest-first selection.
        // Leave its entries untouched and retain the independent owner delegates.
        if (budgetStopped) continue;
        const selected = selectRetentionEntries(entries, policy, started);
        if (!selected.length) continue;
        const holders = await outsideInspectionBudget(() => scan(selected.map((e) => e.path)));
        if (!holders.complete) { receipt.errors.push('incomplete process-holder scan'); continue; }
        for (const entry of selected) {
          if (budgetExpired()) { stopAtBudget(root.path); break; }
          const outcome: DiskReclaimReceipt['entries'][number] = { path: entry.path, classId: entry.classId, bytes: entry.bytes, status: 'protected' };
          receipt.entries.push(outcome);
          if (holders.byPath.has(entry.path)) { outcome.reason = 'live process'; continue; }
          try {
            // Write the intent before the last identity/holder checks, so a
            // slow database round trip cannot widen the check-to-effect window.
            if (!receipt.dryRun) await outsideInspectionBudget(async () => options.record?.('remove-intent', entry));
            // Rescan write activity + identity and process holders immediately before the effect.
            const fresh = await inspectEntry(entry.path, entry.root, entry.classId, budget);
            if (!fresh) throw new Error('entry identity unavailable');
            const freshHolders = await outsideInspectionBudget(() => scan([entry.path]));
            if (!freshHolders.complete || freshHolders.byPath.has(entry.path)) { outcome.reason = 'process evidence unavailable or held'; continue; }
            if (fresh.dev !== entry.dev || fresh.ino !== entry.ino || fresh.newestWriteMs !== entry.newestWriteMs) { outcome.status = 'changed'; continue; }
            if (receipt.dryRun) { outcome.status = 'would-remove'; continue; }
            await outsideInspectionBudget(() => rm(entry.path, { recursive: true, force: false }));
            outcome.status = 'removed';
            await outsideInspectionBudget(async () => options.record?.('removed', outcome));
          } catch (err) {
            outcome.status = 'failed'; outcome.reason = message(err);
            if (budgetExpired()) { stopAtBudget(root.path); break; }
            receipt.errors.push(`remove:${entry.path}: ${message(err)}`);
          }
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
export async function nativeRetentionCommand(repoRoot: string, command: string, args: string[], options: {
  stdoutOnly?: boolean; outputLimit?: number; timeoutMs?: number;
} = {}) {
  const { managedSpawn } = await import('../task-manager/managed-spawn');
  let finish!: (result: { ok: boolean; detail: unknown }) => void;
  const observed = new Promise<{ ok: boolean; detail: unknown }>((resolve) => { finish = resolve; });
  let output = '', taskId: string | null = null, settled = false;
  let outputTruncated = false;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const outputLimit = options.outputLimit ?? 4000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = (ok: boolean, detail: unknown) => {
    if (settled) return;
    settled = true; clearTimeout(timer); finish({ ok, detail });
  };
  try {
    await managedSpawn(command, args, {
      class: 'other', title: 'scheduled disk retention delegate', argv: [command, ...args],
      launchedBy: 'system:disk-retention', planSlug: 'disk-headroom-standing-reclaim-2026-10-12',
      runtimeMaxSec: Math.ceil(timeoutMs / 1000), detail: { subsystem: 'storage', operation: 'retention-delegate' },
    }, {
      spawnOptions: { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
      onSpawn: (child, id) => {
        taskId = id;
        timer = setTimeout(() => {
          done(false, { error: 'delegate timeout', taskId, output });
          child.kill('SIGKILL');
        }, timeoutMs);
        timer.unref();
        const append = (chunk: Buffer) => {
          const combined = output + chunk.toString();
          outputTruncated ||= combined.length > outputLimit;
          output = combined.slice(-outputLimit);
        };
        child.stdout?.on('data', append);
        if (!options.stdoutOnly) child.stderr?.on('data', append);
        child.once('error', (error) => done(false, { error: message(error), taskId, output }));
        child.once('close', (code, signal) => done(code === 0 && !(options.stdoutOnly && outputTruncated), { code, signal, taskId, output }));
      },
    });
  } catch (error) { done(false, { error: message(error), taskId, output }); }
  return observed;
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
