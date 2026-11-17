import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import { prepareRuntimeBlockerBinding, prepareReviewedRuntimeBlockerBinding, runtimeBindingSha256,
  readRuntimeBlockerCondition, readRuntimeToolSchemaIdentity } from './runtime-blocker-condition';

const mocks = vi.hoisted(() => ({ identity: vi.fn(), health: vi.fn(), tools: vi.fn(),
  approvalSql: vi.fn(), lineage: vi.fn(), screen: vi.fn(), eligible: vi.fn() }));
vi.mock('./serving-host-identity', () => ({ getServingHostIdentity: mocks.identity }));
vi.mock('./observability/runtime', () => ({ runtimeObservabilityHealth: mocks.health }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: mocks.approvalSql }),
}));
vi.mock('./acceptance-author-identity', () => ({
  acceptanceLineageClosure: mocks.lineage,
}));
vi.mock('./rubrics', () => ({ resolveAcceptanceBarApproverScreen: mocks.screen }));
vi.mock('@papercusp/tooldef', async original => ({
  ...await original<typeof import('@papercusp/tooldef')>(), listAllProjectedTools: mocks.tools,
}));

const inputSchema = { type: 'object', properties: { acceptance: { type: 'object' } }, additionalProperties: false };
const binding = { schemaVersion: 1 as const, host: 'port-3170',
  sourceBlobs: { 'packages/operator-core/lib/agent-tools/improvements/agent-review.ts': 'a'.repeat(40) },
  toolSchema: { tool: 'improvements:agent-review', sha256: createHash('sha256').update(canonicalJson(inputSchema)).digest('hex') },
  reason: 'Bind the original source and schema condition explicitly', reasonRef: 'EI-parent#comment:123' };
const blocker = { kind: 'runtime' as const, capability: 'live-dependency' as const, capabilitySource: 'explicit' as const,
  ref: 'staging-operator', summary: 'Accepted source and public schema must be loaded', status: 'active' as const,
  createdAt: '2026-11-07T01:00:00Z', updatedAt: '2026-11-07T01:00:00Z', createdBy: 'su-a' };
const bound = { ...blocker, runtimeConditionBinding: { ...binding, boundBy: 'su-a', boundAt: '2026-11-07T02:00:00Z' } };
const item = { id: 'WI-1', state: 'blocked', assignee: 'su-a', payload: { keep: true, externalBlockers: [blocker] } };
const artifact = { status: 'measured', sourceSha: 'c'.repeat(40), bundleSha256: 'd'.repeat(64),
  manifestSha256: 'e'.repeat(64), sourceBlobs: binding.sourceBlobs, evidenceRef: 'immutable-manifest' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lineage.mockResolvedValue(new Set(['su-reviewer']));
  mocks.eligible.mockResolvedValue({ eligible: true });
  mocks.screen.mockResolvedValue({ subjectPlan: 'recovery-plan', check: mocks.eligible });
  mocks.identity.mockReturnValue({ host: 'port-3170', processId: 'linux:boot:123', buildSha: 'c'.repeat(10) });
  mocks.health.mockReturnValue({ artifact });
  mocks.tools.mockReturnValue([{ name: 'improvements:agent-review', expose: { mcp: { name: 'improvements:agent-review' } }, inputSchema }]);
});

describe('audited runtime blocker binding preparation', () => {
  it('adds immutable host-authored provenance while retaining the original active blocker', () => {
    const result = prepareRuntimeBlockerBinding(item, blocker.ref, binding, 'su-a', '2026-11-07T02:00:00Z');
    expect(result).toMatchObject({ ok: true, changed: true, blockers: [bound] });
    expect(item.payload.externalBlockers).toEqual([blocker]);
  });
  it('makes an exact retry a no-op and refuses rebinding or malformed stored metadata', () => {
    const current = { ...item, payload: { externalBlockers: [bound] } };
    expect(prepareRuntimeBlockerBinding(current, blocker.ref, binding, 'su-a')).toMatchObject({ ok: true, changed: false });
    expect(prepareRuntimeBlockerBinding(current, blocker.ref, { ...binding, host: 'port-3070' }, 'su-a')).toMatchObject({ ok: false });
    expect(prepareRuntimeBlockerBinding({ ...current, payload: { externalBlockers: [{ ...bound,
      runtimeConditionBinding: { corrupted: true } }] } }, blocker.ref, binding, 'su-a')).toMatchObject({ ok: false });
  });
  it.each([{ assignee: 'su-b' }, { state: 'done' }, { payload: { externalBlockers: [] } },
    { payload: { externalBlockers: [{ ...blocker, kind: 'human' }] } }])('refuses invalid custody or target: %j', change => {
    expect(prepareRuntimeBlockerBinding({ ...item, ...change }, blocker.ref, binding, 'su-a')).toMatchObject({ ok: false });
  });
  it.each([{ sourceBlobs: {} }, { sourceBlobs: { '../escape.ts': 'a'.repeat(40) } },
    { boundBy: 'forged' }, { toolSchema: { tool: 'improvements:agent-review', sha256: 'wrong' } }])(
    'rejects unbound/malformed source or caller-authored provenance: %j', change => {
      expect(prepareRuntimeBlockerBinding(item, blocker.ref, { ...binding, ...change }, 'su-a')).toMatchObject({ ok: false });
    });
});

describe('reviewed serving-runtime binding upgrades', () => {
  const current = { ...item, harness: 'papercusp', sourcePlanSlug: 'recovery-plan',
    payload: { keep: true, externalBlockers: [bound] } };
  const actor = { ownerId: 'su-a', workspaceId: 'workspace-a' };
  const next = { ...binding, sourceBlobs: Object.fromEntries(Object.keys(binding.sourceBlobs).map(path => [path, 'f'.repeat(40)])),
    toolSchema: { ...binding.toolSchema, sha256: '1'.repeat(64) }, reason: 'Reviewed exact pin upgrade', reasonRef: 'EI-upgrade#proof' };
  const request = { expectedBindingSha256: runtimeBindingSha256(bound.runtimeConditionBinding), binding: next };
  const apply = { ...request, approvalRef: 'thread-post:123' };
  const now = () => '2026-11-17T04:00:00.000Z';
  const prepare = (target: Parameters<typeof prepareReviewedRuntimeBlockerBinding>[0] = current, input: unknown = request) =>
    prepareReviewedRuntimeBlockerBinding(target, blocker.ref, input, actor, { now });
  async function approve() {
    const preview = await prepare();
    if (!preview.ok || !('preview' in preview)) throw new Error('preview refused');
    mocks.approvalSql.mockImplementation(async (sql: TemplateStringsArray) => sql.join('').includes('harness_plans')
      ? [{ acceptance_bar_rubric_slug: 'acceptance-recovery-plan' }]
      : [{ author_id: 'su-reviewer', body: JSON.stringify(preview.preview), created_at: new Date('2026-11-17T03:00:00Z') }]);
    return preview.preview;
  }
  it('previews the scoped effect without reading approval or changing the blocker', async () => {
    expect(await prepare()).toMatchObject({ ok: true, changed: false, preview: {
      schemaVersion: 'runtime-binding-transition-v1', workspaceId: 'workspace-a', harness: 'papercusp',
      workItemId: 'WI-1', custodianId: 'su-a', ref: blocker.ref, binding: next,
      expectedBindingSha256: request.expectedBindingSha256,
      expectedBlockersSha256: runtimeBindingSha256(current.payload.externalBlockers),
    } });
    expect(mocks.approvalSql).not.toHaveBeenCalled();
    expect(mocks.lineage).not.toHaveBeenCalled();
    expect(current.payload.externalBlockers).toEqual([bound]);
  });
  it('authenticates the local post and retains old/new provenance on the active alias', async () => {
    const receipt = await approve();
    expect(await prepare(current, apply)).toMatchObject({ ok: true, changed: true, blockers: [{ ...bound, status: 'active',
      runtimeConditionBinding: { ...next, boundBy: 'su-a', boundAt: now() },
      runtimeConditionBindingTransitions: [{ receipt, priorBinding: bound.runtimeConditionBinding,
        approvedBy: 'su-reviewer', approvedAt: '2026-11-17T03:00:00.000Z', appliedBy: 'su-a', appliedAt: now() }],
    }] });
    const [sql, workspace, postId] = mocks.approvalSql.mock.calls[0];
    expect(sql.join('?')).toContain("origin = 'local'");
    expect(sql.join('?')).toContain('workspace_id = ?');
    expect([workspace, postId]).toEqual(['workspace-a', '123']);
    expect(mocks.screen).toHaveBeenCalledWith({ rubricId: 'acceptance-recovery-plan', applierId: 'su-a' });
    expect(mocks.eligible).toHaveBeenCalledWith('su-reviewer');
    expect(current.payload.externalBlockers).toEqual([bound]);
    expect(mocks.health).not.toHaveBeenCalled();
  });
  it('makes an exact retry a no-op without a second approval read or audit entry', async () => {
    await approve();
    const result = await prepare(current, apply);
    if (!result.ok || !result.changed) throw new Error('apply refused');
    mocks.approvalSql.mockClear();
    expect(await prepare({ ...current, payload: { keep: true, externalBlockers: result.blockers } } as typeof current, apply))
      .toEqual({ ok: true, changed: false, replayed: true });
    expect(mocks.approvalSql).not.toHaveBeenCalled();
  });
  it.each([
    { binding: { ...next, host: 'port-3070' } },
    { binding: { ...next, toolSchema: { ...next.toolSchema, tool: 'another:tool' } } },
    { binding: { ...next, sourceBlobs: { 'other.ts': 'f'.repeat(40) } } },
    { binding: { ...next, boundBy: 'forged' } }, { binding: { ...next, kind: 'git-file-publication' } },
    { binding }, { expectedBindingSha256: '0'.repeat(64) },
  ])('refuses changed scope, stale pins, publication variants or forged provenance: %j', async change => {
    expect(await prepare(current, { ...request, ...change })).toMatchObject({ ok: false });
    expect(mocks.approvalSql).not.toHaveBeenCalled();
  });
  it.each(['not JSON', '{}', '[]', '{"approvedBy":"su-reviewer"}', '{}\n{}'])('refuses malformed/ambiguous receipts: %s', async body => {
    mocks.approvalSql.mockResolvedValue([{ author_id: 'su-reviewer', body, created_at: new Date() }]);
    expect(await prepare(current, apply)).toMatchObject({ ok: false });
  });
  it.each(['workspaceId', 'harness', 'workItemId', 'ref', 'custodianId', 'expectedBlockersSha256'])('refuses another %s', async key => {
    const receipt = await approve();
    mocks.approvalSql.mockResolvedValue([{ author_id: 'su-reviewer', body: JSON.stringify({ ...receipt, [key]: 'foreign' }), created_at: new Date() }]);
    expect(await prepare(current, apply)).toMatchObject({ ok: false });
  });
  it('refuses changed history, foreign custody, terminal state, duplicate aliases and corrupt audit', async () => {
    await approve();
    for (const change of [{ assignee: 'su-b' }, { state: 'done' },
      { payload: { keep: true, externalBlockers: [{ ...bound, summary: 'changed after review' }] } },
      { payload: { keep: true, externalBlockers: [bound, bound] } },
      { payload: { keep: true, externalBlockers: [{ ...bound, runtimeConditionBindingTransitions: null }] } }])
      expect(await prepare({ ...current, ...change } as typeof current, apply)).toMatchObject({ ok: false });
  });
  it('refuses absent/foreign posts, self approval, implementer lineage and unreadable identity evidence', async () => {
    const receipt = await approve();
    mocks.approvalSql.mockResolvedValueOnce([]);
    expect(await prepare(current, apply)).toMatchObject({ ok: false });
    mocks.approvalSql.mockResolvedValueOnce([{ author_id: 'su-a', body: JSON.stringify(receipt), created_at: new Date() }]);
    expect(await prepare(current, apply)).toMatchObject({ ok: false });
    mocks.eligible.mockResolvedValueOnce({ eligible: false });
    expect(await prepare(current, apply)).toMatchObject({ ok: false });
    mocks.lineage.mockResolvedValue(new Set(['su-reviewer', 'su-a']));
    expect(await prepare(current, apply)).toMatchObject({ ok: false });
    mocks.lineage.mockRejectedValue(new Error('identity read unavailable'));
    expect(await prepare(current, apply)).toMatchObject({ ok: false });
  });
  it('fails closed on a missing canonical rubric pin, a foreign subject or an unreadable screen', async () => {
    const receipt = await approve();
    mocks.screen.mockResolvedValueOnce({ subjectPlan: 'foreign-plan', check: mocks.eligible });
    expect(await prepare(current, apply)).toMatchObject({ ok: false });
    mocks.screen.mockRejectedValueOnce(new Error('rubric unreadable'));
    expect(await prepare(current, apply)).toMatchObject({ ok: false });
    mocks.approvalSql.mockResolvedValueOnce([{ author_id: 'su-reviewer', body: JSON.stringify(receipt), created_at: new Date() }]);
    mocks.approvalSql.mockResolvedValueOnce([]);
    expect(await prepare(current, apply)).toMatchObject({ ok: false });
  });
  it('keeps unplanned binding reviews scoped to their item and current/prior custodian lineage', async () => {
    const unplanned = { ...current, sourcePlanSlug: undefined };
    const preview = await prepare(unplanned);
    if (!preview.ok || !('preview' in preview)) throw new Error('preview refused');
    mocks.approvalSql.mockResolvedValue([{ author_id: 'su-reviewer', body: JSON.stringify(preview.preview), created_at: new Date() }]);
    expect(await prepare(unplanned, apply)).toMatchObject({ ok: true, changed: true });
    expect(mocks.screen).not.toHaveBeenCalled();
    expect(mocks.lineage).toHaveBeenCalledWith('su-reviewer', { workspaceId: 'workspace-a' });
  });
});

describe('exact loaded runtime blocker predicate', () => {
  it('requires both the expected boot source blobs and the actual projected tool schema', async () => {
    expect(await readRuntimeToolSchemaIdentity(binding.toolSchema.tool)).toEqual(binding.toolSchema);
    expect(await readRuntimeBlockerCondition(bound)).toMatchObject({ status: 'available', condition: 'satisfied', reachable: true });
    mocks.tools.mockReturnValue([{ expose: { mcp: { name: binding.toolSchema.tool } }, inputSchema: { type: 'object' } }]);
    expect(await readRuntimeBlockerCondition(bound)).toMatchObject({ status: 'available', condition: 'pending' });
    mocks.tools.mockReturnValue([{ expose: { mcp: { name: binding.toolSchema.tool } }, inputSchema }]);
    mocks.health.mockReturnValue({ artifact: { ...artifact, sourceBlobs: { ...binding.sourceBlobs,
      'packages/operator-core/lib/agent-tools/improvements/agent-review.ts': 'f'.repeat(40) } } });
    expect(await readRuntimeBlockerCondition(bound)).toMatchObject({ status: 'available', condition: 'pending' });
  });
  it('does not mistake healthy, unknown, wrong-host or source-unbound runtimes for recovery', async () => {
    expect(await readRuntimeBlockerCondition(blocker)).toMatchObject({ status: 'unknown' });
    mocks.health.mockReturnValue({ healthy: true });
    expect(await readRuntimeBlockerCondition(bound)).toMatchObject({ status: 'unknown' });
    mocks.health.mockReturnValue({ artifact: { ...artifact, sourceBlobs: {} } });
    expect(await readRuntimeBlockerCondition(bound)).toMatchObject({ status: 'unknown' });
    mocks.health.mockReturnValue({ artifact });
    mocks.identity.mockReturnValue({ host: 'port-3070', processId: 'linux:boot:123', buildSha: 'c'.repeat(10) });
    expect(await readRuntimeBlockerCondition(bound)).toMatchObject({ status: 'unknown' });
    mocks.identity.mockReturnValue({ host: 'port-3170', processId: 'linux:boot:123', buildSha: '0'.repeat(10) });
    expect(await readRuntimeBlockerCondition(bound)).toMatchObject({ status: 'unknown' });
  });
  it('refuses missing schema or malformed persisted binding', async () => {
    mocks.tools.mockReturnValue([]);
    expect(await readRuntimeBlockerCondition(bound)).toMatchObject({ status: 'unknown' });
    expect(await readRuntimeBlockerCondition({ ...bound, runtimeConditionBinding: { ...bound.runtimeConditionBinding,
      toolSchema: { ...binding.toolSchema, sha256: 'not-a-hash' } } })).toMatchObject({ status: 'unknown' });
  });
});
