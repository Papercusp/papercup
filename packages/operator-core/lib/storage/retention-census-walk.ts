/** A continuous full-root retention census, using the existing managed walk
 * transport. Caller deadlines abandon the wait, never the native measurement.
 * Partial output is not selection evidence. Each completed result is consumed
 * before effects and can never be reused as an after-reclaim measurement. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
import { inspectRetentionTrees, type RetentionTreeCensus } from './disk-consumer-census';
import { DetachedWalkAbandoned, readWalkState, runDetachedWalk, walkAttemptFiles,
  walkProcessAlive, type DetachedWalkOptions } from './disk-census-detached-walk';

export const RETENTION_CENSUS_LIFETIME_MS = 15 * 60_000;
const identity = z.object({ dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative() });
const entry = identity.extend({ path: z.string(), newestWriteMs: z.number().finite(), bytes: z.number().int().nonnegative(),
  hardlinks: z.array(identity.extend({ bytes: z.number().int().nonnegative(), paths: z.array(z.string()) })).optional(),
  buildDirs: z.array(identity.extend({ path: z.string() })).optional() });
const census = z.object({ entries: z.array(entry), retained: z.array(z.object({ path: z.string(), reason: z.string(), entry: entry.optional() })),
  inspectedNodes: z.number().int().nonnegative(), retainedRecentTrees: z.number().int().nonnegative(),
  error: z.string().optional(), timing: z.object({ elapsedMs: z.number(), lastProgressAfterMs: z.number().nullable(),
    lastChildPath: z.string().nullable(), timeoutMs: z.number().nullable(), progressTimeoutMs: z.number().nullable(),
    timeoutKind: z.enum(['absolute', 'progress', 'native-signal']).nullable() }).optional() });
export const retentionCensusRequest = z.object({ version: z.literal(1), root: z.string(), rootIdentity: identity,
  rootGeneration: z.object({ mtimeMs: z.number(), ctimeMs: z.number() }),
  excludedPaths: z.array(z.string()), collectBuildDirs: z.boolean(), progressTimeoutMs: z.number().positive(),
  requirePrivilege: z.boolean() });
type Request = z.infer<typeof retentionCensusRequest>;
const envelope = z.object({ version: z.literal(1), requestKey: z.string(), startedAt: z.number(), finishedAt: z.number(), result: census });
const keyFor = (request: Request) => createHash('sha256').update(JSON.stringify(request)).digest('hex');
const sameIdentity = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;
const incomplete = (error: string): RetentionTreeCensus => ({ entries: [], retained: [], inspectedNodes: 0, retainedRecentTrees: 0, error });

/** The maintained worker runs this function once; no cross-run child cache is
 * used (direct-child timestamps cannot detect writes to nested files). */
export async function runRetentionCensusWorker(input: unknown) {
  const request = retentionCensusRequest.parse(input);
  if (resolve(request.root) !== request.root) throw new Error('noncanonical retention census root');
  const before = await fs.lstat(request.root);
  if (!before.isDirectory() || before.isSymbolicLink() || !sameIdentity(before, request.rootIdentity) ||
      before.mtimeMs !== request.rootGeneration.mtimeMs || before.ctimeMs !== request.rootGeneration.ctimeMs) throw new Error('retention census root changed');
  const startedAt = Date.now();
  const result = await inspectRetentionTrees(request.root, { retainAfterMs: Infinity, includeRecent: true,
    excludedPaths: request.excludedPaths, collectBuildDirs: request.collectBuildDirs,
    progressTimeoutMs: request.progressTimeoutMs, timeoutMs: RETENTION_CENSUS_LIFETIME_MS,
    requirePrivilege: request.requirePrivilege });
  const after = await fs.lstat(request.root);
  if (!sameIdentity(after, before) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    return { version: 1, requestKey: keyFor(request), startedAt, finishedAt: Date.now(), result: incomplete('retention census root changed during walk') };
  }
  return { version: 1, requestKey: keyFor(request), startedAt, finishedAt: Date.now(), result };
}

export type RetentionCensusWalkOptions = Omit<DetachedWalkOptions, 'command' | 'signal' | 'timeoutMs'> & {
  /** Production supplies the configured checkout root; bundling changes the
   * module location but must never change which maintained worker is run. */
  workerPath?: string;
  /** Caller wait, separate from the fixed native lifetime. */
  waitMs: number;
};

export async function inspectDetachedRetentionTrees(root: string,
  options: Parameters<typeof inspectRetentionTrees>[1], walk: RetentionCensusWalkOptions): Promise<RetentionTreeCensus> {
  // Only the initial complete capped-root census uses this route. Fresh effect
  // inspections, expiry compaction and exact-pin predicates remain inline.
  if (!options.includeRecent || options.paths || options.coversPinnedPath || options.spawn) throw new Error('unsupported detached retention census input');
  root = resolve(root);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return incomplete('retention root is not a plain directory');
  const request: Request = { version: 1, root, rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
    rootGeneration: { mtimeMs: rootStat.mtimeMs, ctimeMs: rootStat.ctimeMs },
    excludedPaths: [...new Set(options.excludedPaths ?? [])].sort(), collectBuildDirs: options.collectBuildDirs ?? false,
    progressTimeoutMs: options.progressTimeoutMs ?? 60_000, requirePrivilege: options.requirePrivilege ?? false };
  const requestKey = keyFor(request);
  const remaining = () => deadline - Date.now();
  const deadline = Date.now() + Math.max(1, Math.min(walk.waitMs, options.timeoutMs ?? walk.waitMs));
  return withFsMutex(`retention-census:${resolve(walk.dir)}`, async () => {
    const state = await readWalkState(walk.dir);
    // The wrapper may die before it writes exit.<attempt>. A consumed or
    // obsolete measurement can be retired once its process identity is dead;
    // requiring the missing exit file would wedge this slot permanently.
    const terminal = !!state && !(walk.isAlive ?? walkProcessAlive)(state);
    const consumed = join(walk.dir, 'consumed');
    const used = await fs.access(consumed).then(() => true, () => false);
    if (state && (used || state.requestKey !== requestKey)) {
      if (!terminal) return incomplete('retention census previous measurement still active');
      await fs.rm(walk.dir, { recursive: true, force: true });
    } else if (!state && await fs.readdir(walk.dir).then(names => names.length > 0, () => false)) {
      return incomplete('retention census slot has unreadable state');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, remaining()));
    try {
      const worker = walk.workerPath ?? fileURLToPath(new URL('../../../../scripts/retention-census-worker.mjs', import.meta.url));
      return await runDetachedWalk(root, { ...walk, timeoutMs: RETENTION_CENSUS_LIFETIME_MS, maxAttempts: 1,
        attribution: { launchedBy: 'system:disk-retention-reclaim', workItemId: 'EI-26925507003255681', title: `retention metadata ${root}` },
        pollMs: Math.min(walk.pollMs ?? 250, 250), signal: controller.signal,
        command: () => [process.execPath, ['--import', 'tsx', worker, JSON.stringify(request)]] }, [], async (finished, code, overdue, failure) => {
        // Consume before parsing/returning. A crash, error or removal can never
        // make this terminal before-reclaim result eligible on a later pass.
        await fs.writeFile(consumed, 'consumed\n');
        if (code !== 0 || overdue || failure) {
          const files = walkAttemptFiles(walk.dir, finished.attempt);
          const err = await fs.open(files.err, 'r').catch(() => null);
          let diagnostic = '';
          if (err) try {
            const size = (await err.stat()).size;
            const buffer = Buffer.alloc(Math.min(size, 4096));
            const { bytesRead } = await err.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
            diagnostic = buffer.subarray(0, bytesRead).toString('utf8').trim();
          } finally { await err.close(); }
          return incomplete(`${failure ?? `retention census worker exited ${code}`}${diagnostic ? `: ${diagnostic}` : ''}`);
        }
        const parsed = envelope.safeParse(JSON.parse(await fs.readFile(walkAttemptFiles(walk.dir, finished.attempt).out, 'utf8')));
        if (!parsed.success) return incomplete('invalid retention census worker result');
        const value = parsed.data;
        const current = await fs.lstat(root);
        if (value.requestKey !== requestKey || value.startedAt < finished.launchedAt || value.finishedAt < value.startedAt ||
            value.finishedAt > Date.now() || Date.now() - value.finishedAt > RETENTION_CENSUS_LIFETIME_MS ||
            !sameIdentity(current, rootStat) || current.mtimeMs !== rootStat.mtimeMs || current.ctimeMs !== rootStat.ctimeMs) {
          return incomplete('stale or changed retention census result');
        }
        const paths = [...value.result.entries.map(e => e.path), ...value.result.retained.map(e => e.path)];
        if (paths.some(path => dirname(path) !== root || resolve(path) !== path) || new Set(paths).size !== paths.length) {
          return incomplete('retention census result has invalid direct children');
        }
        return value.result.error ? { ...value.result, entries: [], retained: [] } : value.result;
      }, requestKey);
    } catch (error) {
      return incomplete(error instanceof DetachedWalkAbandoned ? 'retention census pending; managed walk continues for adoption' : `retention census: ${String(error)}`);
    } finally { clearTimeout(timer); }
  }, { timeoutMs: Math.max(1, Math.min(1000, remaining())), retryMs: 25 });
}
