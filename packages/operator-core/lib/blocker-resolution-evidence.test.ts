import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlockerEvidenceReader, preflightBlockerDecision } from './blocker-resolution-evidence';
import { prepareBlockerDecision } from './blocker-resolution-decision';
import { activeExternalBlockers } from './external-blockers';
import type { UnresolvedDepBlocker } from './work-items';

const mocks = vi.hoisted(() => ({ item: vi.fn(), presence: vi.fn(), cell: vi.fn(), event: vi.fn(),
  doc: vi.fn(), session: vi.fn(), test: vi.fn(), deps: vi.fn(async (): Promise<UnresolvedDepBlocker[]> => []),
  workspace: vi.fn(() => 'workspace-a'), hoist: vi.fn((): string | null => null), runtime: vi.fn() }));
vi.mock('./runtime-blocker-condition', () => ({ readRuntimeBlockerCondition: mocks.runtime }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: mocks.workspace }));
vi.mock('./work-items', () => ({ getWorkItem: mocks.item, readUnresolvedDepBlockers: mocks.deps }));
vi.mock('./work-item-blocking', () => ({ ALL_TERMINAL_STATUSES: new Set(['done', 'dropped']) }));
vi.mock('./agent-tools/coordination/presence', () => ({ getPresence: mocks.presence }));
vi.mock('./cell-read', () => ({ readCell: mocks.cell, formatCellHoist: mocks.hoist }));
vi.mock('./external-condition-reachability', () => ({ readEventConditionReachability: mocks.event }));
vi.mock('./harness/docs/doc-record', () => ({ getAuthoredDocContent: mocks.doc }));
vi.mock('./session-brief', () => ({ getSessionBrief: mocks.session }));
vi.mock('./testing-run-store', () => ({ readHarnessTestRunEvidence: mocks.test }));

const ctx = { ownerId: 'su-a', workItemId: 'WI-1', workspaceId: 'workspace-a', harnessSlug: 'harness-a',
  role: 'bee', root: process.cwd(), blockers: [] };

describe('canonical blocker evidence readers', () => {
  it('preserves state reader role and uses an explicit measured predicate', async () => {
    mocks.cell.mockResolvedValue({ status: 'value', value: { ready: false } });
    const read = createBlockerEvidenceReader(ctx);
    expect(await read({ kind: 'state', ref: 'state:dependency.health' })).toEqual({ status: 'available' });
    expect(await read({ kind: 'state', ref: 'state:dependency.health#/ready=true' })).toMatchObject({ condition: 'pending', reachable: true });
    expect(await read({ kind: 'state', ref: 'state:dependency.health#/ready=false' })).toMatchObject({ condition: 'satisfied' });
    expect(mocks.cell).toHaveBeenLastCalledWith('dependency.health', expect.objectContaining({ roles: ['bee'], ownerId: 'su-a' }), ctx);
    expect((await read({ kind: 'state', ref: 'state:dependency.health#/missing=null' })).status).toBe('unknown');
    mocks.cell.mockResolvedValue({ status: 'value', value: true, unknownHoist: { key: 'unknown', value: [] } });
    expect(await read({ kind: 'state', ref: 'state:dependency.health#=true' })).toMatchObject({ condition: 'satisfied' });
    mocks.hoist.mockReturnValueOnce('Unmeasured qualifier');
    expect((await read({ kind: 'state', ref: 'state:dependency.health#=true' })).status).toBe('unknown');
  });
  it('does not turn absent, inferred or incomplete cell values into clearance', async () => {
    const read = createBlockerEvidenceReader(ctx);
    for (const result of [{ status: 'absent' }, { status: 'unknown' },
      { status: 'value', value: true, source: { authoritative: false } },
      { status: 'value', value: true, assessment: { status: 'unavailable' } }]) {
      mocks.cell.mockResolvedValue(result);
      expect((await read({ kind: 'state', ref: 'state:dependency.health#=true' })).status).not.toBe('available');
    }
  });
  it('requires an exact harness row and live same-workspace custody', async () => {
    mocks.item.mockResolvedValue({ id: 'WI-2', harness: 'harness-b', state: 'wip', assignee: 'su-b' });
    const read = createBlockerEvidenceReader(ctx);
    expect((await read({ kind: 'work-item', ref: 'WI-2' })).status).toBe('absent');
    mocks.presence.mockResolvedValue({ stale: false, workspaceId: 'workspace-a' });
    expect(await read({ kind: 'work-item', ref: 'harness-b#WI-2' })).toMatchObject({ condition: 'pending', liveOwnerId: 'su-b' });
    mocks.presence.mockResolvedValue({ stale: false, workspaceId: 'workspace-b' });
    expect(await read({ kind: 'work-item', ref: 'harness-b#WI-2' })).not.toHaveProperty('liveOwnerId');
    mocks.workspace.mockReturnValueOnce('workspace-b');
    expect((await read({ kind: 'work-item', ref: 'harness-b#WI-2' })).status).toBe('unknown');
  });
  it('uses the existing specific event-condition reader and refuses unknown authority', async () => {
    const read = createBlockerEvidenceReader(ctx);
    mocks.event.mockResolvedValue({ authoritative: true, verdict: 'reachable', basis: 'live-resolver' });
    expect(await read({ kind: 'event', ref: 'dependency:ready:42' })).toMatchObject({ condition: 'pending', reachable: true });
    expect(mocks.event).toHaveBeenLastCalledWith('dependency:ready:42', { requireSpecificCondition: true });
    mocks.event.mockResolvedValue({ authoritative: false, verdict: 'unknown' });
    expect((await read({ kind: 'event', ref: 'dependency:ready:42' })).status).toBe('unknown');
    expect((await read({ kind: 'authority', ref: 'authority:trust-me' })).status).toBe('absent');
  });
  it('keeps document session and exact test evidence within authenticated scope', async () => {
    const read = createBlockerEvidenceReader(ctx);
    mocks.doc.mockResolvedValue('Canonical content');
    expect(await read({ kind: 'doc', ref: 'doc:runbook' })).toEqual({ status: 'available' });
    expect(mocks.doc).toHaveBeenLastCalledWith('harness-a', 'runbook', 'workspace-a');
    mocks.session.mockResolvedValue({ workspaceId: 'workspace-b' });
    expect((await read({ kind: 'session', ref: 'session:su-b' })).status).toBe('absent');
    mocks.test.mockResolvedValue([{ id: 42, status: 'pass' }]);
    expect(await read({ kind: 'test', ref: 'testing:runs:group-a:42' })).toEqual({ status: 'available' });
    expect(mocks.test).toHaveBeenLastCalledWith({ workspaceId: 'workspace-a', harnessSlug: 'harness-a', runGroupId: 'group-a', testRunIds: [42] });
  });
  it('resolves source paths in the canonical tree without treating files as verification', async () => {
    const read = createBlockerEvidenceReader(ctx);
    expect(await read({ kind: 'source', ref: 'source:package.json:1' })).toEqual({ status: 'available' });
    expect((await read({ kind: 'source', ref: '/etc/passwd' })).status).toBe('absent');
    expect((await read({ kind: 'source', ref: '../../../../etc/passwd' })).status).toBe('absent');
    expect((await read({ kind: 'source', ref: 'package.json:99999999' })).status).toBe('absent');
  });
});

describe('unmeasured runtime plain public release', () => {
  const runtime = { kind: 'runtime' as const, ref: 'runtime:codex-execution-authority:9171' };
  const remedy = { kind: 'source' as const, ref: 'source:package.json:1' };
  const blocker = { ...runtime, status: 'active' as const, summary: 'Original native availability',
    capability: 'live-dependency' as const, capabilitySource: 'explicit' as const,
    createdBy: 'su-a', createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' };
  const item = { id: 'WI-1', harness: 'harness-a', state: 'blocked', assignee: 'su-a', payload: { externalBlockers: [blocker] } };
  const context = { ...ctx, sessionId: 'authenticated-session-a' };
  const effect = { release: true, claimHold: null, claimHoldRelease: null, reason: 'Retain unknown', force: false };
  const options = { effect, releasePayload: { patch: {}, unset: [] } };
  const decision = () => ({ schemaVersion: 1 as const, idempotencyKey: 'legacy-runtime', disposition: 'defer' as const,
    symptom: 'Original condition unmeasured', evidenceRefs: [runtime, remedy],
    investigation: [{ action: 'Inspect canonical blocker', outcome: 'No recovery measurement', evidenceRefs: [runtime] }],
    attempts: [{ action: 'Inspect safe remedy', outcome: 'Source confirms missing adapter', evidenceRefs: [remedy] }],
    deferral: { reason: 'technical-limit' as const, responsibleParty: 'su-a', reasonEvidenceRefs: [runtime],
      nextAction: 'Continue the owned diagnosis', recheckRef: { kind: 'work-item' as const, ref: 'harness-a#WI-2' } } });
  beforeEach(() => {
    mocks.deps.mockResolvedValue([]);
    mocks.workspace.mockReturnValue('workspace-a');
    mocks.item.mockResolvedValue({ id: 'WI-2', harness: 'harness-a', state: 'wip', assignee: 'su-a' });
    mocks.runtime.mockResolvedValue({ status: 'unknown', detail: 'No canonical bound measurement' });
  });
  it('keeps a distinct host-only unmeasured variant and the exact original payload', async () => {
    const before = structuredClone(item);
    const measurement = await createBlockerEvidenceReader({ ...ctx, workItemId: item.id,
      custodianId: item.assignee, blockers: [blocker] })(runtime);
    expect(measurement).toMatchObject({ status: 'unmeasured-runtime', ref: runtime.ref });
    expect(measurement).not.toHaveProperty('condition');
    expect(measurement).not.toHaveProperty('reachable');
    expect(await preflightBlockerDecision(item, decision(), context, options)).toMatchObject({ ok: true });
    expect(item).toEqual(before);
  });
  it.each([
    { ...effect, force: true }, { ...effect, claimHold: true }, { ...effect, claimHold: false },
    { ...effect, claimHoldRelease: {} }, { ...effect, reason: 42 }, { ...effect, unknown: true },
    { ...effect, patch: {} }, { ...effect, unset: [] },
    { release: true, patch: {}, unset: [] }, { release: true },
    { state: 'blocked' }, { state: 'done' }, { setBlocker: {} }, { link: {} }, { unlink: {} }, null,
  ])('refuses every other lifecycle effect %j', async badEffect => {
    expect(await preflightBlockerDecision(item, decision(), context, { ...options, effect: badEffect })).toMatchObject({ ok: false });
  });
  it.each([undefined, { patch: { changed: true }, unset: [] }, { patch: {}, unset: ['keep'] },
    { patch: null, unset: [] }])('requires the actual empty writer mutation %j', async releasePayload => {
    expect(await preflightBlockerDecision(item, decision(), context, { effect, releasePayload })).toMatchObject({ ok: false });
  });
  it('refuses terminal clearance, wrong custody and noncanonical runtime aliases', async () => {
    expect(await preflightBlockerDecision(item, decision(), context, { ...options, requireResolution: true })).toMatchObject({ ok: false });
    expect(await preflightBlockerDecision({ ...item, state: 'done' }, decision(), context, options)).toMatchObject({ ok: false });
    expect(await preflightBlockerDecision({ ...item, assignee: 'su-b' }, decision(), context, options)).toMatchObject({ ok: false });
    const other = decision();
    other.evidenceRefs.push({ kind: 'runtime', ref: 'unrelated-native-alias' });
    expect(await preflightBlockerDecision(item, other, context, options)).toMatchObject({ ok: false });
    for (const rows of [[], [blocker, blocker], [{ ...blocker, runtimeConditionBinding: null }]]) {
      expect(await preflightBlockerDecision({ ...item, payload: { externalBlockers: rows } }, decision(), context, options)).toMatchObject({ ok: false });
    }
    const { deferral: _unused, ...base } = decision();
    expect(await preflightBlockerDecision(item, { ...base, disposition: 'self_resolve',
      verification: { outcome: 'An unrelated source exists', evidenceRefs: [remedy] } }, context, options)).toMatchObject({ ok: false });
  });
  it('requires an attempted measured remedy and a separate owned pending recheck', async () => {
    for (const attempts of [[], [{ action: 'Prose only', outcome: 'No measured remedy', evidenceRefs: [runtime] }]]) {
      expect(await preflightBlockerDecision(item, { ...decision(), attempts }, context, options)).toMatchObject({ ok: false });
    }
    for (const row of [null, { id: 'WI-2', harness: 'harness-a', state: 'done', assignee: 'su-a' },
      { id: 'WI-2', harness: 'harness-a', state: 'wip', assignee: null },
      { id: 'WI-2', harness: 'harness-a', state: 'wip', assignee: 'su-b' }]) {
      mocks.item.mockResolvedValue(row);
      expect(await preflightBlockerDecision(item, decision(), context, options)).toMatchObject({ ok: false });
    }
    mocks.item.mockResolvedValue(item);
    const input = decision(); input.deferral.recheckRef.ref = 'harness-a#WI-1';
    expect(await preflightBlockerDecision(item, input, context, options)).toMatchObject({ ok: false });
  });
  it.each(['state', 'event', 'test', 'doc'] as const)('does not exempt unknown %s evidence alongside the runtime', async kind => {
    mocks.cell.mockResolvedValue({ status: 'unknown' });
    mocks.event.mockResolvedValue({ verdict: 'unknown', authoritative: false });
    mocks.test.mockResolvedValue(null); mocks.doc.mockResolvedValue(null);
    const input = decision();
    expect(await preflightBlockerDecision(item, { ...input, evidenceRefs: [...input.evidenceRefs,
      { kind, ref: kind === 'test' ? 'testing:runs:unknown:42' : 'unknown' }] }, context, options)).toMatchObject({ ok: false });
  });
});

describe('canonical blocker boundary preflight', () => {
  const item = { id: 'WI-1', harness: 'harness-a', state: 'wip', assignee: 'su-a', payload: {} };
  const context = { ...ctx, sessionId: 'authenticated-session-a' };
  const effect = { release: true, patch: {}, unset: [] };
  const ref = { kind: 'state' as const, ref: 'state:dependency.health#/ready=true' };
  const decision = { schemaVersion: 1 as const, idempotencyKey: 'boundary-1', symptom: 'Dependency unavailable',
    investigation: [{ action: 'Inspect canonical health', outcome: 'Dependency was unavailable', evidenceRefs: [ref] }],
    attempts: [], evidenceRefs: [ref], disposition: 'self_resolve' as const,
    verification: { outcome: 'Canonical health now ready', evidenceRefs: [ref] } };

  it('preserves an ordinary handoff but refuses missing evidence through a changed verb or status', async () => {
    expect(await preflightBlockerDecision(item, undefined, context, { effect })).toEqual({ ok: true, ordinary: true });
    for (const state of ['blocked', 'needs-human']) {
      expect(await preflightBlockerDecision({ ...item, state }, undefined, context, { effect })).toMatchObject({ ok: false });
    }
    expect(await preflightBlockerDecision(item, undefined, context, { effect, enteringDeferral: true })).toMatchObject({ ok: false });
    mocks.deps.mockResolvedValueOnce([{ ref: 'harness-a#WI-2', kind: 'feature', satisfaction: 'settled' }]);
    expect(await preflightBlockerDecision(item, undefined, context, { effect })).toMatchObject({ ok: false });
  });

  it('returns an exact receipt before live measurement even after custody transfers', async () => {
    const prepared = prepareBlockerDecision({}, decision, { ownerId: 'su-a', sessionId: context.sessionId,
      workItemId: item.id, custodianId: 'su-a' }, { effect });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('fixture invalid');
    mocks.deps.mockClear();
    expect(await preflightBlockerDecision({ ...item, payload: prepared.patch, assignee: 'su-b' }, decision,
      context, { effect })).toMatchObject({ ok: true, replayed: true, record: prepared.record });
    expect(mocks.deps).not.toHaveBeenCalled();
    expect(await preflightBlockerDecision({ ...item, payload: prepared.patch }, decision, context,
      { effect: { ...effect, patch: { changed: true } } })).toMatchObject({ ok: false, code: 'blocker_decision_conflict' });
  });

  it('retains a prior condition after an edge or lifecycle flag is removed', async () => {
    const defer = { ...decision, disposition: 'defer' as const, verification: undefined,
      deferral: { reason: 'technical-limit' as const, reasonEvidenceRefs: [ref], responsibleParty: 'su-a',
        nextAction: 'Repair dependency', recheckRef: ref } };
    delete defer.verification;
    const prepared = prepareBlockerDecision({}, defer, { ownerId: 'su-a', sessionId: context.sessionId,
      workItemId: item.id, custodianId: 'su-a' }, { effect });
    if (!prepared.ok) throw new Error('fixture invalid');
    expect(await preflightBlockerDecision(item, defer, context, { effect, requireResolution: true }))
      .toMatchObject({ ok: false, missing: [expect.stringContaining('self-resolution before a terminal transition')] });
    expect(await preflightBlockerDecision({ ...item, payload: prepared.patch }, undefined, context, { effect })).toMatchObject({ ok: false });
    mocks.cell.mockResolvedValue({ status: 'value', value: { ready: false } });
    expect(await preflightBlockerDecision({ ...item, payload: prepared.patch }, { ...decision, idempotencyKey: 'resolve-1', priorRevision: 1 },
      context, { effect })).toMatchObject({ ok: false, missing: expect.arrayContaining([expect.stringContaining('unresolved canonical condition')]) });
    mocks.cell.mockResolvedValue({ status: 'value', value: { ready: true } });
    expect(await preflightBlockerDecision({ ...item, payload: prepared.patch }, { ...decision, idempotencyKey: 'resolve-1', priorRevision: 1 },
      context, { effect })).toMatchObject({ ok: true, replayed: false });
  });

  it('keeps absorption exclusive to the coupled plan-drop boundary and retains abandonment checks', async () => {
    const { verification: _verification, ...base } = decision;
    const input = { ...base, disposition: 'absorb' as const, absorption: {
      rationale: 'Duplicate covered by producer', decisionId: 'D-006', decisionHash: '0'.repeat(64),
      survivors: [{ harness: 'harness-a', id: 'WI-2', responsibleParty: 'su-b' }],
    } };
    mocks.deps.mockResolvedValue([]);
    mocks.cell.mockResolvedValue({ status: 'value', value: { ready: false } });
    expect(await preflightBlockerDecision(item, input, context, { effect, requireResolution: true }))
      .toMatchObject({ ok: false });
    expect(await preflightBlockerDecision(item, input, context, { effect, requireResolution: true, allowAbsorption: true }))
      .toMatchObject({ ok: true });
    expect(await preflightBlockerDecision({ ...item, state: 'blocked' }, undefined, context, { effect, requireResolution: true }))
      .toMatchObject({ ok: false });
    const held = { ...item, payload: { externalBlockers: [{ kind: 'hold', ref: 'owner:hold', status: 'active',
      createdBy: 'su-b', summary: 'Do not dispose', createdAt: '2026-11-07T02:00:00Z', updatedAt: '2026-11-07T02:00:00Z' }] } };
    expect(await preflightBlockerDecision(held, input, context, { effect, requireResolution: true, allowAbsorption: true }))
      .toMatchObject({ ok: false });
  });

  it('fails closed on an unreadable or potentially truncated canonical dependency census', async () => {
    mocks.deps.mockRejectedValueOnce(new Error('unavailable'));
    expect(await preflightBlockerDecision(item, undefined, context, { effect })).toMatchObject({ ok: false });
    mocks.deps.mockResolvedValueOnce(Array.from({ length: 25 }, () => ({ ref: 'WI-2', kind: 'feature' })));
    expect(await preflightBlockerDecision(item, undefined, context, { effect })).toMatchObject({ ok: false,
      missing: [expect.stringContaining('complete dependency census')] });
  });

  it('verifies a stored runtime binding separately, retaining every canonical obligation', async () => {
    const runtime = { kind: 'runtime' as const, capability: 'live-dependency' as const,
      capabilitySource: 'explicit' as const, ref: 'staging-operator', summary: 'Accepted source/schema',
      status: 'active' as const, createdBy: 'su-a', createdAt: '2026-11-07T02:00:00Z',
      updatedAt: '2026-11-07T02:00:00Z', runtimeConditionBinding: { schemaVersion: 1 } };
    const observed = { ...item, state: 'blocked', payload: { externalBlockers: [runtime] } };
    const runtimeRef = { kind: 'runtime' as const, ref: runtime.ref };
    const input = { ...decision, evidenceRefs: [runtimeRef],
      investigation: [{ action: 'Read bound runtime', outcome: 'Artifact and schema are measured', evidenceRefs: [runtimeRef] }],
      verification: { outcome: 'Exact runtime condition satisfied', evidenceRefs: [runtimeRef] } };
    mocks.deps.mockResolvedValue([]);
    mocks.runtime.mockResolvedValue({ status: 'available', condition: 'satisfied', reachable: true });
    expect(await preflightBlockerDecision(observed, input, context, { effect })).toMatchObject({ ok: true });
    expect(mocks.runtime).toHaveBeenCalledWith(runtime, context.root);
    for (const result of [{ status: 'unknown', detail: 'wrong host or unmeasured artifact' },
      { status: 'available', condition: 'pending', reachable: true }]) {
      mocks.runtime.mockResolvedValue(result);
      expect(await preflightBlockerDecision(observed, input, context, { effect })).toMatchObject({ ok: false });
    }
    expect(await createBlockerEvidenceReader({ ...ctx, blockers: [] })(runtimeRef)).toMatchObject({ status: 'absent' });
    mocks.runtime.mockResolvedValue({ status: 'available', condition: 'satisfied', reachable: true });
    mocks.event.mockResolvedValue({ authoritative: false, verdict: 'unknown' });
    expect(await preflightBlockerDecision({ ...observed, payload: { externalBlockers: [
      { ...runtime, runtimeConditionBinding: undefined },
    ] } }, input, context, { effect })).toMatchObject({ ok: false });
  });

  it('measures proposed conditions before their first write, retaining prior obligations', async () => {
    mocks.deps.mockResolvedValue([]);
    mocks.cell.mockResolvedValue({ status: 'value', value: { ready: true } });
    mocks.event.mockResolvedValue({ authoritative: true, verdict: 'reachable', basis: 'announced' });
    const proposed = { kind: 'event' as const, capability: 'live-dependency' as const,
      capabilitySource: 'explicit' as const, summary: 'A measured pending dependency',
      ref: 'new:dependency', status: 'active' as const, createdBy: 'su-a',
      createdAt: '2026-11-07T02:00:00Z', updatedAt: '2026-11-07T02:00:00Z' };
    const observedItem = { ...item, payload: { externalBlockers: [
      { ...proposed, kind: 'runtime', ref: ref.ref },
    ] } };
    expect(activeExternalBlockers(observedItem.payload)).toHaveLength(1);
    const checked = await preflightBlockerDecision(observedItem, decision, context, {
      effect, additionalBlockers: [proposed],
    });
    expect(checked).toMatchObject({ ok: false,
      missing: expect.arrayContaining(['unresolved canonical condition event:new:dependency']) });
    expect(mocks.event).toHaveBeenCalledWith('new:dependency', expect.any(Object));
    expect(await preflightBlockerDecision(observedItem, decision, context, { effect })).toMatchObject({ ok: true });
  });
});
