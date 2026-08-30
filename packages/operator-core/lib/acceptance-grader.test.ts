import { describe, expect, it, vi } from 'vitest';
import {
  acceptanceGraderLabelPrefix,
  buildAssignedAcceptanceGraderBrief,
  classifyAcceptanceGraderStartupStall,
  classifyAcceptanceGraderTerminalFailure,
  detectAcceptanceGraderTerminalFailure,
  launchAcceptanceGrader,
  resolveAcceptanceGrader,
} from './acceptance-grader';

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

const workItems = [
  {
    id: 'WI-1',
    state: 'done',
    title: 'Implement the thing',
    terminalOwner: 'su-implementer',
    terminalCompletionRef: 'test:thing',
    terminalCompletionEvidence: { command: 'vitest', exitCode: 0 },
  },
] as never;

const ctx = { workspaceId: 'ws-test', harnessSlug: 'papercusp', role: 'su' } as never;

function deps(launch: ReturnType<typeof vi.fn>) {
  return {
    readPlan: vi.fn(async () => plan),
    getRubric: vi.fn(async () => rubric),
    getAudit: vi.fn(async () => audit),
    listWork: vi.fn(async () => workItems),
    launch: launch as never,
    listTasks: vi.fn(async () => []),
    killTask: vi.fn(async () => ({ ok: true })) as never,
  };
}

describe('launchAcceptanceGrader', () => {
  it('launches exactly one fresh headless judge with stable identity and a parseable frozen snapshot', async () => {
    const launch = vi.fn(async (_args: Record<string, unknown>) => ({
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

    const args = launch.mock.calls[0][0];
    expect(args).toMatchObject({
      harness: 'papercusp',
      headless: true,
      account: 'default',
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
    expect(brief).toContain('first resolve the subject harness checkout');
    expect(brief).toContain('capability:read');
    expect(brief).toContain('git rev-parse <superproject-ref>:<nested-path>');
    expect(brief).toContain('not evidence of a fabricated citation');
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

  it('retires an over-age deduped judge and launches a deterministic fresh retry', async () => {
    const launch = vi.fn(async (args: Record<string, unknown>) =>
      String(args.idempotencyKey).includes(':retry:')
        ? {
            content: [{ type: 'text', text: 'launched retry' }],
            data: { deduped: false, launch: { tasks: [{ taskId: 'task-fresh' }] } },
          }
        : {
            content: [{ type: 'text', text: 'already launched' }],
            data: { deduped: true, launch: { tasks: [{ taskId: 'task-stale' }] } },
          },
    );
    const kill = vi.fn(async () => ({ ok: true }));
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      listTasks: vi.fn(async () => [
        {
          taskId: 'task-stale',
          state: 'running',
          startedAt: '2026-08-24T00:00:00.000Z',
          endedAt: null,
        },
      ]) as never,
      killTask: kill as never,
      nowMs: () => Date.parse('2026-08-25T00:00:00.000Z'),
    });

    expect(kill).toHaveBeenCalledWith('task-stale', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1][0]).toMatchObject({
      idempotencyKey: expect.stringMatching(/:retry:[a-f0-9]{16}$/),
    });
    expect(result).toMatchObject({
      state: 'launched',
      launch: { tasks: [{ taskId: 'task-fresh' }] },
      staleRecovery: { retiredTaskIds: ['task-stale'], attempts: 2 },
    });
  });

  it('retires a quota-blocked Claude judge and performs one deterministic Codex fallback', async () => {
    const quotaLog = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
    const launch = vi.fn(async (args: Record<string, unknown>) =>
      args.agent === 'codex'
        ? {
            content: [{ type: 'text', text: 'launched fallback' }],
            data: {
              deduped: false,
              launch: { tasks: [{ taskId: 'task-fallback', logPath: '/tmp/fallback.log' }] },
            },
          }
        : {
            isError: true,
            content: [{ type: 'text', text: 'launched primary' }],
            data: {
              deduped: false,
              launch: { tasks: [{ taskId: 'task-quota', logPath: '/tmp/quota.log' }] },
            },
          },
    );
    const kill = vi.fn(async () => ({ ok: true }));
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      killTask: kill as never,
      readLogTail: (path) => (path === '/tmp/quota.log' ? quotaLog : ''),
    });

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('task-quota', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1][0]).toMatchObject({
      account: 'default',
      agent: 'codex',
      members: [{ role: 'judge', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' }],
      idempotencyKey: expect.stringMatching(/:recovery:[a-f0-9]{16}$/),
    });
    expect(result).toMatchObject({
      state: 'launched',
      launch: { tasks: [{ taskId: 'task-fallback' }] },
      terminalRecovery: {
        retiredTaskIds: ['task-quota'],
        attempts: 2,
        codes: ['model_quota_exhausted'],
        fallback: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'default' },
      },
    });
  });

  it('rechecks the headless log after launch returns before deciding quota fallback', async () => {
    const quotaLog = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
    let primaryReads = 0;
    const launch = vi.fn(async (args: Record<string, unknown>) =>
      args.agent === 'codex'
        ? {
            content: [{ type: 'text', text: 'launched fallback' }],
            data: { deduped: false, launch: { tasks: [{ taskId: 'task-fallback' }] } },
          }
        : {
            content: [{ type: 'text', text: 'launched primary' }],
            data: {
              deduped: false,
              launch: { tasks: [{ taskId: 'task-delayed-quota', logPath: '/tmp/delayed-quota.log' }] },
            },
          },
    );
    const kill = vi.fn(async () => ({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      killTask: kill as never,
      sleep,
      terminalLogRecheckDelayMs: 0,
      readLogTail: (path) => {
        if (path !== '/tmp/delayed-quota.log') return '';
        primaryReads += 1;
        return primaryReads === 1 ? '' : quotaLog;
      },
    });

    expect(primaryReads).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('task-delayed-quota', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      state: 'launched',
      terminalRecovery: {
        retiredTaskIds: ['task-delayed-quota'],
        codes: ['model_quota_exhausted'],
      },
    });
  });

  it('retires a Claude judge stuck on the connection screen and performs one deterministic Codex fallback', async () => {
    const connectingLog =
      'psu: cwd /tmp/papercusp — role-scoped MCP (judge); resume from here\n' +
      '/rc connecting…\n' +
      'psu: the MCP proxy is overloaded; retrying in 1s (attempt 2/5)…';
    const launch = vi.fn(async (args: Record<string, unknown>) =>
      args.agent === 'codex'
        ? {
            content: [{ type: 'text', text: 'launched fallback' }],
            data: { deduped: false, launch: { tasks: [{ taskId: 'task-fallback' }] } },
          }
        : {
            content: [{ type: 'text', text: 'launched primary' }],
            data: {
              deduped: false,
              launch: { tasks: [{ taskId: 'task-connecting', logPath: '/tmp/connecting.log' }] },
            },
          },
    );
    const kill = vi.fn(async () => ({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      killTask: kill as never,
      sleep,
      terminalLogMaxRechecks: 0,
      startupStallLogRecheckDelayMs: 0,
      startupStallLogMaxRechecks: 1,
      readLogTail: (path) => (path === '/tmp/connecting.log' ? connectingLog : ''),
    });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('task-connecting', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1][0]).toMatchObject({
      account: 'default',
      agent: 'codex',
      members: [{ role: 'judge', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' }],
      idempotencyKey: expect.stringMatching(/:recovery:[a-f0-9]{16}$/),
    });
    expect(result).toMatchObject({
      state: 'launched',
      terminalRecovery: {
        retiredTaskIds: ['task-connecting'],
        attempts: 2,
        codes: ['startup_connection_stalled'],
      },
    });
  });

  it('stops after the single terminal fallback when its model is quota-blocked too', async () => {
    const quotaLog = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
    const launch = vi.fn(async (args: Record<string, unknown>) => ({
      content: [{ type: 'text', text: 'launched' }],
      data: {
        deduped: false,
        launch: {
          tasks: [
            {
              taskId: args.agent === 'codex' ? 'task-fallback-quota' : 'task-primary-quota',
              logPath: args.agent === 'codex' ? '/tmp/fallback-quota.log' : '/tmp/primary-quota.log',
            },
          ],
        },
      },
    }));
    const kill = vi.fn(async () => ({ ok: true }));
    const result = await launchAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      killTask: kill as never,
      readLogTail: () => quotaLog,
    });

    expect(launch).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(result.state).toBe('failed');
    expect(result.error).toContain('one-retry ceiling');
    expect(result.terminalRecovery?.retiredTaskIds).toEqual(['task-primary-quota', 'task-fallback-quota']);
  });

  it('uses the same label prefix algebra that cleanup matches', () => {
    expect(acceptanceGraderLabelPrefix('Acceptance / Weird Name')).toBe('acceptance-grader:acceptance-weird-name:');
  });
});

describe('classifyAcceptanceGraderTerminalFailure', () => {
  it('matches the exact terminal model-limit response through terminal control bytes', () => {
    const raw =
      "\u001b[31mYou've reached your Fable 5 limit.\u001b[0m\r\n" +
      'Run /usage-credits to continue or switch models with /model.';
    expect(classifyAcceptanceGraderTerminalFailure(raw)).toEqual({
      code: 'model_quota_exhausted',
      evidence: "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
    });
  });

  it('does not treat broad error/limit prose in frozen evidence as a terminal mission failure', () => {
    expect(
      classifyAcceptanceGraderTerminalFailure('The plan documents a request limit and an error budget.'),
    ).toBeNull();
    expect(classifyAcceptanceGraderTerminalFailure("You've reached your test limit.")).toBeNull();
  });
});

describe('classifyAcceptanceGraderStartupStall', () => {
  it('matches only the exact connection screen when no first-turn progress exists', () => {
    expect(
      classifyAcceptanceGraderStartupStall(
        'psu: role-scoped MCP (judge)\n/rc connecting…\n' +
          'psu: the MCP proxy is overloaded; retrying in 1s (attempt 2/5)…',
      ),
    ).toEqual({
      code: 'startup_connection_stalled',
      evidence: '/rc connecting… · the MCP proxy is overloaded; retrying in 1s (attempt 2/5)…',
    });
  });

  it('rejects generic prose and any tail that has entered the first turn', () => {
    expect(classifyAcceptanceGraderStartupStall('The plan describes a client connecting to MCP.')).toBeNull();
    expect(
      classifyAcceptanceGraderStartupStall('/rc connecting…\nWorking (4s)\npapercusp.tools:invoke({})'),
    ).toBeNull();
  });
});

describe('detectAcceptanceGraderTerminalFailure', () => {
  it('stops after the bounded recheck window when no terminal response arrives', async () => {
    const readLogTail = vi.fn(() => 'still booting');
    const sleep = vi.fn(async () => undefined);

    await expect(
      detectAcceptanceGraderTerminalFailure('/tmp/judge.log', {
        readLogTail,
        sleep,
        delayMs: 0,
        maxRechecks: 2,
      }),
    ).resolves.toBeNull();

    expect(readLogTail).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('waits for the bounded startup window before classifying a persistent connection stall', async () => {
    const readLogTail = vi.fn(() => '/rc connecting…');
    const sleep = vi.fn(async () => undefined);

    await expect(
      detectAcceptanceGraderTerminalFailure('/tmp/judge.log', {
        readLogTail,
        sleep,
        delayMs: 0,
        maxRechecks: 0,
        startupStallDelayMs: 0,
        startupStallMaxRechecks: 2,
      }),
    ).resolves.toEqual({
      code: 'startup_connection_stalled',
      evidence: '/rc connecting…; no first-turn progress after 0ms bounded recheck',
    });

    expect(readLogTail).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('returns healthy as soon as the connecting tail shows first-turn progress', async () => {
    const readLogTail = vi
      .fn()
      .mockReturnValueOnce('/rc connecting…')
      .mockReturnValueOnce('/rc connecting…\nWorking (4s)\npapercusp.tools:invoke({})');

    await expect(
      detectAcceptanceGraderTerminalFailure('/tmp/judge.log', {
        readLogTail,
        sleep: async () => undefined,
        delayMs: 0,
        maxRechecks: 0,
        startupStallDelayMs: 0,
        startupStallMaxRechecks: 2,
      }),
    ).resolves.toBeNull();

    expect(readLogTail).toHaveBeenCalledTimes(2);
  });
});

describe('resolveAcceptanceGrader (P-011 / D-009 discovery-first)', () => {
  const freshLaunch = () =>
    vi.fn(async () => ({
      content: [{ type: 'text', text: 'launched' }],
      data: { deduped: false, launch: { tasks: [{ taskId: 'task-x' }] } },
    }));

  it('ASSIGNS the discovered grader MENU, opens ONE cascade, and never launches a fresh judge', async () => {
    const launch = freshLaunch();
    const openCascade = vi.fn(async () => ({ conversationId: 'conv-1', woke: 1 }));
    const graders = [
      { ownerId: 'su-independent', score: 0.71, liveness: 'live', via: 'floor' as const },
      { ownerId: 'su-second', score: 0.62, liveness: 'parked', via: 'floor' as const },
    ];
    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      discover: vi.fn(async () => ({
        verdict: 'assigned' as const,
        graders,
        routing: { selection: { min: 1, max: 2, selected: [] } },
        excluded: ['su-implementer'],
      })),
      openCascade: openCascade as never,
    });
    expect(result.state).toBe('assigned');
    expect(result.graders?.map((g) => g.ownerId)).toEqual(['su-independent', 'su-second']);
    expect(result.conversationId).toBe('conv-1');
    expect(result.excluded).toEqual(['su-implementer']);
    expect(result.notified).toEqual({ woke: 1 });
    expect(launch).not.toHaveBeenCalled();
    // The WHOLE menu is handed to the cascade, but only ONE open call is made:
    // grader 2 is the cascade's to wake after grader 1 replies/declines/expires
    // (D-003), never a parallel second wake here.
    expect(openCascade).toHaveBeenCalledTimes(1);
    expect(openCascade).toHaveBeenCalledWith(
      expect.objectContaining({
        planSlug: 'ship-the-thing',
        harnessSlug: 'papercusp',
        rubricId: 'acceptance-ship-the-thing',
        graders,
      }),
      ctx,
    );
  });

  it('discovery says fresh → falls through to the frozen judge launch, carrying the reason', async () => {
    const launch = freshLaunch();
    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      discover: vi.fn(async () => ({
        verdict: 'fresh' as const,
        graders: [],
        excluded: ['su-implementer'],
        freshReason: 'all_eligible_unselectable' as const,
      })),
    });
    expect(result.state).toBe('launched');
    expect(result.freshReason).toBe('all_eligible_unselectable');
    expect(result.excluded).toEqual(['su-implementer']);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('surfaces zero-eligible escalation while preserving the fresh-judge fallback', async () => {
    const launch = freshLaunch();
    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      discover: vi.fn(async () => ({
        verdict: 'fresh' as const,
        graders: [],
        excluded: ['su-implementer'],
        eligibility: { eligibleCount: 0, qualifiedCount: 0, measured: true, reason: 'zero_eligible' as const },
        escalation: { code: 'zero_eligible' as const },
        freshReason: 'no_eligible_non_excluded' as const,
      })),
    });
    expect(result.state).toBe('launched');
    expect(result.freshReason).toBe('no_eligible_non_excluded');
    expect(result.eligibility).toEqual({
      eligibleCount: 0,
      qualifiedCount: 0,
      measured: true,
      reason: 'zero_eligible',
    });
    expect(result.escalation).toEqual({ code: 'zero_eligible' });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('discovery FAULT → still launches (discovery is a service, never a new failure mode)', async () => {
    const launch = freshLaunch();
    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      discover: vi.fn(async () => {
        throw new Error('router down');
      }),
    });
    expect(result.state).toBe('launched');
    expect(result.freshReason).toBe('discovery_error');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('a cascade-open failure does not demote the assignment, and reports no conversation', async () => {
    const launch = freshLaunch();
    const result = await resolveAcceptanceGrader('ship-the-thing', ctx, {
      ...deps(launch),
      discover: vi.fn(async () => ({
        verdict: 'assigned' as const,
        graders: [{ ownerId: 'su-independent', score: 0.7, liveness: 'parked', via: 'floor' as const }],
        routing: {},
        excluded: [],
      })),
      openCascade: vi.fn(async () => {
        throw new Error('coord down');
      }) as never,
    });
    expect(result.state).toBe('assigned');
    expect(result.notified).toEqual({ woke: 0 });
    // No conversationId: a failed open must not read as a delivered assignment
    // with a thread that does not exist.
    expect(result.conversationId).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('buildAssignedAcceptanceGraderBrief (cross-hive reachability)', () => {
  it('pins both the plan read and deterministic scorecard checks to the subject harness', () => {
    const brief = buildAssignedAcceptanceGraderBrief('ship-the-thing', 'papercusp', 'acceptance-ship-the-thing');

    expect(brief).toContain('plans:get { slug:"ship-the-thing", harness:"papercusp" }');
    expect(brief).toContain(
      'scorecards:emit { rubricRef:"acceptance-ship-the-thing", targetHive:"papercusp", ratings:',
    );
    expect(brief).toContain("subject tree rather than the grader's checkout");
    expect(brief).toContain('gitlink');
    expect(brief).toContain('cwd` set to the nested submodule');
  });

  it('keeps the legacy operator-plan form when no concrete harness exists', () => {
    const brief = buildAssignedAcceptanceGraderBrief('operator-plan', null, 'operator-rubric');

    expect(brief).toContain('plans:get { slug:"operator-plan" }');
    expect(brief).not.toContain('targetHive:');
  });
});
