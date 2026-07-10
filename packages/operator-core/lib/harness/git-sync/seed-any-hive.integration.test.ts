/**
 * seed-any-hive.integration.test.ts — git-sync-any-hive-2026-06-12 B-07 (P-012):
 * the COMPOSED seed/reconcile/tick behavior across the B-01..B-05 seams, proven
 * against real Postgres + real git fixtures (no mocked modules at all).
 *
 * EI-89 discipline — the DEFAULT code paths run wherever feasible:
 *   - `getOrgPg()` / `getHarnessAdminUrl()` are env-routed at a private MIGRATED
 *     throwaway DB (`createOrgTestDb`, the real baseline→head migration set) via
 *     the `_baseline-coord-fixture` pattern — the seeding spine, the reconcile
 *     sweep, operator-state registry reads/writes, routine upserts, escalations,
 *     and pipeline events all ride their production connections.
 *   - The locks substrate is the REAL `@papercusp/locks` store: the host seam
 *     resolves the same env URL, so `ensureBootstrap` stands up `papercusp_su`
 *     ON THE TESTCONTAINER and the action's acquire/release runs the production
 *     path end-to-end (per-slug auto-register included).
 *   - `runGitSync` runs real `git` against tmp fixtures (bare "origin" + clone).
 *   - The only injected seam anywhere is `fetchPushPermission` in the create
 *     tests (a genuine network probe — gh/GitHub — that cannot run
 *     hermetically); every joiner/no-remote path short-circuits before the
 *     probe and stays fully default.
 *
 * Scenario map (brief B-07):
 *   1. Create → row   — pot:create_from_repo composition (clone faked to a real
 *      on-disk fixture repo, as _create_from_repo.test.ts does) ⇒ member row,
 *      never the home. Plus the production double-seed ordering
 *      (harness:create{hive} seeds coord-less FIRST): step 7.25's coords-rich
 *      seed now UPGRADES the untouched machine-default row (probed push +
 *      branch land, `upgraded: true` surfaced) via the seeder's carve-out.
 *   2. Join → row     — joinHiveAsView ⇒ joiner member active (D-008) + push:false +
 *      per-install-salted cron; never the remote_hive view.
 *   3. Reconcile      — pre-plan registry ⇒ exactly the missing eligible members
 *      seeded; already-seeded + papercup-shaped rows untouched; 2nd run no-op.
 *   4. Tick           — handleGitSync (the registered system action) on a seeded
 *      member with a local bare origin: commit lands, push honors the seeded
 *      flag, per-slug lock resource registered+acquired (asserted via the
 *      papercusp_su registry + a real peer-held back-pressure round),
 *      escalations keyed at the B-05 constant phase 'git-sync' (not 'staging').
 *   5. Idempotence    — re-running add-member / join / the spine over a
 *      human-edited row never clobbers it.
 *
 * Isolation: a PRIVATE migrated DB per file run + per-run-unique slugs and
 * workspace ids (the shared `papercusp_su` side-db persists on the reused
 * container, so lock/registry names carry the run nonce).
 */
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
import {
  _resetForTests as resetLocksPools,
  getTxPool,
  tryAcquireResource,
  tryReleaseResource,
} from '../../agent-tools/locks/su-lock-store';
import { inWorkspaceTxn } from '../../agent-tools/locks/in-workspace-txn';
import {
  loadHarnessRegistry,
  mutateHarnessRegistry,
  type ProjectEntry,
} from '../../harness-registry';
import {
  createPotFromRepo,
  type CreatePotFromRepoDeps,
} from '../../agent-tools/pot/_create_from_repo';
import { addHarnessToPot } from '../../agent-tools/pot/_add-member';
import { joinHiveAsView, type JoinHiveDeps } from '../join-hive';
import {
  GIT_SYNC_SEED_ACTIVE_CREATOR,
  GIT_SYNC_SEED_ACTIVE_JOINER,
  gitSyncCronForKey,
} from './git-sync-eligibility';
import {
  GIT_SYNC_TARGET,
  seedGitSyncRoutineForMember,
  upsertGitSyncRoutine,
} from './git-sync-routine';
import { reconcileGitSyncRoutines } from './git-sync-reconcile';
// Side-effect import: registers the `git-sync` system action exactly as
// production's register-system-actions pass does.
import './git-sync-action';
import { getSystemAction, type SystemActionCtx } from '../routines/system-actions';

// ── Run-unique names (papercusp_su persists on the reused container) ──────────
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36)}`;
const WS1 = `gsah1${RUN}`; // create / add-member scenarios
const WS2 = `gsah2${RUN}`; // join scenarios
const WS3 = `gsah3${RUN}`; // reconcile scenarios
const WS4 = `gsah4${RUN}`; // tick scenarios (also the process workspace pin)

let db: OrgTestDb;
let tmpRoot: string;

// Per-test warn sink: the action and the registry's fire-and-forget notify
// legitimately warn (e.g. sync-invalidate without an SSE host); the integration
// layer's fail-on-console would otherwise red the file on machinery noise.
// PER-TEST (not beforeAll) because vitest-fail-on-console re-patches console in
// its own beforeEach — a file-level spy gets wrapped and the failure fires
// anyway. console.error stays strict. Tests that must prove a warn did NOT
// happen read the `warns` array (cleared per test).
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

// ── git helpers (real subprocess, never throws silently) ──────────────────────

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

/** Stamp the local identity/signing config real `git commit` needs. */
async function configRepo(dir: string): Promise<void> {
  await git(['config', 'user.email', 'gsah-it@example.com'], dir);
  await git(['config', 'user.name', 'gsah integration'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
}

/** A standalone working repo (no remote) with one seed commit, on `main`. */
async function makeWorkRepo(name: string): Promise<string> {
  const dir = join(tmpRoot, name);
  await mkdir(dir, { recursive: true });
  await git(['init', '-b', 'main'], dir);
  await configRepo(dir);
  await writeFile(join(dir, 'seed.txt'), 'seed\n');
  await git(['add', '-A'], dir);
  await git(['commit', '-m', 'seed'], dir);
  return dir;
}

/** A local bare "origin" + a working clone wired to it (seed commit pushed). */
async function makeOriginPair(name: string): Promise<{ bare: string; work: string }> {
  const bare = join(tmpRoot, `${name}-origin.git`);
  await mkdir(bare, { recursive: true });
  await git(['init', '--bare', '-b', 'main'], bare);
  const work = await makeWorkRepo(name);
  await git(['remote', 'add', 'origin', bare], work);
  await git(['push', '-u', 'origin', 'main'], work);
  return { bare, work };
}

// ── PG read helpers ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const routineRow = async (slug: string): Promise<Row | undefined> =>
  (
    await db.adminSql<Row[]>`
      SELECT * FROM harness_shared.routines
       WHERE install_slug = ${slug} AND target_role = ${GIT_SYNC_TARGET}
    `
  )[0];

const routineCount = async (slug: string): Promise<number> =>
  Number(
    (
      await db.adminSql<{ n: string }[]>`
        SELECT count(*) AS n FROM harness_shared.routines
         WHERE install_slug = ${slug} AND target_role = ${GIT_SYNC_TARGET}
      `
    )[0].n,
  );

const pipelineEvents = async (slug: string): Promise<Row[]> =>
  db.adminSql<Row[]>`
    SELECT kind, status, detail FROM harness_shared.pipeline_events
     WHERE install_slug = ${slug} ORDER BY id
  `;

const escalationRow = async (slug: string, phase: string): Promise<Row | undefined> =>
  (
    await db.adminSql<Row[]>`
      SELECT phase, escalation, workspace_id FROM harness_shared.harness_escalations
       WHERE harness_slug = ${slug} AND phase = ${phase}
    `
  )[0];

const cfgOf = (row: Row | undefined): Record<string, unknown> =>
  (row?.trigger_config ?? {}) as Record<string, unknown>;
const metaOf = (row: Row | undefined): Record<string, unknown> =>
  (row?.metadata ?? {}) as Record<string, unknown>;

// ── Fixture wiring ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  db = await createOrgTestDb();

  // Env-route EVERY production connection at the migrated throwaway DB
  // (the _baseline-coord-fixture pattern): getOrgPg() (admin role) and the
  // locks package's host seam (getHarnessAdminUrl → papercusp_su derivation).
  process.env.HARNESS_DATABASE_URL = db.appDsn;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
  // The unscoped callers inside the tick (gitSyncRuntimeGate's
  // loadHarnessRegistry(), runGitSync's projectDirForSlug) resolve the active
  // workspace from this pin (the hermetic setup scrubbed any spawn-time pin).
  process.env.PAPERCUSP_WORKSPACE_ID = WS4;
  process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
  _resetUrlCacheForTests();
  _resetHarnessAdminUrlCacheForTests();
  await resetDbOrgPools();
  await resetLocksPools();

  tmpRoot = await mkdtemp(join(tmpdir(), 'gsah-it-'));
}, 180_000);

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  delete process.env.HARNESS_DATABASE_URL;
  delete process.env.HARNESS_ADMIN_DATABASE_URL;
  delete process.env.PAPERCUSP_WORKSPACE_ID;
  delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
  _resetUrlCacheForTests();
  _resetHarnessAdminUrlCacheForTests();
  await resetLocksPools();
  await resetDbOrgPools();
  await db?.cleanup();
}, 60_000);

// ════════════════════════════════════════════════════════════════════════════
// Scenario 1 — Create → row (pot:create_from_repo composition)
// ════════════════════════════════════════════════════════════════════════════

describe('S1: pot:create_from_repo seeds the MEMBER routine, never the home', () => {
  const REPO = `shop${RUN}`;
  const URL = `https://github.com/acme/${REPO}`;
  const MEMBER = REPO; // base slug = repo name
  const HOME = `${REPO}-hive`;

  /** Composition deps: only the externally-bound seams are faked (clone /
   *  lookup / blueprint / publish / harness-create), exactly the unit-test
   *  pattern — but registry + seeding run their REAL PG paths. */
  function makeDeps(fixtureRepo: string, over: Partial<CreatePotFromRepoDeps> = {}): CreatePotFromRepoDeps {
    return {
      lookup: async () => ({
        kind: 'none',
        coords: { owner: 'acme', repo: REPO, githubRepositoryId: 100, private: false, identityResolved: true },
        bindingUnverified: false,
      }),
      clone: async () => ({
        path: fixtureRepo,
        parsed: { owner: 'acme', repo: REPO, cloneUrl: `${URL}.git` },
        defaultBranch: 'main',
      }),
      buildBlueprint: async (slug) => ({ ok: true, blueprint: { id: slug, extends: 'coding' } }),
      createPot: async (o) => {
        // The real createHiveHarness registers the home entry — mirror that
        // through the REAL registry so the home is visible to later scenarios.
        const homeDir = join(tmpRoot, `${o.slug}-home`);
        await mkdir(homeDir, { recursive: true });
        await mutateHarnessRegistry(
          (r) => ({
            ...r,
            projects: [...r.projects, { slug: o.slug, path: homeDir, harness_kind: 'hive' }],
          }),
          WS1,
        );
        return { ok: true, slug: o.slug, path: homeDir };
      },
      createMember: async (a) => {
        // The real harness:create registers the member entry with hive_slug.
        await mutateHarnessRegistry(
          (r) => ({
            ...r,
            projects: [...r.projects, { slug: a.slug, path: a.path, hive_slug: a.pot }],
          }),
          WS1,
        );
        return { ok: true };
      },
      publish: async () => ({
        announced: true,
        reachablePeers: 1,
        cupboard: { attempted: true, rowsCreated: 1, rowsFailed: 0 },
        localBindings: { created: 1, existed: 0, failed: 0 },
      }),
      // The ONE injected leaf: the GitHub permissions probe is real network
      // (gh CLI + api.github.com) — pin it to `true`. Spine/eligibility/
      // getRoutine/upsert/sql all stay default (EI-89).
      seedGitSync: async (o) =>
        seedGitSyncRoutineForMember(o, { fetchPushPermission: async () => true }),
      ...over,
    };
  }

  it('creates a system:git-sync row for the member (creator defaults: active, probed push, branch, jittered cron) and NO row for the home', async () => {
    const fixtureRepo = await makeWorkRepo(`s1-${REPO}`);
    const r = await createPotFromRepo({ githubUrl: URL, workspaceId: WS1 }, makeDeps(fixtureRepo));

    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.created).toMatchObject({ memberSlug: MEMBER, potSlug: HOME });
    expect(r.gitSync).toMatchObject({
      seeded: true,
      active: GIT_SYNC_SEED_ACTIVE_CREATOR,
      push: true,
      branch: 'main',
      cron: gitSyncCronForKey(MEMBER),
    });

    const row = await routineRow(MEMBER);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      name: 'git-sync',
      target_role: GIT_SYNC_TARGET,
      workspace_id: WS1,
      active: GIT_SYNC_SEED_ACTIVE_CREATOR,
    });
    expect(cfgOf(row)).toEqual({
      cron: gitSyncCronForKey(MEMBER),
      push: true,
      push_submodules: true,
      branch: 'main',
    });
    // The cron parsed — the routines engine has a real next fire time.
    expect(row!.next_fire_at).not.toBeNull();

    // NEVER the home: a hive home is a non-repo state dir.
    expect(await routineCount(HOME)).toBe(0);
  });

  it('upgrade rule: the coords-rich step-7.25 seed wins over the coords-less harness:create seed (probed push + branch land, upgraded surfaced)', async () => {
    // The production from-repo ordering double-seeds: agent-tools/harness/
    // create.ts (step 5a) seeds from the just-registered entry — which carries
    // NO github coords at that point — and _create_from_repo step 7.25 then
    // seeds again WITH coords (branch + probe-decided push). The seeder's
    // coords-aware carve-out (isUntouchedCoordslessCreatorSeed) lets the
    // coords-rich re-seed UPGRADE the step-5a row because it is still exactly
    // the untouched machine-default coords-less shape; anything human-touched
    // would stay routine_exists (S5 + the unit suite cover that side).
    const REPO_B = `shopb${RUN}`;
    const fixtureRepo = await makeWorkRepo(`s1-${REPO_B}`);
    const deps = makeDeps(fixtureRepo, {
      createMember: async (a) => {
        await mutateHarnessRegistry(
          (r) => ({
            ...r,
            projects: [...r.projects, { slug: a.slug, path: a.path, hive_slug: a.pot }],
          }),
          WS1,
        );
        // …and EXACTLY what create.ts step 5a does for { hive }: the default
        // spine over the coord-less entry (no github_remote → push:false,
        // no branch; probe short-circuited so no network).
        await seedGitSyncRoutineForMember({
          workspaceId: WS1,
          installSlug: a.slug,
          entry: { slug: a.slug, path: a.path, hive_slug: a.pot },
          joinerSide: false,
        });
        return { ok: true };
      },
      // Step 7.25 rides makeDeps' default seedGitSync: the REAL spine with only
      // the network probe pinned — the upgrade path now REACHES the probe
      // (the pinned-gap era short-circuited at routine_exists before it).
    });
    const r = await createPotFromRepo(
      { githubUrl: `https://github.com/acme/${REPO_B}`, slug: REPO_B, workspaceId: WS1 },
      deps,
    );

    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    // The coords-rich 7.25 seed WINS over the earlier coords-less seed and
    // says so:
    expect(r.gitSync).toMatchObject({
      seeded: true,
      upgraded: true,
      active: GIT_SYNC_SEED_ACTIVE_CREATOR,
      push: true,
      branch: 'main',
      cron: gitSyncCronForKey(REPO_B),
    });

    // The ROW is the proof: probed push, the clone's default branch, creator
    // active, jittered cron — still exactly one row.
    const row = await routineRow(REPO_B);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ workspace_id: WS1, active: GIT_SYNC_SEED_ACTIVE_CREATOR });
    expect(cfgOf(row)).toEqual({
      cron: gitSyncCronForKey(REPO_B),
      push: true,
      push_submodules: true,
      branch: 'main',
    });
    expect(await routineCount(REPO_B)).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario 2 — Join → row (joinHiveAsView)
// ════════════════════════════════════════════════════════════════════════════

describe('S2: joinHiveAsView seeds joiner members active/push:false, never the view', () => {
  const TOPIC = 'a'.repeat(64);
  const JREPO = `jrepo${RUN}`;
  const REPO_ID = 424242;
  const POT_ID = `h2pot${RUN}`;
  const LINK = `papercusp://harness?topic=${TOPIC}&github=acme%2F${JREPO}&repo_id=${REPO_ID}`;

  let jrepoDir: string;
  let joinLinkCalls = 0;

  const deps = (): JoinHiveDeps => ({
    // The per-link join (attestation/clone/federation) is the one externally-
    // bound seam — the fake registers the member exactly like the real route,
    // through the REAL registry. Registry mutate + git-sync seeding stay
    // fully default (the seeding spine runs joiner-side, which short-circuits
    // before the network probe).
    joinLink: async ({ slug }) => {
      joinLinkCalls++;
      await mutateHarnessRegistry(
        (r) => ({ ...r, projects: [...r.projects, { slug, path: jrepoDir }] }),
        WS2,
      );
      return { ok: true, detail: 'joined' };
    },
    remoteHivesRoot: join(tmpRoot, 'remote-hives'),
  });

  it('member row: active=false, push=false, per-install-salted cron; NO row for the remote_hive view', async () => {
    jrepoDir = await makeWorkRepo(`s2-${JREPO}`);

    const r = await joinHiveAsView(
      { potId: POT_ID, memberLinks: [LINK], workspaceId: WS2 },
      deps(),
    );

    expect(r.ok).toBe(true);
    expect(r.potSlug).toBe(POT_ID);
    expect(r.members).toHaveLength(1);
    expect(r.members[0].slug).toBe(JREPO);
    expect(r.members[0].detail).toBe('joined; git_sync:seeded');

    const row = await routineRow(JREPO);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      workspace_id: WS2,
      active: GIT_SYNC_SEED_ACTIVE_JOINER, // D-008: joiner clones seed ACTIVE (push:false ⇒ local mirror only)
    });
    const cfg = cfgOf(row);
    expect(cfg.push).toBe(false); // joiner_side — read-only by design (no push regardless of active)
    // D-004: the cron jitter key is salted per install on the joiner side.
    expect(cfg.cron).toBe(gitSyncCronForKey(`${JREPO}:${WS2}`));
    expect(cfg).not.toHaveProperty('branch'); // join links carry no default branch

    // The remote_hive VIEW is a non-repo dir — never seeded.
    expect(await routineCount(POT_ID)).toBe(0);

    // Registry view materialized as expected (remote_hive flag + membership).
    const reg = await loadHarnessRegistry(WS2);
    expect(reg.projects.find((p) => p.slug === POT_ID)).toMatchObject({
      harness_kind: 'hive',
      remote_hive: true,
    });
    expect(reg.projects.find((p) => p.slug === JREPO)).toMatchObject({
      hive_slug: POT_ID,
      github_repository_id: REPO_ID,
    });
  });

  it('S5(join): re-joining never clobbers a human-edited row (already_registered + routine_exists)', async () => {
    // A human flips the joiner row active + retunes the cron.
    // (::text::jsonb — the same double-cast production's upsertRoutine uses;
    // a bare ::jsonb makes postgres-js double-encode the string param.)
    const humanCfg = { cron: '0 5 * * * *', push: false, push_submodules: false, human: true };
    await db.adminSql`
      UPDATE harness_shared.routines
         SET active = true,
             trigger_config = ${JSON.stringify(humanCfg)}::text::jsonb
       WHERE install_slug = ${JREPO} AND target_role = ${GIT_SYNC_TARGET}
    `;
    const before = await routineRow(JREPO);
    const callsBefore = joinLinkCalls;

    const r = await joinHiveAsView(
      { potId: POT_ID, memberLinks: [LINK], workspaceId: WS2 },
      deps(),
    );

    expect(r.ok).toBe(true);
    expect(joinLinkCalls).toBe(callsBefore); // repo already registered — not re-joined
    expect(r.members[0].detail).toBe('already_registered; git_sync:routine_exists');

    const after = await routineRow(JREPO);
    expect(after!.active).toBe(true); // the human edit survives
    expect(cfgOf(after)).toEqual(humanCfg);
    expect(cfgOf(after)).toEqual(cfgOf(before));
    expect(after!.updated_at).toEqual(before!.updated_at); // zero writes
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario 3 — Reconcile (pre-plan hive backfill)
// ════════════════════════════════════════════════════════════════════════════

describe('S3: reconcile seeds exactly the missing eligible members', () => {
  const HOME = `h3home${RUN}`; // creator-side hive home (non-repo state dir)
  const M_A = `h3alpha${RUN}`; // member, repo, NOT seeded → seeds
  const M_B = `h3beta${RUN}`; // member, repo, ALREADY seeded (human-edited) → untouched
  const M_C = `h3cloud${RUN}`; // member, repo, cloud deployment → ineligible
  const SOLO = `h3solo${RUN}`; // papercup-shaped: repo, NO hive_slug → never visited
  const RHOME = `h3rview${RUN}`; // joiner-side remote_hive view home
  const M_D = `h3delta${RUN}`; // member of the remote view → seeds joiner-side

  let soloBefore: Row | undefined;
  let bBefore: Row | undefined;

  it('first run: seeds the missing members (joiner detection via the home flag); skips seeded/ineligible; never visits homes, views, or hive-less entries', async () => {
    const aDir = await makeWorkRepo(`s3-${M_A}`);
    const bDir = await makeWorkRepo(`s3-${M_B}`);
    const cDir = await makeWorkRepo(`s3-${M_C}`);
    const soloDir = await makeWorkRepo(`s3-${SOLO}`);
    const dDir = await makeWorkRepo(`s3-${M_D}`);
    const homeDir = join(tmpRoot, `s3-${HOME}`);
    const rhomeDir = join(tmpRoot, `s3-${RHOME}`);
    await mkdir(homeDir, { recursive: true });
    await mkdir(rhomeDir, { recursive: true });

    const projects: ProjectEntry[] = [
      { slug: HOME, path: homeDir, harness_kind: 'hive' },
      { slug: M_A, path: aDir, hive_slug: HOME },
      { slug: M_B, path: bDir, hive_slug: HOME },
      {
        slug: M_C,
        path: cDir,
        hive_slug: HOME,
        deployment: { target: 'hetzner' } as ProjectEntry['deployment'],
      },
      { slug: SOLO, path: soloDir },
      { slug: RHOME, path: rhomeDir, harness_kind: 'hive', remote_hive: true },
      { slug: M_D, path: dDir, hive_slug: RHOME },
    ];
    await mutateHarnessRegistry((r) => ({ ...r, projects: [...r.projects, ...projects] }), WS3);

    // Pre-existing rows: M_B was seeded then HUMAN-EDITED; SOLO mimics the
    // hand-tuned papercup row (no hive_slug — reconcile must never visit it).
    await upsertGitSyncRoutine(db.adminSql, {
      workspaceId: WS3,
      installSlug: M_B,
      cron: '0 7 * * * *',
      push: false,
      active: false,
    });
    await upsertGitSyncRoutine(db.adminSql, {
      workspaceId: WS3,
      installSlug: SOLO,
      cron: '0 */10 * * * *',
      push: true,
      active: true,
    });
    bBefore = await routineRow(M_B);
    soloBefore = await routineRow(SOLO);

    // DEFAULT seams throughout: real registry load, real spine, getOrgPg sql.
    const result = await reconcileGitSyncRoutines({ workspaceId: WS3 });

    expect(result.error).toBeUndefined();
    expect(result.seeded).toEqual([M_A, M_D]);
    expect(result.skipped).toEqual([
      { slug: M_B, reason: 'already_seeded' },
      { slug: M_C, reason: 'ineligible:non_local_deployment' },
    ]);

    // M_A: creator-side defaults (no upstream remote registered → push:false).
    const aRow = await routineRow(M_A);
    expect(aRow).toMatchObject({ workspace_id: WS3, active: GIT_SYNC_SEED_ACTIVE_CREATOR });
    expect(cfgOf(aRow)).toEqual({
      cron: gitSyncCronForKey(M_A),
      push: false,
      push_submodules: true,
    });

    // M_D: joiner-side (home entry carries remote_hive) → active (D-008),
    // push:false (local mirror only), per-install-salted cron.
    const dRow = await routineRow(M_D);
    expect(dRow).toMatchObject({ workspace_id: WS3, active: GIT_SYNC_SEED_ACTIVE_JOINER });
    expect(cfgOf(dRow)).toEqual({
      cron: gitSyncCronForKey(`${M_D}:${WS3}`),
      push: false,
      push_submodules: true,
    });

    // Never seeded: homes, views, the ineligible cloud member.
    expect(await routineCount(HOME)).toBe(0);
    expect(await routineCount(RHOME)).toBe(0);
    expect(await routineCount(M_C)).toBe(0);

    // Untouched: the human-edited member row and the papercup-shaped row.
    const bAfter = await routineRow(M_B);
    expect(bAfter!.active).toBe(false);
    expect(cfgOf(bAfter)).toEqual(cfgOf(bBefore));
    expect(bAfter!.updated_at).toEqual(bBefore!.updated_at);
    const soloAfter = await routineRow(SOLO);
    expect(cfgOf(soloAfter)).toEqual(cfgOf(soloBefore));
    expect(soloAfter!.updated_at).toEqual(soloBefore!.updated_at);
  });

  it('second run is a no-op: everything already seeded or still ineligible', async () => {
    const result = await reconcileGitSyncRoutines({ workspaceId: WS3 });

    expect(result.error).toBeUndefined();
    expect(result.seeded).toEqual([]);
    expect(result.skipped).toEqual([
      { slug: M_A, reason: 'already_seeded' },
      { slug: M_B, reason: 'already_seeded' },
      { slug: M_C, reason: 'ineligible:non_local_deployment' },
      { slug: M_D, reason: 'already_seeded' },
    ]);

    // Still exactly one row per seeded member; the papercup-shaped row intact.
    expect(await routineCount(M_A)).toBe(1);
    expect(await routineCount(M_D)).toBe(1);
    const soloAfter = await routineRow(SOLO);
    expect(soloAfter!.updated_at).toEqual(soloBefore!.updated_at);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario 4 — Tick on a seeded member (the registered system action, real git,
//              real locks substrate)
// ════════════════════════════════════════════════════════════════════════════

describe('S4: handleGitSync ticks a seeded member end-to-end', () => {
  const HOME4 = `h4home${RUN}`;
  const M4A = `h4push${RUN}`; // seeded push:true (local-path "remote" → optimistic)
  const M4B = `h4local${RUN}`; // seeded push:false (no upstream remote registered)

  let bare4a: string;
  let work4a: string;
  let bare4b: string;
  let work4b: string;

  const action = getSystemAction('git-sync')!;

  /** ctx exactly as the routines engine builds it — trigger_config FROM the
   *  seeded row, so the seeded config provably drives the pipeline. */
  async function ctxFor(slug: string): Promise<SystemActionCtx> {
    const row = await routineRow(slug);
    expect(row).toBeDefined();
    return {
      installSlug: slug,
      workspaceId: WS4,
      triggerConfig: cfgOf(row),
      payloadTemplate: null,
    };
  }

  it('seeds both members via the default spine and registers them in the workspace registry', async () => {
    ({ bare: bare4a, work: work4a } = await makeOriginPair(`s4-${M4A}`));
    ({ bare: bare4b, work: work4b } = await makeOriginPair(`s4-${M4B}`));
    const homeDir = join(tmpRoot, `s4-${HOME4}`);
    await mkdir(homeDir, { recursive: true });

    await mutateHarnessRegistry(
      (r) => ({
        ...r,
        projects: [
          ...r.projects,
          { slug: HOME4, path: homeDir, harness_kind: 'hive' },
          // github_remote is a LOCAL path: truthy (hasUpstreamRemote) but not
          // parseable as GitHub → the probe is skipped and the decider lands
          // on permissions_unknown_optimistic → push:true. Zero network.
          {
            slug: M4A,
            path: work4a,
            hive_slug: HOME4,
            github_remote: bare4a,
            github_default_branch: 'main',
          },
          { slug: M4B, path: work4b, hive_slug: HOME4 },
        ],
      }),
      WS4,
    );

    // FULLY default spine for both (no injected deps at all).
    const a = await seedGitSyncRoutineForMember({
      workspaceId: WS4,
      installSlug: M4A,
      entry: {
        slug: M4A,
        path: work4a,
        hive_slug: HOME4,
        github_remote: bare4a,
        github_default_branch: 'main',
      },
    });
    expect(a).toMatchObject({ seeded: true, active: true, push: true, branch: 'main' });
    if (a.seeded) expect(a.pushReason).toMatch(/^permissions_unknown_optimistic/);

    const b = await seedGitSyncRoutineForMember({
      workspaceId: WS4,
      installSlug: M4B,
      entry: { slug: M4B, path: work4b, hive_slug: HOME4 },
    });
    expect(b).toMatchObject({ seeded: true, active: true, push: false });
    if (b.seeded) expect(b.pushReason).toMatch(/^no_upstream_remote/);
  });

  it('push:true tick: commit lands, push reaches the bare origin, metadata + pipeline event recorded, per-slug resource registered, locks released', async () => {
    await writeFile(join(work4a, 'notes.txt'), 'work in the tree\n');

    await action(await ctxFor(M4A));

    // The auto-commit landed and was pushed: origin's main == the clone's HEAD.
    const head = await git(['rev-parse', 'HEAD'], work4a);
    const originTip = await git(['rev-parse', 'main'], bare4a);
    expect(originTip).toBe(head);
    const subject = await git(['log', '-1', '--format=%s'], work4a);
    expect(subject).toBe(`chore(git-sync): auto-commit ${M4A} [skip ci]`);
    expect(await git(['status', '--porcelain'], work4a)).toBe('');

    // Routine metadata recorded the outcome.
    const meta = metaOf(await routineRow(M4A));
    expect(meta.last_status).toBe('synced');
    expect(meta.head_sha).toBe(head);
    expect(meta.last_pushed).toEqual(['superproject']);

    // Pipeline history (mig 177) gained the tick.
    const events = await pipelineEvents(M4A);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'git_sync', status: 'synced' });
    expect((events[0].detail as Record<string, unknown>).headSha).toBe(head);

    // P-006: the per-slug resource was auto-registered in the REAL su registry…
    const su = getTxPool();
    const reg = await su<Row[]>`
      SELECT resource, enforcement, rule_text FROM agent_resource_registry
       WHERE resource = ${`git-sync:${M4A}`}
    `;
    expect(reg).toHaveLength(1);
    expect(reg[0].enforcement).toBe('advisory');
    expect(String(reg[0].rule_text)).toContain(`exclusive(git-sync:${M4A})`);
    // …and the tick's exclusive hold was released (no leftover lock rows).
    const locks = await su<Row[]>`
      SELECT * FROM agent_resource_locks WHERE coordination_domain = ${WS4}
    `;
    expect(locks).toEqual([]);
  });

  it('push:false tick honors the seeded flag: commit lands locally, the origin is untouched', async () => {
    const originBefore = await git(['rev-parse', 'main'], bare4b);
    await writeFile(join(work4b, 'local-only.txt'), 'never pushed\n');

    await action(await ctxFor(M4B));

    const head = await git(['rev-parse', 'HEAD'], work4b);
    expect(head).not.toBe(originBefore); // the commit happened…
    expect(await git(['rev-parse', 'main'], bare4b)).toBe(originBefore); // …but was NOT pushed
    const meta = metaOf(await routineRow(M4B));
    expect(meta.last_status).toBe('synced');
    expect(meta.last_pushed).toEqual([]);
  });

  it('a peer holding exclusive(git-sync:<slug>) back-pressures the tick; release → the next tick syncs', async () => {
    // Real peer acquire through the production store (the resource exists in
    // the registry from the first tick's auto-register).
    const resource = `git-sync:${M4A}`;
    const grab = await inWorkspaceTxn(WS4, 'it-peer', (tx) =>
      tryAcquireResource(tx, {
        coordinationDomain: WS4,
        resource,
        mode: 'exclusive',
        owner: 'it-peer',
        ownerLabel: 'it:peer',
        reason: 'B-07 back-pressure round',
        ttlSec: 120,
      }),
    );
    expect(grab.ok).toBe(true);

    await writeFile(join(work4a, 'blocked.txt'), 'tick must skip\n');
    const headBefore = await git(['rev-parse', 'HEAD'], work4a);
    const eventsBefore = (await pipelineEvents(M4A)).length;

    await action(await ctxFor(M4A));

    // Skipped: nothing committed, no pipeline event, the dirty file remains.
    expect(await git(['rev-parse', 'HEAD'], work4a)).toBe(headBefore);
    expect((await pipelineEvents(M4A)).length).toBe(eventsBefore);
    expect(await git(['status', '--porcelain'], work4a)).toContain('blocked.txt');

    await inWorkspaceTxn(WS4, 'it-peer', (tx) =>
      tryReleaseResource(tx, { coordinationDomain: WS4, owner: 'it-peer', resource }),
    );

    await action(await ctxFor(M4A));
    expect(await git(['status', '--porcelain'], work4a)).toBe('');
    expect(await git(['rev-parse', 'main'], bare4a)).toBe(await git(['rev-parse', 'HEAD'], work4a));
    expect((await pipelineEvents(M4A)).length).toBe(eventsBefore + 1);
  });

  it("conflict tick: escalation written at the B-05 constant phase 'git-sync' (a stale 'staging' row untouched); clean pass clears it", async () => {
    // Diverge origin via a peer clone…
    const peer = join(tmpRoot, `s4-${M4A}-peer`);
    await git(['clone', bare4a, peer], tmpRoot);
    await configRepo(peer);
    await writeFile(join(peer, 'seed.txt'), 'peer side\n');
    await git(['add', '-A'], peer);
    await git(['commit', '-m', 'peer change'], peer);
    await git(['push', 'origin', 'main'], peer);
    // …and a conflicting local edit (uncommitted — the tick auto-commits it).
    await writeFile(join(work4a, 'seed.txt'), 'local side\n');

    // Park a resolver "in flight" so the conflict tick must NOT dispatch a
    // merge-resolver (no blueprint resolution, no loopback POST from a test).
    const dispatchedAt = Date.now();
    // ::text::jsonb (not ::jsonb): postgres-js would otherwise bind the string
    // as a jsonb SCALAR, and `object || scalar` degrades the metadata to an
    // ARRAY — silently breaking every later ->'key' lookup.
    await db.adminSql`
      UPDATE harness_shared.routines
         SET metadata = COALESCE(metadata, '{}'::jsonb) ||
             ${JSON.stringify({ last_resolver: { status: 'dispatched', at: dispatchedAt } })}::text::jsonb
       WHERE install_slug = ${M4A} AND target_role = ${GIT_SYNC_TARGET}
    `;
    // A stale lifecycle-phase row (the pre-P-007 shared key) must survive.
    const stagingBody = JSON.stringify({ kind: 'rebase_conflict', detail: 'lifecycle row' });
    await db.adminSql`
      INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
      VALUES (${M4A}, 'staging', ${stagingBody}, ${Date.now()}, ${WS4})
    `;

    await action(await ctxFor(M4A));

    // The escalation row landed at git-sync's OWN constant phase…
    const esc = await escalationRow(M4A, 'git-sync');
    expect(esc).toBeDefined();
    const body = JSON.parse(String(esc!.escalation)) as Record<string, unknown>;
    expect(body.kind).toBe('git-sync-conflict');
    expect(body.harness_slug).toBe(M4A);
    expect((body.conflicts as Array<{ scope: string }>)[0].scope).toBe('superproject');
    // …and the lifecycle 'staging' row was not touched (P-007's whole point).
    const staging = await escalationRow(M4A, 'staging');
    expect(JSON.parse(String(staging!.escalation))).toMatchObject({ kind: 'rebase_conflict' });

    // The tree aborted CLEAN; the outcome was recorded; no resolver re-dispatch
    // (the parked in-flight marker survived untouched, and the dispatch warning
    // never fired — i.e. no loopback POST left this test).
    expect(warns.filter((w) => w.includes('dispatching merge-resolver'))).toEqual([]);
    expect(await git(['status', '--porcelain'], work4a)).toBe('');
    expect(await git(['diff', '--name-only', '--diff-filter=U'], work4a)).toBe('');
    const meta = metaOf(await routineRow(M4A));
    expect(meta.last_status).toBe('conflict');
    expect(meta.last_conflicts).toEqual(['superproject']);
    expect(meta.last_resolver).toEqual({ status: 'dispatched', at: dispatchedAt });
    const events = await pipelineEvents(M4A);
    expect(events.at(-1)).toMatchObject({ kind: 'git_sync', status: 'conflict' });

    // Resolve by converging on origin; the next clean pass clears the
    // git-sync-phase escalation (and only that one).
    await git(['reset', '--hard', 'origin/main'], work4a);
    await action(await ctxFor(M4A));

    const cleared = await escalationRow(M4A, 'git-sync');
    expect(cleared!.escalation).toBeNull();
    const stagingAfter = await escalationRow(M4A, 'staging');
    expect(JSON.parse(String(stagingAfter!.escalation))).toMatchObject({ kind: 'rebase_conflict' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario 5 — Idempotence / no-clobber for the creator-side producers
// (the join half lives in S2's re-join test)
// ════════════════════════════════════════════════════════════════════════════

describe('S5: re-running add-member / the spine never clobbers a human-edited row', () => {
  const MEMBER = `shop${RUN}`; // S1's member (row exists from scenario 1)
  const HOME = `${MEMBER}-hive`;

  it('pot:add-member over an existing (human-edited) row heals nothing and changes nothing', async () => {
    // The human turns the routine off and retunes it.
    const edited = { cron: '0 1 * * * *', push: false, push_submodules: false, edited_by: 'human' };
    await db.adminSql`
      UPDATE harness_shared.routines
         SET active = false, trigger_config = ${JSON.stringify(edited)}::text::jsonb
       WHERE install_slug = ${MEMBER} AND target_role = ${GIT_SYNC_TARGET}
    `;
    const before = await routineRow(MEMBER);

    // Re-add: DEFAULT seams (real registry, real lazy-imported spine). The
    // spine's non-clobber check returns BEFORE the github probe, so no network.
    const r = await addHarnessToPot({
      workspaceId: WS1,
      potHomeSlug: HOME,
      memberHarnessSlug: MEMBER,
    });

    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false); // already a member — idempotent
    expect(r.gitSync).toEqual({ seeded: false, reason: 'routine_exists' });

    const after = await routineRow(MEMBER);
    expect(after!.active).toBe(false);
    expect(cfgOf(after)).toEqual(edited);
    expect(after!.updated_at).toEqual(before!.updated_at); // zero writes

    expect(await routineCount(MEMBER)).toBe(1);
  });

  it('a direct re-seed via the spine (different inputs) still reports routine_exists and leaves the row alone', async () => {
    const before = await routineRow(MEMBER);
    const reg = await loadHarnessRegistry(WS1);
    const entry = reg.projects.find((p) => p.slug === MEMBER)!;

    const outcome = await seedGitSyncRoutineForMember({
      workspaceId: WS1,
      installSlug: MEMBER,
      entry,
      joinerSide: false,
      cronKey: `${MEMBER}:fresh-salt`, // even different inputs must not rewrite
    });

    expect(outcome).toEqual({ seeded: false, reason: 'routine_exists' });
    const after = await routineRow(MEMBER);
    expect(cfgOf(after)).toEqual(cfgOf(before));
    expect(after!.active).toBe(before!.active);
    expect(after!.updated_at).toEqual(before!.updated_at);
  });
});
