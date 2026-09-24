/**
 * consult-dispatch.test.ts — the fork/convert walk (plan
 * consult-expert-routing-2026-09-22 P-003, D-002 / D-004 / D-009).
 *
 * WHAT THIS PINS, and why each one needs a test rather than a reading:
 *  - a consult NEVER messages a live agent: a LIVE source is FORKED, not pinged
 *    and not refused (the retired reviver refused a live target outright, which
 *    is the behaviour D-002 replaces);
 *  - the walk CONTINUES past a walled account / an unforkable source / a
 *    non-Claude cross-backend rank, and only an exhausted list is terminal —
 *    R-6's "a walled backend never ends a consult";
 *  - a FORK answers under a freshly PRE-PINNED identity, so the consult row can
 *    name its responder before that session exists.
 *
 * `buildAgentLaunchCommand` is deliberately NOT faked. The argv is the contract
 * between this module and psu, so a hand-written expectation here would only
 * restate this file's own assumptions; running the real composer is what makes
 * "--fork carries --owner-id" and "a conversion carries --agent=<target>" claims
 * about the shipped launcher rather than about the fixture.
 */
import { describe, expect, it } from 'vitest';
import {
  DISPATCH_VERIFY_TIMEOUT_MS,
  consultDispatchBrief,
  dispatchConsultResponder,
  makeConsultReachDispatcher,
  planDispatchOperation,
  type ConsultDispatchContext,
  type ConsultDispatchDeps,
} from './consult-dispatch';
import { buildAgentLaunchCommand, injectLaunchedByArg } from '../agent-launch-core';
import {
  DEFAULT_EXPERT_MODEL_ALLOWLIST,
  normalizeExpertModelAllowlist,
  resolveExpertModelAllowlist,
  type AllowedExpertModel,
} from './expert-model-allowlist';

const CTX: ConsultDispatchContext = {
  workspaceId: 'ws-dispatch',
  harnessSlug: 'papercusp',
  launchedBy: 'su-requester',
};

const OPTS = {
  sourceOwnerId: 'su-expert',
  conversationId: 'conv-d-1',
  brief: '🧭 CONSULT — answer this.',
  evidence: [{ session_id: 'sess-1', turn_idx: 1, sim: 0.8 }],
};

/** Only claude+codex ranks, so a three-step walk fits in one readable assertion. */
const RANKS: AllowedExpertModel[] = [
  { rank: 1, agent: 'claude', model: 'opus' },
  { rank: 2, agent: 'codex', model: 'sol' },
];

interface Fakes {
  deps: Partial<ConsultDispatchDeps>;
  calls: {
    spawn: Array<{
      envelope: { env: Record<string, string>; greetingCmd: string; cwd: string };
      coordOwnerId?: string | null;
      label?: string | null;
    }>;
    verify: Array<{ ownerId: string; timeoutMs?: number }>;
    capacity: Array<{ agent: string; workspaceId: string }>;
  };
}

function makeFakes(
  over: Partial<Record<keyof ConsultDispatchDeps, unknown>> = {},
  opts: { source?: Record<string, unknown>; spawnStatuses?: Array<'ok' | 'error' | 'no-proof'> } = {},
): Fakes {
  const calls: Fakes['calls'] = { spawn: [], verify: [], capacity: [] };
  let mintSeq = 0;
  let spawnSeq = 0;
  const statuses = opts.spawnStatuses ?? [];
  const deps = {
    resolveResumeTarget: async () => ({
      ok: true,
      sessionId: 'sess-1',
      resumeId: 'sess-1',
      ompThreadId: null,
      ownerId: 'su-expert',
      agent: 'claude',
      cwd: '/recorded/cwd',
      model: null,
      modelSource: null,
      endedAt: '2026-09-22T00:00:00Z',
      endedBy: 'self',
      live: false,
      advSessionId: 7,
      binding: null,
      ...(opts.source ?? {}),
    }),
    checkResumeTranscript: async () => ({ available: true, detail: 'fixture transcript' }),
    // REAL composer + REAL injector: see the file header.
    buildAgentLaunchCommand,
    injectLaunchedByArg,
    buildConsoleEnvelope: async () => ({ cwd: '/base/cwd', env: { BASE: '1' }, greetingCmd: '' }),
    spawnHeadless: async (o: Fakes['calls']['spawn'][number]) => {
      calls.spawn.push(o);
      const status = statuses[spawnSeq++] ?? 'ok';
      if (status === 'error') return { status: 'error', code: 500, error: 'fixture spawn failure' };
      return {
        status: 'ok',
        pid: 42,
        terminal: 'headless',
        logPath: '/logs/x.log',
        child: null,
        display: null,
        kickoffProof:
          status === 'no-proof'
            ? { persisted: false, nativeRef: null, reason: 'fixture-no-receipt' }
            : { persisted: true, nativeRef: '/native/answer.jsonl', reason: null },
      };
    },
    fetchContextPressure: async () => new Map(),
    verifyResumeStarted: async (ownerId: string, o: { timeoutMs?: number } = {}) => {
      calls.verify.push({ ownerId, ...o });
      return { started: true, waitedMs: 900 };
    },
    probeBackendAvailable: async (agent: string, workspaceId: string) => {
      calls.capacity.push({ agent, workspaceId });
      return { available: true, detail: `${agent} fixture headroom` };
    },
    mintOwnerId: () => `su-answer-${++mintSeq}`,
    loadRanks: async () => RANKS,
    ...over,
  } as unknown as Partial<ConsultDispatchDeps>;
  return { deps, calls };
}

describe('planDispatchOperation (D-009 walk shape)', () => {
  it('same backend forks; claude → other backend converts', () => {
    expect(planDispatchOperation({ agent: 'claude', live: false }, { agent: 'claude' })).toEqual({ operation: 'fork' });
    expect(planDispatchOperation({ agent: 'codex', live: false }, { agent: 'codex' })).toEqual({ operation: 'fork' });
    expect(planDispatchOperation({ agent: 'claude', live: false }, { agent: 'codex' })).toEqual({ operation: 'convert' });
    expect(planDispatchOperation({ agent: 'claude', live: false }, { agent: 'omp' })).toEqual({ operation: 'convert' });
  });

  it('an OMP source cannot fork at all — OMP has no native branch command', () => {
    expect(planDispatchOperation({ agent: 'omp', live: false }, { agent: 'omp' })).toMatchObject({
      operation: null,
      reason: 'fork-unsupported',
    });
  });

  it('a non-Claude source cannot convert: the transform is claude-source-only, so the rank is SKIPPED', () => {
    for (const source of ['codex', 'omp', '', null] as Array<string | null>) {
      const verdict = planDispatchOperation({ agent: source, live: false }, { agent: 'claude' });
      // A skip, never an error: D-009 §3 is explicit that this must not end the
      // consult, because the next rank may still be reachable.
      if (source === 'claude') continue;
      expect(verdict).toMatchObject({ operation: null, reason: 'conversion-unavailable' });
    }
  });

  it('a LIVE claude source defers conversion (the port continues the source identity) but still forks', () => {
    expect(planDispatchOperation({ agent: 'claude', live: true }, { agent: 'codex' })).toMatchObject({
      operation: null,
      reason: 'convert-needs-live-source-identity',
    });
    // The whole point of D-002: a live expert is reachable by FORK, so liveness
    // never costs the consult its rank-1 pick.
    expect(planDispatchOperation({ agent: 'claude', live: true }, { agent: 'claude' })).toEqual({ operation: 'fork' });
  });
});

describe('dispatchConsultResponder — the fork leg', () => {
  it('forks a dead claude source under a freshly PRE-PINNED identity', async () => {
    const { deps, calls } = makeFakes();
    const r = await dispatchConsultResponder(OPTS, CTX, deps);

    expect(r).toMatchObject({
      dispatched: true,
      operation: 'fork',
      agent: 'claude',
      model: 'opus',
      verified: true,
      answeringOwnerId: 'su-answer-1',
    });
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ rank: 1, outcome: 'dispatched', operation: 'fork' });

    // The REAL composer's argv: a fork of the source session that pre-pins the
    // answering identity, and no conversion flag.
    const cmd = calls.spawn[0]!.envelope.greetingCmd;
    expect(cmd).toContain('--resume=sess-1');
    expect(cmd).toContain('--fork');
    expect(cmd).toContain('--owner-id=su-answer-1');
    expect(cmd).toContain('--model=opus');
    expect(cmd).toContain('--account=auto');
    expect(cmd).toContain('--headless');
    expect(cmd).toContain('--launched-by=su-requester');

    // The brief rides the ENV (never the greeting one-liner), the launch lands in
    // the source's recorded cwd, and the task is keyed to the ANSWERING identity.
    expect(calls.spawn[0]!.envelope.env.PAPERCUSP_KICKOFF_PROMPT).toContain(OPTS.brief);
    expect(calls.spawn[0]!.envelope.env.PAPERCUSP_KICKOFF_PROMPT).toContain('EXACT TRANSCRIPT EVIDENCE: sess-1#1');
    expect(calls.spawn[0]!.envelope.env.BASE).toBe('1');
    expect(calls.spawn[0]!.envelope.cwd).toBe('/recorded/cwd');
    expect(calls.spawn[0]!.coordOwnerId).toBe('su-answer-1');
    // Verification polls the ANSWERING identity — the pre-pin is what makes that
    // possible for a fork at all.
    expect(calls.verify[0]).toMatchObject({ ownerId: 'su-answer-1', timeoutMs: DISPATCH_VERIFY_TIMEOUT_MS });
  });

  it('publishes the fork responder before startup verification can admit a first reply', async () => {
    const { deps, calls } = makeFakes();
    const order: string[] = [];
    let rowResponder = 'su-expert';

    deps.verifyResumeStarted = async (ownerId) => {
      order.push('verify');
      expect(rowResponder).toBe(ownerId);
      expect(calls.spawn[0]!.coordOwnerId).toBe(ownerId);
      expect(calls.spawn[0]!.envelope.greetingCmd).toContain(`--owner-id=${ownerId}`);
      return { started: true, waitedMs: 900 };
    };

    const r = await dispatchConsultResponder(
      {
        ...OPTS,
        onAnsweringOwner: async (ownerId) => {
          rowResponder = ownerId;
          order.push('stamped');
        },
      },
      CTX,
      deps,
    );

    expect(order).toEqual(['stamped', 'verify']);
    expect(r).toMatchObject({ dispatched: true, operation: 'fork', answeringOwnerId: 'su-answer-1' });
  });

  it.each([
    { agent: 'codex' as const, model: 'sol', account: 'auto' },
    { agent: 'omp' as const, model: 'sonnet', account: 'default' },
  ])('routes $agent consult conversions with the appropriate account path', async ({ agent, model, account }) => {
    const { deps, calls } = makeFakes({ loadRanks: async () => [{ rank: 1, agent, model }] });
    const result = await dispatchConsultResponder(OPTS, CTX, deps);

    expect(result).toMatchObject({ dispatched: true, operation: 'convert', agent });
    expect(calls.spawn[0]!.envelope.greetingCmd).toContain(`--account=${account}`);
  });

  it('FORKS a LIVE source rather than refusing it — the retired reviver refused here', async () => {
    const { deps, calls } = makeFakes({}, { source: { live: true, endedAt: null } });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);

    expect(r).toMatchObject({ dispatched: true, operation: 'fork', answeringOwnerId: 'su-answer-1' });
    // The answering session is a DIFFERENT identity from the live source, which
    // is what lets it run alongside without colliding on locks/presence/wake.
    expect(r.answeringOwnerId).not.toBe('su-expert');
    expect(calls.spawn[0]!.envelope.greetingCmd).toContain('--fork');
  });

  it('resolves the brief PER OPERATION so a conversion is never told it is a fork', async () => {
    const seen: string[] = [];
    const { deps } = makeFakes(
      {
        loadRanks: async () => [{ rank: 1, agent: 'codex', model: 'sol' }] as AllowedExpertModel[],
      },
      { source: { agent: 'claude' } },
    );
    await dispatchConsultResponder(
      {
        ...OPTS,
        brief: (operation) => {
          seen.push(operation);
          return `brief for ${operation}`;
        },
      },
      CTX,
      deps,
    );
    expect(seen).toEqual(['convert']);
  });

  it('refuses cross-backend conversion when no exact matched transcript turns exist', async () => {
    const { deps, calls } = makeFakes({
      loadRanks: async () => [{ rank: 1, agent: 'codex', model: 'sol' }] as AllowedExpertModel[],
    });
    const result = await dispatchConsultResponder({ ...OPTS, evidence: undefined }, CTX, deps);

    expect(result.dispatched).toBe(false);
    expect(result.attempts).toMatchObject([{ reason: 'evidence-span-unavailable' }]);
    expect(calls.spawn).toHaveLength(0);
  });
});

describe('dispatchConsultResponder — the walk', () => {
  it('skips a WALLED backend and dispatches the next rank (R-6)', async () => {
    const { deps, calls } = makeFakes({
      probeBackendAvailable: async (agent: string) =>
        agent === 'claude'
          ? { available: false, detail: 'every claude account reads full/paused' }
          : { available: true, detail: 'codex headroom' },
    });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);

    expect(r).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex', model: 'sol' });
    expect(r.attempts.map((a) => [a.rank, a.outcome, a.reason])).toEqual([
      [1, 'skipped', 'account-walled'],
      [2, 'dispatched', undefined],
    ]);
    // A conversion names the TARGET backend explicitly (P-002/R-12) — without it
    // psu back-fills from the model name and silently resumes the source backend.
    const cmd = calls.spawn[0]!.envelope.greetingCmd;
    expect(cmd).toContain('--agent=codex');
    expect(cmd).toContain('--resume=sess-1');
    expect(cmd).not.toContain('--fork');
    // A conversion continues the SOURCE identity (the port's authority
    // invariant), so there is nothing to pre-pin and nothing pinned.
    expect(cmd).not.toContain('--owner-id');
    expect(r.answeringOwnerId).toBe('su-expert');
  });

  it('skips a rank whose LAUNCH fails and dispatches the next', async () => {
    const { deps } = makeFakes({}, { spawnStatuses: ['error', 'ok'] });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r).toMatchObject({ dispatched: true, agent: 'codex' });
    expect(r.attempts.map((a) => [a.rank, a.outcome, a.reason])).toEqual([
      [1, 'failed', 'launch-failed'],
      [2, 'dispatched', undefined],
    ]);
  });

  it('treats an unpersisted kickoff as a FAILED rank — an unsubmitted brief is a phantom responder', async () => {
    const { deps } = makeFakes({}, { spawnStatuses: ['no-proof', 'ok'] });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.attempts[0]).toMatchObject({ rank: 1, outcome: 'failed', reason: 'kickoff-not-persisted' });
    expect(r).toMatchObject({ dispatched: true, agent: 'codex' });
  });

  it('a CRITICAL-context source blocks the FORK ranks only — a conversion re-renders into the target budget', async () => {
    const { deps } = makeFakes({
      fetchContextPressure: async () => new Map([['su-expert', 'critical']]),
    });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.attempts[0]).toMatchObject({ rank: 1, operation: 'fork', reason: 'source-context-critical' });
    expect(r).toMatchObject({ dispatched: true, operation: 'convert', agent: 'codex' });
  });

  it('an exhausted allowlist is the terminal verdict, with every rank recorded as evidence', async () => {
    const { deps, calls } = makeFakes({
      probeBackendAvailable: async (agent: string) => ({ available: false, detail: `${agent} walled` }),
    });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.dispatched).toBe(false);
    expect(r.answeringOwnerId).toBeNull();
    expect(r.attempts.map((a) => a.reason)).toEqual(['account-walled', 'account-walled']);
    expect(r.detail).toContain('every allowed expert model was exhausted');
    // Nothing was launched, and — the D-002 invariant — nothing was messaged:
    // this module has no notify seam to message anyone WITH.
    expect(calls.spawn).toHaveLength(0);
  });

  it('an OMP source with no OMP-reachable rank exhausts by SKIP, never by error', async () => {
    const { deps } = makeFakes(
      { loadRanks: async () => [...RANKS, { rank: 3, agent: 'omp', model: 'grok' }] as AllowedExpertModel[] },
      { source: { agent: 'omp', ompThreadId: 'thr-1', sessionId: null, resumeId: '9' } },
    );
    const r = await dispatchConsultResponder({ ...OPTS, evidence: undefined }, CTX, deps);
    expect(r.dispatched).toBe(false);
    expect(r.attempts.map((a) => [a.agent, a.reason])).toEqual([
      ['claude', 'conversion-unavailable'],
      ['codex', 'conversion-unavailable'],
      ['omp', 'fork-unsupported'],
    ]);
    expect(r.attempts.every((a) => a.outcome === 'skipped')).toBe(true);
  });

  it('refuses before any launch when the source transcript is gone', async () => {
    const { deps, calls } = makeFakes({
      checkResumeTranscript: async () => ({ available: false, detail: 'native transcript unavailable (retired)' }),
    });
    const r = await dispatchConsultResponder(OPTS, CTX, deps);
    expect(r.dispatched).toBe(false);
    expect(r.detail).toContain('source transcript unavailable');
    expect(calls.spawn).toHaveLength(0);
  });

  it('never throws — an unresolvable source is a dispatched:false verdict', async () => {
    const { deps } = makeFakes({
      resolveResumeTarget: async () => ({ ok: false, error: 'not_found', detail: 'no adv row' }),
    });
    await expect(dispatchConsultResponder(OPTS, CTX, deps)).resolves.toMatchObject({
      dispatched: false,
      detail: expect.stringContaining('source session unresolvable'),
    });
  });

  it('never throws — a throwing seam is a dispatched:false verdict', async () => {
    const { deps } = makeFakes({
      resolveResumeTarget: async () => {
        throw new Error('pg is down');
      },
    });
    await expect(dispatchConsultResponder(OPTS, CTX, deps)).resolves.toMatchObject({
      dispatched: false,
      detail: expect.stringContaining('dispatch threw: pg is down'),
    });
  });
});

describe('makeConsultReachDispatcher (D-010: the seam shape survives, its meaning changes)', () => {
  it('reports a dispatched launch in the delivery-count shape every consult call site already reads', async () => {
    const { deps, calls } = makeFakes();
    const reach = makeConsultReachDispatcher(CTX, deps);
    const r = await reach({
      responder: 'su-expert',
      conversationId: 'conv-d-1',
      summary: '🧭 consult from su-requester: why?',
      body: 'Why you: evidence line.',
    });
    expect(r).toMatchObject({ queued: 1, woke: 1, pickupConfirmed: true, answeringOwnerId: 'su-answer-1' });
    // The wake copy carries over verbatim into the brief, under a frame that says
    // this session was launched FOR the consult.
    const brief = calls.spawn[0]!.envelope.env.PAPERCUSP_KICKOFF_PROMPT;
    expect(brief).toContain('conv-d-1');
    expect(brief).toContain('Why you: evidence line.');
    expect(brief).toContain('🧭 consult from su-requester: why?');
    expect(brief).toContain('FORK of su-expert');
  });

  it('a still-BOOTING launch is a delivery without a pickup claim', async () => {
    const { deps } = makeFakes({
      verifyResumeStarted: async () => ({ started: false, waitedMs: DISPATCH_VERIFY_TIMEOUT_MS }),
    });
    const reach = makeConsultReachDispatcher(CTX, deps);
    const r = await reach({ responder: 'su-expert', conversationId: 'c', summary: 's', body: 'b' });
    expect(r).toMatchObject({ queued: 1, woke: 0, pickupConfirmed: false });
  });

  it('an exhausted walk reports ZERO deliveries — which is what every caller already cascades on', async () => {
    const { deps } = makeFakes({
      probeBackendAvailable: async () => ({ available: false, detail: 'walled' }),
    });
    const reach = makeConsultReachDispatcher(CTX, deps);
    const r = await reach({ responder: 'su-expert', conversationId: 'c', summary: 's', body: 'b' });
    expect(r).toMatchObject({ queued: 0, woke: 0, pickupConfirmed: false, answeringOwnerId: null });
    expect(r.dispatch.attempts.length).toBeGreaterThan(0);
  });
});

describe('consultDispatchBrief', () => {
  it('tells a fork it is a fork, and says the source was NOT notified', () => {
    const brief = consultDispatchBrief({
      conversationId: 'conv-1',
      sourceOwnerId: 'su-expert',
      operation: 'fork',
      summary: 'S',
      body: 'B',
    });
    expect(brief).toContain('FORK of su-expert');
    expect(brief).toContain('NOT notified');
    expect(brief).toContain('conv-1');
  });

  it('tells a conversion it was carried across backends', () => {
    const brief = consultDispatchBrief({
      conversationId: 'conv-1',
      sourceOwnerId: 'su-expert',
      operation: 'convert',
      summary: 'S',
      body: 'B',
    });
    expect(brief).toContain('CONVERTED onto another backend');
    expect(brief).not.toContain('FORK of');
  });

  it('P-004: carries the ANSWER-ONLY posture on BOTH operations — the brief is the only thing that sets it', () => {
    for (const operation of ['fork', 'convert'] as const) {
      const brief = consultDispatchBrief({
        conversationId: 'conv-1',
        sourceOwnerId: 'su-expert',
        operation,
        summary: 'S',
        body: 'B',
      });
      expect(brief).toContain('ANSWER-ONLY');
      expect(brief).toContain('END YOUR TURN');
      // The specific failure this exists to prevent: a session reading its
      // inherited transcript as its own agenda and resuming the source's work
      // under a second identity.
      expect(brief).toContain('not an agenda to continue');
      expect(brief).toContain('Do not claim work-items');
    }
  });
});

describe('expert-model allowlist (D-004)', () => {
  it('seeds the D-006 rank order: Claude fable/opus, then ChatGPT sol/astra', () => {
    expect([...DEFAULT_EXPERT_MODEL_ALLOWLIST]).toEqual([
      { rank: 1, agent: 'claude', model: 'fable' },
      { rank: 2, agent: 'claude', model: 'opus' },
      { rank: 3, agent: 'codex', model: 'sol' },
      { rank: 4, agent: 'codex', model: 'gpt-6-astra' },
    ]);
  });

  it('re-ranks densely after a GUI reorder leaves gaps, and keeps authored order on a tie', () => {
    expect(
      normalizeExpertModelAllowlist([
        { rank: 7, agent: 'codex', model: 'sol' },
        { rank: 1, agent: 'claude', model: 'opus' },
        { rank: 1, agent: 'claude', model: 'fable' },
      ]),
    ).toEqual([
      { rank: 1, agent: 'claude', model: 'opus' },
      { rank: 2, agent: 'claude', model: 'fable' },
      { rank: 3, agent: 'codex', model: 'sol' },
    ]);
  });

  it('drops unusable rows instead of failing the consult, and de-duplicates a repeated pair', () => {
    expect(
      normalizeExpertModelAllowlist([
        null,
        'opus',
        { agent: 'gemini', model: 'pro' },
        { agent: 'claude', model: '   ' },
        { agent: 'claude', model: 'opus' },
        { agent: 'CLAUDE', model: 'opus' },
      ]),
    ).toEqual([{ rank: 1, agent: 'claude', model: 'opus' }]);
  });

  it('falls back to the seed when the stored setting is empty, unusable, or unreadable', async () => {
    const seed = normalizeExpertModelAllowlist([...DEFAULT_EXPERT_MODEL_ALLOWLIST]);
    await expect(resolveExpertModelAllowlist('ws', {})).resolves.toEqual(seed);
    await expect(resolveExpertModelAllowlist('ws', { loadRanks: async () => [] })).resolves.toEqual(seed);
    await expect(
      resolveExpertModelAllowlist('ws', { loadRanks: async () => [{ agent: 'nope', model: 'x' }] as never }),
    ).resolves.toEqual(seed);
    await expect(
      resolveExpertModelAllowlist('ws', {
        loadRanks: async () => {
          throw new Error('settings table missing');
        },
      }),
    ).resolves.toEqual(seed);
  });

  it('uses the stored ranks when they are usable', async () => {
    await expect(
      resolveExpertModelAllowlist('ws', { loadRanks: async () => [{ rank: 1, agent: 'codex', model: 'astra' }] }),
    ).resolves.toEqual([{ rank: 1, agent: 'codex', model: 'astra' }]);
  });
});

describe('buildAgentLaunchCommand ownerId rule (the pre-pin this dispatch depends on)', () => {
  it('pins a fork and a cross-backend conversion', () => {
    expect(
      buildAgentLaunchCommand({ mode: 'fork', sessionId: 'sid', agent: 'claude', ownerId: 'su-new' }),
    ).toContain('--owner-id=su-new');
    expect(
      buildAgentLaunchCommand({
        mode: 'resume',
        sessionId: 'sid',
        agent: 'claude',
        targetAgent: 'omp',
        ownerId: 'su-new',
      }),
    ).toContain('--owner-id=su-new');
  });

  it('REFUSES a same-backend resume rather than silently resuming under the recorded id', () => {
    expect(() =>
      buildAgentLaunchCommand({ mode: 'resume', sessionId: 'sid', agent: 'claude', ownerId: 'su-new' }),
    ).toThrow(/same-backend resume/);
    expect(() =>
      buildAgentLaunchCommand({
        mode: 'resume',
        sessionId: 'sid',
        agent: 'claude',
        targetAgent: 'claude',
        ownerId: 'su-new',
      }),
    ).toThrow(/same-backend resume/);
  });
});
