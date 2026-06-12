/**
 * two-peer-convergence.integration.test.ts — git-sync-any-hive-2026-06-12 P-010
 * (brief B-06 scenario matrix): the EMPIRICAL leg of D-004 (multi-pusher,
 * origin-serialized). Two push-capable peers sync the same shared-hive origin;
 * we verify the existing fetch→merge→push + non-FF-retry + escalation +
 * resolver pipeline CONVERGES — and quantify ticks-to-converge and resolver
 * invocations — under deterministic worst-case interleavings.
 *
 * ## Why two member slugs in one process ≡ two operator stacks
 * git-sync shares NOTHING between peers except the git origin: each peer has
 * its own checkout, its own routine row (metadata, `last_resolver` dedup), its
 * own `(slug, 'git-sync')` escalation row, and its own `git-sync:<slug>` lock
 * resource. Two slugs against one real bare origin therefore reproduce the
 * two-stack topology exactly for everything the pipeline touches, while making
 * the race interleavings DETERMINISTIC — a live two-stack run with real LLM
 * resolvers cannot force "peer pushes between your fetch and your push" or
 * "two resolvers resolve the same conflict differently" on demand; this file
 * forces both, every run.
 *
 * ## The resolver loop is REAL, the resolver agent is scripted-adversarial
 * Unlike S4 of seed-any-hive (which parks an in-flight marker to avoid the
 * dispatch), these ticks run `spawnMergeResolver` END-TO-END: conflict →
 * escalation → `resolveLaunchTargetForEvent('git-sync:conflict')` (the real
 * built-in merge-resolution blueprint) → loopbackFetch POST at
 * `PAPERCUSP_OPERATOR_BASE` — an in-test HTTP server standing in for the
 * invoke route. The test then plays the merge-resolver agent itself with the
 * documented contract (redo the merge, resolve, push; on a non-FF rejection
 * re-fetch + re-merge + re-resolve), resolving ADVERSARIALLY (every peer/pass
 * writes distinct content — the worst case for cross-peer agreement) before
 * settling the HTTP call, which drives the action's observe loop
 * (`last_resolver` dispatched→ok, `merge_resolver` pipeline events).
 *
 * Scenario map (B-06):
 *   P0. In-pass push race (runGitSync level, real git): a peer push landing
 *       between our fetch and our push exercises the non-FF retry
 *       (run-git-sync.ts:309–325) — clean re-merge AND re-conflict variants.
 *   C1. Disjoint edits, same tick window — both land, union on origin, no
 *       escalation, zero resolver dispatches.
 *   C2. Overlapping edit — exactly the losing peer escalates + dispatches;
 *       a second conflicted tick while the resolver is in flight does NOT
 *       re-dispatch (RESOLVER_INFLIGHT_MS honored); resolution → clean pass
 *       clears; fleet converges; settle recorded (ok / 200 / exit 0).
 *   C3. Resolver race probe — BOTH peers conflict against a third-party tip,
 *       both resolvers dispatched, their resolutions interleaved so the second
 *       push is non-FF-rejected and its re-merge RE-CONFLICTS
 *       (resolution-vs-resolution — the P-010 ping-pong candidate). Verified:
 *       bounded at ONE extra pass (origin serializes; every successful push
 *       descends from the tip it merged), fleet converges in 2 clean ticks.
 *   C4. Three consecutive adversarial rounds, alternating the losing peer —
 *       the settle→re-dispatch lifecycle and escalation clear→rewrite reuse
 *       hold round over round (no wedged dedup, no stale escalation).
 *
 * Verdict recorded on the plan: NO ping-pong — a scripted resolver that NEVER
 * agrees with its peer still converges, because origin serializes pushes and
 * each retry merges a strict descendant of its last base. The plan's
 * contingent backoff (skip dispatch when origin moved since the conflicting
 * fetch) is NOT needed for convergence.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetForTests as resetDbOrgPools } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes (mirrors _baseline-coord-fixture)
import { _resetUrlCacheForTests } from '../../../../../libs/papercusp/libs/db/src/connection';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { _resetHarnessAdminUrlCacheForTests } from '../../embedded-pg-discovery';
import { _resetForTests as resetLocksPools } from '../../agent-tools/locks/su-lock-store';
import { mutateHarnessRegistry } from '../../harness-registry';
import { seedGitSyncRoutineForMember, GIT_SYNC_TARGET } from './git-sync-routine';
import { runGitSync, type RunGit } from './run-git-sync';
// Side-effect import: registers the `git-sync` system action exactly as
// production's register-system-actions pass does.
import './git-sync-action';
import { getSystemAction, type SystemActionCtx } from '../routines/system-actions';

// ── Run-unique names (papercusp_su persists on the reused container) ──────────
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36)}`;
const WS = `tpc${RUN}`; // the process workspace pin
const HOME = `tpchome${RUN}`;
const PEER_A = `tpca${RUN}`;
const PEER_B = `tpcb${RUN}`;

let db: OrgTestDb;
let tmpRoot: string;

// ── Per-test warn sink (same rationale as seed-any-hive: the action + registry
// notify paths legitimately warn; console.error stays strict) ─────────────────
let warnSpy: ReturnType<typeof vi.spyOn> | undefined;
const warns: string[] = [];

beforeEach(() => {
  warns.length = 0;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warns.push(a.map(String).join(' '));
  });
});

afterEach(() => {
  warnSpy?.mockRestore();
  warnSpy = undefined;
});

const dispatchWarns = (): string[] => warns.filter((w) => w.includes('dispatching merge-resolver'));

// ── git helpers (real subprocess) ──────────────────────────────────────────────

function sh(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', (e) => resolve({ code: -1, out, err: err + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await sh('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.err || r.out}`);
  return r.out.trim();
}

async function configRepo(dir: string): Promise<void> {
  await git(['config', 'user.email', 'tpc-it@example.com'], dir);
  await git(['config', 'user.name', 'tpc integration'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
}

/** One bare "shared hive origin" + N working clones of it (seed commit pushed). */
async function makeSharedOrigin(name: string, clones: string[]): Promise<{ bare: string; works: string[] }> {
  const bare = join(tmpRoot, `${name}-origin.git`);
  await mkdir(bare, { recursive: true });
  await git(['init', '--bare', '-b', 'main'], bare);
  const seedDir = join(tmpRoot, `${name}-seedclone`);
  await git(['clone', bare, seedDir], tmpRoot);
  await configRepo(seedDir);
  await writeFile(join(seedDir, 'shared.txt'), 'seed\n');
  await git(['add', '-A'], seedDir);
  await git(['commit', '--no-verify', '-m', 'seed'], seedDir);
  await git(['push', '-u', 'origin', 'main'], seedDir);
  const works: string[] = [];
  for (const c of clones) {
    const dir = join(tmpRoot, c);
    await git(['clone', bare, dir], tmpRoot);
    await configRepo(dir);
    works.push(dir);
  }
  await rm(seedDir, { recursive: true, force: true });
  return { bare, works };
}

const headOf = (dir: string): Promise<string> => git(['rev-parse', 'HEAD'], dir);
const originTipOf = (bare: string): Promise<string> => git(['rev-parse', 'main'], bare);

// ── PG read helpers ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const routineRow = async (slug: string): Promise<Row | undefined> =>
  (
    await db.adminSql<Row[]>`
      SELECT * FROM harness_shared.routines
       WHERE install_slug = ${slug} AND target_role = ${GIT_SYNC_TARGET}
    `
  )[0];

const escalationRow = async (slug: string): Promise<Row | undefined> =>
  (
    await db.adminSql<Row[]>`
      SELECT phase, escalation FROM harness_shared.harness_escalations
       WHERE harness_slug = ${slug} AND phase = 'git-sync'
    `
  )[0];

const pipelineEvents = async (slug: string): Promise<Row[]> =>
  db.adminSql<Row[]>`
    SELECT kind, status FROM harness_shared.pipeline_events
     WHERE install_slug = ${slug} ORDER BY id
  `;

const cfgOf = (row: Row | undefined): Record<string, unknown> =>
  (row?.trigger_config ?? {}) as Record<string, unknown>;
const metaOf = (row: Row | undefined): Record<string, unknown> =>
  (row?.metadata ?? {}) as Record<string, unknown>;

// ── The in-test invoke route (the "second stack's" resolver dispatch surface) ──

interface InvokeDispatch {
  slug: string;
  role: string;
  body: { kickoff?: string; extra?: string[]; timeoutMs?: number };
  /** Settle the invoke HTTP call — "the resolver agent finished". */
  respond: (result: { ok: boolean; exitCode?: number }) => void;
}

let invokeServer: Server;
const pendingDispatches: InvokeDispatch[] = [];
const dispatchWaiters: Array<(d: InvokeDispatch) => void> = [];

function onDispatch(d: InvokeDispatch): void {
  const w = dispatchWaiters.shift();
  if (w) w(d);
  else pendingDispatches.push(d);
}

/** The next resolver dispatch the action fires (arrived or about to). */
function nextDispatch(timeoutMs = 10_000): Promise<InvokeDispatch> {
  const queued = pendingDispatches.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no merge-resolver dispatch arrived')), timeoutMs);
    dispatchWaiters.push((d) => {
      clearTimeout(t);
      resolve(d);
    });
  });
}

/** Prove the action did NOT dispatch (give the fire-and-forget POST a beat). */
async function expectNoDispatch(ms = 500): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  expect(pendingDispatches).toEqual([]);
}

// ── The scripted ADVERSARIAL merge-resolver ───────────────────────────────────

interface ResolverRun {
  /** Merge passes that hit conflicts and were resolved (≥2 = a resolution
   *  re-conflicted with a peer's resolution — the P-010 race observed). */
  resolved: number;
  /** Push attempts until origin accepted (≥2 = the non-FF rejection path ran). */
  pushAttempts: number;
}

/**
 * The merge-resolver contract, scripted: redo the merge, resolve EVERY
 * conflicted file with peer-distinct content (maximally adversarial — it never
 * agrees with the other peer's resolution), push; on a non-FF rejection
 * re-fetch + re-merge (resolving any re-conflict) and retry. `prePush` fires
 * once before the FIRST push — the deterministic race injector (the other
 * peer's resolver lands first). Throws after 5 passes: that would be the
 * ping-pong P-010 hunts.
 */
async function scriptedResolver(
  work: string,
  marker: string,
  opts: { prePush?: () => Promise<void> } = {},
): Promise<ResolverRun> {
  let resolved = 0;
  let prePush = opts.prePush;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await git(['fetch', 'origin', 'main'], work);
    const m = await sh('git', ['merge', '--no-edit', 'origin/main'], work);
    if (m.code !== 0) {
      const files = (await sh('git', ['diff', '--name-only', '--diff-filter=U'], work)).out
        .trim()
        .split('\n')
        .filter(Boolean);
      if (files.length === 0) {
        await sh('git', ['merge', '--abort'], work);
        throw new Error(`resolver(${marker}): merge failed without conflicted paths: ${m.err || m.out}`);
      }
      resolved++;
      for (const f of files) await writeFile(join(work, f), `resolved by ${marker} (pass ${attempt})\n`);
      await git(['add', '-A'], work);
      await git(['commit', '--no-verify', '-m', `resolve(${marker}) pass ${attempt}`], work);
    }
    if (prePush) {
      const hook = prePush;
      prePush = undefined;
      await hook();
    }
    const p = await sh('git', ['push', 'origin', 'HEAD:main'], work);
    if (p.code === 0) return { resolved, pushAttempts: attempt };
  }
  throw new Error(`resolver(${marker}): no convergence within 5 passes — PING-PONG`);
}

// ── Fixture wiring ─────────────────────────────────────────────────────────────

let bare: string;
let workA: string;
let workB: string;

const action = (): NonNullable<ReturnType<typeof getSystemAction>> => getSystemAction('git-sync')!;

/** ctx exactly as the routines engine builds it — trigger_config FROM the row. */
async function ctxFor(slug: string): Promise<SystemActionCtx> {
  const row = await routineRow(slug);
  expect(row).toBeDefined();
  return { installSlug: slug, workspaceId: WS, triggerConfig: cfgOf(row), payloadTemplate: null };
}

const tick = async (slug: string): Promise<void> => action()(await ctxFor(slug));

/** Poll the routine's `last_resolver` until the dispatch observe-loop settles. */
async function waitForResolverSettle(slug: string, status: 'ok' | 'failed' | 'error'): Promise<Row> {
  return vi.waitFor(
    async () => {
      const lr = metaOf(await routineRow(slug)).last_resolver as Row | undefined;
      expect(lr?.status).toBe(status);
      return lr!;
    },
    { timeout: 10_000, interval: 100 },
  );
}

beforeAll(async () => {
  db = await createOrgTestDb();

  // Env-route every production connection at the migrated throwaway DB
  // (the _baseline-coord-fixture pattern), and pin the workspace for the
  // unscoped callers inside the tick (registry gate, projectDirForSlug).
  process.env.HARNESS_DATABASE_URL = db.appDsn;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
  process.env.PAPERCUSP_WORKSPACE_ID = WS;
  process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
  _resetUrlCacheForTests();
  _resetHarnessAdminUrlCacheForTests();
  await resetDbOrgPools();
  await resetLocksPools();

  tmpRoot = await mkdtemp(join(tmpdir(), 'tpc-it-'));

  // The invoke route stand-in: spawnMergeResolver's loopbackFetch lands HERE
  // (never on a live operator port — this test must not spawn real agents).
  invokeServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://localhost');
      const m = u.pathname.match(/^\/api\/harness\/([^/]+)\/invoke$/);
      if (!m) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      onDispatch({
        slug: decodeURIComponent(m[1]),
        role: u.searchParams.get('role') ?? '',
        body: raw ? (JSON.parse(raw) as InvokeDispatch['body']) : {},
        respond: (result) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        },
      });
    });
  });
  await new Promise<void>((r) => invokeServer.listen(0, '127.0.0.1', r));
  const port = (invokeServer.address() as AddressInfo).port;
  process.env.PAPERCUSP_OPERATOR_BASE = `http://127.0.0.1:${port}`;

  // The shared hive: one bare origin, one checkout per peer.
  ({ bare, works: [workA, workB] } = await makeSharedOrigin('hive', ['peer-a', 'peer-b']));

  // Register home + both members; seed both routines via the REAL spine
  // (creator-side; the local-path github_remote skips the network probe and
  // lands on permissions_unknown_optimistic → push:true — the S4 pattern).
  const homeDir = join(tmpRoot, 'hive-home');
  await mkdir(homeDir, { recursive: true });
  await mutateHarnessRegistry(
    (r) => ({
      ...r,
      projects: [
        ...r.projects,
        { slug: HOME, path: homeDir, harness_kind: 'hive' },
        { slug: PEER_A, path: workA, hive_slug: HOME, github_remote: bare, github_default_branch: 'main' },
        { slug: PEER_B, path: workB, hive_slug: HOME, github_remote: bare, github_default_branch: 'main' },
      ],
    }),
    WS,
  );
  for (const [slug, path] of [
    [PEER_A, workA],
    [PEER_B, workB],
  ] as const) {
    const seeded = await seedGitSyncRoutineForMember({
      workspaceId: WS,
      installSlug: slug,
      entry: { slug, path, hive_slug: HOME, github_remote: bare, github_default_branch: 'main' },
    });
    expect(seeded).toMatchObject({ seeded: true, push: true, branch: 'main' });
  }
}, 180_000);

afterAll(async () => {
  // Never strand a parked invoke call across teardown.
  for (const d of pendingDispatches.splice(0)) d.respond({ ok: false });
  await new Promise((r) => setTimeout(r, 200));
  await new Promise<void>((r) => invokeServer?.close(() => r()));
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  delete process.env.HARNESS_DATABASE_URL;
  delete process.env.HARNESS_ADMIN_DATABASE_URL;
  delete process.env.PAPERCUSP_WORKSPACE_ID;
  delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
  delete process.env.PAPERCUSP_OPERATOR_BASE;
  _resetUrlCacheForTests();
  _resetHarnessAdminUrlCacheForTests();
  await resetLocksPools();
  await resetDbOrgPools();
  await db?.cleanup();
}, 60_000);

// ════════════════════════════════════════════════════════════════════════════
// P0 — the in-pass push race (runGitSync level, real git): a peer push landing
// between our fetch and our push exercises the non-FF retry (run-git-sync.ts
// 309–325), which no unit test drives with real git.
// ════════════════════════════════════════════════════════════════════════════

describe('P0: a peer push between our fetch and our push (the in-pass non-FF retry)', () => {
  const spawnGit: RunGit = (args, cwd) =>
    new Promise((resolve) => {
      const child = spawn('git', args, { cwd });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += String(d)));
      child.stderr.on('data', (d) => (stderr += String(d)));
      child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });

  /** A RunGit that fires `onFirstPush` once, right before the pipeline's first
   *  `git push` — the deterministic "peer pushed in our race window". */
  const raceInjecting = (onFirstPush: () => Promise<void>): RunGit => {
    let injected = false;
    return async (args, cwd) => {
      if (!injected && args[0] === 'push') {
        injected = true;
        await onFirstPush();
      }
      return spawnGit(args, cwd);
    };
  };

  it('disjoint peer push in the window → retry re-fetches, re-merges, lands BOTH (synced)', async () => {
    const { bare: o, works: [mine, peer] } = await makeSharedOrigin('p0a', ['p0a-mine', 'p0a-peer']);
    await writeFile(join(peer, 'peer.txt'), 'peer work\n');
    await git(['add', '-A'], peer);
    await git(['commit', '--no-verify', '-m', 'peer commit'], peer);
    // NOT pushed yet — it lands inside our race window.

    await writeFile(join(mine, 'mine.txt'), 'my work\n');
    const outcome = await runGitSync('p0a', {
      repoPath: mine,
      config: { branch: 'main' },
      runGit: raceInjecting(async () => {
        await git(['push', 'origin', 'main'], peer);
      }),
    });

    expect(outcome.status).toBe('synced');
    if (outcome.status !== 'synced') throw new Error('expected synced');
    expect(outcome.pushed).toEqual(['superproject']);
    expect(outcome.merged).toEqual(['superproject']); // the retry's re-merge
    // Origin holds the UNION; our clone converged to it.
    const files = await git(['ls-tree', '-r', '--name-only', 'main'], o);
    expect(files).toContain('mine.txt');
    expect(files).toContain('peer.txt');
    expect(await originTipOf(o)).toBe(await headOf(mine));
  }, 30_000);

  it('CONFLICTING peer push in the window → the retry re-merge conflicts, aborts CLEAN, reports', async () => {
    const { works: [mine, peer] } = await makeSharedOrigin('p0b', ['p0b-mine', 'p0b-peer']);
    await writeFile(join(peer, 'shared.txt'), 'peer version\n');
    await git(['add', '-A'], peer);
    await git(['commit', '--no-verify', '-m', 'peer conflicting commit'], peer);

    await writeFile(join(mine, 'shared.txt'), 'my version\n');
    const outcome = await runGitSync('p0b', {
      repoPath: mine,
      config: { branch: 'main' },
      runGit: raceInjecting(async () => {
        await git(['push', 'origin', 'main'], peer);
      }),
    });

    expect(outcome.status).toBe('conflict');
    if (outcome.status !== 'conflict') throw new Error('expected conflict');
    expect(outcome.conflicts).toEqual([{ scope: 'superproject', conflictedFiles: ['shared.txt'] }]);
    // Aborted to a clean tree — no half-merge ever left behind.
    expect(await git(['status', '--porcelain', '--untracked-files=no'], mine)).toBe('');
    await expect(git(['rev-parse', '--verify', 'MERGE_HEAD'], mine)).rejects.toThrow();
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// C1 — disjoint edits, same tick window: both land, no escalation, no resolver
// ════════════════════════════════════════════════════════════════════════════

describe('C1: disjoint edits converge with no conflict and no resolver dispatch', () => {
  it('A pushes; B fetch-merges A and pushes; A merges back — union on origin', async () => {
    await writeFile(join(workA, 'from-a.txt'), 'a work\n');
    await writeFile(join(workB, 'from-b.txt'), 'b work\n');

    await tick(PEER_A); // A: commit + push
    await tick(PEER_B); // B: commit + merge A's push + push
    await tick(PEER_A); // A: merge B's push — converged

    const tip = await originTipOf(bare);
    expect(await headOf(workA)).toBe(tip);
    expect(await headOf(workB)).toBe(tip);
    const files = await git(['ls-tree', '-r', '--name-only', 'main'], bare);
    expect(files).toContain('from-a.txt');
    expect(files).toContain('from-b.txt');

    expect(metaOf(await routineRow(PEER_A)).last_status).toBe('synced');
    expect(metaOf(await routineRow(PEER_B)).last_status).toBe('synced');
    expect(await escalationRow(PEER_A)).toBeUndefined();
    expect(await escalationRow(PEER_B)).toBeUndefined();
    expect(dispatchWarns()).toEqual([]);
    await expectNoDispatch();
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════
// C2 — overlapping edit: the losing peer escalates + dispatches exactly once;
// in-flight dedup holds; the resolution clears and the fleet converges.
// ════════════════════════════════════════════════════════════════════════════

describe('C2: overlapping edit — one loser, one resolver, convergence', () => {
  it('loser escalates + dispatches; a second conflicted tick does NOT re-dispatch; resolution clears + converges', async () => {
    await writeFile(join(workA, 'shared.txt'), 'A v2\n');
    await writeFile(join(workB, 'shared.txt'), 'B v2\n');

    await tick(PEER_A); // wins the push
    await tick(PEER_B); // commits, then conflicts on A's tip

    // The loser (and ONLY the loser) escalated at the constant 'git-sync' phase
    // and dispatched its resolver through the real blueprint → invoke loop.
    const esc = await escalationRow(PEER_B);
    expect(esc).toBeDefined();
    expect(JSON.parse(String(esc!.escalation))).toMatchObject({ kind: 'git-sync-conflict', harness_slug: PEER_B });
    expect(await escalationRow(PEER_A)).toBeUndefined();
    expect(metaOf(await routineRow(PEER_B)).last_status).toBe('conflict');

    const dispatch = await nextDispatch();
    expect(dispatch.slug).toBe(PEER_B);
    expect(dispatch.role).toBe('merge-resolver'); // resolved FROM the merge-resolution blueprint
    expect(dispatch.body.kickoff).toContain('superproject = `main`');
    expect(dispatch.body.extra?.[0]).toBe('--git-sync-conflict');
    expect(dispatchWarns()).toHaveLength(1);

    // While that resolver is in flight (the invoke call is parked), another
    // conflicted tick must NOT double-dispatch (RESOLVER_INFLIGHT_MS dedup).
    await tick(PEER_B);
    expect(metaOf(await routineRow(PEER_B)).last_status).toBe('conflict');
    expect(dispatchWarns()).toHaveLength(1);
    await expectNoDispatch();

    // The resolver agent does its job (one conflicted pass) and settles.
    const run = await scriptedResolver(workB, 'peer-B');
    expect(run).toEqual({ resolved: 1, pushAttempts: 1 });
    dispatch.respond({ ok: true, exitCode: 0 });
    const settled = await waitForResolverSettle(PEER_B, 'ok');
    expect(settled).toMatchObject({ status: 'ok', httpStatus: 200, exitCode: 0 });

    // Clean pass clears the escalation; the other peer merges the resolution.
    await tick(PEER_B);
    expect((await escalationRow(PEER_B))!.escalation).toBeNull();
    await tick(PEER_A);

    const tip = await originTipOf(bare);
    expect(await headOf(workA)).toBe(tip);
    expect(await headOf(workB)).toBe(tip);
    expect(await git(['show', 'main:shared.txt'], bare)).toBe('resolved by peer-B (pass 1)');

    // The observe loop logged the resolver settle in pipeline history.
    const events = await pipelineEvents(PEER_B);
    expect(events.filter((e) => e.kind === 'merge_resolver' && e.status === 'ok')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'git_sync' && e.status === 'conflict')).toHaveLength(2);
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════
// C3 — the resolver race probe: both peers conflict against a third-party tip,
// both resolvers run, their resolutions interleave so the second one's push is
// rejected and its re-merge RE-CONFLICTS with the first one's resolution.
// ════════════════════════════════════════════════════════════════════════════

describe('C3: simultaneous conflicts + racing adversarial resolvers — bounded, no ping-pong', () => {
  it('two dispatches; the losing resolver re-conflicts ONCE and converges on its second push', async () => {
    // A third party moves the shared file on origin…
    const third = join(tmpRoot, 'third-party');
    await git(['clone', bare, third], tmpRoot);
    await configRepo(third);
    await writeFile(join(third, 'shared.txt'), 'third-party v3\n');
    await git(['add', '-A'], third);
    await git(['commit', '--no-verify', '-m', 'third-party change'], third);
    await git(['push', 'origin', 'main'], third);

    // …while BOTH peers hold conflicting local edits of it.
    await writeFile(join(workA, 'shared.txt'), 'A v3\n');
    await writeFile(join(workB, 'shared.txt'), 'B v3\n');

    await tick(PEER_A);
    await tick(PEER_B);

    // Both conflicted, both escalated, both dispatched their own resolver.
    expect(metaOf(await routineRow(PEER_A)).last_status).toBe('conflict');
    expect(metaOf(await routineRow(PEER_B)).last_status).toBe('conflict');
    const d1 = await nextDispatch();
    const d2 = await nextDispatch();
    const bySlug = Object.fromEntries([d1, d2].map((d) => [d.slug, d]));
    const dispatchA = bySlug[PEER_A];
    const dispatchB = bySlug[PEER_B];
    expect(dispatchA).toBeDefined();
    expect(dispatchB).toBeDefined();

    // The race, deterministically: B's resolver resolves first but A's FULL
    // resolution lands on origin in B's pre-push window → B's push is
    // non-FF-rejected → its re-merge hits a resolution-vs-resolution conflict
    // (the ping-pong candidate) → resolves again → second push accepted.
    let runA: ResolverRun | undefined;
    const runB = await scriptedResolver(workB, 'resolver-B', {
      prePush: async () => {
        runA = await scriptedResolver(workA, 'resolver-A');
        dispatchA.respond({ ok: true, exitCode: 0 });
      },
    });
    dispatchB.respond({ ok: true, exitCode: 0 });

    expect(runA).toEqual({ resolved: 1, pushAttempts: 1 });
    // resolved: 2 — the re-conflict HAPPENED; pushAttempts: 2 — and it was
    // bounded at one extra pass. Convergence is structural: origin serializes,
    // every accepted push descends from the tip its merge consumed.
    expect(runB).toEqual({ resolved: 2, pushAttempts: 2 });

    await waitForResolverSettle(PEER_A, 'ok');
    await waitForResolverSettle(PEER_B, 'ok');

    // Two clean ticks converge the fleet and clear both escalations.
    await tick(PEER_A);
    await tick(PEER_B);
    const tip = await originTipOf(bare);
    expect(await headOf(workA)).toBe(tip);
    expect(await headOf(workB)).toBe(tip);
    expect(await git(['show', 'main:shared.txt'], bare)).toBe('resolved by resolver-B (pass 2)');
    expect((await escalationRow(PEER_A))!.escalation).toBeNull();
    expect((await escalationRow(PEER_B))!.escalation).toBeNull();
    await expectNoDispatch();
  }, 90_000);
});

// ════════════════════════════════════════════════════════════════════════════
// C4 — consecutive adversarial rounds, alternating the loser: the settle →
// re-dispatch lifecycle and escalation clear→rewrite hold round over round.
// ════════════════════════════════════════════════════════════════════════════

describe('C4: three consecutive conflict rounds, alternating losers', () => {
  it('each round: one conflict, one dispatch, one resolution, convergence — no wedged dedup or stale escalation', async () => {
    for (let round = 1; round <= 3; round++) {
      // Alternate which peer wins the push (so BOTH routines' dispatch
      // lifecycles get re-exercised across rounds).
      const [winner, winnerWork, loser, loserWork] =
        round % 2 === 1
          ? ([PEER_A, workA, PEER_B, workB] as const)
          : ([PEER_B, workB, PEER_A, workA] as const);

      await writeFile(join(winnerWork, 'shared.txt'), `${winner} round ${round}\n`);
      await writeFile(join(loserWork, 'shared.txt'), `${loser} round ${round}\n`);

      await tick(winner);
      await tick(loser);
      expect(metaOf(await routineRow(loser)).last_status).toBe('conflict');

      const dispatch = await nextDispatch();
      expect(dispatch.slug).toBe(loser);
      const run = await scriptedResolver(loserWork, `round-${round}-${loser}`);
      expect(run).toEqual({ resolved: 1, pushAttempts: 1 });
      dispatch.respond({ ok: true, exitCode: 0 });
      await waitForResolverSettle(loser, 'ok');

      await tick(loser);
      await tick(winner);
      const tip = await originTipOf(bare);
      expect(await headOf(workA)).toBe(tip);
      expect(await headOf(workB)).toBe(tip);
      expect((await escalationRow(loser))!.escalation).toBeNull();
    }

    // Exactly one dispatch per round, none left over.
    await expectNoDispatch();
    expect(dispatchWarns()).toHaveLength(3);
  }, 120_000);
});
