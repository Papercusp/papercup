/**
 * P-035 (review-system-rework-reduction-2026-09-23): the how-to handoff.
 *
 * The measured failure: WI-10002581's holder concluded, after three `tools:find` calls,
 * that no verb existed to amend an acceptance BAR — while the same program had used
 * `rubrics:amend` 112 times and named it in Decisions D-024..D-026. The prior-attempt
 * brief carried WHAT was tried but not HOW earlier holders changed the plan.
 *
 * Guard: a claim on a plan with a prior `rubrics:amend` names it in `workedVerbs`.
 */
import { describe, expect, it } from 'vitest';
import { compileWorkedVerbs, getClaimTimePriorAttemptBrief, type WorkedVerbCallRow } from './prior-attempt-context';
import type { WorkItem } from './work-items';

const EFFECTS: Record<string, 'read' | 'write'> = {
  'rubrics:amend': 'write',
  'plans:add-decision': 'write',
  'coord:send': 'write',
  'work_items:checkpoint': 'write',
  'plans:get': 'read',
  'rubrics:get': 'read',
};
const effectOf = (tool: string) => EFFECTS[tool];

const PLAN = [
  '## Decisions',
  '',
  '### D-024 — Amend the R-2 BAR',
  'Date: 2026-09-21',
  'Applied with rubrics:amend { dryRun:true } first, then for real. Approved by owner:Avi; read back with rubrics:get.',
  '',
  '### D-025 — Amend the R-3 BAR',
  'Date: 2026-09-21',
  'Same flow: rubrics:amend, then plans:add-decision to record it.',
].join('\n');

const item = {
  id: 'WI-9',
  family: 'issue',
  harness: 'papercusp',
  sourcePlanItemIds: ['P-009'],
  payload: {},
  terminalCompletionRef: null,
  terminalCompletionEvidence: null,
  completionAuthority: null,
  terminalOwner: null,
  closedAt: null,
  updatedAt: '2026-09-22T12:00:00Z',
} as unknown as WorkItem;

const LEDGER: WorkedVerbCallRow[] = [
  { tool: 'coord:send', calls: 376, lastAt: '2026-09-22T22:15:20.000Z', lastActor: 'su-a' },
  { tool: 'work_items:checkpoint', calls: 337, lastAt: '2026-09-23T03:18:12.000Z', lastActor: 'su-b' },
  { tool: 'plans:get', calls: 435, lastAt: '2026-09-23T03:16:51.000Z', lastActor: 'su-c' },
  { tool: 'rubrics:amend', calls: 112, lastAt: '2026-09-22T01:39:40.000Z', lastActor: 'su-a604a73a' },
];

function deps(overrides: Record<string, unknown> = {}) {
  return {
    getPlan: async () => ({ content: PLAN }),
    specs: async () => [],
    edges: async () => [],
    evidence: async () => [],
    item: async () => item,
    items: async () => [item],
    thread: async () => ({ posts: [], total: 0, topics: [], createdAt: '2026-09-20T08:00:00Z' }),
    checkpoint: async () => ({ checkpoint: 'Released: could not find a way to amend the BAR.', updatedAtMs: Date.parse('2026-09-23T04:00:00Z') }),
    lifecycle: async () => ({ events: [], flags: { needsHuman: false, claimHold: false, heldOpenBy: null, heldOpenReason: null }, coverage: { auditRows: 0, reopenEntries: 0, notRecorded: [], degraded: false } }),
    priorWork: async () => null,
    workedVerbCalls: async () => LEDGER,
    toolEffect: effectOf,
    ...overrides,
  };
}

const pointer = { harness: 'papercusp', planSlug: 'plan', planItemId: 'P-009', workItemId: 'WI-9' };

/** The clause's observable (RSR-P-035-A): the new holder's brief names the verb. */
function briefNamesVerb(brief: Awaited<ReturnType<typeof getClaimTimePriorAttemptBrief>>, tool: string): boolean {
  return Boolean(brief?.workedVerbs?.verbs.some((verb) => verb.tool === tool));
}

describe('getClaimTimePriorAttemptBrief — workedVerbs (P-035)', () => {
  it('FALSIFIABILITY CONTROL: the guard predicate rejects a brief built without the P-035 legs', async () => {
    // The pre-P-035 behavior, reproduced by withholding both legs: the same plan, the
    // same Decisions, the same ledger — and a brief that cannot name the verb. If the
    // guard below could pass against this, it would not be a guard.
    const withoutLegs = await getClaimTimePriorAttemptBrief(
      pointer,
      deps({ toolEffect: undefined, workedVerbCalls: undefined }) as never,
    );
    expect(withoutLegs).not.toBeNull();
    expect(briefNamesVerb(withoutLegs, 'rubrics:amend')).toBe(false);
    // A classifier that mislabels the verb as a read is the other way to lose it.
    const misclassified = await getClaimTimePriorAttemptBrief(
      pointer,
      deps({ toolEffect: (tool: string) => (tool === 'rubrics:amend' ? 'read' : effectOf(tool)) }) as never,
    );
    expect(briefNamesVerb(misclassified, 'rubrics:amend')).toBe(false);
  });

  it('names rubrics:amend for a claim on a plan that already amended with it', async () => {
    expect(briefNamesVerb(await getClaimTimePriorAttemptBrief(pointer, deps() as never), 'rubrics:amend')).toBe(true);
    const brief = await getClaimTimePriorAttemptBrief(pointer, deps() as never);
    const worked = brief!.workedVerbs!;
    expect(worked.planSlug).toBe('plan');
    expect(worked.classifier).toBe('tool-registry-effect');
    expect(worked.ledger).toBe('read');
    const amend = worked.verbs.find((verb) => verb.tool === 'rubrics:amend')!;
    expect(amend).toBeDefined();
    expect(amend.calls).toBe(112);
    expect(amend.lastActor).toBe('su-a604a73a');
    expect(amend.decisionRefs).toEqual(expect.arrayContaining([expect.stringMatching(/#D-024$/), expect.stringMatching(/#D-025$/)]));
    // The curated method leads, ahead of higher-volume coordination plumbing.
    expect(worked.verbs[0]!.tool).toBe('rubrics:amend');
  });

  it('lists only registry WRITE verbs: reads and unregistered prose tokens are dropped', async () => {
    const brief = await getClaimTimePriorAttemptBrief(pointer, deps() as never);
    const tools = brief!.workedVerbs!.verbs.map((verb) => verb.tool);
    expect(tools).not.toContain('plans:get');
    expect(tools).not.toContain('rubrics:get');
    expect(tools).not.toContain('owner:Avi');
    expect(tools).toEqual(expect.arrayContaining(['rubrics:amend', 'plans:add-decision', 'coord:send', 'work_items:checkpoint']));
  });

  it('keeps the brief and the decision-named verbs when the call ledger fails', async () => {
    const brief = await getClaimTimePriorAttemptBrief(
      pointer,
      deps({ workedVerbCalls: async () => { throw new Error('ledger down'); } }) as never,
    );
    expect(brief).not.toBeNull();
    expect(brief!.workedVerbs!.ledger).toBe('unavailable');
    const amend = brief!.workedVerbs!.verbs.find((verb) => verb.tool === 'rubrics:amend')!;
    expect(amend.calls).toBe(0);
    expect(amend.decisionRefs.length).toBe(2);
  });

  it('degrades a slow ledger to unavailable instead of blocking the claim', async () => {
    const brief = await getClaimTimePriorAttemptBrief(
      { ...pointer, timeoutMs: 150 },
      deps({ workedVerbCalls: () => new Promise(() => {}) }) as never,
    );
    expect(brief!.workedVerbs!.ledger).toBe('unavailable');
  });

  it('adds nothing when no classifier is wired (pre-P-035 doubles stay byte-identical)', async () => {
    const brief = await getClaimTimePriorAttemptBrief(pointer, deps({ toolEffect: undefined }) as never);
    expect(brief).not.toBeNull();
    expect(brief!.workedVerbs).toBeUndefined();
  });

  it('counts the block in serializedChars so the advertised size stays true', async () => {
    const brief = await getClaimTimePriorAttemptBrief(pointer, deps() as never);
    expect(brief!.serializedChars).toBe(JSON.stringify(brief).length);
  });
});

describe('compileWorkedVerbs', () => {
  it('returns null when the ledger was read and nothing on the plan was written', () => {
    expect(compileWorkedVerbs({ planSlug: 'p', calls: [], decisions: [], effectOf })).toBeNull();
  });

  it('reports an unread ledger as unavailable rather than as an empty history', () => {
    const worked = compileWorkedVerbs({ planSlug: 'p', calls: null, decisions: [], effectOf });
    expect(worked).toEqual(expect.objectContaining({ ledger: 'unavailable', verbs: [], omittedVerbs: 0 }));
  });

  it('bounds the list and discloses how many verbs it cut', () => {
    const calls = Array.from({ length: 20 }, (_, i) => ({ tool: `t${i}:write`, calls: 20 - i, lastAt: null, lastActor: null }));
    const worked = compileWorkedVerbs({ planSlug: 'p', calls, decisions: [], effectOf: () => 'write', limit: 5 })!;
    expect(worked.verbs.map((verb) => verb.tool)).toEqual(['t0:write', 't1:write', 't2:write', 't3:write', 't4:write']);
    expect(worked.omittedVerbs).toBe(15);
  });

  it('treats a throwing classifier as unclassifiable, not as a crash', () => {
    const worked = compileWorkedVerbs({
      planSlug: 'p',
      calls: [{ tool: 'rubrics:amend', calls: 1, lastAt: null, lastActor: null }],
      decisions: [],
      effectOf: () => { throw new Error('registry not loaded'); },
    });
    expect(worked).toBeNull();
  });
});
