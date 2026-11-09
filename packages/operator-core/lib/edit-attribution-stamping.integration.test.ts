/**
 * P-005 / R-4 (change-provenance-and-admission-throughput-2026-10-27): an edit is stamped
 * with the work item its editor HOLDS (work_items.taken_by), not a short-lived claim lease.
 * One held item stamps it; several are disambiguated by the lock intent, then the declared
 * presence intent; otherwise the row stays unstamped and records the candidates. Every row
 * records HOW it was chosen. R-5: the editing session id persists on the row.
 * Real Postgres with the real ledger migrations; the writer is the production function.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { RunGit } from './harness/git-sync/run-git-sync';
import type { FrozenEditCohort } from './edit-attribution';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({
  db: null as FreshPgDb | null,
  presence: null as { currentPlanSlug: string | null; intent: string | null } | null,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.db!.sql }),
}));
vi.mock('./agent-tools/coordination/presence', () => ({ getPresence: async () => h.presence }));

const { recordEditAttribution, preserveEditGeneration, readEditPredecessors, describeEditCohort,
  freezeEditCohort, checkFrozenEditCohortEvidence, preserveReleasedEditGenerations } = await import('./edit-attribution');

const WS = 'ws-stamping';
const AGENT = 'su-stamping';
let root: string;
let closeLocks: (() => Promise<void>) | undefined;

beforeAll(async () => {
  h.db = await createFreshPgDb('edit-attr-stamping');
  await applyMigrationsForTest(
    h.db.sql,
    [
      '363-commit-attribution-ledger.sql',
      '364-edit-attribution-ledger-repo-root.sql',
      '784-edit-attribution-acquired-via.sql',
      '1367-edit-attribution-dispatch-call-id.sql',
      '1540-git-sync-commit-attribution-repo-committed-at.sql',
      '1584-edit-attribution-symbols.sql',
      '1587-edit-attribution-signal-eligibility.sql',
      '1599-edit-attribution-work-item-resolution.sql',
    ],
    { runtimeTables: ['harness_shared.git_sync_commit_attribution'] },
  );
  // Only the columns the held-set read touches.
  await h.db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text,
      feature_id   text NOT NULL,
      taken_by     text,
      status       text NOT NULL,
      lane         text,
      payload      jsonb
    )`);
  root = mkdtempSync(join(tmpdir(), 'edit-attr-stamping-'));
  writeFileSync(join(root, 'tool.ts'), 'export const x = 1;\n');
}, 120_000);
afterAll(async () => {
  await closeLocks?.();
  await h.db?.cleanup();
  if (root) rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => {
  h.presence = null;
  await h.db!.sql.unsafe('TRUNCATE harness_shared.edit_attribution_ledger, harness_shared.work_items');
  // Never candidates: a finished item and an observation-lane reflection.
  await hold('WI-done', 'done');
  await hold('EI-observation', 'open', 'observation');
});

async function hold(id: string, status = 'open', lane: string | null = null) {
  await h.db!.sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, taken_by, status, lane)
    VALUES (${WS}, 'papercusp', ${id}, ${AGENT}, ${status}, ${lane})`;
}

async function edit(intent: string, sessionId?: string) {
  await recordEditAttribution(
    { repoRoot: root, files: ['tool.ts'], agentId: AGENT, workspaceId: WS, intent, sessionId },
    { strict: true },
  );
  const rows = await h.db!.sql<Array<{
    work_item_id: string | null;
    harness_slug: string | null;
    work_item_resolution: string | null;
    work_item_candidates: string[] | null;
    session_id: string | null;
  }>>`
    SELECT work_item_id, harness_slug, work_item_resolution, work_item_candidates, session_id
      FROM harness_shared.edit_attribution_ledger
     WHERE agent_id = ${AGENT}`;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('edit stamping from the editor held set', () => {
  const context = { configurationIdentity: 'config-1', environmentIdentity: 'isolated-env-1', requiredChecks: ['focused-suite'] };
  const member = (id: string, path: string, dependencies: Array<{ requestId: string; generation: number; paths: string[]; tree: string | null }> = []) => ({
    version: 1, kind: 'edit-generation', pending: true,
    capture: { ok: true, ref: `refs/fixture/${id}`, candidate: {
      version: 2, kind: 'candidate', repository: '/fixture/.git', requestId: id, generation: 1,
      paths: [path], base: 'a'.repeat(40), baseTree: 'b'.repeat(40), tree: id === 'op-a' ? 'c'.repeat(40) : 'd'.repeat(40),
      ...(dependencies.length ? { dependencies } : {}),
    } },
  });
  async function fullEdit(id: string, path: string, dependencies: Parameters<typeof member>[2] = []) {
    await recordEditAttribution({ repoRoot: root, files: [path], agentId: AGENT, workspaceId: WS,
      goalRef: 'WI-A', dispatchCallId: id, captureReceipt: member(id, path, dependencies) }, { strict: true });
  }
  const freeze = () => freezeEditCohort({ workspaceId: WS, harnessSlug: 'papercusp', workItemId: 'WI-A', ...context });
  async function lifecycle() {
    return (await cohort() as { gitSyncLifecycle: { captures: Record<string, unknown>; frozen: FrozenEditCohort } }).gitSyncLifecycle;
  }
  function evidence(frozen: FrozenEditCohort, captures: Record<string, unknown>) {
    return { frozen, captures, ...context, publicationIntent: true, dependencies: [],
      checks: [{ check: 'focused-suite', identity: frozen.identity, environmentIdentity: context.environmentIdentity,
        passed: true, runId: 'measured-run-1' }] };
  }

  it.each(['turn-end', 'session-restart'])('retains a complete unfinished frozen cohort after %s', async _boundary => {
    await hold('WI-A');
    await Promise.all([fullEdit('op-a', 'a.ts'), fullEdit('op-b', 'b.ts')]);
    const frozen = await freeze();
    // Both lifecycle boundaries can drop the short-lived editor, never the work.
    h.presence = null;
    await h.db!.sql`UPDATE harness_shared.work_items SET taken_by = NULL WHERE workspace_id = ${WS} AND feature_id = 'WI-A'`;
    const reloaded = await lifecycle();
    expect(reloaded.frozen).toEqual(frozen);
    expect(await freeze()).toEqual(frozen);
    expect(checkFrozenEditCohortEvidence({ ...evidence(reloaded.frozen, reloaded.captures), publicationIntent: false }))
      .toEqual({ ok: false, reason: 'cohort-unfinished' });
  });

  it('invalidates the whole frozen subject when another captured file arrives', async () => {
    await hold('WI-A');
    await fullEdit('op-a', 'a.ts');
    const frozen = await freeze();
    expect(checkFrozenEditCohortEvidence(evidence(frozen, (await lifecycle()).captures))).toEqual({ ok: true });
    await fullEdit('op-b', 'b.ts');
    expect(checkFrozenEditCohortEvidence(evidence(frozen, (await lifecycle()).captures)))
      .toEqual({ ok: false, reason: 'cohort-changed' });
    const next = await freeze();
    expect(next.identity).not.toBe(frozen.identity);
    expect(next.members.map(member => member.operationId)).toEqual(['op-a', 'op-b']);
  });

  it('rejects a stale run, changed environment/configuration and missing measured check', async () => {
    await hold('WI-A');
    await fullEdit('op-a', 'a.ts');
    const frozen = await freeze();
    const current = evidence(frozen, (await lifecycle()).captures);
    expect(checkFrozenEditCohortEvidence({ ...current, checks: [{ ...current.checks[0], identity: 'older-candidate' }] }))
      .toEqual({ ok: false, reason: 'cohort-check-missing-or-stale' });
    expect(checkFrozenEditCohortEvidence({ ...current, checks: [{ ...current.checks[0], runId: '' }] }))
      .toEqual({ ok: false, reason: 'cohort-check-missing-or-stale' });
    expect(checkFrozenEditCohortEvidence({ ...current, environmentIdentity: 'other-env' }))
      .toEqual({ ok: false, reason: 'cohort-changed' });
    expect(checkFrozenEditCohortEvidence({ ...current, configurationIdentity: 'other-config' }))
      .toEqual({ ok: false, reason: 'cohort-changed' });
  });

  it('requires exact finished predecessor proof even when the successor checks pass', async () => {
    await hold('WI-A');
    const dependency = { requestId: 'unfinished-A1', generation: 1, paths: ['a.ts'], tree: 'e'.repeat(40) };
    await fullEdit('op-b', 'a.ts', [dependency]);
    const frozen = await freeze();
    const current = evidence(frozen, (await lifecycle()).captures);
    expect(checkFrozenEditCohortEvidence(current)).toEqual({ ok: false, reason: 'cohort-ancestor-unfinished' });
    expect(checkFrozenEditCohortEvidence({ ...current, dependencies: [{ ...dependency, repository: '/fixture/.git', tree: 'f'.repeat(40) }] }))
      .toEqual({ ok: false, reason: 'cohort-ancestor-unfinished' });
    expect(checkFrozenEditCohortEvidence({ ...current, dependencies: [{ ...dependency, repository: '/fixture/.git' }] })).toEqual({ ok: true });
  });

  it('refuses separately captured overlapping files without causal order and incompatible bases', () => {
    const a = member('op-a', 'a.ts'), b = member('op-b', 'a.ts');
    expect(() => describeEditCohort({ 'op-a': a, 'op-b': b }, context)).toThrow('unordered-overlapping');
    const ordered = member('op-b', 'a.ts', [{ requestId: 'op-a', generation: 1, paths: ['a.ts'], tree: a.capture.candidate.tree }]);
    expect(describeEditCohort({ 'op-b': ordered, 'op-a': a }, context).members).toHaveLength(2);
    expect(() => describeEditCohort({ 'op-a': a, 'op-b': { ...ordered, capture: { ...ordered.capture,
      candidate: { ...ordered.capture.candidate, base: 'f'.repeat(40) } } } }, context)).toThrow('incompatible-bases');
  });

  it('uses acknowledged nullable-attribution handoff history and keeps legacy ancestry unknown', async () => {
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'fixture');
    git('add', '--', 'tool.ts'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
    const runGit: RunGit = async (args, cwd, options) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...options?.env } });
      return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    };
    const input = { repoRoot: root, files: ['tool.ts'], agentId: AGENT, workspaceId: WS,
      dispatchCallId: 'unassigned-A1', operationState: 'granted' as const };
    writeFileSync(join(root, 'tool.ts'), 'export const x = 2;\n');
    const receipt = await preserveEditGeneration(input, runGit);
    await recordEditAttribution({ ...input, captureReceipt: receipt }, { strict: true });
    writeFileSync(join(root, 'tool.ts'), 'export const x = 3;\n');
    const next = await preserveEditGeneration({ ...input, dispatchCallId: 'unassigned-B1' }, runGit);
    expect(next).toMatchObject({ capture: { candidate: { dependencies: [{
      requestId: 'unassigned-A1', generation: 1, paths: ['tool.ts'],
      tree: (receipt.capture as { candidate: { tree: string } }).candidate.tree,
    }] } } });
    await recordEditAttribution({ repoRoot: root, files: ['tool.ts'], agentId: AGENT, workspaceId: WS,
      intent: 'shell edit' }, { strict: true });
    const unknown = await readEditPredecessors({ ...input, dispatchCallId: 'after-legacy' }, runGit);
    expect(unknown).toEqual([{ requestId: expect.stringMatching(/^legacy-ledger:/), generation: 1, paths: ['tool.ts'], tree: null }]);
  });

  it.each([
    { route: 'release', assigned: true }, { route: 'expiry', assigned: true },
    { route: 'release', assigned: false }, { route: 'expiry', assigned: false },
  ])('preserves real multi-file Git custody and PG attribution before $route handoff (assigned=$assigned)', async ({ route, assigned }) => {
    const store = await import('./agent-tools/locks/su-lock-store');
    const { inWorkspaceTxn } = await import('./agent-tools/locks/in-workspace-txn');
    const { configureLocks, locksHost } = await import('@papercusp/locks');
    closeLocks = store._resetForTests;
    await store.ensureBootstrap();
    const repo = mkdtempSync(join(root, 'handoff-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    const runGit: RunGit = async (args, cwd, options) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, ...options?.env } });
      return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    };
    git('init', '-b', 'main'); git('config', 'user.name', 'fixture');
    git('config', 'user.email', 'fixture@example.test');
    for (const file of ['a.txt', 'b.txt']) writeFileSync(join(repo, file), 'base\n');
    git('add', '-A'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
    if (assigned) await hold('WI-A');
    const held = await inWorkspaceTxn(repo, AGENT, tx => store.tryAcquire(tx, {
      coordinationDomain: repo, owner: AGENT, ownerLabel: 'predecessor', paths: ['a.txt', 'b.txt'],
      intent: 'original edit', goalRef: assigned ? 'WI-A' : undefined, ttlSec: 60,
    }));
    if (!held.ok) throw new Error('predecessor setup failed');
    const waiter = await inWorkspaceTxn(repo, 'successor', tx => store.tryInsertWaiter(tx, {
      coordinationDomain: repo, owner: 'successor', ownerLabel: 'successor', paths: ['a.txt', 'b.txt'],
      intent: 'next edit', ttlSec: 60, maxWaitSec: 120,
    }));
    if (!waiter.ok || 'self_granted' in waiter) throw new Error('successor setup failed');
    writeFileSync(join(repo, 'a.txt'), 'A1 staged\n'); git('add', '--', 'a.txt');
    writeFileSync(join(repo, 'a.txt'), 'A1 working\n');
    writeFileSync(join(repo, 'b.txt'), Buffer.from([0, 255, 128, 1]));
    const index = readFileSync(join(repo, '.git/index'));
    const captures: Array<Awaited<ReturnType<typeof preserveEditGeneration>>> = [];
    let originalMilestone: FrozenEditCohort | undefined;
    const saved = locksHost();
    configureLocks({ ...saved, beforeFileLocksRelease: async input => {
      expect(input.coordinationDomain).toBe(repo);
      expect(input.rows.map(row => row.owner)).toEqual([AGENT, AGENT]);
      expect((await store.readWaiterStatus(store.getTxPool(), waiter.ticket_id)).status).toBe('waiting');
      await preserveReleasedEditGenerations({ repoRoot: repo, rows: input.rows,
        agentId: AGENT, sessionId: AGENT, workspaceId: WS }, {
        preserve: async input => {
          const receipt = await preserveEditGeneration(input, runGit);
          captures.push(receipt);
          return receipt;
        },
      });
      if (assigned) originalMilestone = await freeze();
    } });
    try {
      if (route === 'release') await inWorkspaceTxn(repo, AGENT, tx => store.tryRelease(tx, {
        coordinationDomain: repo, owner: AGENT, lockId: held.lock_id,
      }));
      else {
        await store.getTxPool()`UPDATE agent_file_locks SET expires_ts = clock_timestamp() - interval '1 second'
          WHERE coordination_domain = ${repo}`;
        await inWorkspaceTxn(repo, 'successor', tx => store.pokeWorkspace(tx, repo));
      }
      expect((await store.readWaiterStatus(store.getTxPool(), waiter.ticket_id)).status).toBe('granted');
      expect(captures).toHaveLength(1);
      const capture = captures[0].capture as { ref: string; candidate: { requestId: string } };
      if (assigned) {
        // Real release/expiry and a successor grant do not finish the work or
        // lose the complete milestone when its editing session goes away.
        h.presence = null;
        await h.db!.sql`UPDATE harness_shared.work_items SET taken_by = NULL
          WHERE workspace_id = ${WS} AND feature_id = 'WI-A'`;
        const resumed = await lifecycle();
        expect(resumed.frozen).toEqual(originalMilestone);
        expect(await freeze()).toEqual(originalMilestone);
        expect(originalMilestone!.members).toHaveLength(1);
        expect(originalMilestone!.members[0].candidate.paths).toEqual(['a.txt', 'b.txt']);
        expect(checkFrozenEditCohortEvidence({ ...evidence(resumed.frozen, resumed.captures), publicationIntent: false }))
          .toEqual({ ok: false, reason: 'cohort-unfinished' });
      }
      const ledger = await h.db!.sql`SELECT file, agent_id, session_id, work_item_id, dispatch_call_id
        FROM harness_shared.edit_attribution_ledger WHERE repo_root = ${repo} ORDER BY file`;
      expect(ledger).toEqual(['a.txt', 'b.txt'].map(file => ({ file, agent_id: AGENT, session_id: AGENT,
        work_item_id: assigned ? 'WI-A' : null, dispatch_call_id: capture.candidate.requestId })));
      expect(readFileSync(join(repo, '.git/index'))).toEqual(index);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('A1 working\n');
      writeFileSync(join(repo, 'a.txt'), 'B1 working\n');
      expect(git('show', `${capture.ref}:payload/a.txt`)).toBe('A1 working');
      const binary = spawnSync('git', ['show', `${capture.ref}:payload/b.txt`], { cwd: repo });
      expect(binary.status).toBe(0);
      expect(binary.stdout).toEqual(Buffer.from([0, 255, 128, 1]));
      expect(readFileSync(join(repo, '.git/index'))).toEqual(index);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('B1 working\n');
      if (assigned) {
        await h.db!.sql`UPDATE harness_shared.work_items SET taken_by = 'successor'
          WHERE workspace_id = ${WS} AND feature_id = 'WI-A'`;
        const successor = { repoRoot: repo, files: ['a.txt', 'b.txt'], agentId: 'successor', workspaceId: WS,
          goalRef: 'WI-A', sessionId: 'fresh-successor-session', dispatchCallId: 'successor-session-edit' };
        const receipt = await preserveEditGeneration({ ...successor, operationState: 'granted' }, runGit);
        await recordEditAttribution({ ...successor, captureReceipt: receipt }, { strict: true });
        const resumed = await lifecycle();
        expect(checkFrozenEditCohortEvidence(evidence(originalMilestone!, resumed.captures)))
          .toEqual({ ok: false, reason: 'cohort-changed' });
        const nextMilestone = await freeze();
        expect(nextMilestone.identity).not.toBe(originalMilestone!.identity);
        expect(nextMilestone.members.map(member => member.operationId).sort())
          .toEqual([capture.candidate.requestId, successor.dispatchCallId].sort());
        expect(checkFrozenEditCohortEvidence({ ...evidence(nextMilestone, resumed.captures),
          checks: evidence(originalMilestone!, resumed.captures).checks }))
          .toEqual({ ok: false, reason: 'cohort-check-missing-or-stale' });
        const sessions = await h.db!.sql`SELECT DISTINCT session_id FROM harness_shared.edit_attribution_ledger
          WHERE repo_root = ${repo} ORDER BY session_id`;
        expect(sessions.map(row => row.session_id).sort()).toEqual([AGENT, 'fresh-successor-session'].sort());
        expect(git('rev-list', '--count', 'HEAD')).toBe('1');
        expect(readFileSync(join(repo, '.git/index'))).toEqual(index);
        expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('B1 working\n');
      }
    } finally {
      configureLocks(saved);
      await store.getTxPool()`DELETE FROM agent_file_locks WHERE coordination_domain = ${repo}`;
      await store.getTxPool()`DELETE FROM agent_lock_waiters WHERE coordination_domain = ${repo}`;
    }
  });

  const receipt = (path: string) => ({ version: 1, kind: 'edit-generation', pending: true,
    capture: { candidate: { repository: '/fixture/.git', paths: [path], base: 'a'.repeat(40), tree: 'b'.repeat(40) } } });
  async function capturedEdit(id: string, path: string, sessionId = 'session-1') {
    await recordEditAttribution({ repoRoot: root, files: [path], agentId: AGENT, workspaceId: WS,
      goalRef: 'WI-A', sessionId, dispatchCallId: id, captureReceipt: receipt(path) }, { strict: true });
  }
  async function cohort() {
    const rows = await h.db!.sql<Array<{ payload: Record<string, unknown> }>>`
      SELECT payload FROM harness_shared.work_items WHERE feature_id = 'WI-A' AND workspace_id = ${WS}`;
    return rows[0].payload;
  }

  it('merges concurrent captured members durably across editing sessions without losing payload fields', async () => {
    await hold('WI-A');
    await h.db!.sql`UPDATE harness_shared.work_items SET payload = '{"existing":"preserved","gitSyncLifecycle":{"frozen":{"identity":"previous"}}}'::jsonb
      WHERE feature_id = 'WI-A' AND workspace_id = ${WS}`;
    await Promise.all([capturedEdit('op-a', 'a.ts'), capturedEdit('op-b', 'b.ts', 'session-2')]);
    expect(await cohort()).toEqual({ existing: 'preserved', gitSyncLifecycle: { version: 1, frozen: { identity: 'previous' },
      captures: { 'op-a': receipt('a.ts'), 'op-b': receipt('b.ts') } } });
    await capturedEdit('op-a', 'a.ts', 'restarted-session');
    expect(await cohort()).toMatchObject({ gitSyncLifecycle: {
      captures: { 'op-a': receipt('a.ts'), 'op-b': receipt('b.ts') } } });
  });

  it('refuses a changed member under the same operation key and keeps its original generation', async () => {
    await hold('WI-A');
    await capturedEdit('op-a', 'a.ts');
    await expect(capturedEdit('op-a', 'changed.ts')).rejects.toThrow('ownership-or-generation-changed');
    expect(await cohort()).toMatchObject({ gitSyncLifecycle: { captures: { 'op-a': receipt('a.ts') } } });
  });

  it('keeps settlement separate from immutable membership and never reopens it on a stale replay', async () => {
    await hold('WI-A');
    await capturedEdit('op-a', 'a.ts');
    await recordEditAttribution({ repoRoot: root, files: ['a.ts'], agentId: AGENT, workspaceId: WS,
      goalRef: 'WI-A', dispatchCallId: 'op-a', captureReceipt: { ...receipt('a.ts'), pending: false } }, { strict: true });
    await capturedEdit('op-a', 'a.ts');
    expect(await cohort()).toMatchObject({ gitSyncLifecycle: {
      captures: { 'op-a': { ...receipt('a.ts'), pending: false } } } });
  });

  it('records none when the editor holds no open work item', async () => {
    const row = await edit('PreToolUse:Edit');
    expect(row).toMatchObject({ work_item_id: null, work_item_resolution: 'none', work_item_candidates: null });
  });

  it('stamps the single held item', async () => {
    await hold('WI-A');
    const row = await edit('PreToolUse:Edit');
    expect(row).toMatchObject({ work_item_id: 'WI-A', harness_slug: 'papercusp', work_item_resolution: 'single-holder' });
  });

  it('picks the held item the lock intent names when several are held', async () => {
    await hold('WI-A');
    await hold('WI-B');
    const row = await edit('fixing WI-B stamping');
    expect(row).toMatchObject({ work_item_id: 'WI-B', work_item_resolution: 'lock-intent' });
  });

  it('falls back to the declared presence intent', async () => {
    await hold('WI-A');
    await hold('WI-B');
    h.presence = { currentPlanSlug: null, intent: 'working WI-A now' };
    const row = await edit('PreToolUse:Edit');
    expect(row).toMatchObject({ work_item_id: 'WI-A', work_item_resolution: 'declared-intent' });
  });

  it('leaves the row unstamped with candidates when nothing singles one out', async () => {
    await hold('WI-A');
    await hold('WI-B');
    const row = await edit('PreToolUse:Edit');
    expect(row.work_item_id).toBeNull();
    expect(row.work_item_resolution).toBe('ambiguous');
    expect(row.work_item_candidates).toEqual(['WI-A', 'WI-B']);
  });

  it('persists the editing session id (R-5)', async () => {
    await hold('WI-A');
    const row = await edit('PreToolUse:Edit', 'native-session-123');
    expect(row).toMatchObject({ work_item_id: 'WI-A', session_id: 'native-session-123' });
  });
});
