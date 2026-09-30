/**
 * The author preview against the runtime (portable-identity-packages-2026-09-26
 * P-015, D-033; spec AUTO-BAR-R-7-P-015).
 *
 * Falsifier: the preview disagrees with runtime delivery, or omits a grant, a
 * rule, a visibility change, a shared dependent or a preserved edit. Every case
 * here runs the real runtime path beside previewIdentity over the same pot,
 * catalog, rule package and receipts, and compares what each produced.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { Sql } from 'postgres';
import { layerContentHash, pinPackageInput, resolveBlueprint } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { compileBlueprintWithPackages } from '../blueprint/compile-packages';
import { planRecipePackageResource, prepareRecipePackageResource } from '../blueprint/package-recipe-resources';
import { applyPackageResourceDependent, beginPackageInstallation } from '../blueprint/package-resource-receipts';
import { toolGuardText } from '../endpoint-route/routes/agent-mcp/identity-hook-sinks';
import { identityRevisionTag } from './identity-async-rules';
import { previewIdentity } from './identity-preview';
import { appendPackageOrientationRows } from './package-orientation-classes';
import { DEFAULT_SINK_HOST_LIMITS, resetSinkEvaluatorForTests } from './sink-evaluator';
import { evaluateTurnStartPackageSink } from './turn-start-package-sink';

const pg = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: pg.sql }),
}));
// The runtime's provider call. The preview never reaches it: it substitutes the sample.
const dispatch = vi.hoisted(() => ({ calls: 0, value: null as unknown }));
vi.mock('../events/await/predicate-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../events/await/predicate-watch')>()),
  dispatchReadOnlyTool: async () => { dispatch.calls += 1; return dispatch.value; },
}));

const WS = 'identity-preview-ws';
const POT = 'identity-preview-pot';
const NOTES_SCHEMA = {
  type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'], additionalProperties: false,
};
const APPLIED = { specificationRevision: 'spec-1', stateRevision: 'state-1' };
// Default token budgets with a wall clock fleet load cannot hit (see turn-start-package-sink.integration.test.ts).
const LIMITS = {
  ...DEFAULT_SINK_HOST_LIMITS,
  sinkBudget: { tokens: DEFAULT_SINK_HOST_LIMITS.sinkBudget.tokens, wallClockMs: 15_000 },
  turnCeiling: { tokens: DEFAULT_SINK_HOST_LIMITS.turnCeiling.tokens, wallClockMs: 30_000 },
};
const NO_RM = {
  schemaVersion: 1, id: 'no-rm', title: 'no-rm', description: 'no-rm guard', version: '1.0.0', delivery: 'sync', sink: 'pre-tool',
  tools: ['capability:bash'], guard: { deny: { 'input.command': { matches: 'rm -rf' } }, reason: 'no recursive deletes' },
};

describe('identity preview (runtime sink, worn guard and package receipts side by side)', () => {
  let db: OrgTestDb;
  let root: string;
  let nextSessionId = 9700;

  async function registerClass(id: string, provider: string | null) {
    const sql = db.adminSql;
    await sql`
      INSERT INTO harness_shared.capability_class_registry (workspace_id, id, version, title, description, interface_verbs)
      VALUES (${WS}, ${id}, '1.0.0', ${id}, 'preview fixture',
        ${JSON.stringify({ read: { inputSchema: { type: 'object' }, outputSchema: NOTES_SCHEMA } })}::jsonb)`;
    if (!provider) return;
    const run = `run-${id}`;
    await sql`
      INSERT INTO harness_shared.capability_class_conformance_runs
        (id, workspace_id, class_id, class_version, provider_package, provider_version, registry_revision,
         verb_bindings, structural_passed, report, provider_kind, latency_class)
      VALUES (${run}, ${WS}, ${id}, '1.0.0', ${provider}, '1.0.0', 'registry-1',
        ${sql.json({ read: `${provider}:read` })}, true, ${sql.json({})}, 'tool', 'sync')`;
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

  const due = (id: string, priority: number, tokenBudget: number, trigger: unknown = 'every-turn') => ({
    id, purpose: 'resource', source: 'provider', refresh: trigger === 'on-demand' ? 'on-demand' : 'turn',
    inputKind: 'capability-provider', ref: 'context.notes@1', verb: 'read', producerRef: 'context.notes@1',
    availability: 'optional', injection: { sinks: ['turn-start'], trigger, tokenBudget, priority, overBudget: 'truncate' },
  });

  function writeIdentity(identityId: string, fields: Record<string, unknown>) {
    const dir = join(root, 'home', 'blueprints', identityId);
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    const identity = { id: identityId, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }], ...fields };
    writeFileSync(join(dir, 'blueprint.yaml'), stringifyYaml({
      ...identity, attestation: { contentHash: layerContentHash(identity), signedBy: 'approved-publisher' },
    }));
  }

  async function wear(ownerId: string, stack: string[], applied: typeof APPLIED = APPLIED, artifact?: unknown) {
    if (artifact) {
      await db.adminSql`INSERT INTO harness_shared.adv_sessions (id,workspace_id,mode,coord_owner_id,session_id,started_at,launch_spec)
        VALUES (${nextSessionId++},${WS},'console',${ownerId},${`native-${ownerId}`},now(),
          ${JSON.stringify({ ...applied, specificationArtifact: artifact })}::text::jsonb)`;
    }
    await db.adminSql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_generation, control_state)
      VALUES (${ownerId}, ${WS}, 1, ${db.adminSql.json({ stack, scope: { harness: POT }, activation: { applied } })})
      ON CONFLICT (owner_id) DO UPDATE SET control_state = EXCLUDED.control_state`;
  }

  /** The runtime delivery, rendered exactly as turn-start-memory renders the package rows. */
  async function runtimeTurnStart(ownerId: string, limits = LIMITS) {
    const sink = await evaluateTurnStartPackageSink({ ownerId, workspaceId: WS, deps: { limits }, turnId: `${ownerId}:t` });
    expect(sink.error).toBeUndefined();
    const text = appendPackageOrientationRows('', sink.classes).packageRows.map((row) => row.text).join('\n');
    return { text, result: sink.result! };
  }

  async function previewTurnStart(samples: Record<string, string>, limits = LIMITS) {
    const preview = await previewIdentity({ workspaceId: WS, potSlug: POT, identityId: 'previewed', samples, limits });
    return { preview, turn: preview.injection!.sinks.find((sink) => sink.sink === 'turn-start')! };
  }

  /** Every runtime-owned fact of one delivery the preview claims to reproduce. */
  const delivered = (result: { allocation: unknown; deliveredTokens: number;
    deliveries: ReadonlyArray<{ contributionId: string; allowance: number; tokens: number; truncated: boolean }>;
    omissions: ReadonlyArray<{ contributionId: string; reason: string; marker: string }> }) => ({
    allocation: result.allocation,
    deliveredTokens: result.deliveredTokens,
    deliveries: result.deliveries.map(({ contributionId, allowance, tokens, truncated }) =>
      ({ contributionId, allowance, tokens, truncated })),
    omissions: result.omissions.map(({ contributionId, reason, marker }) => ({ contributionId, reason, marker })),
  });

  beforeAll(async () => {
    db = await createOrgTestDb();
    pg.sql = db.adminSql;
    root = mkdtempSync(join(tmpdir(), 'identity-preview-'));
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    // An installed rule package, where the cupboard puts one (the user layer of rule-store.ts).
    const rule = join(root, 'home', 'rules', 'installed', 'no-rm');
    mkdirSync(rule, { recursive: true });
    writeFileSync(join(rule, 'rule.json'), JSON.stringify(NO_RM));
    writeFileSync(join(rule, 'listing.json'), JSON.stringify({ kind: 'rule', version: '1.0.0' }));
    await registerClass('context.notes', 'notes-tool');
    await registerClass('context.absent', null);
    writeIdentity('previewed', { contributions: [
      due('brief', 90, 300),
      due('digest', 50, 300),
      due('later', 99, 300, 'on-demand'),
    ] });
    writeIdentity('guarded', { bundles: [{ kind: 'rule', ref: 'no-rm' }] });
  }, 180_000);

  beforeEach(() => {
    resetSinkEvaluatorForTests();
    dispatch.calls = 0;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    pg.sql = null;
    if (root) rmSync(root, { recursive: true, force: true });
    await db?.cleanup();
  });

  it('renders byte-for-byte what the runtime delivers, and moves with it when the sample or budget changes', async () => {
    const cases = [
      { owner: 'owner-long', value: { notes: 'x'.repeat(4_000) }, limits: LIMITS },
      { owner: 'owner-short', value: { notes: 'a short note' }, limits: LIMITS },
      { owner: 'owner-tight', value: { notes: 'x'.repeat(4_000) },
        limits: { ...LIMITS, sinkBudget: { ...LIMITS.sinkBudget, tokens: 150 } } },
    ];
    const texts: string[] = [];
    for (const { owner, value, limits } of cases) {
      await wear(owner, ['domain:previewed']);
      dispatch.value = value;
      const runtime = await runtimeTurnStart(owner, limits);
      const sample = JSON.stringify(value);
      const { turn } = await previewTurnStart({ brief: sample, digest: sample }, limits);
      expect(turn.error).toBeUndefined();
      expect(turn.text).toBe(runtime.text);
      expect(delivered(turn)).toEqual(delivered(runtime.result));
      texts.push(runtime.text);
    }
    // The runtime really called the provider for each case; the preview never did.
    expect(dispatch.calls).toBeGreaterThanOrEqual(cases.length);
    // Each change is visible: three distinct deliveries, each reproduced above.
    expect(new Set(texts).size).toBe(3);
    // The tight budget left the second contribution nothing, and both sides say so.
    const tight = await previewTurnStart({ brief: '{"notes":"x"}', digest: '{"notes":"x"}' },
      { ...LIMITS, sinkBudget: { ...LIMITS.sinkBudget, tokens: 150 } });
    expect(tight.turn.omissions).toEqual([expect.objectContaining({ contributionId: 'digest', reason: 'budget-exhausted' })]);
  }, 180_000);

  it('shows every contribution timing and the class provider pin it resolves to in this pot', async () => {
    const { preview } = await previewTurnStart({ brief: '{"notes":"n"}', digest: '{"notes":"n"}' });
    expect(preview.injection!.timing).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'contribution', id: 'brief', timing: 'every-turn', tokenBudget: 300, priority: 90 }),
      expect.objectContaining({ kind: 'contribution', id: 'later', timing: 'on-demand' }),
    ]));
    expect(preview.declared!.classPins).toEqual([expect.objectContaining({
      providerPackage: 'notes-tool', providerVersion: '1.0.0', conformanceRunId: 'run-context.notes', verbs: ['read'],
    })]);
    // Consent names what install asks, destination-independently: the class read
    // through whichever provider the pot binds (D-034). No grant, so no binding is written.
    expect(preview.consent).toMatchObject({ contentOnly: false, contextReads: ['context.notes@1 read'], providerBindings: [] });
  }, 120_000);

  it('names a required grant the pot cannot satisfy, in validation, the declared surface and consent', async () => {
    const preview = await previewIdentity({ workspaceId: WS, potSlug: POT, source: {
      id: 'granted', extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
      grants: { requires: ['context.absent@1.0.0'] },
    } });
    expect(preview.ok).toBe(false);
    expect(preview.validation.errors).toContainEqual(expect.objectContaining({
      source: 'grants', code: 'required_capability_provider_absent', ref: 'context.absent@1.0.0',
    }));
    expect(preview.declared!.grants.requires).toEqual(['context.absent@1.0.0']);
    expect(preview.consent!.grants).toEqual(['context.absent@1.0.0']);
    expect(preview.consent!.contentOnly).toBe(false);
  }, 120_000);

  it('shows a bundled guard rule, its visibility and its verdict, and the runtime guard agrees', async () => {
    const pendingDelete = { tool: 'capability:bash', input: { command: 'rm -rf /tmp/scratch' } };
    const pendingList = { tool: 'capability:bash', input: { command: 'ls /tmp' } };
    const preview = await previewIdentity({ workspaceId: WS, potSlug: POT, identityId: 'guarded', pendingCall: pendingDelete });
    expect(preview.validation.errors.map((issue) => `${issue.source}/${issue.code}: ${issue.message}`)).toEqual([]);
    expect(preview.declared!.rules.unreadable).toEqual([]);
    expect(preview.declared!.rules.sync).toEqual([expect.objectContaining({
      id: 'no-rm', sink: 'pre-tool', kind: 'guard', tools: ['capability:bash'],
    })]);
    expect(preview.declared!.visibility).toContainEqual(expect.objectContaining({
      packageKind: 'rule', ref: 'no-rm', visibleTo: 'the wearer\'s own hooks only',
    }));
    expect(preview.injection!.timing).toContainEqual(expect.objectContaining({
      kind: 'sync-rule', id: 'no-rm', timing: 'at pre-tool', tools: ['capability:bash'],
    }));
    expect(preview.consent!.rules).toEqual(['no-rm (guard at pre-tool)']);
    expect(preview.injection!.preTool).toMatchObject({ decision: 'deny', ruleId: 'no-rm', reason: 'no recursive deletes' });
    const allowed = await previewIdentity({ workspaceId: WS, potSlug: POT, identityId: 'guarded', pendingCall: pendingList });
    expect(allowed.injection!.preTool).toEqual({ decision: 'none' });

    // The runtime: a wearer launched on an artifact carrying the same installed rule package.
    const source = resolveBlueprint({ id: 'guarded', bundles: [{ kind: 'rule', ref: 'no-rm' }],
      workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } });
    const artifact = await compileBlueprintWithPackages(source, { workspaceId: WS, harnessSlug: POT });
    const applied = { specificationRevision: artifact.specificationRevision, stateRevision: 'state-guarded' };
    await wear('owner-guarded', ['domain:guarded'], applied, artifact);
    const guard = (call: typeof pendingDelete) =>
      toolGuardText({ ownerId: 'owner-guarded', workspaceId: WS, call: { ...call, client: 'claude' } });
    expect(await guard(pendingDelete)).toContain('no recursive deletes');
    expect(await guard(pendingList)).not.toContain('no recursive deletes');
  }, 180_000);

  it('predicts what release keeps: a shared resource, a preserved edit, and removes only the pristine one', async () => {
    const sql = db.adminSql;
    const recipe = (id: string) => pinPackageInput({
      packageKind: 'recipe', ref: id, revision: '1.0.0', files: [{ path: 'recipe.json', bytes: id }],
      value: { id, title: id, description: `${id} fixture`, script: 'return 1;', toolsUsed: [], tags: [] },
    });
    const pins = { shared: recipe('preview-shared'), edited: recipe('preview-edited'), pristine: recipe('preview-pristine') };
    async function install(ownerId: string, dependentId: string, installed: Array<ReturnType<typeof recipe>>) {
      const expectedResources = new Map(installed.map((pin) => {
        const planned = planRecipePackageResource(pin, WS);
        return [planned.resourceKey, planned.address.installedHash] as const;
      }));
      await beginPackageInstallation(sql, { workspaceId: WS, dependentId, ownerId,
        specificationRevision: `spec-${ownerId}`, stateRevision: 'state-1', expectedResources });
      for (const pin of installed) await prepareRecipePackageResource(sql, { pin, workspaceId: WS, dependentId });
      await sql.begin((tx) => applyPackageResourceDependent(tx, WS, dependentId, expectedResources));
    }
    await wear('owner-life', ['domain:previewed'], { specificationRevision: 'spec-owner-life', stateRevision: 'state-1' });
    await install('owner-life', 'dep-life', [pins.shared, pins.edited, pins.pristine]);
    await install('owner-other', 'dep-other', [pins.shared]);
    // The operator edits one installed recipe after the install.
    await sql`UPDATE harness_shared.code_recipes SET script = 'return 2;' WHERE id = 'preview-edited'`;

    const preview = await previewIdentity({ workspaceId: WS, potSlug: POT, identityId: 'previewed',
      samples: { brief: '{"notes":"n"}', digest: '{"notes":"n"}' }, ownerId: 'owner-life' });
    const lifecycle = preview.lifecycle!;
    expect(lifecycle.error).toBeUndefined();
    expect(lifecycle.revisionTag).toBe(identityRevisionTag('spec-owner-life'));
    const outcome = Object.fromEntries(lifecycle.resources.map((row) => [row.itemKey, row]));
    expect(outcome['preview-shared']).toMatchObject({ dependentId: 'dep-life', onRelease: 'kept-shared', sharedWith: 1 });
    expect(outcome['preview-edited']).toMatchObject({ onRelease: 'kept-edited', sharedWith: 0 });
    expect(outcome['preview-pristine']).toMatchObject({ onRelease: 'removed', sharedWith: 0 });
    expect(lifecycle.resources).toHaveLength(3);
  }, 180_000);
});
