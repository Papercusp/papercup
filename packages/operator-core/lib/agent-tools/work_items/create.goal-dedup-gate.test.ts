/**
 * create.goal-dedup-gate.test — the P-004 WRAPPER derivation
 * (goal-mode-design-intent-hardening-2026-08-16): work_items:create derives the
 * internal `goalDedupGate` core rail SERVER-SIDE — flag GOAL_CREATE_DEDUP_GATE ∧ the
 * creator's RESOLVED goal context (resolveGoalContext), resolved ONCE per call —
 * and the strict zod schema REJECTS any attempt to smuggle the rail in as a tool
 * argument (stronger than stripping: unrecognized_keys is a loud error), so a
 * caller can never arm or disarm its own dedup gate. The core's behavior under the
 * rail is pinned separately in _create-core.goal-dedup-gate.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fleetAdmission = vi.hoisted(() => ({
  admit: vi.fn(async () => ({ allowed: true, scoped: false }) as any),
  notify: vi.fn(),
}));
const goalMocks = vi.hoisted(() => ({
  getFlag: vi.fn(async () => true),
  resolveGoalContext: vi.fn(async (): Promise<string | null> => 'goal-123'),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'me', workspaceId: 'default' }),
  resolveSelfLiteral: (value: string | undefined, callerOwnerId: string) => (value === 'self' ? callerOwnerId : value),
}));
vi.mock('./_create-core', () => ({ createOneWorkItem: vi.fn() }));
vi.mock('../../modes/store', () => ({ getModes: vi.fn(async () => []) }));
vi.mock('./drain-flow', () => ({ withDrainBugAdmission: vi.fn() }));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitSubjectForFleetTarget: fleetAdmission.admit,
  notifyFleetScopeRefusal: fleetAdmission.notify,
  fleetScopeLeaderRemedy: vi.fn(() => 'remedy'),
}));
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: goalMocks.getFlag }));
vi.mock('../../modes/goal-context', () => ({ resolveGoalContext: goalMocks.resolveGoalContext }));

import { FLAGS } from '@papercusp/flags';
import { createOneWorkItem, type CreateOneWorkItemResult } from './_create-core';
import type { WorkItem } from '../../work-items';
const createM = vi.mocked(createOneWorkItem);

const aWorkItem = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'WI-1',
  kind: 'bug',
  family: 'issue',
  harness: 'papercup',
  title: 'a title',
  summary: '',
  state: 'open',
  assignee: null,
  takenAt: null,
  lastProgressAt: null,
  assignedBy: null,
  createdBy: null,
  severity: null,
  parent: null,
  payload: null,
  origin: null,
  auditVerdict: null,
  verifiedAuthorGithubUserId: null,
  rank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  priority: null,
  terminalOwner: null,
  terminalCompletionRef: null,
  terminalCompletionEvidence: null,
  completionAuthority: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  closedAt: null,
} as WorkItem);

const okCore = (title: string): CreateOneWorkItemResult => ({
  ok: true,
  workItem: aWorkItem({ id: `WI-${title}`, title }),
});
const tool = (await import('./create')).default;

const ctx = { workspaceId: 'default', harnessSlug: 'papercup' } as never;
const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(parse(args) as never, ctx)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  goalMocks.getFlag.mockResolvedValue(true);
  goalMocks.resolveGoalContext.mockResolvedValue('goal-123');
  createM.mockImplementation(async (spec) => okCore(spec.title));
});

describe('work_items:create × goal dedup gate derivation (P-004)', () => {
  it('flag ON + resolved goal → EVERY spec carries goalDedupGate:true, resolver consulted ONCE per call', async () => {
    await body({
      items: [
        { kind: 'bug', title: 'b' },
        { kind: 'change', title: 'c' },
        { kind: 'feature', title: 'f', harness: 'papercup' },
      ],
    });
    expect(goalMocks.getFlag).toHaveBeenCalledWith(FLAGS.GOAL_CREATE_DEDUP_GATE, 'system');
    expect(goalMocks.resolveGoalContext).toHaveBeenCalledTimes(1);
    expect(goalMocks.resolveGoalContext).toHaveBeenCalledWith('default', 'me');
    for (const n of [1, 2, 3]) {
      expect(createM).toHaveBeenNthCalledWith(
        n,
        expect.objectContaining({ goalDedupGate: true }),
        expect.anything(),
      );
    }
  });

  it('flag OFF → rail stays false and the resolver is never consulted', async () => {
    goalMocks.getFlag.mockResolvedValue(false);
    await body({ kind: 'bug', title: 'b' });
    expect(goalMocks.resolveGoalContext).not.toHaveBeenCalled();
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({ goalDedupGate: false }),
      expect.anything(),
    );
  });

  it('flag ON + creator under NO goal → rail stays false', async () => {
    goalMocks.resolveGoalContext.mockResolvedValue(null);
    await body({ kind: 'bug', title: 'b' });
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({ goalDedupGate: false }),
      expect.anything(),
    );
  });

  it('resolver THROWING fails OPEN (rail false) and the create still lands', async () => {
    goalMocks.resolveGoalContext.mockRejectedValue(new Error('pg down'));
    const out = await body({ kind: 'bug', title: 'b' });
    expect(out.counts).toMatchObject({ ok: 1 });
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({ goalDedupGate: false }),
      expect.anything(),
    );
  });

  it('the rail can NEVER arrive as a tool argument — strict schema rejects it loudly (single AND items form)', () => {
    expect(() => parse({ kind: 'bug', title: 'x', goalDedupGate: true })).toThrow(/goalDedupGate/);
    expect(() => parse({ items: [{ kind: 'bug', title: 'x', goalDedupGate: false }] })).toThrow(/goalDedupGate/);
    // The DRAIN rail rides the same guarantee — pinned here since WI-38403 predates this file.
    expect(() => parse({ kind: 'bug', title: 'x', requireCompleteDedupCoverage: false })).toThrow(
      /requireCompleteDedupCoverage/,
    );
  });
});
