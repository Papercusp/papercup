/** portable-identity-packages P-010 / PORTABLE-P-010@1 — the turn-start sink
 * invocation over REAL control-anchor rows, the REAL identity source catalog, the
 * REAL capability-class registry and the REAL output validator. Only the final
 * read-only tool dispatch is replaced (there is no projected tool to run here).
 *
 * Normal case: every due contribution of every worn identity shares ONE sink
 * budget and ONE per-turn ceiling. Counterexample (the falsifier): adding
 * providers never multiplies the allowance, a result evaluated against an
 * attachment the wearer has left never renders, and a provider that cannot
 * resolve is a visible omission, never silence. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { Sql } from 'postgres';
import { layerContentHash } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { DEFAULT_SINK_HOST_LIMITS, resetSinkEvaluatorForTests } from './sink-evaluator';
import { projectPackageOrientationRows } from './package-orientation-classes';
import { evaluateTurnStartPackageSink, packageSinkReceipt } from './turn-start-package-sink';

const pg = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: pg.sql }),
}));
const dispatch = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; env: { role: string; spawnId: string; signal?: AbortSignal } }>,
  impl: null as null | ((tool: string) => Promise<unknown>),
}));
vi.mock('../events/await/predicate-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../events/await/predicate-watch')>()),
  dispatchReadOnlyTool: async (tool: string, _args: unknown, env: { role: string; spawnId: string; signal?: AbortSignal }) => {
    dispatch.calls.push({ tool, env });
    return dispatch.impl!(tool);
  },
}));

const WS = 'pkg-sink-ws';
const POT = 'pkg-sink-pot';
const NOTES_SCHEMA = {
  type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'], additionalProperties: false,
};
const APPLIED = { specificationRevision: 'spec-1', stateRevision: 'state-1' };
// The default TOKEN budgets, with a wall clock that cold module loads and fleet
// load cannot hit: these cases measure allocation and fencing, not the deadline
// (sink-evaluator.integration.test.ts owns the deadline cases).
const LIMITS = {
  ...DEFAULT_SINK_HOST_LIMITS,
  sinkBudget: { tokens: DEFAULT_SINK_HOST_LIMITS.sinkBudget.tokens, wallClockMs: 15_000 },
  turnCeiling: { tokens: DEFAULT_SINK_HOST_LIMITS.turnCeiling.tokens, wallClockMs: 30_000 },
};

describe('turn-start package sink (real anchor + catalog + class registry)', () => {
  let db: OrgTestDb;
  let root: string;

  async function registerClass(id: string, provider: string | null) {
    const sql = db.adminSql;
    await sql`
      INSERT INTO harness_shared.capability_class_registry (workspace_id, id, version, title, description, interface_verbs)
      VALUES (${WS}, ${id}, '1.0.0', ${id}, 'sink fixture',
        ${JSON.stringify({ read: { inputSchema: { type: 'object' }, outputSchema: NOTES_SCHEMA } })}::jsonb)`;
    if (!provider) return;
    const run = `run-${id}`;
    await sql`
      INSERT INTO harness_shared.capability_class_conformance_runs
        (id, workspace_id, class_id, class_version, provider_package, provider_version, registry_revision,
         verb_bindings, structural_passed, report, provider_kind, latency_class)
      VALUES (${run}, ${WS}, ${id}, '1.0.0', ${provider}, '1.0.0', 'registry-1',
        ${sql.json({ read: `${provider}:read` })}, true, '{}'::jsonb, 'tool', 'sync')`;
    await sql`
      INSERT INTO harness_shared.capability_class_provider_bindings
        (workspace_id, class_id, class_version, provider_package, provider_version, conformance_run_id,
         provider_kind, latency_class)
      VALUES (${WS}, ${id}, '1.0.0', ${provider}, '1.0.0', ${run}, 'tool', 'sync')`;
    await sql`
      INSERT INTO harness_shared.pot_capability_class_bindings
        (workspace_id, pot_slug, class_id, class_version, provider_package, provider_version, provider_kind, latency_class)
      VALUES (${WS}, ${POT}, ${id}, '1.0.0', ${provider}, '1.0.0', 'tool', 'sync')`;
  }

  const due = (id: string, ref: string, priority: number, tokenBudget: number, trigger: unknown = 'every-turn') => ({
    id, purpose: 'resource', source: 'provider', refresh: trigger === 'on-demand' ? 'on-demand' : 'turn',
    inputKind: 'capability-provider', ref, verb: 'read', producerRef: ref, availability: 'optional',
    injection: { sinks: ['turn-start'], trigger, tokenBudget, priority, overBudget: 'truncate' },
  });

  function writeIdentity(identityId: string, contributions: Array<Record<string, unknown>>) {
    const dir = join(root, 'home', 'blueprints', identityId);
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    const identity = { id: identityId, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }], contributions };
    writeFileSync(join(dir, 'blueprint.yaml'), stringifyYaml({
      ...identity, attestation: { contentHash: layerContentHash(identity), signedBy: 'approved-publisher' },
    }));
  }

  async function wear(ownerId: string, stack: string[], applied: typeof APPLIED = APPLIED) {
    await db.adminSql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_generation, control_state)
      VALUES (${ownerId}, ${WS}, 1, ${db.adminSql.json({ stack, scope: { harness: POT }, activation: { applied } })})
      ON CONFLICT (owner_id) DO UPDATE SET control_state = EXCLUDED.control_state`;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    pg.sql = db.adminSql;
    root = mkdtempSync(join(tmpdir(), 'pkg-sink-'));
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    await registerClass('context.notes', 'notes-tool');
    await registerClass('context.unbound', null);
    // Two identities, three due contributions, each asking for most of the sink.
    writeIdentity('pkg-a', [due('brief', 'context.notes@1', 90, 300)]);
    writeIdentity('pkg-b', [
      due('digest', 'context.notes@1', 50, 300),
      due('extra', 'context.notes@1', 10, 300),
      // Declared, but not due at turn start: never evaluated here.
      due('later', 'context.notes@1', 99, 300, 'on-demand'),
    ]);
    writeIdentity('pkg-unbound', [due('ghost', 'context.unbound@1', 40, 100)]);
  }, 180_000);

  beforeEach(() => {
    resetSinkEvaluatorForTests();
    dispatch.calls = [];
    dispatch.impl = async () => ({ notes: 'x'.repeat(4_000) });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    pg.sql = null;
    if (root) rmSync(root, { recursive: true, force: true });
    await db?.cleanup();
  });

  it('DIAG-TEMP resolution concurrency', async () => {
    const { resolveIdentityClassProvider } = await import('./class-provider');
    const one = () => resolveIdentityClassProvider(db.adminSql, { workspaceId: WS, potSlug: POT, classRef: 'context.notes@1', verb: 'read' })
      .then((r) => (r.ok ? 'ok' : r.code), (e) => `throw:${String(e)}`);
    const seq = [await one(), await one()];
    const par = await Promise.all([one(), one(), one()]);
    console.log('DIAG', JSON.stringify({ seq, par, options: (db.adminSql as unknown as { options?: { max?: number } }).options?.max }));
    const { defaultTurnStartPackageSinkDeps } = await import('./turn-start-package-sink');
    const real = defaultTurnStartPackageSinkDeps();
    await wear('owner-diag', ['domain:pkg-a', 'domain:pkg-b']);
    const log: unknown[] = [];
    await evaluateTurnStartPackageSink({ ownerId: 'owner-diag', workspaceId: WS, turnId: 'd1', deps: { limits: LIMITS,
      readDueContributions: async (id) => { const r = await real.readDueContributions(id); log.push({ due: id, r }); return r; },
      produceContext: async (call) => {
        const { getOrgPg } = await import('@papercusp/db-org');
        const s = getOrgPg().sql;
        log.push({ id: call.contribution.id, sameSql: s === db.adminSql, pre: await one() });
        const { signal: _s, ...rest } = call;
        try { const out = await real.produceContext(call); log.push({ call: rest, ok: true }); return out; }
        catch (e) { log.push({ call: rest, err: String(e) }); throw e; }
      } } });
    console.log('DIAG2', JSON.stringify(log));
    const after = await one();
    const rows = await db.adminSql`SELECT workspace_id, id, version, status, created_at FROM harness_shared.capability_class_registry WHERE id LIKE 'context.%' ORDER BY id`;
    console.log('DIAG3', JSON.stringify({ after, rows }));
    const par2 = await Promise.all([one(), one(), one(), one()]);
    const [c1, c2] = [await db.adminSql.reserve(), await db.adminSql.reserve()].map((c) => c);
    const probe = async (c: typeof c1) => (await c`SELECT current_user AS u, session_user AS su, current_setting('search_path') AS sp,
      current_setting('transaction_isolation') AS iso, pg_backend_pid() AS pid,
      (SELECT count(*) FROM harness_shared.capability_class_registry) AS n,
      (SELECT relrowsecurity FROM pg_class WHERE oid = 'harness_shared.capability_class_registry'::regclass) AS rls`)[0];
    console.log('DIAG4', JSON.stringify({ par2, c1: await probe(c1), c2: await probe(c2) }));
    c1.release(); c2.release();
  }, 120_000);

  it('shares ONE aggregate budget across every worn identity, in priority order, and renders it', async () => {
    await wear('owner-agg', ['domain:pkg-a', 'domain:pkg-b']);
    const sink = await evaluateTurnStartPackageSink({ ownerId: 'owner-agg', workspaceId: WS, deps: { limits: LIMITS }, turnId:'t1' });
    const result = sink.result!;
    expect(result.budget.tokens).toBe(DEFAULT_SINK_HOST_LIMITS.sinkBudget.tokens);
    // Three requests of 300 against a 400 pool: allocation never exceeds the pool.
    expect(result.allocation).toEqual([
      { identityId: 'pkg-a', contributionId: 'brief', allowance: 300 },
      { identityId: 'pkg-b', contributionId: 'digest', allowance: 100 },
      { identityId: 'pkg-b', contributionId: 'extra', allowance: 0 },
    ]);
    expect(result.allocation.reduce((sum, row) => sum + row.allowance, 0)).toBeLessThanOrEqual(400);
    expect(result.deliveredTokens).toBeLessThanOrEqual(400);
    expect(result.omissions).toEqual([expect.objectContaining({
      identityId: 'pkg-b', contributionId: 'extra', reason: 'budget-exhausted',
    })]);
    // The contribution granted nothing was never started — no provider call for it.
    expect(result.started).toBe(2);
    expect(dispatch.calls.map((call) => call.tool)).toEqual(['notes-tool:read', 'notes-tool:read']);
    expect(dispatch.calls.every((call) => call.env.role === 'su' && call.env.spawnId === 'identity-sink:turn-start'
      && call.env.signal instanceof AbortSignal)).toBe(true);
    // Output passed the pinned contract schema and carries the provider's provenance.
    const brief = result.deliveries.find((row) => row.contributionId === 'brief')!;
    expect(brief.truncated).toBe(true);
    expect(brief.text).toContain('"classRef":"context.notes@1.0.0"');
    expect(brief.text).toContain('"providerRef":"notes-tool@1.0.0"');
    // Rendered: a disjoint package class id per contribution, the omission visible.
    const rows = projectPackageOrientationRows(sink.classes, 'turn-start').map((row) => row.text);
    expect(sink.classes.map((cls) => cls.id)).toEqual([
      'package:pkg-a/brief', 'package:pkg-b/digest', 'package:pkg-b/extra',
    ]);
    expect(rows.some((text) => text.includes('pkg-b/extra omitted: budget-exhausted'))).toBe(true);
    // The persisted receipt names every allowance and hashes what it delivered.
    const receipt = packageSinkReceipt(sink)!;
    expect(receipt).toMatchObject({ status: 'rendered', turnId: 't1', attachmentRevision: 'spec-1:state-1' });
    expect(receipt.deliveries).toContainEqual(expect.objectContaining({
      contributionId: 'brief', outputRevision: createHash('sha256').update(brief.text).digest('hex'),
    }));
  }, 120_000);

  it('adding providers never multiplies the sink, and the turn ceiling caps a second invocation', async () => {
    await wear('owner-one', ['domain:pkg-a']);
    const alone = (await evaluateTurnStartPackageSink({ ownerId: 'owner-one', workspaceId: WS, deps: { limits: LIMITS }, turnId:'solo' })).result!;
    await wear('owner-many', ['domain:pkg-a', 'domain:pkg-b', 'domain:pkg-unbound']);
    const many = (await evaluateTurnStartPackageSink({ ownerId: 'owner-many', workspaceId: WS, deps: { limits: LIMITS }, turnId:'m1' })).result!;
    expect(many.budget.tokens).toBe(alone.budget.tokens);
    expect(many.allocation.reduce((sum, row) => sum + row.allowance, 0)).toBeLessThanOrEqual(many.budget.tokens);
    // Same session, same turn: the second sink invocation gets only what the ceiling has left.
    const again = (await evaluateTurnStartPackageSink({ ownerId: 'owner-many', workspaceId: WS, deps: { limits: LIMITS }, turnId:'m1' })).result!;
    expect(again.budget.tokens).toBe(Math.min(
      DEFAULT_SINK_HOST_LIMITS.sinkBudget.tokens,
      DEFAULT_SINK_HOST_LIMITS.turnCeiling.tokens - many.deliveredTokens,
    ));
    expect(many.deliveredTokens + again.deliveredTokens).toBeLessThanOrEqual(DEFAULT_SINK_HOST_LIMITS.turnCeiling.tokens);
  }, 120_000);

  it('never renders a result the wearer left mid-invocation (generation fence)', async () => {
    await wear('owner-fence', ['domain:pkg-a']);
    dispatch.impl = async () => {
      // The wearer re-attaches while the provider is running.
      await wear('owner-fence', ['domain:pkg-a'], { specificationRevision: 'spec-2', stateRevision: 'state-2' });
      return { notes: 'late' };
    };
    const sink = await evaluateTurnStartPackageSink({ ownerId: 'owner-fence', workspaceId: WS, deps: { limits: LIMITS }, turnId:'f1' });
    expect(sink.result?.invocation.attachmentRevision).toBe('spec-1:state-1');
    expect(sink.classes).toEqual([]);
    expect(packageSinkReceipt(sink)).toMatchObject({ status: 'fenced' });
  }, 120_000);

  it('renders an unresolvable provider as a visible omission, never silence', async () => {
    await wear('owner-unbound', ['domain:pkg-unbound']);
    const sink = await evaluateTurnStartPackageSink({ ownerId: 'owner-unbound', workspaceId: WS, deps: { limits: LIMITS }, turnId:'u1' });
    expect(dispatch.calls).toEqual([]);
    expect(sink.result!.omissions).toEqual([expect.objectContaining({
      contributionId: 'ghost', reason: 'provider-error', detail: 'capability-class:class-unbound',
    })]);
    const rows = projectPackageOrientationRows(sink.classes, 'turn-start').map((row) => row.text);
    expect(rows).toEqual(['- ⟦pkg-unbound/ghost omitted: provider-error⟧']);
  }, 120_000);

  it('is a no-op for a wearer that declares nothing due, and for an unknown session', async () => {
    await wear('owner-builtin', ['autonomy:su.mode-auto']);
    expect(await evaluateTurnStartPackageSink({ ownerId: 'owner-builtin', workspaceId: WS, deps: { limits: LIMITS }, turnId:'n1' }))
      .toEqual({ result: null, classes: [] });
    expect(await evaluateTurnStartPackageSink({ ownerId: 'owner-nobody', workspaceId: WS, deps: { limits: LIMITS }, turnId:'n2' }))
      .toEqual({ result: null, classes: [] });
    expect(dispatch.calls).toEqual([]);
  }, 120_000);
});
