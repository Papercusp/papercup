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

  async function registerClass(id: string, provider: string | null, kind: 'tool' | 'recipe' = 'tool') {
    const sql = db.adminSql;
    await sql`
      INSERT INTO harness_shared.capability_class_registry (workspace_id, id, version, title, description, interface_verbs)
      VALUES (${WS}, ${id}, '1.0.0', ${id}, 'sink fixture',
        ${JSON.stringify({ read: { inputSchema: { type: 'object' }, outputSchema: NOTES_SCHEMA } })}::jsonb)`;
    if (!provider) return;
    const run = `run-${id}`;
    // A recipe row carries the inspected evidence class-provider.ts requires to admit it.
    const report = kind === 'recipe'
      ? { schemaVersion: 'capability-class-recipe-v1', recipes: { read: {
        ok: true, recipe: { id: `${provider}:read`, revision: 'a'.repeat(64) },
        inspectionPin: { sourceSha256: 'b'.repeat(64), bindingsSha256: 'c'.repeat(64), recipeRevision: 'a'.repeat(64) },
        toolNames: ['notes:read'], requiredCapabilities: ['notes:read'], outputSchema: NOTES_SCHEMA } } }
      : {};
    await sql`
      INSERT INTO harness_shared.capability_class_conformance_runs
        (id, workspace_id, class_id, class_version, provider_package, provider_version, registry_revision,
         verb_bindings, structural_passed, report, provider_kind, latency_class)
      VALUES (${run}, ${WS}, ${id}, '1.0.0', ${provider}, '1.0.0', 'registry-1',
        ${sql.json({ read: `${provider}:read` })}, true, ${sql.json(report)}, ${kind}, 'sync')`;
    await sql`
      INSERT INTO harness_shared.capability_class_provider_bindings
        (workspace_id, class_id, class_version, provider_package, provider_version, conformance_run_id,
         provider_kind, latency_class)
      VALUES (${WS}, ${id}, '1.0.0', ${provider}, '1.0.0', ${run}, ${kind}, 'sync')`;
    await sql`
      INSERT INTO harness_shared.pot_capability_class_bindings
        (workspace_id, pot_slug, class_id, class_version, provider_package, provider_version, provider_kind, latency_class)
      VALUES (${WS}, ${POT}, ${id}, '1.0.0', ${provider}, '1.0.0', ${kind}, 'sync')`;
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
    await registerClass('context.recipe', 'notes-recipe', 'recipe');
    // Two identities, three due contributions, each asking for most of the sink.
    writeIdentity('pkg-a', [due('brief', 'context.notes@1', 90, 300)]);
    writeIdentity('pkg-b', [
      due('digest', 'context.notes@1', 50, 300),
      due('extra', 'context.notes@1', 10, 300),
      // Declared, but not due at turn start: never evaluated here.
      due('later', 'context.notes@1', 99, 300, 'on-demand'),
    ]);
    writeIdentity('pkg-unbound', [due('ghost', 'context.unbound@1', 40, 100)]);
    writeIdentity('pkg-recipe', [due('pinned', 'context.recipe@1', 40, 100)]);
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

  it('omits an inspected recipe binding visibly and dispatches nothing until the wearer resolver exists (P-013 D-020)', async () => {
    await wear('owner-recipe', ['domain:pkg-recipe']);
    const sink = await evaluateTurnStartPackageSink({ ownerId: 'owner-recipe', workspaceId: WS, deps: { limits: LIMITS }, turnId:'r1' });
    expect(dispatch.calls).toEqual([]);
    expect(sink.result!.omissions).toEqual([expect.objectContaining({
      contributionId: 'pinned', reason: 'provider-error', detail: 'capability-class:recipe-wearer-unavailable',
    })]);
    const rows = projectPackageOrientationRows(sink.classes, 'turn-start').map((row) => row.text);
    expect(rows).toEqual(['- ⟦pkg-recipe/pinned omitted: provider-error⟧']);
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
