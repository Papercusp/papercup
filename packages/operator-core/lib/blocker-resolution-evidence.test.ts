import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlockerEvidenceReader, preflightBlockerDecision } from './blocker-resolution-evidence';
import { prepareBlockerDecision } from './blocker-resolution-decision';
import { activeExternalBlockers } from './external-blockers';
import type { UnresolvedDepBlocker } from './work-items';
import type { PlanRow } from './agent-tools/plans/source';

const mocks = vi.hoisted(() => ({ item: vi.fn(), presence: vi.fn(), cell: vi.fn(), event: vi.fn(),
  doc: vi.fn(), session: vi.fn(), test: vi.fn(), deps: vi.fn(async (): Promise<UnresolvedDepBlocker[]> => []),
  workspace: vi.fn(() => 'workspace-a'), hoist: vi.fn((): string | null => null), runtime: vi.fn(),
  hold: vi.fn(), parked: vi.fn(), nodes: vi.fn(), plan: vi.fn(), scorecard: vi.fn() }));
vi.mock('./runtime-blocker-condition', () => ({ readRuntimeBlockerCondition: mocks.runtime }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: mocks.workspace }));
vi.mock('./work-items', () => ({ getWorkItem: mocks.item, readUnresolvedDepBlockers: mocks.deps,
  readWorkItemClaimHoldProvenance: mocks.hold, isClaimHoldParked: mocks.parked }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({ ...(await importOriginal<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: {} }) }));
vi.mock('./agent-tools/plans/plan-line-graph', () => ({ readPlanLineNodes: mocks.nodes }));
vi.mock('./agent-tools/plans/source', () => ({ getPlanRow: mocks.plan,
  planItemsForRow: (row: { items: unknown[] }) => row.items }));
vi.mock('./work-item-blocking', () => ({ ALL_TERMINAL_STATUSES: new Set(['done', 'dropped']),
  ALL_SUCCESSFUL_STATUSES: new Set(['done', 'resolved', 'passed']) }));
vi.mock('./agent-tools/coordination/presence', () => ({ getPresence: mocks.presence }));
vi.mock('./cell-read', () => ({ readCell: mocks.cell, formatCellHoist: mocks.hoist }));
vi.mock('./external-condition-reachability', () => ({ readEventConditionReachability: mocks.event }));
vi.mock('./harness/docs/doc-record', () => ({ getAuthoredDocContent: mocks.doc }));
vi.mock('./session-brief', () => ({ getSessionBrief: mocks.session }));
vi.mock('./testing-run-store', () => ({ readHarnessTestRunEvidence: mocks.test }));
vi.mock('./scorecards', () => ({ readScorecardRecipeHeader: mocks.scorecard }));

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
  it('preserves the event resolver diagnostic without promoting unknown evidence', async () => {
    const evidence = 'reachability resolver failed: permission denied for table event_key_fires';
    mocks.item.mockClear();
    mocks.event.mockResolvedValue({ authoritative: false, verdict: 'unknown', basis: 'unmeasured', evidence });
    expect(await createBlockerEvidenceReader(ctx)({ kind: 'event', ref: 'work-item:done:WI-2' }))
      .toEqual({ status: 'unknown', detail: `event condition could not be measured: ${evidence}` });
    expect(mocks.item).not.toHaveBeenCalled();
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

describe('canonical plan-route conditions', () => {
  const route = { kind: 'event' as const, ref: 'plan-route:route-plan:D-001' };
  const citation = { kind: 'doc' as const, ref: 'plan:route-plan#D-004' };
  const gate = { kind: 'gate' as const, ref: route.ref, status: 'active' as const,
    capability: 'live-dependency' as const, capabilitySource: 'explicit' as const,
    summary: 'Obtain a route override', createdBy: 'su-original',
    createdAt: '2026-09-26T12:00:00Z', updatedAt: '2026-09-26T12:00:00Z' };
  const content = (body = 'Supersedes D-001. Use the portfolio fleet.', date = '2026-11-07') =>
    `## Decisions\n\n### D-001 — SELF route\nDate: 2026-09-07\nImplement it yourself; no new fleet or builder fan-out.\n\n### D-004 — Fleet route override\nDate: ${date}\n${body}\n`;
  const plan = (body = content(), patch: Partial<Pick<PlanRow, 'workspaceId' | 'harnessSlug' | 'planSlug' | 'content'>> = {}):
    Pick<PlanRow, 'workspaceId' | 'harnessSlug' | 'planSlug' | 'content'> =>
    ({ workspaceId: ctx.workspaceId, harnessSlug: ctx.harnessSlug, planSlug: 'route-plan', content: body, ...patch });
  const subject = () => ({ id: 'WI-1', harness: ctx.harnessSlug, state: 'blocked', assignee: ctx.ownerId,
    takenAt: '2026-11-14T00:00:00Z', payload: { externalBlockers: [gate], keep: 'unchanged' } });
  const context = () => ({ ...ctx, custodianId: ctx.ownerId, blockers: [gate], evidenceRefs: [citation] });
  const decision = () => ({ schemaVersion: 1 as const, idempotencyKey: 'route-override', disposition: 'self_resolve' as const,
    symptom: 'Historical route gate', evidenceRefs: [route, citation],
    investigation: [{ action: 'Read canonical route override', outcome: 'Later decision supersedes original route', evidenceRefs: [citation] }],
    attempts: [], verification: { outcome: 'Exact route restriction superseded', evidenceRefs: [route] } });
  beforeEach(() => {
    vi.clearAllMocks(); mocks.workspace.mockReturnValue(ctx.workspaceId); mocks.deps.mockResolvedValue([]);
    mocks.item.mockResolvedValue(subject());
    mocks.nodes.mockResolvedValue([{ id: 'P-004', featureId: 'WI-1', planSlug: 'route-plan' }]);
    mocks.plan.mockResolvedValue(plan());
    mocks.event.mockResolvedValue({ authoritative: true, verdict: 'reachable', basis: 'fired' });
  });
  it('measures a cited later canonical override without treating an event fire as authority', async () => {
    expect(await createBlockerEvidenceReader(context())(route)).toMatchObject({ status: 'available', condition: 'satisfied' });
    expect(mocks.event).not.toHaveBeenCalled();
    expect(await createBlockerEvidenceReader(context())(citation)).toEqual({ status: 'available' });
    const item = subject(); const before = structuredClone(item);
    expect(await preflightBlockerDecision(item, decision(), { ...ctx, sessionId: ctx.ownerId },
      { effect: { setBlocker: { clear: true } } })).toMatchObject({ ok: true });
    expect(item).toEqual(before);
  });
  it('recognizes the canonical portfolio restriction supersession clause', async () => {
    mocks.plan.mockResolvedValue(plan(content('It supersedes earlier authoring-only or solo/no-implementation-fanout route restrictions for this portfolio only.')));
    expect(await createBlockerEvidenceReader(context())(route)).toMatchObject({ status: 'available', condition: 'satisfied' });
  });
  it.each([
    ['earlier', content(undefined, '2026-09-01')],
    ['same date', content(undefined, '2026-09-26')],
    ['undated', content().replace('Date: 2026-11-07', '')],
    ['unrelated', content('Supersedes D-002. Use the portfolio fleet.')],
    ['negative', content('This decision does not supersede D-001.')],
    ['hypothetical', content('If approved, this decision supersedes D-001.')],
    ['conditional', content('Supersedes D-001 only after a future approval.')],
    ['fenced example', content('Example only:\n```text\nSupersedes D-001.\n```')],
    ['future', content(undefined, '2099-11-07')],
    ['ambiguous', content() + '\n### D-004 — Duplicate override\nDate: 2026-11-08\nSupersedes D-001.\n'],
    ['withdrawn', content() + '\n### D-005 — Withdraw route override\nDate: 2026-11-08\nWithdraw D-004.\n'],
    ['missing original', content().replace('### D-001', '### D-002')],
  ])('retains a %s override', async (_label, body) => {
    mocks.plan.mockResolvedValue(plan(body));
    expect(await createBlockerEvidenceReader(context())(route)).toMatchObject({ status: 'unknown' });
  });
  it.each([
    ['missing citation', []], ['wrong plan', [{ ...citation, ref: 'plan:other-plan#D-004' }]],
    ['wrong decision', [{ ...citation, ref: 'plan:route-plan#D-009' }]],
  ])('requires the %s to resolve exactly', async (_label, evidenceRefs) => {
    expect(await createBlockerEvidenceReader({ ...context(), evidenceRefs })(route)).toMatchObject({ status: 'unknown' });
  });
  it('refuses changed gate, tenant, plan binding, custody and failed readers', async () => {
    for (const patch of [{ assignee: 'su-b' }, { harness: 'other' }, { id: 'WI-other' }, { state: 'done' },
      { payload: { externalBlockers: [{ ...gate, createdAt: '2026-09-27T00:00:00Z' }] } }]) {
      mocks.item.mockResolvedValue({ ...subject(), ...patch });
      expect(await createBlockerEvidenceReader(context())(route)).toMatchObject({ status: 'unknown' });
    }
    mocks.item.mockResolvedValue(subject()); mocks.workspace.mockReturnValueOnce('other');
    expect(await createBlockerEvidenceReader(context())(route)).toMatchObject({ status: 'unknown' });
    mocks.nodes.mockResolvedValue([{ id: 'P-004', featureId: 'WI-other', planSlug: 'route-plan' }]);
    expect(await createBlockerEvidenceReader(context())(route)).toMatchObject({ status: 'unknown' });
    mocks.nodes.mockResolvedValue([{ id: 'P-004', featureId: 'WI-1', planSlug: 'route-plan' }]);
    mocks.item.mockResolvedValueOnce(subject()).mockResolvedValueOnce({ ...subject(), takenAt: '2026-11-14T01:00:00Z' });
    expect(await createBlockerEvidenceReader(context())(route)).toMatchObject({ status: 'unknown' });
    mocks.item.mockResolvedValue(subject()); mocks.plan.mockRejectedValueOnce(new Error('reader unavailable'));
    expect(await createBlockerEvidenceReader(context())(route)).toMatchObject({ status: 'unknown' });
    for (const patch of [{ workspaceId: 'other' }, { harnessSlug: 'other' }, { planSlug: 'other' }]) {
      mocks.plan.mockResolvedValue(plan(content(), patch));
      expect(await createBlockerEvidenceReader(context())(route)).toMatchObject({ status: 'unknown' });
    }
  });
  it('allows only an accountable plain release of an unmeasured route, preserving the gate', async () => {
    mocks.plan.mockResolvedValue(plan(content('No replacement route is approved.')));
    const item = subject(); const before = structuredClone(item);
    const remedy = { kind: 'source' as const, ref: 'package.json' };
    const input = { schemaVersion: 1 as const, idempotencyKey: 'route-defer', disposition: 'defer' as const,
      symptom: 'No route measurement', evidenceRefs: [route, remedy],
      investigation: [{ action: 'Inspect exact route gate', outcome: 'Still unmeasured', evidenceRefs: [route] }],
      attempts: [{ action: 'Inspect maintained implementation', outcome: 'Repair retained', evidenceRefs: [remedy] }],
      deferral: { reason: 'technical-limit' as const, responsibleParty: ctx.ownerId, reasonEvidenceRefs: [route],
        nextAction: 'Repair the canonical route measurement', recheckRef: { kind: 'work-item' as const, ref: 'harness-a#WI-2' } } };
    mocks.item.mockImplementation(async id => id === 'WI-1' ? subject()
      : { id: 'WI-2', harness: ctx.harnessSlug, state: 'open', assignee: ctx.ownerId });
    const boundary = { ...ctx, sessionId: ctx.ownerId };
    const effect = { release: true, claimHold: null, claimHoldRelease: null, reason: null, force: false };
    const options = { effect, releasePayload: { patch: {}, unset: [] } };
    expect(await preflightBlockerDecision(item, input, boundary, options)).toMatchObject({ ok: true });
    expect(item).toEqual(before);
    for (const changed of [{ ...options, effect: { ...effect, claimHold: false } },
      { ...options, requireResolution: true }, { ...options, releasePayload: { patch: { changed: true }, unset: [] } },
      { ...options, effect: { state: 'wip' } }]) {
      expect(await preflightBlockerDecision(item, input, boundary, changed)).toMatchObject({ ok: false });
    }
    mocks.item.mockImplementation(async id => id === 'WI-1' ? subject()
      : { id: 'WI-2', harness: ctx.harnessSlug, state: 'open', assignee: 'su-b' });
    expect(await preflightBlockerDecision(item, input, boundary, options)).toMatchObject({ ok: false });
    expect(await preflightBlockerDecision(item, decision(), boundary, options)).toMatchObject({ ok: false });
  });
  it('keeps unrelated pending and unreadable conditions outside route clearance', async () => {
    const other = { ...gate, kind: 'human' as const, capability: 'product-decision' as const, ref: 'human-action' };
    const item = { ...subject(), payload: { externalBlockers: [gate, other] } };
    expect(await preflightBlockerDecision(item, decision(), { ...ctx, sessionId: ctx.ownerId },
      { effect: { setBlocker: { clear: true } } })).toMatchObject({ ok: false });
    for (const ref of ['plan:route-plan#D-009', 'plan:route-plan', 'plan:route-plan#D-004:extra']) {
      expect(await createBlockerEvidenceReader(context())({ kind: 'doc', ref })).toMatchObject({ status: 'absent' });
    }
  });
});

describe('legacy grading-audit conditions', () => {
  const legacy = { kind: 'event' as const, ref: 'grading-audit:EI-target' };
  const canonical = { kind: 'event' as const, ref: 'scorecard:grading-audit:EI-target' };
  const target = () => ({ issueId: 'EI-target', createdBy: 'su-author',
    gradingAudit: { state: 'passed', metaRubricRef: 'grading-integrity', auditIssueId: 'EI-audit',
      auditor: 'su-auditor', auditedAt: '2026-11-13T18:00:00Z', rubricRevision: 14, criteriaHash: 'audit-hash' } });
  const audit = () => ({ issueId: 'EI-audit', createdBy: 'su-auditor', rubricRef: 'grading-integrity',
    subject: { kind: 'scorecard', ref: 'EI-target' }, rubricRevision: 14, criteriaHash: 'audit-hash' });
  let subject: ReturnType<typeof target>;
  let verdict: ReturnType<typeof audit>;
  beforeEach(() => {
    subject = target(); verdict = audit();
    mocks.workspace.mockReset().mockReturnValue(ctx.workspaceId); mocks.deps.mockResolvedValue([]);
    mocks.event.mockReset().mockResolvedValue({ authoritative: false, verdict: 'unknown' });
    mocks.scorecard.mockReset().mockImplementation(async (id: string) => id === 'EI-target'
      ? { kind: 'found', scorecard: subject } : id === 'EI-audit'
        ? { kind: 'found', scorecard: verdict } : { kind: 'not_found' });
  });
  it('measures a passed legacy audit from its exact canonical card', async () => {
    const read = createBlockerEvidenceReader(ctx);
    const measured = await read(legacy);
    expect(measured).toMatchObject({ status: 'available', condition: 'satisfied', reachable: true });
    expect(await read(canonical)).toEqual(measured);
    expect(mocks.scorecard).toHaveBeenCalledWith('EI-target');
    expect(mocks.scorecard).toHaveBeenCalledWith('EI-audit');
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it.each(['pending', 'awaiting-reemit', 'failed', 'cancelled'])('retains a %s audit despite a fired event', async state => {
    subject.gradingAudit.state = state;
    mocks.event.mockResolvedValue({ authoritative: true, verdict: 'reachable', basis: 'fired' });
    expect(await createBlockerEvidenceReader(ctx)(legacy)).toMatchObject({ status: 'available', condition: 'pending' });
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it.each(['not_found', 'not_scorecard'])('refuses a %s target', async kind => {
    mocks.scorecard.mockResolvedValue({ kind });
    expect(await createBlockerEvidenceReader(ctx)(legacy)).toMatchObject({ status: 'unknown' });
  });
  it.each([
    ['wrong subject', () => { verdict.subject.ref = 'EI-other'; }],
    ['wrong audit rubric', () => { verdict.rubricRef = 'other'; }],
    ['wrong audit identity', () => { verdict.issueId = 'EI-other'; }],
    ['wrong target identity', () => { subject.issueId = 'EI-other'; }],
    ['wrong auditor', () => { verdict.createdBy = 'su-other'; }],
    ['self audit', () => { subject.gradingAudit.auditor = subject.createdBy; verdict.createdBy = subject.createdBy; }],
    ['wrong revision', () => { verdict.rubricRevision = 13; }],
    ['wrong hash', () => { verdict.criteriaHash = 'other'; }],
    ['missing timestamp', () => { subject.gradingAudit.auditedAt = ''; }],
  ] as const)('refuses %s', async (_label, change) => {
    change(); expect(await createBlockerEvidenceReader(ctx)(legacy)).toMatchObject({ status: 'unknown' });
  });
  it.each(['retracted', 'provisional', 'supersededBy'])('refuses an audit carrying %s', async field => {
    Object.assign(verdict, { [field]: field === 'supersededBy' ? 'EI-new' : {} });
    expect(await createBlockerEvidenceReader(ctx)(legacy)).toMatchObject({ status: 'unknown' });
  });
  it('retains uncertainty on a reader failure or foreign tenant', async () => {
    mocks.scorecard.mockRejectedValue(new Error('unavailable'));
    expect(await createBlockerEvidenceReader(ctx)(legacy)).toMatchObject({ status: 'unknown' });
    mocks.scorecard.mockClear(); mocks.workspace.mockReturnValue('workspace-b');
    expect(await createBlockerEvidenceReader(ctx)(legacy)).toMatchObject({ status: 'unknown' });
    expect(mocks.scorecard).not.toHaveBeenCalled();
  });
  it('canonically verifies a stored legacy obligation using the same-target alias without rewriting it', async () => {
    const gate = { kind: 'event' as const, ref: legacy.ref, status: 'active' as const,
      capability: 'live-dependency' as const, capabilitySource: 'explicit' as const,
      summary: 'Independent grading audit', createdBy: ctx.ownerId, createdAt: '2026-11-13T17:00:00Z',
      updatedAt: '2026-11-13T17:00:00Z' };
    const item = { id: ctx.workItemId, harness: ctx.harnessSlug, state: 'blocked', assignee: ctx.ownerId,
      payload: { externalBlockers: [gate] } };
    const before = structuredClone(item);
    expect(activeExternalBlockers(item.payload)).toHaveLength(1);
    const decision = { schemaVersion: 1 as const, idempotencyKey: 'settled-audit',
      disposition: 'self_resolve' as const, symptom: 'Legacy audit reservation remains blocked',
      evidenceRefs: [canonical], investigation: [{ action: 'Read exact target and audit',
        outcome: 'Canonical stamp passed', evidenceRefs: [canonical] }], attempts: [],
      verification: { outcome: 'Exact audited target settled', evidenceRefs: [canonical] } };
    const verified = await preflightBlockerDecision(item, decision, { ...ctx, sessionId: ctx.ownerId },
      { effect: { status: 'wip' } });
    expect(verified, JSON.stringify({ verified, reads: mocks.scorecard.mock.calls })).toMatchObject({ ok: true });
    expect(mocks.scorecard.mock.calls).toEqual(expect.arrayContaining([
      ['EI-target'], ['EI-audit'],
    ]));
    expect(mocks.scorecard).toHaveBeenCalledTimes(4);
    expect(item).toEqual(before);
    subject.gradingAudit.state = 'pending';
    expect(await preflightBlockerDecision(item, decision, { ...ctx, sessionId: ctx.ownerId },
      { effect: { status: 'wip' } })).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
    expect(item).toEqual(before);
  });
  it('does not clear a pending original with a different passed audit', async () => {
    subject.gradingAudit.state = 'pending';
    const other = { ...target(), issueId: 'EI-other' };
    const otherAudit = { ...audit(), subject: { kind: 'scorecard', ref: other.issueId } };
    mocks.scorecard.mockImplementation(async (id: string) => id === subject.issueId
      ? { kind: 'found', scorecard: subject } : id === other.issueId
        ? { kind: 'found', scorecard: other } : { kind: 'found', scorecard: otherAudit });
    const otherRef = { kind: 'event' as const, ref: 'scorecard:grading-audit:EI-other' };
    expect(await createBlockerEvidenceReader(ctx)(otherRef)).toMatchObject({ condition: 'satisfied' });
    const item = { id: ctx.workItemId, harness: ctx.harnessSlug, state: 'blocked', assignee: ctx.ownerId,
      payload: { externalBlockers: [{ kind: 'event', ref: legacy.ref, status: 'active',
        capability: 'live-dependency', capabilitySource: 'explicit', summary: 'Original audit',
        createdBy: ctx.ownerId, createdAt: '2026-11-13T17:00:00Z', updatedAt: '2026-11-13T17:00:00Z' }] } };
    expect(activeExternalBlockers(item.payload)).toHaveLength(1);
    const decision = { schemaVersion: 1, idempotencyKey: 'unrelated-audit', disposition: 'self_resolve',
      symptom: 'Original audit pending', evidenceRefs: [otherRef],
      investigation: [{ action: 'Read another audit', outcome: 'Other target passed', evidenceRefs: [otherRef] }],
      attempts: [], verification: { outcome: 'Other target passed', evidenceRefs: [otherRef] } };
    expect(await preflightBlockerDecision(item, decision, { ...ctx, sessionId: ctx.ownerId },
      { effect: { status: 'wip' } })).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
  });
  it.each(['grading-audit:', 'grading-audit:*', 'grading-audit:WI-target',
    'grading-audit:EI-target#other', 'grading-audit:EI-target/other',
    'scorecard:grading-audit:EI-target extra'])('refuses malformed alias %s despite a fire', async ref => {
    mocks.event.mockResolvedValue({ authoritative: true, verdict: 'reachable', basis: 'fired' });
    expect(await createBlockerEvidenceReader(ctx)({ kind: 'event', ref })).toMatchObject({ status: 'absent' });
    expect(mocks.event).not.toHaveBeenCalled();
    expect(mocks.scorecard).not.toHaveBeenCalled();
  });
  it.each(['retracted', 'provisional'])('refuses a target carrying %s', async field => {
    Object.assign(subject, { [field]: {} });
    expect(await createBlockerEvidenceReader(ctx)(legacy)).toMatchObject({ status: 'unknown' });
  });
  it('refuses a missing audit and incomplete or unrecognized canonical stamps', async () => {
    mocks.scorecard.mockImplementation(async (id: string) => id === subject.issueId
      ? { kind: 'found', scorecard: subject } : { kind: 'not_found' });
    expect(await createBlockerEvidenceReader(ctx)(legacy)).toMatchObject({ status: 'unknown' });
    for (const patch of [{ state: 'unrecognized' }, { criteriaHash: '' }, { rubricRevision: 0 },
      { auditedAt: 'invalid' }, { auditor: '' }, { metaRubricRef: 'other' }]) {
      Object.assign(subject.gradingAudit, target().gradingAudit, patch);
      expect(await createBlockerEvidenceReader(ctx)(legacy)).toMatchObject({ status: 'unknown' });
    }
  });
  it('allows the exact historical audit without substituting the superseding target', async () => {
    Object.assign(subject, { supersededBy: 'EI-successor' });
    expect(await createBlockerEvidenceReader(ctx)(legacy)).toMatchObject({ condition: 'satisfied' });
    expect(mocks.scorecard).not.toHaveBeenCalledWith('EI-successor');
  });
});

describe('system-derived plan-lane evidence', () => {
  const ref = { kind: 'event' as const, ref: 'plan-lane:recovery#P-002' };
  const gate = { kind: 'gate' as const, ref: ref.ref, status: 'active' as const,
    capability: 'live-dependency' as const, capabilitySource: 'explicit' as const, summary: 'Canonical prerequisite',
    createdBy: 'system:plan-item-lane-sync', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z' };
  const subject = () => ({ id: ctx.workItemId, harness: ctx.harnessSlug, state: 'blocked', assignee: ctx.ownerId,
    payload: { planLaneParkedFrom: 'open', externalBlockers: [gate] } });
  const plan = () => ({ workspaceId: ctx.workspaceId, harnessSlug: ctx.harnessSlug, items: [
    { id: 'P-001', text: 'Prerequisite', storedStatus: 'done', blockedBy: [], lineNumber: 1, rawLine: '' },
    { id: 'P-002', text: 'Recover lane', storedStatus: 'blocked', blockedBy: ['P-001'], lineNumber: 2, rawLine: '' },
  ] });
  const context = () => ({ ...ctx, custodianId: ctx.ownerId, blockers: [gate] });
  const read = () => createBlockerEvidenceReader(context())(ref);
  const decision = () => ({ schemaVersion: 1 as const, idempotencyKey: 'derived-recovery',
    disposition: 'self_resolve' as const, symptom: 'Derived lane remained blocked after prerequisite completion',
    evidenceRefs: [ref], investigation: [{ action: 'Read canonical graph', outcome: 'Prerequisite settled', evidenceRefs: [ref] }],
    attempts: [], verification: { outcome: 'Exact dependency predicate satisfied', evidenceRefs: [ref] } });
  beforeEach(() => {
    mocks.workspace.mockReturnValue(ctx.workspaceId);
    mocks.item.mockResolvedValue(subject());
    mocks.hold.mockReturnValue({ parked: null, heldOpen: null, attributed: false });
    mocks.parked.mockReturnValue(false);
    mocks.nodes.mockResolvedValue([{ id: 'P-001', featureId: 'WI-2' }, { id: 'P-002', featureId: ctx.workItemId }]);
    mocks.plan.mockResolvedValue(plan());
    mocks.deps.mockResolvedValue([]);
    mocks.event.mockReset();
  });
  it('measures the canonical graph without manufacturing an event', async () => {
    const measured = await read();
    expect(measured, JSON.stringify(measured)).toMatchObject({ status: 'available', condition: 'satisfied',
      reachable: true, subjectWorkItemId: ctx.workItemId });
    expect(mocks.event).not.toHaveBeenCalled();
    expect(await preflightBlockerDecision(subject(), decision(), { ...context(), sessionId: ctx.ownerId },
      { effect: { status: 'wip' } })).toMatchObject({ ok: true });
  });
  it('retains a pending prerequisite and refuses self-resolution', async () => {
    const pending = plan();
    pending.items[0].storedStatus = 'wip';
    mocks.plan.mockResolvedValue(pending);
    const measured = await read();
    expect(measured, JSON.stringify(measured)).toMatchObject({ status: 'available', condition: 'pending' });
    expect(await preflightBlockerDecision(subject(), decision(), { ...context(), sessionId: ctx.ownerId },
      { effect: { status: 'wip' } })).toMatchObject({ ok: false, code: 'blocker_decision_evidence',
      missing: expect.arrayContaining([`unresolved canonical condition event:${ref.ref}`]) });
  });
  it.each(['todo', 'wip'])('measures an actionable %s lane with no dependencies', async status => {
    const actionable = plan();
    actionable.items[1].storedStatus = status;
    actionable.items[1].blockedBy = [];
    mocks.plan.mockResolvedValue(actionable);

    expect(await read()).toMatchObject({ status: 'available', condition: 'satisfied',
      reachable: true, subjectWorkItemId: ctx.workItemId });
    expect(await preflightBlockerDecision(subject(), decision(), { ...context(), sessionId: ctx.ownerId },
      { effect: { status: 'wip' } })).toMatchObject({ ok: true });
  });
  it('retains an explicitly blocked lane with no declared prerequisites', async () => {
    const blocked = plan();
    blocked.items[1].blockedBy = [];
    mocks.plan.mockResolvedValue(blocked);

    expect(await read()).toMatchObject({ status: 'unknown' });
  });
  it('permits accountable parking of a dependency-free lane without resolving an external condition', async () => {
    const actionable = plan();
    actionable.items[1].storedStatus = 'todo';
    actionable.items[1].blockedBy = [];
    mocks.plan.mockResolvedValue(actionable);
    const external = { ...gate, kind: 'event' as const, ref: 'fixture:external', createdBy: 'su-other' };
    const externalRef = { kind: 'event' as const, ref: external.ref };
    mocks.event.mockResolvedValue({ authoritative: true, verdict: 'reachable', basis: 'announced' });
    const current = subject();
    const item = { ...current, payload: { ...current.payload, externalBlockers: [gate, external] } };

    expect(await preflightBlockerDecision(item, decision(), { ...context(), sessionId: ctx.ownerId },
      { effect: { release: true } })).toMatchObject({ ok: false,
      missing: expect.arrayContaining(['unresolved canonical condition event:fixture:external']) });
    const defer = { schemaVersion: 1 as const, idempotencyKey: 'actionable-lane-park',
      disposition: 'defer' as const, symptom: 'Independent source condition remains pending',
      evidenceRefs: [ref, externalRef],
      investigation: [{ action: 'Read the canonical lane and independent condition',
        outcome: 'The lane is actionable; the external condition is pending', evidenceRefs: [ref, externalRef] }],
      attempts: [], deferral: { reason: 'external-dependency' as const,
        responsibleParty: `event:${external.ref}`, reasonEvidenceRefs: [externalRef],
        nextAction: 'Reconsider the parked work when its independent source condition changes', recheckRef: externalRef } };
    expect(await preflightBlockerDecision(item, defer, { ...context(), sessionId: ctx.ownerId },
      { effect: { release: true, claimHold: true } })).toMatchObject({ ok: true });
  });
  it.each([
    ['other custodian', { custodianId: 'su-other' }],
    ['other tenant', { workspaceId: 'workspace-b' }],
    ['missing harness', { harnessSlug: null }],
    ['forged author', { blockers: [{ ...gate, createdBy: ctx.ownerId }] }],
    ['wrong kind', { blockers: [{ ...gate, kind: 'event' }] }],
    ['wrong capability', { blockers: [{ ...gate, capability: 'owner-decision' }] }],
    ['ambiguous gates', { blockers: [gate, gate] }],
  ])('fails closed for %s', async (_label, patch) => {
    const measured = await createBlockerEvidenceReader({ ...context(), ...patch } as ReturnType<typeof context>)(ref);
    expect(measured).toMatchObject({ status: 'unknown' });
  });
  it.each([
    ['lost custody', { assignee: 'su-other' }],
    ['terminal node', { state: 'done' }],
    ['other harness', { harness: 'other-harness' }],
    ['independent park', { payload: { ...subject().payload, _claimHold: true } }],
    ['missing pre-park provenance', { payload: { externalBlockers: [gate] } }],
    ['ambiguous canonical blocker', { payload: { ...subject().payload, externalBlockers: [gate, gate] } }],
  ])('retains %s', async (_label, patch) => {
    mocks.item.mockResolvedValue({ ...subject(), ...patch });
    if (_label === 'independent park') mocks.parked.mockReturnValue(true);
    expect(await read()).toMatchObject({ status: 'unknown' });
  });
  it.each(['parked', 'heldOpen'])('retains an independent %s lease', async field => {
    mocks.hold.mockReturnValue({ parked: null, heldOpen: null, [field]: { by: 'su-other' } });
    expect(await read()).toMatchObject({ status: 'unknown' });
  });
  it('honors the canonical anonymous claim-park predicate', async () => {
    mocks.parked.mockReturnValue(true);
    expect(await read()).toMatchObject({ status: 'unknown' });
  });
  describe('plain release with an owned reservation', () => {
    const reserved = () => ({ ...subject(), payload: { ...subject().payload,
      _claimHold: true, held_open_by: ctx.ownerId, held_open_reason: 'Preserve original custody',
      held_open_at: '2026-11-10T00:00:00Z' } });
    const effect = { release: true, claimHold: null, claimHoldRelease: null,
      reason: 'Retain the reservation and unresolved dependency', force: false };
    const options = { effect, releasePayload: { patch: {}, unset: [] } };
    const defer = () => ({ schemaVersion: 1 as const, idempotencyKey: 'reserved-lane-release',
      disposition: 'defer' as const, symptom: 'The original dependency remains pending', evidenceRefs: [ref],
      investigation: [{ action: 'Read the exact canonical dependency and custody',
        outcome: 'The owner reservation remains and the dependency is pending', evidenceRefs: [ref] }],
      attempts: [{ action: 'Inspect the safe ordinary release boundary',
        outcome: 'Only release the inactive assignment; retain the condition', evidenceRefs: [ref] }],
      deferral: { reason: 'technical-limit' as const, responsibleParty: ctx.ownerId,
        reasonEvidenceRefs: [ref], nextAction: 'Reconsider the original dependency when it changes', recheckRef: ref } });
    beforeEach(() => {
      const pending = plan();
      pending.items[0].storedStatus = 'wip';
      mocks.plan.mockResolvedValue(pending);
      mocks.item.mockResolvedValue(reserved());
      mocks.parked.mockReturnValue(true);
      mocks.hold.mockReturnValue({ parked: null, heldOpen: { by: ctx.ownerId,
        reason: 'Preserve original custody', at: '2026-11-10T00:00:00Z' }, attributed: true });
    });
    it('admits an accountable plain release without changing the reservation or pending gate', async () => {
      const item = reserved();
      const before = structuredClone(item);
      expect(await preflightBlockerDecision(item, defer(), { ...context(), sessionId: ctx.ownerId }, options))
        .toMatchObject({ ok: true });
      expect(item).toEqual(before);
      expect(mocks.event).not.toHaveBeenCalled();
    });
    it('does not extend the reservation exception to other effects or hidden writer mutations', async () => {
      const boundaries = [
        { ...options, effect: { status: 'wip' } },
        { ...options, effect: { ...effect, force: true } },
        { ...options, effect: { ...effect, claimHold: false } },
        { ...options, effect: { ...effect, claimHold: true } },
        { ...options, releasePayload: { patch: { held_open_by: null }, unset: [] } },
        { ...options, releasePayload: { patch: {}, unset: ['externalBlockers'] } },
        { ...options, additionalDependencyRefs: ['harness-a#WI-2'] },
      ];
      for (const boundary of boundaries) {
        expect(await preflightBlockerDecision(reserved(), defer(), { ...context(), sessionId: ctx.ownerId }, boundary))
          .toMatchObject({ ok: false });
      }
    });
    it('retains foreign, coexisting durable, and unattributed holds during ordinary release', async () => {
      for (const hold of [
        { parked: null, heldOpen: { by: 'su-other' }, attributed: true },
        { parked: { by: ctx.ownerId }, heldOpen: { by: ctx.ownerId }, attributed: true },
        { parked: { by: 'su-other' }, heldOpen: { by: ctx.ownerId }, attributed: true },
        { parked: null, heldOpen: null, attributed: false },
      ]) {
        mocks.hold.mockReturnValue(hold);
        expect(await preflightBlockerDecision(reserved(), defer(), { ...context(), sessionId: ctx.ownerId }, options))
          .toMatchObject({ ok: false });
      }
    });
    it('retains unattributed durable-park metadata beside an owned reservation', async () => {
      for (const park of [{ claim_hold_by: 'su-other' }, { claim_hold_reason: 'Independent restriction' },
        { claim_hold_at: '2026-11-09T00:00:00Z' }]) {
        const item = reserved();
        mocks.item.mockResolvedValue({ ...item, payload: { ...item.payload, ...park } });
        expect(await preflightBlockerDecision(item, defer(), { ...context(), sessionId: ctx.ownerId }, options))
          .toMatchObject({ ok: false });
      }
    });
    it('does not permit self-resolution through an owned reservation even when the lane is satisfied', async () => {
      mocks.plan.mockResolvedValue(plan());
      expect(await preflightBlockerDecision(reserved(), decision(), { ...context(), sessionId: ctx.ownerId }, options))
        .toMatchObject({ ok: false });
    });
  });
  it.each(['missing', 'tenant', 'harness', 'missing-reference', 'cycle'])('rejects %s plan evidence', async fault => {
    const current = plan();
    if (fault === 'tenant') current.workspaceId = 'other-workspace';
    if (fault === 'harness') current.harnessSlug = 'other-harness';
    if (fault === 'missing-reference') current.items[1].blockedBy = ['P-999'];
    if (fault === 'cycle') current.items[0].blockedBy = ['P-002'];
    mocks.plan.mockResolvedValue(fault === 'missing' ? null : current);
    expect(await read()).toMatchObject({ status: 'unknown' });
  });
  it.each([
    [], [{ id: 'P-002', featureId: 'WI-other' }],
    [{ id: 'P-002', featureId: ctx.workItemId }, { id: 'P-002', featureId: ctx.workItemId }],
  ])('rejects missing, substituted or ambiguous node identities (%j)', async (...nodes) => {
    mocks.nodes.mockResolvedValue(nodes);
    expect(await read()).toMatchObject({ status: 'unknown' });
  });
  it('fails closed when a canonical reader is unavailable', async () => {
    mocks.plan.mockRejectedValue(new Error('reader unavailable'));
    expect(await read()).toMatchObject({ status: 'unknown' });
  });
  it('retains a canonical owner gate marker', async () => {
    mocks.nodes.mockResolvedValue([{ id: 'P-002', featureId: ctx.workItemId, ownerGateMarker: 'owner approval' }]);
    expect(await read()).toMatchObject({ status: 'unknown' });
  });
  it('does not discharge a genuine independent external condition', async () => {
    const external = { ...gate, kind: 'event' as const, ref: 'fixture:external', createdBy: 'su-other' };
    mocks.event.mockResolvedValue({ authoritative: true, verdict: 'reachable', basis: 'announced' });
    const item = subject();
    const payload = { ...item.payload, externalBlockers: [gate, external] };
    mocks.item.mockResolvedValue({ ...item, payload });
    expect(await preflightBlockerDecision({ ...item, payload }, decision(), { ...context(), sessionId: ctx.ownerId },
      { effect: { status: 'wip' } })).toMatchObject({ ok: false,
      missing: expect.arrayContaining(['unresolved canonical condition event:fixture:external']) });
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
  const settlementRef = { kind: 'event' as const, ref: 'work-item:settled:WI-2' };
  const manifest = () => ({ version: 1, generation: 1, evidenceHash: 'e'.repeat(64),
    repositoryRoot: process.cwd(), headSha: 'a'.repeat(40), normalizedPaths: ['repair.ts'],
    contentIdentity: [{ path: 'repair.ts', headBlobSha: 'b'.repeat(40), workingTreeBlobSha: 'c'.repeat(40) }] });
  const proposal = () => ({ id: 'WI-2', harness: 'harness-a', state: 'done', assignee: null,
    terminalOwner: 'su-a', completionAuthority: 'proposed',
    terminalCompletionEvidence: { settlementManifest: manifest() } });
  const settlementDecision = () => ({ ...decision(), deferral: { ...decision().deferral, recheckRef: settlementRef } });
  beforeEach(() => {
    mocks.deps.mockResolvedValue([]);
    mocks.workspace.mockReturnValue('workspace-a');
    mocks.item.mockResolvedValue({ id: 'WI-2', harness: 'harness-a', state: 'wip', assignee: 'su-a' });
    mocks.runtime.mockResolvedValue({ status: 'unknown', detail: 'No canonical bound measurement' });
    mocks.event.mockResolvedValue({ authoritative: true, verdict: 'reachable', basis: 'live-resolver' });
  });
  it('retains a pending owned proposal as a commit-settlement recheck', async () => {
    const row = proposal();
    mocks.item.mockResolvedValue(row);
    // Lifecycle completion remains distinct from the exact commit-settlement event.
    expect(await createBlockerEvidenceReader(ctx)({ kind: 'work-item', ref: 'WI-2' }))
      .toMatchObject({ condition: 'satisfied' });
    const before = structuredClone(item);
    expect(await preflightBlockerDecision(item, settlementDecision(), context, options)).toMatchObject({ ok: true });
    expect(item).toEqual(before);
    expect(row).toEqual(proposal());
  });
  it.each(['work-item:done:WI-2', 'dependency:settled:WI-2', 'work-item:settled:WI-2:extra'])(
    'refuses an unrelated or malformed event recheck %s', async ref => {
      mocks.item.mockResolvedValue(proposal());
      const input = settlementDecision(); input.deferral.recheckRef.ref = ref;
      expect(await preflightBlockerDecision(item, input, context, options)).toMatchObject({ ok: false });
    });
  it.each([
    { terminalOwner: 'su-b' }, { terminalOwner: null }, { assignee: 'su-b' },
    { completionAuthority: 'committed' }, { state: 'wip' }, { state: 'dropped' },
    { harness: 'harness-b' }, { id: 'WI-1' }, { id: 'WI-other' },
    { terminalCompletionEvidence: null }, { terminalCompletionEvidence: {} },
  ])('refuses an unowned, settled or unbound proposal %j', async override => {
    mocks.item.mockResolvedValue({ ...proposal(), ...override });
    expect(await preflightBlockerDecision(item, settlementDecision(), context, options)).toMatchObject({ ok: false });
  });
  it.each([
    { ...manifest(), version: 2 }, { ...manifest(), generation: 0 },
    { ...manifest(), evidenceHash: 'unmeasured' }, { ...manifest(), contentIdentity: [] },
    { ...manifest(), contentIdentity: [{ path: 'repair.ts', workingTreeBlobSha: null }] },
    { ...manifest(), normalizedPaths: ['unrelated.ts'] },
    { ...manifest(), residualPaths: [{ path: 'repair.ts', reason: 'superseded-before-commit' }] },
    { ...manifest(), residualPaths: [{ path: 'repair.ts', reason: 'not-a-repository-path' }] },
  ])('requires a complete settleable manifest %j', async settlementManifest => {
    mocks.item.mockResolvedValue({ ...proposal(), terminalCompletionEvidence: { settlementManifest } });
    expect(await preflightBlockerDecision(item, settlementDecision(), context, options)).toMatchObject({ ok: false });
  });
  it('refuses a fired or unmeasured settlement key and non-release effects', async () => {
    mocks.item.mockResolvedValue(proposal());
    for (const read of [{ authoritative: true, verdict: 'reachable', basis: 'fired' },
      { authoritative: false, verdict: 'unknown' }]) {
      mocks.event.mockResolvedValue(read);
      expect(await preflightBlockerDecision(item, settlementDecision(), context, options)).toMatchObject({ ok: false });
    }
    mocks.event.mockResolvedValue({ authoritative: true, verdict: 'reachable', basis: 'live-resolver' });
    for (const changed of [{ ...options, requireResolution: true },
      { ...options, effect: { ...effect, claimHold: true } },
      { ...options, releasePayload: { patch: { rewritten: true }, unset: [] } }]) {
      expect(await preflightBlockerDecision(item, settlementDecision(), context, changed)).toMatchObject({ ok: false });
    }
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

describe('subject-bound git-sync commit evidence', () => {
  const eventRef = { kind: 'event' as const, ref: 'git-sync:committed' };
  const blocker = { kind: 'event' as const, capability: 'live-dependency' as const,
    capabilitySource: 'explicit' as const, ref: eventRef.ref, status: 'active' as const,
    summary: 'Wait for this work item’s code files', createdBy: ctx.ownerId,
    createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z' };
  const paths = ['src/a.ts', 'src/b.ts'];
  let root: string;
  let current: { id: string; harness: string; state: string; assignee: string; takenAt: string; payload: Record<string, unknown> };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (author: string) => git(root, '-c', `user.name=${author}`, '-c',
    'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  const subject = () => ({ id: current.id, harness: current.harness, state: current.state,
    assignee: current.assignee, payload: current.payload });
  const evidenceContext = () => ({ ...ctx, root, custodianId: ctx.ownerId, blockers: [blocker] });
  const read = () => createBlockerEvidenceReader(evidenceContext())(eventRef);
  const deferred = () => ({ schemaVersion: 1 as const, idempotencyKey: 'git-sync-working-set-defer',
    disposition: 'defer' as const, symptom: 'The local sync has not committed this work item’s files',
    evidenceRefs: [eventRef],
    investigation: [{ action: 'Measure each owner-stamped file against local HEAD',
      outcome: 'At least one exact working blob is not in a sync-authored commit', evidenceRefs: [eventRef] }],
    attempts: [], deferral: { reason: 'external-dependency' as const, responsibleParty: 'system:git-sync',
      reasonEvidenceRefs: [eventRef], nextAction: 'Recheck the exact code working set after the local commit',
      recheckRef: eventRef } });
  const resolved = () => ({ schemaVersion: 1 as const, idempotencyKey: 'git-sync-working-set-resolve',
    disposition: 'self_resolve' as const, symptom: 'The local sync committed this work item’s files',
    evidenceRefs: [eventRef],
    investigation: [{ action: 'Measure each owner-stamped file against local HEAD',
      outcome: 'Every exact working blob is in a sync-authored commit', evidenceRefs: [eventRef] }],
    attempts: [], verification: { outcome: 'All current code working-set blobs are committed', evidenceRefs: [eventRef] } });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'git-sync-blocker-evidence-'));
    git(root, 'init', '-q');
    mkdirSync(join(root, 'src'));
    for (const path of paths) writeFileSync(join(root, path), 'baseline\n');
    git(root, 'add', ...paths);
    commit('fixture-baseline');
    current = { id: ctx.workItemId, harness: ctx.harnessSlug!, state: 'blocked', assignee: ctx.ownerId,
      takenAt: '2026-11-13T00:00:00.000Z', payload: { externalBlockers: [blocker], codeWorkingSet: {
        owner: ctx.ownerId, epoch: 1, derivedAt: '2026-11-13T00:01:00.000Z', paths, symbols: [],
      } } };
    mocks.workspace.mockReturnValue(ctx.workspaceId);
    mocks.item.mockResolvedValue(current);
    mocks.deps.mockResolvedValue([]);
    mocks.event.mockReset().mockResolvedValue({ authoritative: false, verdict: 'unknown', evidence: 'broad key' });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('defers on exact pending blobs, ignores unrelated commits, then verifies sync-authored containment', async () => {
    for (const path of paths) writeFileSync(join(root, path), `changed ${path}\n`);
    const context = { ...evidenceContext(), sessionId: ctx.ownerId };
    expect(await read()).toMatchObject({ status: 'available', condition: 'pending', reachable: true,
      responsibleParty: 'system:git-sync', subjectWorkItemId: ctx.workItemId });
    expect(await preflightBlockerDecision(subject(), deferred(), context, { effect: { state: 'blocked' } }))
      .toMatchObject({ ok: true });

    writeFileSync(join(root, 'src/unrelated.ts'), 'unrelated\n');
    git(root, 'add', 'src/unrelated.ts');
    commit('papercusp-git-sync');
    expect(await read()).toMatchObject({ status: 'available', condition: 'pending', reachable: true });

    git(root, 'add', ...paths);
    commit('papercusp-git-sync');
    expect(await read()).toMatchObject({ status: 'available', condition: 'satisfied', reachable: true });
    expect(await preflightBlockerDecision(subject(), resolved(), context,
      { effect: { state: 'done' }, requireResolution: true })).toMatchObject({ ok: true });
    expect(mocks.event).not.toHaveBeenCalled();
  });

  it('keeps the broad wake unmeasured without a current owner-stamped work set', async () => {
    current.payload = { externalBlockers: [blocker], codeWorkingSet: {
      owner: 'su-other', epoch: 1, derivedAt: '2026-11-13T00:01:00.000Z', paths, symbols: [],
    } };
    expect(await read()).toMatchObject({ status: 'unknown' });
    expect(mocks.event).not.toHaveBeenCalled();
  });
});
