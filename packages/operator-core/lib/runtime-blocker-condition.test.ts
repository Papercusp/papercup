import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import { prepareRuntimeBlockerBinding, readRuntimeBlockerCondition, runtimeToolSchemaIdentity } from './runtime-blocker-condition';

const mocks = vi.hoisted(() => ({ identity: vi.fn(), health: vi.fn(), tools: vi.fn() }));
vi.mock('./serving-host-identity', () => ({ getServingHostIdentity: mocks.identity }));
vi.mock('./observability/runtime', () => ({ runtimeObservabilityHealth: mocks.health }));
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

describe('exact loaded runtime blocker predicate', () => {
  it('requires both the expected boot source blobs and the actual projected tool schema', async () => {
    expect(runtimeToolSchemaIdentity(binding.toolSchema.tool)).toEqual(binding.toolSchema);
    expect(await readRuntimeBlockerCondition(bound)).toMatchObject({ status: 'available', condition: 'satisfied', reachable: true });
    mocks.tools.mockReturnValue([{ name: binding.toolSchema.tool, inputSchema: { type: 'object' } }]);
    expect(await readRuntimeBlockerCondition(bound)).toMatchObject({ status: 'available', condition: 'pending' });
    mocks.tools.mockReturnValue([{ name: binding.toolSchema.tool, inputSchema }]);
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
