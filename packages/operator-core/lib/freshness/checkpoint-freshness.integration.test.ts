/**
 * checkpoint-freshness.integration.test.ts — the P-007 freshness pilot end-to-end
 * against real Postgres (agent-protocol-authority-semantics-2026-07-26, D-013).
 *
 * The unit suite (./freshness.test.ts) proves the pure verdict logic. This one
 * proves the parts only a real database and a real filesystem can:
 *   - a declared dependency's token is RESOLVED and STAMPED at write time;
 *   - a later read re-resolves it and returns the right verdict;
 *   - the `recomputed` marker is decided across two separate writes;
 *   - the tri-state `dependsOn` (omit ⇒ preserve, [] ⇒ clear) survives a re-write;
 *   - an unresolvable dependency is dropped, not stamped (the false-stale trap).
 *
 * The two INVERSION tests are the point of the whole axis: they assert the cases
 * the time heuristics get backwards by construction.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  loadHarnessRegistry: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
vi.mock('../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness-registry')>();
  return { ...actual, loadHarnessRegistry: h.loadHarnessRegistry };
});
// The loop write path pushes a derived Orders-panel invalidation. It is fail-soft in
// production; stubbing it keeps the suite off the sync bus entirely.
vi.mock('../agent-orders-notify', () => ({ notifyAgentOrdersChanged: vi.fn(async () => {}) }));

const { setWorkItemCheckpointWithPrior, getWorkItemCheckpointFreshness, getWorkItemCheckpointDeps } = await import(
  '../work-item-checkpoint'
);
const {
  setLoopCarryNote,
  setLoopCarryNoteWithPrior,
  getLoopCarryNoteDeps,
  getLoopCarryNoteFreshness,
  loopScope,
} = await import('../carry-note');
const { resolveCurrentTokens } = await import('./resolvers');

const HARNESS = 'h1';
const WS = 'default';

const CARRY_NOTES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.carry_notes (
    workspace_id text NOT NULL,
    scope text NOT NULL,
    note text,
    journal jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_ts bigint NOT NULL,
    deps jsonb,
    -- migration 1118 (P-007/R-06) unchanged-attestation state. body_ts = when the note
    -- TEXT last actually changed (NULL on pre-1118 rows; readers coalesce to
    -- updated_ts); attested_count = the consecutive-attestation chain since the last
    -- real body write. Kept in step with the real schema deliberately: this fixture
    -- tracks harness_shared.carry_notes rather than stubbing a minimal subset.
    body_ts bigint,
    attested_count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, scope))`;
const WORK_ITEMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_items (
    -- WI-38326: FEATURE_COLS projects these five claim-spec filter columns; a fixture
    -- missing them fails that projection with "column does not exist" (D-014 debt).
    tags jsonb,
    source_plan_slug text,
    source_plan_item_ids text[],
    redundancy integer,
    expected_cost_cents bigint,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    status text,
    updated_ts bigint,
    last_progress_at timestamptz,
    admission text, admitted_at timestamptz, admitted_by text,
    PRIMARY KEY (workspace_id, harness_slug, feature_id))`;
const ENGINEER_ISSUES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.engineer_issues (
    workspace_id text NOT NULL DEFAULT 'default',
    issue_id text NOT NULL,
    state text NOT NULL DEFAULT 'open',
    assignee text,
    assigned_at timestamptz,
    updated_at timestamptz,
    PRIMARY KEY (workspace_id, issue_id))`;
const PLANS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_plans (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    plan_slug text NOT NULL,
    version bigint,
    content_hash text,
    updated_at timestamptz,
    PRIMARY KEY (workspace_id, harness_slug, plan_slug))`;

let db: FreshPgDb;
let repoRoot: string;
const PRIOR_WS_ENV = process.env.PAPERCUSP_WORKSPACE_ID;
const PRIOR_ROOT_ENV = process.env.PAPERCUSP_INTEGRATION_ROOT;

beforeAll(async () => {
  process.env.PAPERCUSP_WORKSPACE_ID = WS;
  db = await createFreshPgDb('checkpoint-freshness');
  h.sql = db.sql;
  await db.sql.unsafe(CARRY_NOTES_DDL);
  await db.sql.unsafe(WORK_ITEMS_DDL);
  await db.sql.unsafe(ENGINEER_ISSUES_DDL);
  await db.sql.unsafe(PLANS_DDL);
  // A real directory standing in for the repo, so `file:` deps hash real bytes.
  //
  // The production write/read paths resolve the root INTERNALLY via
  // detectPapercupRoot() — there is exactly one repo root at runtime, so plumbing an
  // override through the checkpoint API would be test-only ceremony. Instead make the
  // temp dir a root detectPapercupRoot genuinely accepts: it requires BOTH
  // apps/operator/package.json and libs/papercusp/package.json (hasPapercupMarkers).
  // Without them it walks up to the real repo, where these fixtures do not exist, and
  // every file: dep silently resolves unresolvable — which is exactly how the first
  // run of this suite failed. Seeding the markers keeps the test on the real
  // resolution path rather than bypassing it.
  repoRoot = await mkdtemp(join(tmpdir(), 'freshness-root-'));
  await mkdir(join(repoRoot, 'apps', 'operator'), { recursive: true });
  await mkdir(join(repoRoot, 'libs', 'papercusp'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'operator', 'package.json'), '{"name":"@papercusp/operator"}');
  await writeFile(join(repoRoot, 'libs', 'papercusp', 'package.json'), '{"name":"@papercusp/papercusp"}');
  process.env.PAPERCUSP_INTEGRATION_ROOT = repoRoot;
}, 120_000);

afterAll(async () => {
  if (PRIOR_WS_ENV === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = PRIOR_WS_ENV;
  if (PRIOR_ROOT_ENV === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
  else process.env.PAPERCUSP_INTEGRATION_ROOT = PRIOR_ROOT_ENV;
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  await db?.cleanup();
});

beforeEach(async () => {
  h.loadHarnessRegistry.mockReset().mockRejectedValue(new Error('registry unavailable in default fixture'));
  await db.sql`DELETE FROM harness_shared.carry_notes`;
  await db.sql`DELETE FROM harness_shared.work_items`;
  await db.sql`DELETE FROM harness_shared.engineer_issues`;
  await db.sql`DELETE FROM harness_shared.harness_plans`;
});

const ref = (workItemId: string) => ({ harness: HARNESS, workItemId, workspaceId: WS });

async function seedFile(name: string, contents: string): Promise<string> {
  await writeFile(join(repoRoot, name), contents);
  return `file:${name}`;
}

async function seedWorkItem(id: string, status: string, updatedTs: number): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, status, updated_ts)
    VALUES (${WS}, ${HARNESS}, ${id}, ${status}, ${updatedTs})
    ON CONFLICT (workspace_id, harness_slug, feature_id)
      DO UPDATE SET status = EXCLUDED.status, updated_ts = EXCLUDED.updated_ts`;
}

describe('resolvers — tokens come from versions that already exist', () => {
  it('hashes file contents and changes the token only when the bytes change', async () => {
    const dep = await seedFile('a.ts', 'const x = 1;');
    const first = await resolveCurrentTokens([dep], { workspaceId: WS, harness: HARNESS, repoRoot });
    expect(first.get(dep)).toMatch(/^sha256:[0-9a-f]{16}$/);

    // Rewriting identical bytes must NOT move the token — a git-sync checkout or a
    // touch changes mtime without changing meaning, and a false stale here would
    // train agents to ignore the verdict.
    await writeFile(join(repoRoot, 'a.ts'), 'const x = 1;');
    const same = await resolveCurrentTokens([dep], { workspaceId: WS, harness: HARNESS, repoRoot });
    expect(same.get(dep)).toBe(first.get(dep));

    await writeFile(join(repoRoot, 'a.ts'), 'const x = 2;');
    const changed = await resolveCurrentTokens([dep], { workspaceId: WS, harness: HARNESS, repoRoot });
    expect(changed.get(dep)).not.toBe(first.get(dep));
  });

  it('resolves both work-item families and a plan version', async () => {
    await seedWorkItem('WI-1', 'open', 1000);
    await db.sql`
      INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, state, updated_at)
      VALUES (${WS}, 'EI-9', 'open', to_timestamp(2))`;
    await db.sql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, version)
      VALUES (${WS}, ${HARNESS}, 'my-plan', 28)`;

    const tokens = await resolveCurrentTokens(['work-item:WI-1', 'work-item:EI-9', 'plan:my-plan'], {
      workspaceId: WS,
      harness: HARNESS,
      repoRoot,
    });
    expect(tokens.get('work-item:WI-1')).toBe('open@1000');
    expect(tokens.get('work-item:EI-9')).toBe('open@2000');
    expect(tokens.get('plan:my-plan')).toBe('v28');
  });

  it('normalizes a bare work-item id before stamping its checkpoint dependency', async () => {
    await seedWorkItem('WI-DEP', 'open', 1000);

    const res = await setWorkItemCheckpointWithPrior(ref('WI-BARE'), 'blocked on WI-DEP', {
      dependsOn: ['WI-DEP'],
    });

    expect(res.depsStamped).toBe(1);
    expect(res.depsWarnings).toBeUndefined();
    expect((await getWorkItemCheckpointDeps(ref('WI-BARE')))?.stamps).toEqual([
      expect.objectContaining({ dep: 'work-item:WI-DEP', token: 'open@1000' }),
    ]);
    expect((await getWorkItemCheckpointFreshness(ref('WI-BARE')))?.verdict).toBe('fresh');

    await seedWorkItem('WI-DEP', 'done', 2000);
    expect((await getWorkItemCheckpointFreshness(ref('WI-BARE')))?.verdict).toBe('stale');
  });

  it('refuses to read outside the repo root and never throws', async () => {
    const tokens = await resolveCurrentTokens(['file:../escape.ts', 'file:/etc/passwd', 'bogus-kind:x'], {
      workspaceId: WS,
      harness: HARNESS,
      repoRoot,
    });
    expect(tokens.get('file:../escape.ts')).toBeNull();
    expect(tokens.get('file:/etc/passwd')).toBeNull();
    expect(tokens.get('bogus-kind:x')).toBeNull();
  });
});

describe('write → read round trip', () => {
  it('stamps and later re-resolves a canonical file when the declaring harness registry root is phantom', async () => {
    const phantomRoot = await mkdtemp(join(tmpdir(), 'freshness-checkpoint-phantom-'));
    try {
      h.loadHarnessRegistry.mockResolvedValue({
        projects: [{ slug: HARNESS, path: phantomRoot, harness_kind: 'coding' }],
      });
      const dep = await seedFile('phantom-root-owner.ts', 'stable canonical bytes');

      const res = await setWorkItemCheckpointWithPrior(ref('WI-PHANTOM'), 'did the thing', {
        dependsOn: [dep],
      });

      expect(res.depsStamped).toBe(1);
      expect(res.depsWarnings).toBeUndefined();
      expect((await getWorkItemCheckpointFreshness(ref('WI-PHANTOM')))?.verdict).toBe('fresh');
    } finally {
      await rm(phantomRoot, { recursive: true, force: true });
    }
  });

  it('stamps declared dependencies and reads back fresh when nothing moved', async () => {
    const dep = await seedFile('b.ts', 'stable');
    const res = await setWorkItemCheckpointWithPrior(ref('WI-100'), 'did the thing', { dependsOn: [dep] });
    expect(res.stored).toBe('did the thing');
    expect(res.depsStamped).toBe(1);
    expect(res.depsWarnings).toBeUndefined();

    const stored = await getWorkItemCheckpointDeps(ref('WI-100'));
    expect(stored?.stamps).toHaveLength(1);
    expect(stored?.stamps[0]?.dep).toBe(dep);

    const verdict = await getWorkItemCheckpointFreshness(ref('WI-100'));
    expect(verdict?.verdict).toBe('fresh');
  });

  it('returns undefined (⇒ heuristic fallback) for a checkpoint that declared nothing', async () => {
    await setWorkItemCheckpointWithPrior(ref('WI-101'), 'no deps declared');
    expect(await getWorkItemCheckpointFreshness(ref('WI-101'))).toBeUndefined();
  });

  it('drops an unresolvable dependency instead of stamping it', async () => {
    // Stamping a dep that cannot resolve would make it read as CHANGED the moment
    // it first resolves — a manufactured false stale.
    const res = await setWorkItemCheckpointWithPrior(ref('WI-102'), 'note', {
      dependsOn: ['file:does-not-exist.ts', 'not-a-kind:x'],
    });
    expect(res.depsStamped).toBe(0);
    expect(res.depsWarnings).toHaveLength(2);
    expect(res.depsWarnings?.join(' ')).toContain('not-a-kind');
    expect(await getWorkItemCheckpointDeps(ref('WI-102'))).toBeNull();
  });
});

describe('the inversions — what the TTL heuristics get backwards', () => {
  it('an OLD checkpoint whose dependencies never moved reads FRESH', async () => {
    const dep = await seedFile('c.ts', 'untouched');
    await setWorkItemCheckpointWithPrior(ref('WI-200'), 'written long ago', { dependsOn: [dep] });
    // Backdate the write well past STALE_CHECKPOINT_MS (45m): every existing
    // heuristic distrusts it purely for its age.
    await db.sql`
      UPDATE harness_shared.carry_notes SET updated_ts = ${Date.now() - 6 * 3_600_000}
       WHERE workspace_id = ${WS}`;

    const verdict = await getWorkItemCheckpointFreshness(ref('WI-200'));
    expect(verdict?.verdict).toBe('fresh');
    expect(verdict?.reason).toContain('age alone is not a reason');
  });

  it('a SECONDS-OLD checkpoint whose file a PEER changed reads STALE, naming the file', async () => {
    // The structural hole: computeCheckpointStaleness keys on the ASSIGNEE's own
    // lastActiveAt, so a peer's edit is invisible to it at any threshold.
    const dep = await seedFile('shared.ts', 'before peer edit');
    await setWorkItemCheckpointWithPrior(ref('WI-201'), 'rig is intact', { dependsOn: [dep] });
    await writeFile(join(repoRoot, 'shared.ts'), 'AFTER a peer rewrote it');

    const verdict = await getWorkItemCheckpointFreshness(ref('WI-201'));
    expect(verdict?.verdict).toBe('stale');
    expect(verdict?.changed.map((c) => c.dep)).toEqual([dep]);
    expect(verdict?.reason).toContain('shared.ts');
  });

  it('a work-item dependency moving flips the verdict to stale', async () => {
    await seedWorkItem('WI-DEP', 'open', 1000);
    await setWorkItemCheckpointWithPrior(ref('WI-202'), 'blocked on WI-DEP', { dependsOn: ['work-item:WI-DEP'] });
    expect((await getWorkItemCheckpointFreshness(ref('WI-202')))?.verdict).toBe('fresh');

    await seedWorkItem('WI-DEP', 'done', 2000);
    const verdict = await getWorkItemCheckpointFreshness(ref('WI-202'));
    expect(verdict?.verdict).toBe('stale');
    expect(verdict?.changed[0]).toMatchObject({ dep: 'work-item:WI-DEP', was: 'open@1000', now: 'done@2000' });
  });
});

describe('recomputed — the third marker, decided across two writes', () => {
  it('marks a rewrite that replaced an already-stale note', async () => {
    const dep = await seedFile('d.ts', 'v1');
    await setWorkItemCheckpointWithPrior(ref('WI-300'), 'first note', { dependsOn: [dep] });

    // The world moves — the stored note is now stale.
    await writeFile(join(repoRoot, 'd.ts'), 'v2');
    expect((await getWorkItemCheckpointFreshness(ref('WI-300')))?.verdict).toBe('stale');

    // The author rewrites against the new world.
    const res = await setWorkItemCheckpointWithPrior(ref('WI-300'), 'second note', { dependsOn: [dep] });
    expect(res.recomputed).toBe(true);

    const verdict = await getWorkItemCheckpointFreshness(ref('WI-300'));
    expect(verdict?.verdict).toBe('recomputed');
    expect(verdict?.changed).toEqual([]);
  });

  it('does NOT mark a rewrite that replaced a still-fresh note', async () => {
    const dep = await seedFile('e.ts', 'v1');
    await setWorkItemCheckpointWithPrior(ref('WI-301'), 'first', { dependsOn: [dep] });
    const res = await setWorkItemCheckpointWithPrior(ref('WI-301'), 'second', { dependsOn: [dep] });
    expect(res.recomputed).toBeUndefined();
    expect((await getWorkItemCheckpointFreshness(ref('WI-301')))?.verdict).toBe('fresh');
  });
});

describe('dependsOn tri-state', () => {
  it('PRESERVES the declaration when a later write omits dependsOn', async () => {
    // Otherwise a plain re-write or an append silently drops the note's only
    // non-guessed freshness signal.
    const dep = await seedFile('f.ts', 'v1');
    await setWorkItemCheckpointWithPrior(ref('WI-400'), 'first', { dependsOn: [dep] });
    await setWorkItemCheckpointWithPrior(ref('WI-400'), 'rewritten without re-declaring');

    const stored = await getWorkItemCheckpointDeps(ref('WI-400'));
    expect(stored?.stamps[0]?.dep).toBe(dep);
    expect((await getWorkItemCheckpointFreshness(ref('WI-400')))?.verdict).toBe('fresh');
  });

  it('CLEARS rather than preserving when a new declaration is wholly unresolvable', async () => {
    // Preserving the prior stamps here would judge the NEW note by the OLD note's
    // dependency set and could report `fresh` for a note whose own declaration
    // failed entirely — a false fresh. Clearing yields `undeclared`, routing the
    // reader to the time heuristics: an honest "we don't know".
    const dep = await seedFile('j.ts', 'v1');
    await setWorkItemCheckpointWithPrior(ref('WI-404'), 'first', { dependsOn: [dep] });
    const res = await setWorkItemCheckpointWithPrior(ref('WI-404'), 'second', {
      dependsOn: ['file:nope-does-not-exist.ts'],
    });
    expect(res.depsStamped).toBe(0);
    expect(res.recomputed).toBeUndefined();
    expect(await getWorkItemCheckpointDeps(ref('WI-404'))).toBeNull();
    expect(await getWorkItemCheckpointFreshness(ref('WI-404'))).toBeUndefined();
  });

  it('CLEARS the declaration on an explicit empty list', async () => {
    const dep = await seedFile('g.ts', 'v1');
    await setWorkItemCheckpointWithPrior(ref('WI-401'), 'first', { dependsOn: [dep] });
    await setWorkItemCheckpointWithPrior(ref('WI-401'), 'now undeclared', { dependsOn: [] });

    expect(await getWorkItemCheckpointDeps(ref('WI-401'))).toBeNull();
    expect(await getWorkItemCheckpointFreshness(ref('WI-401'))).toBeUndefined();
  });

  it('keeps declarations isolated per work-item', async () => {
    const depA = await seedFile('h.ts', 'A');
    const depB = await seedFile('i.ts', 'B');
    await setWorkItemCheckpointWithPrior(ref('WI-402'), 'a', { dependsOn: [depA] });
    await setWorkItemCheckpointWithPrior(ref('WI-403'), 'b', { dependsOn: [depB] });

    await writeFile(join(repoRoot, 'h.ts'), 'A-changed');
    expect((await getWorkItemCheckpointFreshness(ref('WI-402')))?.verdict).toBe('stale');
    expect((await getWorkItemCheckpointFreshness(ref('WI-403')))?.verdict).toBe('fresh');
  });
});

/**
 * The LOOP carry-note — the second carrier on this same axis (EI-19470389781357111).
 *
 * `work_items:checkpoint` had the declared-dependency axis; `loop:checkpoint` did not,
 * and a cold loop's carry-note is the case that needs it MOST: it is that session's
 * ONLY continuity surface, so an age heuristic getting freshness backwards there is
 * unrecoverable. The write/read contract is deliberately the SHARED one (same
 * `stampDeclaredDeps`, same verdict computation), proved by ./stamp.test.ts with no
 * database. What can only be proved HERE is where the loop note DIFFERS from the
 * work-item checkpoint: its row is pinned to ONE workspace while its refs must resolve
 * under the CALLER's.
 */
describe('the loop carry-note carries the same axis', () => {
  const LOOP = { harness: HARNESS, ownerId: 'su-loop-owner' };

  it('CALIBRATION: a declared file dep reads fresh, then stale when a peer edits it', async () => {
    // If this fails, every assertion below is meaningless — a loop note that stamps
    // nothing trivially "passes" the refusal tests further down.
    const dep = await seedFile('loop-calib.ts', 'v1');
    await setLoopCarryNoteWithPrior(LOOP, 'did X; next Y', { dependsOn: [dep], depsResolveWorkspaceId: WS });

    expect((await getLoopCarryNoteFreshness(LOOP, WS))?.verdict).toBe('fresh');

    await writeFile(join(repoRoot, 'loop-calib.ts'), 'v2');
    const after = await getLoopCarryNoteFreshness(LOOP, WS);
    expect(after?.verdict).toBe('stale');
    expect(after?.changed.map((c) => c.dep)).toEqual([dep]);
  });

  it('resolves refs under the CALLER workspace, not the workspace its row is pinned to', async () => {
    // THE loop-specific invariant. The row lives in the coord workspace because the
    // loop's whole lifecycle rides the coord subsystem; but `work-item:`/`plan:` refs
    // are filtered by a strict workspace_id, so resolving them under the PINNED
    // namespace would drop every one of them and silently reduce the loop note to
    // `file:`-only dependencies. Nothing about the stored row would look wrong.
    const TENANT = 'ws-tenant';
    await db.sql`
      INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, status, updated_ts)
      VALUES (${TENANT}, ${HARNESS}, 'WI-TENANT', 'open', 5000)`;

    const res = await setLoopCarryNoteWithPrior(LOOP, 'blocked on WI-TENANT', {
      dependsOn: ['work-item:WI-TENANT'],
      depsResolveWorkspaceId: TENANT,
    });
    expect(res.depsWarnings).toBeUndefined();
    expect((await getLoopCarryNoteDeps(LOOP))?.stamps[0]?.token).toBe('open@5000');

    // CONTROL: the same ref under the ROW's workspace resolves to NOTHING. That is
    // what conflating the two workspaces would have produced — and it is
    // indistinguishable from "the agent declared no work-item deps".
    const pinned = await resolveCurrentTokens(['work-item:WI-TENANT'], {
      workspaceId: WS,
      harness: HARNESS,
      repoRoot,
    });
    // `null`, not absent: resolveCurrentTokens returns Map<string, string | null> and
    // records an unresolvable ref explicitly. Asserting `toBeUndefined()` here fails
    // against a correct implementation — the control has to match the instrument.
    expect(pinned.get('work-item:WI-TENANT')).toBeNull();
  });

  it('REFUSES to stamp when no concrete caller workspace was supplied', async () => {
    // A `?superuser=1` session with no workspace chosen sends the '*' read sentinel.
    // Stamping it would resolve refs under whatever workspace the sidecar process
    // happens to be pinned to — a verdict about a DIFFERENT tenant's rows, stored as
    // if it were authoritative. `undeclared` routes the reader to the age heuristics,
    // which is an honest "we don't know".
    //
    // This is the case that shipped BROKEN: the guard asked `resolveConcreteWorkspaceId`,
    // whose ambient fallback never returns null, so the refusal branch was unreachable
    // and '*' was quietly stamped against the process-global workspace.
    const dep = await seedFile('loop-refuse.ts', 'v1');
    const res = await setLoopCarryNoteWithPrior(LOOP, 'note', { dependsOn: [dep], depsResolveWorkspaceId: '*' });

    expect(res.depsWarnings?.join(' ')).toContain('no concrete workspace');
    expect(await getLoopCarryNoteDeps(LOOP)).toBeNull();
    // The READ side refuses on the same input for the same reason.
    expect(await getLoopCarryNoteFreshness(LOOP, '*')).toBeUndefined();
  });

  it('treats a CLEARED note as undeclared even though the journal ring keeps its row', async () => {
    // Loop notes journal: a clear sets note→null but the row survives, still carrying
    // the cleared note's `deps`. Reporting those would hand back a verdict for a note
    // that no longer exists — worse than falling through to the heuristics.
    const dep = await seedFile('loop-cleared.ts', 'v1');
    await setLoopCarryNoteWithPrior(LOOP, 'about to be cleared', { dependsOn: [dep], depsResolveWorkspaceId: WS });
    expect(await getLoopCarryNoteDeps(LOOP)).not.toBeNull();

    await setLoopCarryNote(LOOP, null);

    const scope = loopScope(LOOP.harness, LOOP.ownerId);
    const row = await db.sql<{ note: string | null; deps: unknown }[]>`
      SELECT note, deps FROM harness_shared.carry_notes WHERE scope = ${scope}`;
    expect(row[0]?.note).toBeNull();
    expect(row[0]?.deps).not.toBeNull(); // the stamps genuinely survive the clear
    expect(await getLoopCarryNoteDeps(LOOP)).toBeNull();
    expect(await getLoopCarryNoteFreshness(LOOP, WS)).toBeUndefined();
  });
});
