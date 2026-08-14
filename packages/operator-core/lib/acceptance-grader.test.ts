import { describe, expect, it, vi } from 'vitest';
import { acceptanceGraderLabelPrefix, launchAcceptanceGrader } from './acceptance-grader';

const plan = {
  row: {
    planSlug: 'ship-the-thing',
    workspaceId: 'ws-test',
    harnessSlug: 'papercusp',
    version: 7,
    contentHash: 'content-hash-7',
    items: [{ id: 'P-001', status: 'done', text: 'Implement the thing' }],
    decisions: [{ id: 'D-006', title: 'Independent grading', body: 'Use a frozen dedicated judge.' }],
  },
} as never;

const rubric = {
  rubricId: 'acceptance-ship-the-thing',
  title: 'Ship acceptance',
  proposedBy: 'su-implementer',
  criteria: [{ key: 'outcome', title: 'Outcome works', description: 'The shipped outcome is verified.' }],
} as never;

const audit = {
  planSlug: 'ship-the-thing',
  harnessSlug: 'papercusp',
  auditSeq: 3,
  createdBy: 'su-implementer',
  createdAt: '2026-08-14T00:00:00.000Z',
  auditedSha: 'abc123',
  summary: 'Focused verification passed.',
  findings: [],
  items: [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'test', path: 'lib/thing.test.ts' }] }],
} as never;

const workItems = [{
  id: 'WI-1',
  state: 'done',
  title: 'Implement the thing',
  terminalOwner: 'su-implementer',
  terminalCompletionRef: 'test:thing',
  terminalCompletionEvidence: { command: 'vitest', exitCode: 0 },
}] as never;

const ctx = { workspaceId: 'ws-test', harnessSlug: 'papercusp', role: 'su' } as never;

function deps(launch: ReturnType<typeof vi.fn>) {
  return {
    readPlan: vi.fn(async () => plan),
    getRubric: vi.fn(async () => rubric),
    getAudit: vi.fn(async () => audit),
    listWork: vi.fn(async () => workItems),
    launch: launch as never,
  };
}

describe('launchAcceptanceGrader', () => {
  it('launches exactly one fresh headless judge with stable identity and a parseable frozen snapshot', async () => {
    const launch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'launched' }],
      data: { deduped: false, launch: { tasks: [{ taskId: 'task-1', logPath: '/tmp/judge.log' }] } },
    }));

    const first = await launchAcceptanceGrader('ship-the-thing', ctx, deps(launch));
    const second = await launchAcceptanceGrader('ship-the-thing', ctx, deps(launch));

    expect(launch).toHaveBeenCalledTimes(2);
    expect(first.state).toBe('launched');
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.label).toBe(second.label);
    expect(first.label).toMatch(/^acceptance-grader:acceptance-ship-the-thing:/);

    const args = launch.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({
      harness: 'papercusp',
      headless: true,
      agent: 'claude',
      count: 1,
      members: [{ role: 'judge' }],
      label: first.label,
      idempotencyKey: first.idempotencyKey,
    });
    const brief = String(args.brief);
    const snapshot = JSON.parse(brief.split('FROZEN_ACCEPTANCE_CONTEXT=')[1]);
    expect(snapshot.plan).toMatchObject({ slug: 'ship-the-thing', version: 7, contentHash: 'content-hash-7' });
    expect(snapshot.rubric.rubricId).toBe('acceptance-ship-the-thing');
    expect(snapshot.audit.auditSeq).toBe(3);
    expect(snapshot.terminalWork[0]).toMatchObject({ id: 'WI-1', state: 'done' });
    expect(brief.length).toBeLessThan(8_000);
  });

  it('surfaces launch-ledger dedupe as a deduped lifecycle with the original task identity', async () => {
    const launch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'already launched' }],
      data: { deduped: true, launch: { deduped: true, tasks: [{ taskId: 'task-1', logPath: '/tmp/judge.log' }] } },
    }));
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, deps(launch));
    expect(result).toMatchObject({ state: 'deduped', launch: { tasks: [{ taskId: 'task-1' }] } });
  });

  it('uses the same label prefix algebra that cleanup matches', () => {
    expect(acceptanceGraderLabelPrefix('Acceptance / Weird Name')).toBe('acceptance-grader:acceptance-weird-name:');
  });
});
