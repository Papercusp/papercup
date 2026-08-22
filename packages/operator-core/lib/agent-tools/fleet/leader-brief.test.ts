/**
 * leader-brief.test.ts — fleet-reliability-verification-2026-07-10 P-007.
 *
 * projectMember is the PURE per-member reshape (fleet:assignments'
 * decoration output → the leader-lean brief row) — unit-tested directly, no
 * PG/DI ceremony (mirrors deriveMemberVerdict/deriveContextPressure).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  computeBenchSuggestion,
  computeDormantAlert,
  computeFleetBlockVerdict,
  computeFloorStarvedFleetAlert,
  computeIdleWithClaimableAlert,
  computeSpecStarvedFleetAlert,
  computeSpecAuthorshipAlert,
  computeSpinningAlert,
  computeStrandedFleetAlert,
  compactLeaderBriefMemberVerdicts,
  decorateComposedParkedOn,
  FALSIFIER_FORBIDDEN_TOOLS,
  fleetCapacityProviderForMembers,
  projectMember,
  readLeaderMonitoringBlindAdvisory,
  reconcilePsuHostLiveness,
  resolveComposedParkedOn,
  selectLeaderBriefMembers,
  topExcludedFloors,
  type ComposedParkEntry,
  type DecoratedAgent,
} from './leader-brief';
import leaderBriefTool from './leader-brief';
import { VERDICT_SPEAKING_FRESH_MS } from './assignments';

const NOW = Date.parse('2026-07-10T12:00:00.000Z');

describe('fleet:leader-brief — ambient workspace transaction safety (EI-20192040030675541)', () => {
  it('opts out because the supervision read never uses ctx.tx', () => {
    expect((leaderBriefTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

describe('fleet:leader-brief — profile-derived zero-awaiters advisory (P-015)', () => {
  const expectedKeys = [
    'fleet:member-dead:alpha',
    'fleet:drained:alpha',
    'fleet:context-critical:alpha',
    'fleet:claim-released:alpha',
    'fleet:admission-blocked:alpha',
  ];

  it('reads the exact five standard profile keys and stays absent when every key has a live awaiter', async () => {
    const seen: string[] = [];
    const advisory = await readLeaderMonitoringBlindAdvisory('alpha', async (eventKey) => {
      seen.push(eventKey);
      return [{}];
    });

    expect(seen).toEqual(expectedKeys);
    expect(advisory).toBeUndefined();
  });

  it('warns when any required key has zero awaiters and carries one actionable fleet arm handle', async () => {
    const advisory = await readLeaderMonitoringBlindAdvisory('alpha', async (eventKey) =>
      eventKey === 'fleet:drained:alpha' ? [] : [{}],
    );

    expect(advisory).toMatchObject({
      line: expect.stringMatching(/monitoring blind.*1\/5.*live_awaiters:0/i),
      missingEventKeys: ['fleet:drained:alpha'],
      arm: {
        tool: 'events:await',
        args: { event: '@fleet:alpha', note: expect.stringContaining('leader control') },
      },
    });
  });

  it('fails soft by omitting the advisory when the live-awaiter read cannot be established', async () => {
    await expect(
      readLeaderMonitoringBlindAdvisory('alpha', async () => {
        throw new Error('await store unavailable');
      }),
    ).resolves.toBeUndefined();
  });
});

describe('fleetCapacityProviderForMembers (EI-20243921934115652)', () => {
  it('scopes an all-Codex fleet to the Codex pool', () => {
    expect(
      fleetCapacityProviderForMembers([
        { model: 'gpt-5.6-luna', alive: true },
        { model: 'gpt-5.6-sol', alive: true },
      ]),
    ).toBe('codex');
  });

  it('keeps an all-Claude fleet on the Claude pool', () => {
    expect(
      fleetCapacityProviderForMembers([
        { model: 'claude-sonnet-4-5', alive: true },
        { model: 'opus', alive: true },
      ]),
    ).toBe('claude');
  });

  it('ignores dead historical identities when the live fleet is uniform', () => {
    expect(
      fleetCapacityProviderForMembers([
        { model: 'gpt-5.6-luna', alive: true },
        { model: 'claude-sonnet-4-5', alive: false, verdict: 'dead' },
      ]),
    ).toBe('codex');
  });

  it('uses the authoritative adv-session backend for visible PSU members without model tiers', () => {
    expect(
      fleetCapacityProviderForMembers(
        [
          { agentId: 'su-codex-1', model: null, alive: true },
          { agentId: 'su-codex-2', model: null, alive: true },
        ],
        new Map([
          ['su-codex-1', 'codex'],
          ['su-codex-2', 'codex'],
        ]),
      ),
    ).toBe('codex');
  });

  it('ignores a dead historical Claude backend beside live visible Codex members', () => {
    expect(
      fleetCapacityProviderForMembers(
        [
          { agentId: 'su-codex', model: null, alive: true },
          { agentId: 'su-claude-old', model: null, alive: false, verdict: 'dead' },
        ],
        new Map([
          ['su-codex', 'codex'],
          ['su-claude-old', 'claude'],
        ]),
      ),
    ).toBe('codex');
  });

  it('keeps live visible mixed backends unknown', () => {
    expect(
      fleetCapacityProviderForMembers(
        [
          { agentId: 'su-codex', model: null, alive: true },
          { agentId: 'su-claude', model: null, alive: true },
        ],
        new Map([
          ['su-codex', 'codex'],
          ['su-claude', 'claude'],
        ]),
      ),
    ).toBeNull();
  });

  it('does not infer a provider from OMP without a model', () => {
    expect(
      fleetCapacityProviderForMembers(
        [{ agentId: 'su-omp', model: null, alive: true }],
        new Map([['su-omp', 'omp']]),
      ),
    ).toBeNull();
    expect(
      fleetCapacityProviderForMembers(
        [{ agentId: 'su-omp', model: 'gpt-5.6-luna', alive: true }],
        new Map([['su-omp', 'omp']]),
      ),
    ).toBe('codex');
  });

  it('returns unknown for live-mixed or unmeasured fleets instead of borrowing a provider', () => {
    expect(
      fleetCapacityProviderForMembers([
        { model: 'gpt-5.6-luna', alive: true },
        { model: 'claude-sonnet-4-5', alive: true },
      ]),
    ).toBeNull();
    expect(fleetCapacityProviderForMembers([{ model: null }, {}])).toBeNull();
  });
});

/** decorateComposedParkedOn mutates its input in place, adding an optional
 *  `parkedOnResolved` — test fixtures declare it explicitly so the mutated
 *  field is visible to tsc after the call, not just at runtime. */
type ComposedTestAgent = { agentId: string; parkedOn: string[]; parkedOnResolved?: Array<string | ComposedParkEntry> };

function baseAgent(overrides: Partial<DecoratedAgent> = {}): DecoratedAgent {
  return {
    agentId: 'su-1',
    label: null,
    name: null,
    present: true,
    alive: true,
    heartbeatAt: new Date(NOW).toISOString(),
    intent: '',
    declaredPlanSlug: null,
    fleetSlug: 'p2p-git',
    fleetRole: 'member',
    claims: [],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
    ...overrides,
  };
}

describe('reconcilePsuHostLiveness (WI-4755)', () => {
  it('marks a parked visible member ended when its psu host is gone', () => {
    const agent = baseAgent({ sessionState: 'parked' });
    reconcilePsuHostLiveness([agent], new Map([['su-1', 'su']]), () => null);
    expect(agent.sessionState).toBe('ended');
    expect(agent.alive).toBe(false);
  });

  it('does not let a stale directed-wake activity row keep a hostless member live', () => {
    const agent = baseAgent({ sessionState: 'live' });
    reconcilePsuHostLiveness([agent], new Map([['su-1', 'su']]), () => null);
    expect(agent.sessionState).toBe('ended');
    expect(agent.alive).toBe(false);
  });

  it('preserves nursery cups without a psu host', () => {
    const agent = baseAgent({ sessionState: 'parked' });
    reconcilePsuHostLiveness([agent], new Map([['su-1', 'cup']]), () => null);
    expect(agent.sessionState).toBe('parked');
    expect(agent.alive).toBe(true);
  });

  it('keeps a no-host ghost out of the leader census after reconciliation', () => {
    const agent = baseAgent({ agentId: 'su-ghost', sessionState: 'live' });
    reconcilePsuHostLiveness([agent], new Map([['su-ghost', 'su']]), () => null);
    const { rows, census } = selectLeaderBriefMembers([agent], 'p2p-git');
    expect(rows).toEqual([]);
    expect(census).toMatchObject({ candidates: 1, counted: 0, withheld: 1 });
  });
});

describe('selectLeaderBriefMembers (EI-11840)', () => {
  it('keeps every live presence-backed member, including an idle member with no claims', () => {
    const { rows: members } = selectLeaderBriefMembers(
      [
        baseAgent({ agentId: 'su-live-working', claims: [{ type: 'work-item', id: 'WI-1' }] as never }),
        baseAgent({ agentId: 'su-live-idle', claims: [], alive: true }),
        baseAgent({ agentId: 'su-other-fleet', fleetSlug: 'other-fleet', alive: true }),
        baseAgent({ agentId: 'su-stale', alive: false, claims: [] }),
      ],
      'p2p-git',
    );

    expect(members.map((member) => member.agentId)).toEqual([
      'su-live-working',
      'su-live-idle',
    ]);
  });

  it('includes stale canonical roster entries only when explicitly requested', () => {
    const stale = baseAgent({ agentId: 'su-stale', alive: false, claims: [] });
    expect(selectLeaderBriefMembers([stale], 'p2p-git').rows).toEqual([]);
    expect(selectLeaderBriefMembers([stale], 'p2p-git', true).rows).toEqual([stale]);
  });

  // P-010 (fleet-lead-instrumentation-audit-2026-08-09): the same fleet read 11 /
  // 11 / 14 / 8 / 9 across leader-brief and fleet:assignments within minutes, each
  // number defensible and none reconciled. The census makes every count say what
  // it counted and what it hid.
  it('names the population and reports what the stale-idle cut withheld, with the lever to reveal it', () => {
    const entries = [
      baseAgent({ agentId: 'su-live-working', claims: [{ type: 'work-item', id: 'WI-1' }] as never }),
      baseAgent({ agentId: 'su-live-idle', claims: [], alive: true }),
      baseAgent({ agentId: 'su-stale-1', alive: false, claims: [] }),
      baseAgent({ agentId: 'su-stale-2', alive: false, claims: [] }),
    ];
    const { rows, census } = selectLeaderBriefMembers(entries, 'p2p-git');
    expect(census.counted).toBe(rows.length);
    expect(census.candidates).toBe(4);
    expect(census.withheld).toBe(2);
    expect(census.reveal).toBe('include_stale: true');
    // The operative warning: this default hides members exactly when they die.
    expect(census.withheldReason).toContain('stale-idle');

    const revealed = selectLeaderBriefMembers(entries, 'p2p-git', true);
    expect(revealed.census.counted).toBe(4);
    expect(revealed.census.withheld).toBe(0);
    expect(revealed.census.withheldReason).toBeNull();
  });

  // Members of ANOTHER fleet were never candidates for this number. Counting them
  // as `withheld` would make the field grow with unrelated fleets and read as mass
  // concealment — the opposite of the reconciliation this exists to provide.
  it('does NOT count other fleets as withheld — roster membership is not a discretionary filter', () => {
    const { census } = selectLeaderBriefMembers(
      [
        baseAgent({ agentId: 'su-live', alive: true, claims: [] }),
        baseAgent({ agentId: 'su-other-1', fleetSlug: 'other-fleet', alive: true }),
        baseAgent({ agentId: 'su-other-2', fleetSlug: 'other-fleet', alive: false, claims: [] }),
      ],
      'p2p-git',
    );
    expect(census.candidates).toBe(1);
    expect(census.counted).toBe(1);
    expect(census.withheld).toBe(0);
    expect(census.population).toContain('p2p-git');
  });
});

describe('compactLeaderBriefMemberVerdicts (EI-20226510994156306)', () => {
  it('keeps every member id and verdict available for a large-fleet recovery read', () => {
    const members = Array.from({ length: 50 }, (_, i) => ({
      agentId: `su-${i}`,
      verdict: i % 2 === 0 ? ('monitoring' as const) : ('speaking' as const),
      idleVerdict: { cause: i % 2 === 0 ? ('genuinely-idle' as const) : ('working' as const) },
    }));

    const index = compactLeaderBriefMemberVerdicts(members);

    expect(index).toHaveLength(50);
    expect(index[0]).toEqual({ agentId: 'su-0', verdict: 'monitoring', idleCause: 'genuinely-idle' });
    expect(index[49]).toEqual({ agentId: 'su-49', verdict: 'speaking', idleCause: 'working' });
    expect(new Set(index.map((row) => row.agentId)).size).toBe(50);
  });
});

describe('projectMember (pure)', () => {
  it('keeps authoritative verified-wait evidence and its owner/takeover remedy beside the member', () => {
    const alert = {
      subscriberId: 'su-worker',
      eventKey: 'release:green:papercusp',
      firedAt: '2026-08-13T12:00:00.000Z',
      classification: 'absent' as const,
      nextAction: 'wake-owner-or-takeover' as const,
      producer: { kind: 'green-checkpoint', id: 'run-42' },
      owner: { ownerId: 'su-producer', workItemId: 'WI-42' },
      checkedAtMs: 42,
      verificationDeadlineMs: 40,
      lastProgressAtMs: null,
      lastFireAtMs: null,
      remedy: 'Wake the owner of WI-42; if it does not resume promptly, claim/take over WI-42.',
    };
    const m = projectMember(baseAgent({ verifiedWaitTakeovers: [alert] }), NOW);
    expect(m.verifiedWaitTakeovers).toEqual([alert]);
  });

  it('computes lastToolCallAgeMs from the ISO timestamp', () => {
    const agent = baseAgent({ lastToolCallAt: new Date(NOW - 5_000).toISOString() });
    const m = projectMember(agent, NOW);
    expect(m.lastToolCallAgeMs).toBe(5_000);
  });

  it('null lastToolCallAgeMs when the member has never taken a turn', () => {
    const agent = baseAgent({ lastToolCallAt: null });
    const m = projectMember(agent, NOW);
    expect(m.lastToolCallAgeMs).toBeNull();
  });

  // EI-19931924184335892 (recurrence guard): a leader force-released a LIVE claim
  // on the basis of a leader-brief row reading sessionState:'recorded' + stalled:true
  // beside a lastToolCallAgeMs of ~53s — the holder closed the item, with a
  // committed evidenced fix, 8 minutes later. `stalled` is a claim-progress-checkpoint
  // signal (no last_progress_at/taken_at movement in >10min), NOT a liveness signal,
  // and must never read `true` beside a lastToolCallAgeMs that itself proves the
  // member is speaking right now.
  it('never reports stalled:true when lastToolCallAgeMs proves the member is speaking now (EI-19931924184335892)', () => {
    const agent = baseAgent({
      sessionState: 'recorded',
      stalled: true,
      lastToolCallAt: new Date(NOW - 53_000).toISOString(),
    });
    const m = projectMember(agent, NOW);
    expect(m.lastToolCallAgeMs).toBe(53_000);
    expect(m.stalled).toBe(false);
  });

  it('still reports stalled:true when the member is NOT demonstrably speaking (no fresh tool call)', () => {
    const agent = baseAgent({
      sessionState: 'recorded',
      stalled: true,
      lastToolCallAt: new Date(NOW - VERDICT_SPEAKING_FRESH_MS - 1_000).toISOString(),
    });
    const m = projectMember(agent, NOW);
    expect(m.stalled).toBe(true);
  });

  it('leaves stalled:false untouched when the member is speaking and not actually claim-stalled', () => {
    const agent = baseAgent({
      stalled: false,
      lastToolCallAt: new Date(NOW - 1_000).toISOString(),
    });
    const m = projectMember(agent, NOW);
    expect(m.stalled).toBe(false);
  });

  it('collapses claims to queuedCount/load and bounded work-item ids, never the full claim records', () => {
    const agent = baseAgent({
      claims: [
        { type: 'work-item', id: 'WI-1' },
        { type: 'plan-item', id: 'P-1' },
        { type: 'work-item', id: 'WI-2' },
      ] as never,
      queued: [{ id: 'WI-1' }, { id: 'WI-2' }] as never,
      load: 3,
    });
    const m = projectMember(agent, NOW);
    expect(m.queuedCount).toBe(2);
    expect(m.load).toBe(3);
    expect(m.workItemIds).toEqual(['WI-1', 'WI-2']);
    expect('claims' in m).toBe(false);
  });

  it('omits `unanswered` when absent — never a bare zero/empty stub', () => {
    const m = projectMember(baseAgent({}), NOW);
    expect('unanswered' in m).toBe(false);
  });

  it('carries `unanswered` verbatim when the decoration stamped one', () => {
    const unanswered = { count: 2, oldestAgeMs: 90_000, newest: [{ msgId: 'm1', from: 'su-2', ageMs: 1000 }] };
    const m = projectMember(baseAgent({ unanswered }), NOW);
    expect(m.unanswered).toEqual(unanswered);
  });

  it('omits `parkedOn` when empty/absent, carries it when non-empty (bench state)', () => {
    expect('parkedOn' in projectMember(baseAgent({ parkedOn: [] }), NOW)).toBe(false);
    const m = projectMember(baseAgent({ parkedOn: ['p2p-git:phase3-open'] }), NOW);
    expect(m.parkedOn).toEqual(['p2p-git:phase3-open']);
  });

  it('carries verdict/sessionState/wakeMode/contextPressure through as null when unstamped', () => {
    const m = projectMember(baseAgent({}), NOW);
    expect(m.verdict).toBeNull();
    expect(m.sessionState).toBeNull();
    expect(m.wakeMode).toBeNull();
    expect(m.monitorState).toBeNull();
    expect(m.nextFireAt).toBeNull();
    expect(m.contextPressure).toBeNull();
    expect(m.loopMode).toBeNull();
  });

  it('carries healthy loop lifecycle and next fire through verbatim', () => {
    const m = projectMember(
      baseAgent({ monitorState: 'waiting', nextFireAt: '2026-07-10T12:01:00.000Z' }),
      NOW,
    );
    expect(m.monitorState).toBe('waiting');
    expect(m.nextFireAt).toBe('2026-07-10T12:01:00.000Z');
  });

  it("WI-5345: surfaces the member's armed loop mode inline (work vs monitor), independent of monitorState", () => {
    const wedgedMonitor = projectMember(
      baseAgent({ monitorState: 'monitoring', doing: null, loopMode: 'monitor' }),
      NOW,
    );
    expect(wedgedMonitor.monitorState).toBe('monitoring');
    expect(wedgedMonitor.doing).toBeNull();
    expect(wedgedMonitor.loopMode).toBe('monitor');

    const healthyBetweenItems = projectMember(
      baseAgent({ monitorState: 'monitoring', doing: null, loopMode: 'work' }),
      NOW,
    );
    // Same monitorState:'monitoring' + doing:null shape as the wedged case above — the
    // exact ambiguity WI-5345 reports — but loopMode now distinguishes them without a
    // separate loop:status{ownerId} call.
    expect(healthyBetweenItems.monitorState).toBe('monitoring');
    expect(healthyBetweenItems.doing).toBeNull();
    expect(healthyBetweenItems.loopMode).toBe('work');
  });

  // EI-19381528967421062: a member whose loop backed off from a provider wall reads
  // active:true/sessionState:parked identically to a healthy between-wakes member on
  // every OTHER field here — `throttled` is the ONE signal that tells them apart.
  it('omits `throttled` when the loop is healthy (no lifecycleBackoff stamped)', () => {
    const m = projectMember(baseAgent({ monitorState: 'waiting', nextFireAt: '2026-07-10T12:01:00.000Z' }), NOW);
    expect('throttled' in m).toBe(false);
  });

  it('carries `throttled` verbatim when the loop backed off from a provider wall', () => {
    const lifecycleBackoff = { reason: 'rate_limited', until: '2026-08-02T23:58:00.000Z', resumesInMs: 5_940_000 };
    const m = projectMember(baseAgent({ nextFireAt: '2026-08-02T23:58:00.000Z', lifecycleBackoff }), NOW);
    expect(m.throttled).toEqual(lifecycleBackoff);
    // nextFireAt alone (per the earlier tests) is indistinguishable from a healthy wait —
    // throttled is what makes THIS row legible as "silenced until X", not "next tick soon".
    expect(m.nextFireAt).toBe('2026-08-02T23:58:00.000Z');
  });
});

describe('computeBenchSuggestion (pure, EI-9943)', () => {
  const doing = { id: 'WI-1', itemKind: 'bug', title: 'stuck thing', status: 'open', rank: 0, rankWriter: null, activity: 'stalled' as const };

  it('flags a speaking member whose claim is stalled and not already benched', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: [], doing });
    expect(s).toBeDefined();
    expect(s?.item).toBe('WI-1');
    expect(s?.itemTitle).toBe('stuck thing');
  });

  it('also flags first-turn-done (not just speaking) — the between-wakes window', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'first-turn-done', parkedOn: [], doing });
    expect(s).toBeDefined();
  });

  it('does NOT flag an already-benched member (parkedOn non-empty) — avoid re-nudging', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: ['some:event'], doing });
    expect(s).toBeUndefined();
  });

  it('does NOT flag a member that is not stalled', () => {
    const s = computeBenchSuggestion({ stalled: false, verdict: 'speaking', parkedOn: [], doing: null });
    expect(s).toBeUndefined();
  });

  it('does NOT flag a dead/booted/joined member — not burning turns, relaunch is the right lever', () => {
    for (const verdict of ['dead', 'booted', 'joined', 'stalled', null] as const) {
      expect(computeBenchSuggestion({ stalled: true, verdict, parkedOn: [], doing })).toBeUndefined();
    }
  });

  it('projectMember surfaces benchSuggestion only when computeBenchSuggestion fires', () => {
    const flagged = projectMember(baseAgent({ stalled: true, verdict: 'speaking', parkedOn: [], doing }), NOW);
    expect(flagged.benchSuggestion).toBeDefined();
    const benched = projectMember(baseAgent({ stalled: true, verdict: 'speaking', parkedOn: ['k'], doing }), NOW);
    expect('benchSuggestion' in benched).toBe(false);
  });

  // EI-18679536216711688 (recurrence guard): `stalled` is derived purely from MCP
  // tool-call recency, which is indistinguishable from a member mid a long
  // foreground exec (a test run) that emits no MCP calls until it returns — this
  // is exactly that fixture. The suggestion must NOT assert a specific wrong
  // cause (a fabricated diagnosis reading as fact invites a destructive
  // coord:send { endTurn: true } on a productively-working member); it must
  // hedge honestly and point at sessions:timeline as the disambiguation step
  // before any escalation.
  it('does NOT assert a confident wrong cause for a stalled+speaking member — hedges instead (foreground-exec false-positive)', () => {
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: [], doing });
    expect(s).toBeDefined();
    expect(s?.reason.toLowerCase()).not.toContain('live-loop-polling');
    expect(s?.reason.toLowerCase()).toContain('may be genuinely wedged');
    expect(s?.reason.toLowerCase()).toContain('foreground exec');
    expect(s?.reason.toLowerCase()).toContain('sessions:timeline');
  });
});

describe('computeBenchSuggestion — LANELESS-IDLE (EI-13846)', () => {
  it('flags a speaking member with zero claims/queued and not parked', () => {
    const s = computeBenchSuggestion({ stalled: false, verdict: 'speaking', parkedOn: [], doing: null, load: 0, queued: [] });
    expect(s).toBeDefined();
    expect(s?.item).toBeNull();
    expect(s?.reason).toMatch(/idle-cycling/);
  });

  it("flags a LOOP-DRIVEN member ('monitoring'/'waiting' verdict) — the case `stalled`-gated speaking/first-turn-done could never catch", () => {
    for (const verdict of ['monitoring', 'waiting'] as const) {
      const s = computeBenchSuggestion({ stalled: false, verdict, parkedOn: [], doing: null, load: 0, queued: [] });
      expect(s).toBeDefined();
    }
  });

  it('does NOT flag a member already parked on an event (parked-awaiting-capability shape)', () => {
    const s = computeBenchSuggestion({
      stalled: false,
      verdict: 'parked-awaiting-capability',
      parkedOn: ['work-item:claimable'],
      doing: null,
      load: 0,
      queued: [],
    });
    expect(s).toBeUndefined();
  });

  it('does NOT flag a member holding a real claim (load>0) or with queued work', () => {
    const holding = { id: 'WI-1', itemKind: 'bug', title: 'in progress', status: 'open', rank: 0, rankWriter: null, activity: 'alive' as const };
    expect(computeBenchSuggestion({ stalled: false, verdict: 'monitoring', parkedOn: [], doing: holding, load: 1, queued: [] })).toBeUndefined();
    expect(
      computeBenchSuggestion({ stalled: false, verdict: 'monitoring', parkedOn: [], doing: null, load: 0, queued: [{ id: 'WI-9' }] as never }),
    ).toBeUndefined();
  });

  it('does NOT flag dead/booted/joined — a fresh boot or a dead session is not "idle-cycling"', () => {
    for (const verdict of ['dead', 'booted', 'joined'] as const) {
      expect(computeBenchSuggestion({ stalled: false, verdict, parkedOn: [], doing: null, load: 0, queued: [] })).toBeUndefined();
    }
  });

  it('load/queued omitted (pre-EI-13846 call sites) never falsely triggers — undefined reads as "not laneless"', () => {
    expect(computeBenchSuggestion({ stalled: false, verdict: 'monitoring', parkedOn: [], doing: null })).toBeUndefined();
  });

  it('projectMember surfaces the laneless-idle suggestion end-to-end', () => {
    const m = projectMember(baseAgent({ verdict: 'waiting', monitorState: 'waiting' }), NOW);
    expect(m.benchSuggestion).toBeDefined();
    expect(m.benchSuggestion?.reason).toMatch(/idle-cycling/);
  });
});

// EI-18730414627683753: a member with NO self-wake mechanism at all (no loop, no park,
// no claim) is a DISTINCT, more severe state than "laneless-idle" (which assumes a healthy
// armed loop will re-cycle it) — the live incident this closes had `bench_suggested`/
// `laneless_idle` fire for both dormant members, indistinguishable from a merely-idle
// loop-armed one, so the leader had to hand-inspect loopMode/nextFireAt per row to notice.
describe('computeDormantAlert (EI-18730414627683753)', () => {
  it('flags a first-turn-done member with no loop, not parked, no claim', () => {
    expect(
      computeDormantAlert({ verdict: 'first-turn-done', loopMode: null, parkedOn: [], doing: null, load: 0, queued: [] }),
    ).toBe(true);
  });

  it('flags a speaking member in the same shape', () => {
    expect(
      computeDormantAlert({ verdict: 'speaking', loopMode: null, parkedOn: [], doing: null, load: 0, queued: [] }),
    ).toBe(true);
  });

  it('does NOT flag a member with an active loop (work or monitor) — it will re-cycle on its own', () => {
    for (const loopMode of ['work', 'monitor'] as const) {
      expect(
        computeDormantAlert({ verdict: 'first-turn-done', loopMode, parkedOn: [], doing: null, load: 0, queued: [] }),
      ).toBe(false);
    }
  });

  it('does NOT flag a member parked on an event — it has a wake mechanism', () => {
    expect(
      computeDormantAlert({
        verdict: 'first-turn-done',
        loopMode: null,
        parkedOn: ['work-item:status:WI-1'],
        doing: null,
        load: 0,
        queued: [],
      }),
    ).toBe(false);
  });

  it('does NOT flag a member holding a claim or with queued work', () => {
    const holding = { id: 'WI-1', itemKind: 'bug', title: 'in progress', status: 'open', rank: 0, rankWriter: null, activity: 'alive' as const };
    expect(
      computeDormantAlert({ verdict: 'first-turn-done', loopMode: null, parkedOn: [], doing: holding, load: 1, queued: [] }),
    ).toBe(false);
    expect(
      computeDormantAlert({
        verdict: 'first-turn-done',
        loopMode: null,
        parkedOn: [],
        doing: null,
        load: 0,
        queued: [{ id: 'WI-9' }] as never,
      }),
    ).toBe(false);
  });

  it('does NOT flag dead/booted/joined/monitoring/waiting — only speaking/first-turn-done are dormant-eligible', () => {
    for (const verdict of ['dead', 'booted', 'joined', 'monitoring', 'waiting'] as const) {
      expect(
        computeDormantAlert({ verdict, loopMode: null, parkedOn: [], doing: null, load: 0, queued: [] }),
      ).toBe(false);
    }
  });

  it('is suppressed for a paused (winding-down) fleet, matching every sibling alert', () => {
    expect(
      computeDormantAlert(
        { verdict: 'first-turn-done', loopMode: null, parkedOn: [], doing: null, load: 0, queued: [] },
        true,
      ),
    ).toBe(false);
  });

  it('projectMember surfaces `dormant:true` end-to-end, distinct from benchSuggestion', () => {
    const m = projectMember(baseAgent({ verdict: 'first-turn-done' }), NOW);
    expect(m.dormant).toBe(true);
    // Same idle shape also trips the (unchanged) laneless-idle benchSuggestion —
    // dormant is an ADDITIONAL, more urgent signal, not a replacement.
    expect(m.benchSuggestion?.kind).toBe('laneless-idle');
  });

  it('projectMember does NOT set `dormant` for a healthy loop-armed idle member', () => {
    const m = projectMember(baseAgent({ verdict: 'waiting', monitorState: 'waiting', loopMode: 'monitor' }), NOW);
    expect(m.dormant).toBeUndefined();
  });
});

// EI-19307414464301772: a member reading HEALTHY on every existing surface (live,
// verdict:monitoring, lastToolCallAgeMs fresh, not stalled) while its last 14 tool
// calls were entirely per-turn housekeeping (coord:glance/activity:report/journal:
// record-turn/flags:get/sessions:ingest-gate-event), holding zero claims, for ~8h,
// with 3 directed messages left unanswered the whole time.
describe('computeSpinningAlert (EI-19307414464301772)', () => {
  const BUDGET = 30 * 60_000;

  it('flags a member ticking fresh but whose last PRODUCTIVE call is stale past budget', () => {
    expect(
      computeSpinningAlert({
        verdict: 'monitoring',
        parkedOn: [],
        lastToolCallAgeMs: 20_000,
        productiveToolCallAgeMs: BUDGET + 60_000,
      }),
    ).toBe(true);
  });

  it('does NOT flag when there is no productive call on record at all (null) — absence of data is not evidence of spinning', () => {
    expect(
      computeSpinningAlert({
        verdict: 'monitoring',
        parkedOn: [],
        lastToolCallAgeMs: 20_000,
        productiveToolCallAgeMs: null,
      }),
    ).toBe(false);
  });

  it('does NOT flag a healthy member whose last call was itself productive (fresh productiveToolCallAgeMs)', () => {
    expect(
      computeSpinningAlert({
        verdict: 'monitoring',
        parkedOn: [],
        lastToolCallAgeMs: 20_000,
        productiveToolCallAgeMs: 20_000,
      }),
    ).toBe(false);
  });

  it('does NOT flag a member that is not visibly ticking (lastToolCallAgeMs stale/absent) — that is stalled/dead territory', () => {
    expect(
      computeSpinningAlert({
        verdict: 'monitoring',
        parkedOn: [],
        lastToolCallAgeMs: BUDGET + 60_000,
        productiveToolCallAgeMs: BUDGET + 60_000,
      }),
    ).toBe(false);
    expect(
      computeSpinningAlert({
        verdict: 'monitoring',
        parkedOn: [],
        lastToolCallAgeMs: null,
        productiveToolCallAgeMs: BUDGET + 60_000,
      }),
    ).toBe(false);
  });

  it('does NOT flag dead/booted/joined — never took a turn yet, or confirmed gone', () => {
    for (const verdict of ['dead', 'booted', 'joined'] as const) {
      expect(
        computeSpinningAlert({
          verdict,
          parkedOn: [],
          lastToolCallAgeMs: 20_000,
          productiveToolCallAgeMs: BUDGET + 60_000,
        }),
      ).toBe(false);
    }
  });

  it('does NOT flag a member deliberately parked on an event — it is already benched', () => {
    expect(
      computeSpinningAlert({
        verdict: 'monitoring',
        parkedOn: ['some:event'],
        lastToolCallAgeMs: 20_000,
        productiveToolCallAgeMs: BUDGET + 60_000,
      }),
    ).toBe(false);
  });

  it('is suppressed for a paused (winding-down) fleet, matching every sibling alert', () => {
    expect(
      computeSpinningAlert(
        { verdict: 'monitoring', parkedOn: [], lastToolCallAgeMs: 20_000, productiveToolCallAgeMs: BUDGET + 60_000 },
        true,
      ),
    ).toBe(false);
  });

  it('respects a custom budget', () => {
    const tight = 5 * 60_000;
    expect(
      computeSpinningAlert(
        { verdict: 'monitoring', parkedOn: [], lastToolCallAgeMs: 60_000, productiveToolCallAgeMs: 6 * 60_000 },
        false,
        tight,
      ),
    ).toBe(true);
    expect(
      computeSpinningAlert(
        { verdict: 'monitoring', parkedOn: [], lastToolCallAgeMs: 60_000, productiveToolCallAgeMs: 4 * 60_000 },
        false,
        tight,
      ),
    ).toBe(false);
  });

  it('does NOT require load===0 — a member spinning WHILE holding a claim is the more dangerous case, not a suppressed one', () => {
    // Deliberately does not accept load/doing/queued at all — unlike computeDormantAlert
    // and computeBenchSuggestion's laneless-idle branch, this alert is independent of claim
    // state by construction (see the doc comment on computeSpinningAlert).
    expect(
      computeSpinningAlert({
        verdict: 'speaking',
        parkedOn: [],
        lastToolCallAgeMs: 20_000,
        productiveToolCallAgeMs: BUDGET + 60_000,
      }),
    ).toBe(true);
  });

  it('projectMember computes productiveToolCallAgeMs from the ISO timestamp, and surfaces `spinning:true` end-to-end', () => {
    const agent = baseAgent({
      verdict: 'monitoring',
      lastToolCallAt: new Date(NOW - 20_000).toISOString(),
      productiveToolCallAt: new Date(NOW - (BUDGET + 60_000)).toISOString(),
    });
    const m = projectMember(agent, NOW);
    expect(m.productiveToolCallAgeMs).toBe(BUDGET + 60_000);
    expect(m.spinning).toBe(true);
  });

  it('projectMember: null productiveToolCallAgeMs when no productive call is on record', () => {
    const m = projectMember(baseAgent({ productiveToolCallAt: null }), NOW);
    expect(m.productiveToolCallAgeMs).toBeNull();
    expect(m.spinning).toBeUndefined();
  });

  it('projectMember does NOT set `spinning` for a healthy member whose last call was productive', () => {
    const agent = baseAgent({
      verdict: 'monitoring',
      lastToolCallAt: new Date(NOW - 20_000).toISOString(),
      productiveToolCallAt: new Date(NOW - 20_000).toISOString(),
    });
    const m = projectMember(agent, NOW);
    expect(m.spinning).toBeUndefined();
  });
});

// WI-5973: a fleet leader running its monitor loop is SUPPOSED to hold zero
// claims — that IS the documented leader contract (monitor each wake: burn-down
// delta, member liveness, completion-integrity audit, reclaim orphans). Before
// this fix, the leader's OWN row (fleetRole:'leader', loopMode:'monitor',
// verdict:'monitoring', isSelf:true) still tripped the EI-13846 laneless-idle
// heuristic written for MEMBERS pulling from a claim spec — and its paired
// remedy (fleet:bench the leader onto a scoped event) is the exact failure the
// leader contract exists to prevent: the one agent watching for member death
// goes to sleep. Observed live 2026-07-26 on nonp2p-bug-drain-0725 (twice).
describe('computeBenchSuggestion — the LEADER\'s own monitor row is never idle-cycling (WI-5973)', () => {
  it('does NOT flag a leader with fleetRole:"leader" + loopMode:"monitor", zero claims, not parked', () => {
    const s = computeBenchSuggestion({
      stalled: false,
      verdict: 'monitoring',
      parkedOn: [],
      doing: null,
      load: 0,
      queued: [],
      fleetRole: 'leader',
      loopMode: 'monitor',
    });
    expect(s).toBeUndefined();
  });

  it('does NOT flag the leader even when claimable work exists (the idle-with-claimable branch is ALSO leader-exempt)', () => {
    const s = computeBenchSuggestion(
      {
        stalled: false,
        verdict: 'monitoring',
        parkedOn: [],
        doing: null,
        load: 0,
        queued: [],
        fleetRole: 'leader',
        loopMode: 'monitor',
      },
      5, // claimableCount > 0 — would fire 'idle-with-claimable' for an ordinary member
    );
    expect(s).toBeUndefined();
  });

  it('STILL flags a member with fleetRole:"leader" but loopMode:"work" (a leader that also pulls work is not exempt)', () => {
    const s = computeBenchSuggestion({
      stalled: false,
      verdict: 'monitoring',
      parkedOn: [],
      doing: null,
      load: 0,
      queued: [],
      fleetRole: 'leader',
      loopMode: 'work',
    });
    expect(s).toBeDefined();
  });

  it('STILL flags an ordinary member ("member"/null fleetRole) with loopMode:"monitor" — the exemption is leader-specific', () => {
    for (const fleetRole of ['member', null, undefined] as const) {
      const s = computeBenchSuggestion({
        stalled: false,
        verdict: 'monitoring',
        parkedOn: [],
        doing: null,
        load: 0,
        queued: [],
        fleetRole,
        loopMode: 'monitor',
      });
      expect(s).toBeDefined();
    }
  });

  it('does NOT suppress the stalled-no-mcp branch for a leader that DID take on work and looks wedged — still a genuine fault', () => {
    const held = {
      id: 'WI-1',
      itemKind: 'bug',
      title: 'in progress',
      status: 'open',
      rank: 0,
      rankWriter: null,
      activity: 'alive' as const,
    };
    const s = computeBenchSuggestion({
      stalled: true,
      verdict: 'speaking',
      parkedOn: [],
      doing: held,
      load: 1,
      queued: [],
      fleetRole: 'leader',
      loopMode: 'monitor',
    });
    expect(s?.kind).toBe('stalled-no-mcp');
  });

  it('projectMember never surfaces benchSuggestion for the leader\'s own monitoring row end-to-end', () => {
    const m = projectMember(
      baseAgent({ fleetRole: 'leader', loopMode: 'monitor', verdict: 'monitoring', monitorState: 'monitoring' }),
      NOW,
    );
    expect(m.benchSuggestion).toBeUndefined();
  });
});

// EI-18681259560385029 — the live incident: five members carried the laneless-idle line
// ("likely idle-cycling a drained or scoped-out lane") while claimableCount was 2, and the
// leader read it, concluded the lane was drained, and stood the fleet down. The wording
// asserted a fact it never checked; the remedy it named (fleet:bench) was backwards.
describe('computeBenchSuggestion — idle beside a NONEMPTY queue (EI-18681259560385029)', () => {
  const idle = { stalled: false, verdict: 'waiting' as const, parkedOn: [], doing: null, load: 0, queued: [] };

  it('does NOT claim the lane is drained when work IS claimable — and says so explicitly', () => {
    const s = computeBenchSuggestion(idle, 2);
    expect(s?.kind).toBe('idle-with-claimable');
    expect(s?.reason).toMatch(/2 item\(s\) ARE claimable/);
    expect(s?.reason).toMatch(/lane is NOT drained/);
    // The regression in one line: it must never assert the queue is empty when it is not.
    expect(s?.reason).not.toMatch(/drained or scoped-out/);
  });

  it('does NOT recommend benching when the queue is nonempty — benching sleeps a member beside real work', () => {
    const s = computeBenchSuggestion(idle, 2);
    expect(s?.reason).toMatch(/DO NOT fleet:bench/);
    expect(s?.reason).toMatch(/wake/i);
  });

  // EI-19412077774087262 — the live inversion: su-70390c8c sat at contextPressure
  // 'critical' with NO claim while this suggestion told the leader it "should be taking
  // work". A member at critical context that claims runs out mid-item and dies HOLDING the
  // claim, so the standard remedy converts an idle member into an orphaned work-item.
  describe('CRITICAL context inverts the remedy', () => {
    const critical = { ...idle, contextPressure: 'critical' as const };

    it('still reports the lane is NOT drained (the claimable fact is unchanged)', () => {
      const s = computeBenchSuggestion(critical, 2);
      expect(s?.kind).toBe('idle-with-claimable');
      expect(s?.reason).toMatch(/2 item\(s\) ARE claimable/);
    });

    it('does NOT tell the leader to wake it to claim — that orphans the claim', () => {
      const s = computeBenchSuggestion(critical, 2);
      expect(s?.reason).toMatch(/DO NOT wake it to claim/);
      expect(s?.reason).toMatch(/orphans the claim/);
      // and must not fall back to the other wrong remedy either
      expect(s?.reason).toMatch(/DO NOT fleet:bench/);
    });

    it('prescribes the ORDERING that makes claiming safe (flush -> self-compact -> pull)', () => {
      const s = computeBenchSuggestion(critical, 2);
      expect(s?.reason).toMatch(/checkpoint/);
      expect(s?.reason).toMatch(/self-compact/);
      expect(s?.reason).toMatch(/idle CORRECTLY/);
    });

    it('leaves NON-critical pressure on the ordinary wake-it path', () => {
      // The guard must be scoped to 'critical' only — 'high' and 'ok' members are genuinely
      // startable, and suppressing their dispatch would starve the lane for the opposite reason.
      for (const p of ['ok', 'high', null, undefined] as const) {
        const s = computeBenchSuggestion({ ...idle, contextPressure: p }, 2);
        expect(s?.kind).toBe('idle-with-claimable');
        expect(s?.reason).toMatch(/Wake it to re-run scheduler:get_next/);
        expect(s?.reason).not.toMatch(/DO NOT wake it to claim/);
      }
    });
  });

  // WI-37161 — the live incident: `throttled: 0` fleet-wide while fleet:capacity reported
  // `degraded:true, factor:0` — the old reason text told the leader to wake idle members and,
  // if they still took nothing, blamed a claim floor. The real cause was gateway queue
  // congestion, and the prescribed remedy (wake more members) fed MORE requests into the same
  // congested queue.
  describe('a CONGESTED shared inference pool inverts the remedy (WI-37161)', () => {
    const degradedPool = { poolExhausted: false, degraded: true, factor: 0, queueDepth: 28, usableAccounts: 1, availableAccounts: 2 };
    const exhaustedPool = { poolExhausted: true, degraded: false, factor: 0, queueDepth: 5, usableAccounts: 0, availableAccounts: 0 };

    it('still reports the lane is NOT drained (the claimable fact is unchanged)', () => {
      const s = computeBenchSuggestion(idle, 2, null, false, null, degradedPool);
      expect(s?.kind).toBe('idle-with-claimable');
      expect(s?.reason).toMatch(/2 item\(s\) ARE claimable/);
    });

    it('does NOT tell the leader to wake it — that queues MORE requests behind the congestion', () => {
      const s = computeBenchSuggestion(idle, 2, null, false, null, degradedPool);
      expect(s?.reason).toMatch(/DO NOT wake it/);
      expect(s?.reason).not.toMatch(/Wake it to re-run scheduler:get_next/);
      expect(s?.reason).toMatch(/DO NOT fleet:bench/);
      expect(s?.reason).toMatch(/QUEUED FOR INFERENCE/);
    });

    it('names DEGRADED vs EXHAUSTED correctly and surfaces factor/queueDepth', () => {
      const degraded = computeBenchSuggestion(idle, 2, null, false, null, degradedPool);
      expect(degraded?.reason).toMatch(/DEGRADED/);
      expect(degraded?.reason).not.toMatch(/EXHAUSTED/);
      expect(degraded?.reason).toMatch(/factor 0\.00/);
      expect(degraded?.reason).toMatch(/28 request\(s\)/);

      const exhausted = computeBenchSuggestion(idle, 2, null, false, null, exhaustedPool);
      expect(exhausted?.reason).toMatch(/EXHAUSTED/);
    });

    it('does NOT fire when the pool is degraded but the gateway queue is EMPTY — nothing is actually backed up', () => {
      const s = computeBenchSuggestion(idle, 2, null, false, null, { ...degradedPool, queueDepth: 0 });
      expect(s?.reason).toMatch(/Wake it to re-run scheduler:get_next/);
    });

    it('does NOT fire when the pool read is healthy (degraded:false, poolExhausted:false)', () => {
      const s = computeBenchSuggestion(idle, 2, null, false, null, {
        poolExhausted: false, degraded: false, factor: 1, queueDepth: 0, usableAccounts: 4, availableAccounts: 4,
      });
      expect(s?.reason).toMatch(/Wake it to re-run scheduler:get_next/);
    });

    it('an UNREAD pool state (null/undefined) never suppresses or alters the existing remedy', () => {
      expect(computeBenchSuggestion(idle, 2, null, false, null, null)?.reason).toMatch(
        /Wake it to re-run scheduler:get_next/,
      );
      expect(computeBenchSuggestion(idle, 2)?.reason).toMatch(/Wake it to re-run scheduler:get_next/);
    });

    it('projectMember threads poolCapacity through end-to-end', () => {
      const m = projectMember(
        baseAgent({ verdict: 'waiting', monitorState: 'waiting' }),
        NOW,
        3,
        null,
        false,
        null,
        degradedPool,
      );
      expect(m.benchSuggestion?.kind).toBe('idle-with-claimable');
      expect(m.benchSuggestion?.reason).toMatch(/QUEUED FOR INFERENCE/);
    });
  });

  it('keeps the historical bench advice when the lane is VERIFIED drained (0 claimable AND 0 matching)', () => {
    // EI-18689489507862177 TIGHTENED THIS TEST'S PREMISE. It used to pass `claimableCount: 0`
    // with no gating read and assert "VERIFIED drained" — but an empty queue alone cannot
    // establish drainage: a lane whose every matching row sits behind a claim floor reads 0
    // here too (measured live: 108 matched / 0 claimable). Verification now requires the
    // pre-floor match count as well, so the second argument below is what makes the claim
    // true. The test's INTENT is unchanged: a genuinely drained lane keeps the bench advice.
    const s = computeBenchSuggestion(idle, 0, { matchedByFilter: 0, excluded: {} });
    expect(s?.kind).toBe('laneless-idle');
    expect(s?.reason).toMatch(/VERIFIED drained/);
    expect(s?.reason).toMatch(/fleet:bench/);
  });

  it('an UNREADABLE queue (null) is reported as unknown — never silently folded into "drained"', () => {
    for (const unknown of [null, undefined]) {
      const s = computeBenchSuggestion(idle, unknown);
      expect(s?.kind).toBe('laneless-idle');
      expect(s?.reason).toMatch(/could NOT be read/);
      expect(s?.reason).toMatch(/an unread queue is not an empty one/);
      expect(s?.reason).not.toMatch(/VERIFIED drained/);
    }
  });

  it('tags the stalled branch with its own kind so a leader can tell the two remedies apart', () => {
    const held = {
      id: 'WI-1',
      itemKind: 'bug',
      title: 'in progress',
      status: 'open',
      rank: 0,
      rankWriter: null,
      activity: 'alive' as const,
    };
    const s = computeBenchSuggestion({ stalled: true, verdict: 'speaking', parkedOn: [], doing: held }, 5);
    expect(s?.kind).toBe('stalled-no-mcp');
  });

  it('projectMember threads the claimable count through end-to-end', () => {
    const m = projectMember(baseAgent({ verdict: 'waiting', monitorState: 'waiting' }), NOW, 3);
    expect(m.benchSuggestion?.kind).toBe('idle-with-claimable');
    expect(m.benchSuggestion?.reason).toMatch(/3 item\(s\) ARE claimable/);
  });

  it('does NOT flag an idle-shaped member whose recent tool call proves it is between claims (EI-18833129079136289)', () => {
    const m = projectMember(
      baseAgent({
        verdict: 'waiting',
        monitorState: 'waiting',
        lastToolCallAt: new Date(NOW - VERDICT_SPEAKING_FRESH_MS + 1_000).toISOString(),
      }),
      NOW,
      3,
    );
    expect(m.lastToolCallAgeMs).toBe(VERDICT_SPEAKING_FRESH_MS - 1_000);
    expect(m.benchSuggestion).toBeUndefined();
  });

  it('still flags an idle-shaped member whose last tool call is stale (EI-18833129079136289)', () => {
    const m = projectMember(
      baseAgent({
        verdict: 'waiting',
        monitorState: 'waiting',
        lastToolCallAt: new Date(NOW - VERDICT_SPEAKING_FRESH_MS - 1_000).toISOString(),
      }),
      NOW,
      3,
    );
    expect(m.lastToolCallAgeMs).toBe(VERDICT_SPEAKING_FRESH_MS + 1_000);
    expect(m.benchSuggestion?.kind).toBe('idle-with-claimable');
  });
});

describe('computeIdleWithClaimableAlert (EI-18681259560385029 — the summary-level alert)', () => {
  it('fires on the exact incident shape: 5 idle members, 2 claimable', () => {
    const alert = computeIdleWithClaimableAlert({ claimableCount: 2, idleMemberCount: 5 });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/5 member\(s\)/);
    expect(alert?.reason).toMatch(/2 item\(s\) are claimable/);
    expect(alert?.reason).toMatch(/wake/i);
  });

  it('does not fire when the queue is genuinely empty — idle beside nothing is correct', () => {
    expect(computeIdleWithClaimableAlert({ claimableCount: 0, idleMemberCount: 5 })).toBeUndefined();
  });

  it('does not fire when every member is working, however full the queue', () => {
    expect(computeIdleWithClaimableAlert({ claimableCount: 40, idleMemberCount: 0 })).toBeUndefined();
  });

  it('does NOT fire on an unreadable count — unknown is not evidence of a full queue either', () => {
    expect(computeIdleWithClaimableAlert({ claimableCount: null, idleMemberCount: 5 })).toBeUndefined();
  });

  // WI-37161 — the summary-level twin of the per-member fix: a leader reading only the
  // summary alert must not be told to wake a fleet that is actually inference-queued.
  describe('a CONGESTED shared inference pool inverts the remedy (WI-37161)', () => {
    const degradedPool = { poolExhausted: false, degraded: true, factor: 0, queueDepth: 28, usableAccounts: 1, availableAccounts: 2 };

    it('still fires (the lane is not drained) but does NOT tell the leader to wake them', () => {
      const alert = computeIdleWithClaimableAlert({
        claimableCount: 2,
        idleMemberCount: 6,
        poolCapacity: degradedPool,
      });
      expect(alert).toBeDefined();
      expect(alert?.reason).toMatch(/QUEUED FOR INFERENCE/);
      expect(alert?.reason).not.toMatch(/coord:send \{ wake: "required" \} those members so they re-run/);
      expect(alert?.reason).toMatch(/DO NOT wake/);
    });

    it('falsifier calls fleet:capacity, not the member-holdings check', () => {
      const alert = computeIdleWithClaimableAlert({
        claimableCount: 2,
        idleMemberCount: 6,
        poolCapacity: degradedPool,
      });
      expect(alert?.falsifier.tool).toBe('fleet:capacity');
    });

    it('falls back to the ordinary wake-them remedy once the pool read is healthy', () => {
      const alert = computeIdleWithClaimableAlert({
        claimableCount: 2,
        idleMemberCount: 6,
        poolCapacity: { poolExhausted: false, degraded: false, factor: 1, queueDepth: 0, usableAccounts: 4, availableAccounts: 4 },
      });
      expect(alert?.reason).toMatch(/wake/i);
      expect(alert?.falsifier.tool).toBe('work_items:list');
    });

    it('an unread pool state (undefined) never changes the existing remedy', () => {
      const alert = computeIdleWithClaimableAlert({ claimableCount: 2, idleMemberCount: 6 });
      expect(alert?.falsifier.tool).toBe('work_items:list');
    });
  });

  it('fires even while OTHER members are busy — partial starvation is still starvation', () => {
    // Deliberately unlike computeStrandedFleetAlert/computeSpecStarvedFleetAlert, which both
    // require fleet-wide zero wip and so miss a fleet that is half-working, half-starving.
    expect(computeIdleWithClaimableAlert({ claimableCount: 1, idleMemberCount: 1 })).toBeDefined();
  });
});

// EI-18703234178947959 — the live incident (2026-07-26, fleet bug-drain-200k, 19 members):
// leader-brief reported `claimable_now: 2` + `idleWithClaimableAlert` and told the leader to
// wake all 19 members to "re-run scheduler:get_next", while THAT VERY ORACLE returned
// `windDown:true` for the same fleet (owner pause standing since 2026-07-21). The 2 rows were
// real backlog — real backlog OUTSIDE the paused fleet's scope. Idle members were COMPLYING
// with the stand-down; the brief diagnosed compliance as starvation, once per polling tick.
describe('a PAUSED (winding-down) fleet never gets a wake/bench suggestion (EI-18703234178947959)', () => {
  const idle = {
    stalled: false,
    verdict: 'waiting' as const,
    parkedOn: [],
    doing: null,
    load: 0,
    queued: [],
  };

  it('THE REGRESSION: idle + 2 claimable + fleet paused ⇒ no "wake it" suggestion at all', () => {
    // Unpaused, this is the EI-18681259560385029 shape and MUST still fire (guard against
    // over-suppression: the pause is the only thing that may silence it).
    expect(computeBenchSuggestion(idle, 2)?.kind).toBe('idle-with-claimable');
    expect(computeBenchSuggestion(idle, 2, null, true)).toBeUndefined();
  });

  it('suppresses the laneless-idle branches too — bench/widen-the-spec are equally moot while paused', () => {
    // Verified-drained, gated, and unknown-queue all reach the same idle branch.
    expect(computeBenchSuggestion(idle, 0, { matchedByFilter: 0, excluded: {} }, true)).toBeUndefined();
    expect(
      computeBenchSuggestion(idle, 0, { matchedByFilter: 108, excluded: { claimHold: 38 } }, true),
    ).toBeUndefined();
    expect(computeBenchSuggestion(idle, null, null, true)).toBeUndefined();
  });

  it('still reports a member that HOLDS a claim and looks wedged — that blocks the stand-down', () => {
    const held = {
      id: 'WI-1',
      itemKind: 'bug',
      title: 'in progress',
      status: 'open',
      rank: 0,
      rankWriter: null,
      activity: 'alive' as const,
    };
    const s = computeBenchSuggestion(
      { stalled: true, verdict: 'speaking', parkedOn: [], doing: held },
      2,
      null,
      true,
    );
    expect(s?.kind).toBe('stalled-no-mcp');
  });

  it('an unread control state (absent/false) is NOT a pause — a real starvation signal survives', () => {
    for (const notPaused of [undefined, null, false]) {
      expect(computeBenchSuggestion(idle, 2, null, notPaused)?.kind).toBe('idle-with-claimable');
    }
  });

  it('projectMember threads the pause through end-to-end', () => {
    const agent = baseAgent({ verdict: 'waiting', monitorState: 'waiting' });
    expect(projectMember(agent, NOW, 2).benchSuggestion?.kind).toBe('idle-with-claimable');
    expect(projectMember(agent, NOW, 2, null, true).benchSuggestion).toBeUndefined();
  });

  it('suppresses BOTH summary alerts while paused — defence-in-depth behind the member gate', () => {
    // The exact numbers from the incident (2 claimable, idle members) — must stay silent.
    expect(
      computeIdleWithClaimableAlert({ claimableCount: 2, idleMemberCount: 19, fleetPaused: true }),
    ).toBeUndefined();
    expect(
      computeFloorStarvedFleetAlert({
        claimable: 0,
        matchedByFilter: 108,
        idleMemberCount: 5,
        fleetPaused: true,
      }),
    ).toBeUndefined();
    // …and both still fire on the same inputs when the fleet is ACTIVE.
    expect(
      computeIdleWithClaimableAlert({ claimableCount: 2, idleMemberCount: 19, fleetPaused: false }),
    ).toBeDefined();
    expect(
      computeFloorStarvedFleetAlert({ claimable: 0, matchedByFilter: 108, idleMemberCount: 5 }),
    ).toBeDefined();
  });
});

describe('computeStrandedFleetAlert (EI-15055 — the whole-fleet-asleep-on-available-supply shape)', () => {
  it('fires on the exact incident shape: zero fleet-wide load, ≥1 parked member, ≥1 unowned critical', () => {
    const alert = computeStrandedFleetAlert({ totalLoad: 0, parkedCount: 7, unownedCriticalCount: 8 });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/fleet-wide wip is 0/);
    expect(alert?.reason).toMatch(/7 member/);
    expect(alert?.reason).toMatch(/8 unowned critical/);
  });

  it('does NOT fire when the fleet still holds live work (totalLoad > 0)', () => {
    expect(computeStrandedFleetAlert({ totalLoad: 1, parkedCount: 7, unownedCriticalCount: 8 })).toBeUndefined();
  });

  it('does NOT fire when nobody is parked (parkedCount 0) even if criticals sit unowned', () => {
    expect(computeStrandedFleetAlert({ totalLoad: 0, parkedCount: 0, unownedCriticalCount: 8 })).toBeUndefined();
  });

  it('does NOT fire when there is no known unowned-critical supply (a genuinely drained fleet resting is fine)', () => {
    expect(computeStrandedFleetAlert({ totalLoad: 0, parkedCount: 7, unownedCriticalCount: 0 })).toBeUndefined();
  });
});

describe('computeSpecStarvedFleetAlert (EI-18655873409999215 — the spec-matches-zero blind spot computeStrandedFleetAlert cannot see)', () => {
  it('fires on the exact incident shape: zero fleet-wide load, spec matches 0 of a nonempty pool', () => {
    const alert = computeSpecStarvedFleetAlert({ totalLoad: 0, specMatched: 0, poolSize: 1224 });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/fleet-wide wip is 0/);
    expect(alert?.reason).toMatch(/0 of 1224 claimable/);
  });

  it('does NOT fire when the fleet still holds live work (totalLoad > 0) — a per-bee override spec may still be pulling', () => {
    expect(computeSpecStarvedFleetAlert({ totalLoad: 1, specMatched: 0, poolSize: 1224 })).toBeUndefined();
  });

  it('does NOT fire when the pool itself is empty — a genuinely drained harness is fine, not a spec bug', () => {
    expect(computeSpecStarvedFleetAlert({ totalLoad: 0, specMatched: 0, poolSize: 0 })).toBeUndefined();
  });

  it('does NOT fire when the spec matches at least one row — this is not the starved-spec shape', () => {
    expect(computeSpecStarvedFleetAlert({ totalLoad: 0, specMatched: 3, poolSize: 1224 })).toBeUndefined();
  });
});

describe('computeSpecAuthorshipAlert (P-005 — a fleet spec rewritten under the leader, silently)', () => {
  /** The wake-8 incident on nonp2p-bug-drain, verbatim: a cup took the spec to rev4. */
  const INCIDENT = {
    readerId: 'su-b8422496',
    updatedBy: 's-1786236383559',
    revision: 4,
    updatedAt: '2026-08-09T01:12:00.000Z',
    harness: 'papercusp',
    fleet: 'nonp2p-bug-drain',
  };

  it('fires on the exact incident shape: the last write belongs to another actor', () => {
    const alert = computeSpecAuthorshipAlert(INCIDENT);
    expect(alert).toBeDefined();
    // The three facts a leader needs to act: who, which revision, and that it was not them.
    expect(alert?.reason).toMatch(/s-1786236383559/);
    expect(alert?.reason).toMatch(/revision 4/);
    expect(alert?.reason).toMatch(/not by you/);
  });

  it('does NOT fire when the reader authored the spec themselves — the silent case is the common one', () => {
    expect(
      computeSpecAuthorshipAlert({ ...INCIDENT, updatedBy: INCIDENT.readerId }),
    ).toBeUndefined();
  });

  it('fires on an UNATTRIBUTED write — a row with no author is no more verified than a foreign one', () => {
    const alert = computeSpecAuthorshipAlert({ ...INCIDENT, updatedBy: null });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/UNATTRIBUTED/);
  });

  it('stays SILENT when the reader is unresolvable — an unattributable reader cannot be a wronged author', () => {
    // The cry-wolf guard. An su session whose identity does not resolve reads this brief
    // routinely; firing there would train the alert away before it ever caught a real one.
    expect(computeSpecAuthorshipAlert({ ...INCIDENT, readerId: null })).toBeUndefined();
  });

  it('degrades to a still-runnable falsifier when fleet/harness are unresolved', () => {
    // Same fail-soft contract the rest of the family holds: never paste `harness: null`
    // into a leader's terminal.
    const alert = computeSpecAuthorshipAlert({ ...INCIDENT, harness: null, fleet: null });
    expect(alert?.falsifier.check).not.toContain('null');
    expect(alert?.falsifier.check).toContain('work_items:claimable');
  });

  it('renders a missing revision without leaking a literal null into the reason', () => {
    const alert = computeSpecAuthorshipAlert({ ...INCIDENT, revision: null, updatedAt: null });
    expect(alert?.reason).toMatch(/revision unknown/);
    expect(alert?.reason).not.toContain('null');
  });
});

/** The live nonp2p-bug-drain-0725 reading at 2026-07-26T07:00Z, used verbatim below so the
 *  tests assert the ACTUAL measured incident rather than an invented shape. */
const LIVE_GATED_LANE = {
  claimable: 0,
  matchedByFilter: 108,
  excluded: {
    federationDetector: 50,
    claimHold: 38,
    needsHuman: 11,
    taken: 8,
    observationLane: 1,
    externalBlocker: 1,
    planLaneReserved: 0,
    loopNoise: 0,
  },
};

describe('topExcludedFloors (EI-18689489507862177)', () => {
  it('ranks floors largest-first and drops the zero buckets', () => {
    expect(topExcludedFloors(LIVE_GATED_LANE.excluded)).toEqual([
      ['federationDetector', 50],
      ['claimHold', 38],
      ['needsHuman', 11],
    ]);
  });

  it('is empty (never throws) for an absent breakdown', () => {
    expect(topExcludedFloors(null)).toEqual([]);
    expect(topExcludedFloors(undefined)).toEqual([]);
  });
});

describe('computeFloorStarvedFleetAlert (EI-18689489507862177 — the GATED lane every sibling alert is blind to)', () => {
  it('fires on the exact live shape: 108 matched, 0 claimable, members idle', () => {
    const alert = computeFloorStarvedFleetAlert({ ...LIVE_GATED_LANE, idleMemberCount: 5 });
    expect(alert).toBeDefined();
    expect(alert?.reason).toMatch(/5 member/);
    expect(alert?.reason).toMatch(/108 row/);
    expect(alert?.reason).toMatch(/ZERO survive the claim floors/);
  });

  it('names the dominant floors so the leader knows WHAT to clear, not just that something is wrong', () => {
    const alert = computeFloorStarvedFleetAlert({ ...LIVE_GATED_LANE, idleMemberCount: 5 });
    expect(alert?.reason).toMatch(/federationDetector=50/);
    expect(alert?.reason).toMatch(/claimHold=38/);
  });

  it('tells the leader NOT to bench — benching is the harmful remedy this alert exists to prevent', () => {
    const alert = computeFloorStarvedFleetAlert({ ...LIVE_GATED_LANE, idleMemberCount: 5 });
    expect(alert?.reason).toMatch(/Do NOT fleet:bench/);
    expect(alert?.reason).toMatch(/wind-down/);
  });

  it('does NOT fire when the spec matches nothing — that is computeSpecStarvedFleetAlert, not a floor problem', () => {
    expect(
      computeFloorStarvedFleetAlert({ claimable: 0, matchedByFilter: 0, idleMemberCount: 5 }),
    ).toBeUndefined();
  });

  it('does NOT fire when work IS claimable — that is computeIdleWithClaimableAlert', () => {
    expect(
      computeFloorStarvedFleetAlert({ claimable: 4, matchedByFilter: 108, idleMemberCount: 5 }),
    ).toBeUndefined();
  });

  it('does NOT fire when nobody is idle — a fully-busy fleet is not starving', () => {
    expect(
      computeFloorStarvedFleetAlert({ ...LIVE_GATED_LANE, idleMemberCount: 0 }),
    ).toBeUndefined();
  });

  it('does NOT fire on an unreadable claimable count — unknown is not evidence of a gated lane', () => {
    expect(
      computeFloorStarvedFleetAlert({ claimable: null, matchedByFilter: 108, idleMemberCount: 5 }),
    ).toBeUndefined();
  });

  it('does NOT fire on an unreadable match count — the gated verdict requires BOTH halves', () => {
    expect(
      computeFloorStarvedFleetAlert({ claimable: 0, matchedByFilter: null, idleMemberCount: 5 }),
    ).toBeUndefined();
  });

  it('still fires without a breakdown, just without naming floors (the count alone is the alert)', () => {
    const alert = computeFloorStarvedFleetAlert({
      claimable: 0,
      matchedByFilter: 108,
      idleMemberCount: 5,
    });
    expect(alert).toBeDefined();
    expect(alert?.reason).not.toMatch(/buckets overlap/);
  });
});

describe('computeBenchSuggestion — GATED vs DRAINED (EI-18689489507862177)', () => {
  const idleMember = { verdict: 'monitoring' as const, load: 0, queued: [], doing: null, stalled: false };

  it('calls a gated lane GATED and withholds the bench advice', () => {
    const s = computeBenchSuggestion(idleMember, 0, LIVE_GATED_LANE);
    expect(s?.kind).toBe('laneless-idle');
    expect(s?.reason).toMatch(/GATED, not drained/);
    expect(s?.reason).toMatch(/108 row/);
    expect(s?.reason).toMatch(/DO NOT fleet:bench/);
  });

  it('surfaces the dominant floor on the member row, so the leader sees the cause in place', () => {
    const s = computeBenchSuggestion(idleMember, 0, LIVE_GATED_LANE);
    expect(s?.reason).toMatch(/federationDetector=50/);
  });

  it('still reports a VERIFIED drained lane (0 claimable AND 0 matching) and keeps the bench advice', () => {
    const s = computeBenchSuggestion(idleMember, 0, { matchedByFilter: 0, excluded: {} });
    expect(s?.reason).toMatch(/VERIFIED drained/);
    expect(s?.reason).toMatch(/fleet:bench it onto a scoped event/);
    expect(s?.reason).not.toMatch(/GATED/);
  });

  it('REFUSES to call the lane drained when the gating was not read — the unchecked assertion this item fixes', () => {
    // The regression guard: claimableCount===0 alone must never reproduce "VERIFIED drained".
    const s = computeBenchSuggestion(idleMember, 0, null);
    expect(s?.reason).not.toMatch(/VERIFIED drained/);
    expect(s?.reason).toMatch(/NOT read on this brief/);
    expect(s?.reason).toMatch(/excludedBreakdown/);
  });

  it('leaves the claimable>0 branch (EI-18681259560385029) untouched', () => {
    const s = computeBenchSuggestion(idleMember, 3, LIVE_GATED_LANE);
    expect(s?.kind).toBe('idle-with-claimable');
  });
});

describe('resolveComposedParkedOn (pure, EI-18732218464905145 — the false-deadlock rendering fix)', () => {
  it('collapses a composed root + its own leaf siblings into ONE entry, never as flat peers', () => {
    const trees = new Map([
      [96, { required: 1, leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'], expiresTs: '2026-07-26T18:36:37Z', onTimeout: 'wake' as const }],
    ]);
    const out = resolveComposedParkedOn(
      ['work-item:status:WI-6088', 'work-item:status:WI-6095', 'composed-root:96'],
      trees,
    );
    expect(out).toEqual([
      {
        kind: 'composed',
        rootId: 96,
        mode: 'any',
        required: 1,
        of: 2,
        leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'],
        expiresTs: '2026-07-26T18:36:37Z',
        onTimeout: 'wake',
      },
    ]);
  });

  it('derives mode: all (required === leaf count), any (required 1), k-of-n (in between)', () => {
    const of3 = (required: number) =>
      resolveComposedParkedOn(
        ['composed-root:1'],
        new Map([[1, { required, leaves: ['a', 'b', 'c'], expiresTs: null, onTimeout: 'wake' as const }]]),
      )[0] as { mode: string };
    expect(of3(3).mode).toBe('all');
    expect(of3(1).mode).toBe('any');
    expect(of3(2).mode).toBe('k-of-n');
  });

  it('a plain (non-composed) parked key passes through unchanged, alongside a composed entry', () => {
    const trees = new Map([[1, { required: 1, leaves: ['x'], expiresTs: null, onTimeout: 'wake' as const }]]);
    const out = resolveComposedParkedOn(['lock:grant:t1', 'x', 'composed-root:1'], trees);
    expect(out).toContain('lock:grant:t1');
    expect(out).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'composed', rootId: 1 })]));
    // 'x' is a leaf of root 1 — consumed into the composed entry, not duplicated as a flat string.
    expect(out.filter((e) => e === 'x')).toHaveLength(0);
  });

  it('fails OPEN on an unresolved composed-root sentinel (no matching tree) — keeps the raw key visible', () => {
    const out = resolveComposedParkedOn(['composed-root:404'], new Map());
    expect(out).toEqual(['composed-root:404']);
  });

  it('empty input returns empty output', () => {
    expect(resolveComposedParkedOn([], new Map())).toEqual([]);
  });
});

describe('decorateComposedParkedOn (EI-18732218464905145)', () => {
  const node = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 96,
    rootId: 96,
    parentId: null,
    subscriberId: 'su-1',
    requiredCount: 1,
    firedCount: 0,
    firedAt: null,
    spec: null,
    wakeHandle: null,
    note: null,
    expiresTs: '2026-07-26T18:36:37Z',
    timeoutBehavior: 'wake' as const,
    cancelledAt: null,
    ...over,
  });
  const leaf = (eventKey: string, id: number) => ({
    id,
    eventKey,
    nodeId: 97,
    rootId: 96,
    memberFiredAt: null,
    memberPayload: null,
    firedAt: null,
    cancelledAt: null,
  });

  it('resolves parkedOnResolved for an agent whose parkedOn holds a composed-root sentinel', async () => {
    const listActiveComposedRoots = vi.fn(async () => [node()]);
    const loadTreeLeaves = vi.fn(async () => [leaf('work-item:status:WI-6088', 1), leaf('work-item:status:WI-6095', 2)]);
    const agents: ComposedTestAgent[] = [
      { agentId: 'su-1', parkedOn: ['work-item:status:WI-6088', 'work-item:status:WI-6095', 'composed-root:96'] },
    ];
    await decorateComposedParkedOn(agents, { listActiveComposedRoots: listActiveComposedRoots as never, loadTreeLeaves: loadTreeLeaves as never });
    expect(listActiveComposedRoots).toHaveBeenCalledWith('su-1');
    expect(loadTreeLeaves).toHaveBeenCalledWith(96);
    expect(agents[0].parkedOnResolved).toEqual([
      {
        kind: 'composed',
        rootId: 96,
        mode: 'any',
        required: 1,
        of: 2,
        leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'],
        expiresTs: '2026-07-26T18:36:37Z',
        onTimeout: 'wake',
      },
    ]);
  });

  it('skips the read entirely for an agent with no composed sentinel (no extra cost on the common case)', async () => {
    const listActiveComposedRoots = vi.fn(async () => [node()]);
    const agents: ComposedTestAgent[] = [{ agentId: 'su-1', parkedOn: ['lock:grant:t1'] }, { agentId: 'su-2', parkedOn: [] }];
    await decorateComposedParkedOn(agents, { listActiveComposedRoots: listActiveComposedRoots as never, loadTreeLeaves: vi.fn() as never });
    expect(listActiveComposedRoots).not.toHaveBeenCalled();
    expect(agents[0].parkedOnResolved).toBeUndefined();
  });

  it('a roots-read failure fails soft (via the shared withBoundedTimeout degrade) — never throws, keeps the raw sentinel visible', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listActiveComposedRoots = vi.fn(async () => {
      throw new Error('pg down');
    });
    const agents: ComposedTestAgent[] = [{ agentId: 'su-1', parkedOn: ['composed-root:96'] }];
    await expect(
      decorateComposedParkedOn(agents, { listActiveComposedRoots: listActiveComposedRoots as never, loadTreeLeaves: vi.fn() as never }),
    ).resolves.toBeDefined();
    // withBoundedTimeout degrades the failed read to its [] fallback rather than throwing, so
    // resolution proceeds with an empty tree map — resolveComposedParkedOn's own fail-open path
    // (asserted in isolation above) then keeps the unresolved sentinel visible, same as a genuine
    // 1.5s timeout would. Never silently drops the raw signal a leader could otherwise have seen.
    expect(agents[0].parkedOnResolved).toEqual(['composed-root:96']);
  });

  it('projectMember prefers parkedOnResolved over the raw flat parkedOn end-to-end', () => {
    const agent = baseAgent({
      parkedOn: ['work-item:status:WI-6088', 'composed-root:96'],
      parkedOnResolved: [
        { kind: 'composed', rootId: 96, mode: 'any', required: 1, of: 2, leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'], expiresTs: '2026-07-26T18:36:37Z', onTimeout: 'wake' },
      ],
    });
    const m = projectMember(agent, NOW);
    expect(m.parkedOn).toEqual([
      { kind: 'composed', rootId: 96, mode: 'any', required: 1, of: 2, leaves: ['work-item:status:WI-6088', 'work-item:status:WI-6095'], expiresTs: '2026-07-26T18:36:37Z', onTimeout: 'wake' },
    ]);
  });

  it('projectMember falls back to the raw flat parkedOn when nothing was resolved (unchanged pre-fix behavior)', () => {
    const m = projectMember(baseAgent({ parkedOn: ['p2p-git:phase3-open'] }), NOW);
    expect(m.parkedOn).toEqual(['p2p-git:phase3-open']);
  });
});

describe('EI-19313376980892266 — the brief must not call an AT-CAPACITY member idle-with-claimable', () => {
  // The live failure: a PARKED item retains `taken_by`, so it counts against the
  // scheduler's maxConcurrentClaims while contributing nothing to the presence layer's
  // `load`. `load === 0 && activeClaims >= 1` is therefore reachable, and in it the brief
  // reported five members `idle_with_claimable` — the leader broadcast twice and woke all
  // five (woken:1 verified) demanding work the scheduler was structurally refusing.
  const idleShape = {
    stalled: false,
    verdict: 'monitoring' as const,
    parkedOn: [],
    doing: null,
    load: 0,
    queued: [],
  };

  it('suppresses idle-with-claimable when the shared oracle says the member is concurrency-blocked', () => {
    const s = computeBenchSuggestion(idleShape, 5, null, false, {
      blocked: true,
      activeClaims: 1,
      heldIds: ['WI-1'],
    });
    expect(s).toBeUndefined();
  });

  it('STILL flags idle-with-claimable when the member is genuinely free (the alert must not be neutered)', () => {
    const s = computeBenchSuggestion(idleShape, 5, null, false, {
      blocked: false,
      activeClaims: 0,
      heldIds: [],
    });
    expect(s?.kind).toBe('idle-with-claimable');
  });

  it('fails OPEN when no verdict was read — an unread oracle must not silence a real starvation signal', () => {
    // Absent/null both read as "not read on this call", never as "not blocked".
    expect(computeBenchSuggestion(idleShape, 5, null, false, null)?.kind).toBe('idle-with-claimable');
    expect(computeBenchSuggestion(idleShape, 5, null, false)?.kind).toBe('idle-with-claimable');
  });

  it('does not count a suppressed member in idle_with_claimable, which is what the leader acts on', () => {
    // summary.idle_with_claimable filters on benchSuggestion?.kind === 'idle-with-claimable',
    // so suppression at the source is what removes it from the count the leader reads.
    const blocked = computeBenchSuggestion(idleShape, 5, null, false, {
      blocked: true,
      activeClaims: 2,
      heldIds: ['WI-1', 'WI-2'],
    });
    const free = computeBenchSuggestion(idleShape, 5, null, false, {
      blocked: false,
      activeClaims: 0,
      heldIds: [],
    });
    const idleWithClaimable = [blocked, free].filter((s) => s?.kind === 'idle-with-claimable');
    expect(idleWithClaimable).toHaveLength(1);
  });
});

describe('computeFleetBlockVerdict (P-019/P-012 — which LAYER is blocking the fleet)', () => {
  const congestedPool = {
    poolExhausted: true,
    degraded: true,
    factor: 0,
    queueDepth: 28,
    usableAccounts: 0,
    availableAccounts: 0,
  };
  const healthyPool = {
    poolExhausted: false,
    degraded: false,
    factor: 0.9,
    queueDepth: 0,
    usableAccounts: 4,
    availableAccounts: 4,
  };
  /** A fleet whose members are ALL working — nothing idle, nothing paused. */
  const working = {
    claimable: 40,
    matchedByFilter: 120,
    idleMemberCount: 0,
    lanelessIdleCount: 0,
    poolCapacity: healthyPool,
  };

  it('returns undefined when no member is idle and the fleet is not paused', () => {
    expect(computeFleetBlockVerdict(working)).toBeUndefined();
  });

  it('does NOT emit a reassuring "nothing wrong" row — absence is the signal', () => {
    // Guards the shape choice: a `layer: 'none'` verdict would be one more field to read
    // on every healthy brief, which is what the flat-alert problem already suffers from.
    expect(computeFleetBlockVerdict(working)).toBeUndefined();
  });

  describe('precedence — the layers dominate in physical dependency order', () => {
    it('fleet-paused outranks EVERY other layer', () => {
      const v = computeFleetBlockVerdict({
        ...working,
        fleetPaused: true,
        poolCapacity: congestedPool,
        claimable: 0,
        matchedByFilter: 0,
        idleMemberCount: 6,
        lanelessIdleCount: 3,
      });
      expect(v?.layer).toBe('fleet-paused');
      expect(v?.remedy).toContain('fleet:resume');
    });

    /**
     * THE INVERSION THIS ITEM EXISTS FOR. Measured live 2026-08-09T02:31Z: pool at factor 0
     * with 28 queued, 6 members idle beside a NONEMPTY claimable queue. Read flat, that is
     * `idleWithClaimableAlert` and the remedy is "wake them" — which adds six more requests
     * behind the same congestion. The pool layer must win.
     */
    it('inference-pool outranks members even when the queue is full and members are idle', () => {
      const v = computeFleetBlockVerdict({
        claimable: 293,
        matchedByFilter: 457,
        idleMemberCount: 6,
        lanelessIdleCount: 0,
        poolCapacity: congestedPool,
      });
      expect(v?.layer).toBe('inference-pool');
      expect(v?.remedy).toMatch(/do NOT coord:send wake/i);
      // and it must NAME the alert it is overruling, so the leader does not act on it next
      expect(v?.subordinate).toContain('idleWithClaimableAlert');
    });

    it('inference-pool outranks claim-floors', () => {
      const v = computeFleetBlockVerdict({
        claimable: 0,
        matchedByFilter: 108,
        idleMemberCount: 0,
        lanelessIdleCount: 5,
        poolCapacity: congestedPool,
      });
      expect(v?.layer).toBe('inference-pool');
      expect(v?.subordinate).toContain('floorStarvedAlert');
    });

    it('spec-scope wins over claim-floors when the spec matches nothing', () => {
      const v = computeFleetBlockVerdict({
        claimable: 0,
        matchedByFilter: 0,
        idleMemberCount: 0,
        lanelessIdleCount: 4,
        poolCapacity: healthyPool,
      });
      expect(v?.layer).toBe('spec-scope');
      expect(v?.remedy).toContain('scheduler:set_claim_spec');
    });

    it('claim-floors when the spec matches plenty and every row is withheld', () => {
      const v = computeFleetBlockVerdict({
        claimable: 0,
        matchedByFilter: 108,
        idleMemberCount: 0,
        lanelessIdleCount: 5,
        poolCapacity: healthyPool,
      });
      expect(v?.layer).toBe('claim-floors');
      expect(v?.remedy).toMatch(/do NOT bench/i);
    });

    it('members ONLY when every upstream layer is read and clear', () => {
      const v = computeFleetBlockVerdict({
        claimable: 293,
        matchedByFilter: 457,
        idleMemberCount: 6,
        lanelessIdleCount: 0,
        poolCapacity: healthyPool,
      });
      expect(v?.layer).toBe('members');
      expect(v?.remedy).toContain('coord:send');
      expect(v?.reason).toContain('pool read and healthy');
    });
  });

  describe('a degraded pool with an EMPTY queue is not currently starving anyone', () => {
    it('falls through to the members layer', () => {
      const v = computeFleetBlockVerdict({
        claimable: 293,
        matchedByFilter: 457,
        idleMemberCount: 6,
        lanelessIdleCount: 0,
        poolCapacity: { ...congestedPool, poolExhausted: false, queueDepth: 0 },
      });
      expect(v?.layer).toBe('members');
    });
  });

  describe('an exhausted pool remains blocking even with an EMPTY gateway queue', () => {
    it('lets poolExhausted outrank members when no provider accounts are usable', () => {
      const v = computeFleetBlockVerdict({
        claimable: 293,
        matchedByFilter: 457,
        idleMemberCount: 6,
        lanelessIdleCount: 0,
        poolCapacity: {
          ...congestedPool,
          degraded: false,
          queueDepth: 0,
          usableAccounts: 0,
          availableAccounts: 0,
        },
      });
      expect(v?.layer).toBe('inference-pool');
      expect(v?.remedy).toMatch(/do NOT coord:send wake/i);
    });
  });

  describe('fail-soft direction — an UNREAD pool never silently promotes the wake remedy', () => {
    it('states that layer 2 was not ruled out, and sends the leader to check it first', () => {
      const v = computeFleetBlockVerdict({
        claimable: 293,
        matchedByFilter: 457,
        idleMemberCount: 6,
        lanelessIdleCount: 0,
        poolCapacity: null,
      });
      expect(v?.layer).toBe('members');
      expect(v?.reason).toMatch(/could NOT be read/i);
      expect(v?.remedy).toMatch(/falsifier FIRST/i);
      // the falsifier must point at the layer that was NOT ruled out, not at the queue
      expect(v?.falsifier.tool).toBe('fleet:capacity');
      expect(v?.falsifier.kills).toMatch(/inference-pool/);
    });

    it('an unread pool cannot itself manufacture an inference-pool verdict', () => {
      const v = computeFleetBlockVerdict({
        claimable: 0,
        matchedByFilter: 108,
        idleMemberCount: 0,
        lanelessIdleCount: 5,
        poolCapacity: null,
      });
      expect(v?.layer).toBe('claim-floors');
    });
  });

  /**
   * The pool verdict is computed from a cached projection that has now false-positived
   * TWICE in one session (fleet:capacity reporting poolExhausted/usableAccounts:0 while a
   * live probe found 3 of 4 accounts answering 200). Its falsifier must therefore be the
   * LIVE probe, not a re-read of the same projection — and must say plainly that the
   * projection alone is not grounds to escalate to the owner.
   */
  describe('the inference-pool falsifier is the live probe, not the projection', () => {
    const v = computeFleetBlockVerdict({
      claimable: 293,
      matchedByFilter: 457,
      idleMemberCount: 6,
      lanelessIdleCount: 0,
      poolCapacity: congestedPool,
    });

    it('calls accounts:probe-capacity', () => {
      expect(v?.falsifier.tool).toBe('accounts:probe-capacity');
      expect(v?.falsifier.check).toContain('accounts:probe-capacity');
    });

    it('measures something INDEPENDENT of the input it fired on', () => {
      expect(v?.falsifier.measurement).toMatch(/live/i);
      expect(v?.falsifier.measurement).toMatch(/independent of the cached/i);
    });

    it('warns against escalating a pool fault on the projection alone', () => {
      expect(v?.falsifier.kills).toMatch(/NEVER escalate/i);
      expect(v?.falsifier.kills).toMatch(/probe first/i);
    });
  });

  /**
   * FALSIFIABILITY CONTROL (CLAUDE.md "proving a guard is falsifiable" — module tier: a
   * deliberately-wrong implementation kept PERMANENTLY in the test file, never a mutation
   * of the shared tree).
   *
   * `naiveFlatVerdict` is the behaviour that existed BEFORE this item: the alerts read in
   * field order, members-first, with no precedence. If someone reorders the real function's
   * branches — or deletes the pool check — it degenerates to exactly this. The control
   * proves the precedence assertions above can actually FAIL, and the calibration case
   * proves they are not passing for a trivial reason (e.g. both returning undefined).
   */
  describe('control: the pre-fix flat reading, kept so the precedence tests can fail', () => {
    type Input = Parameters<typeof computeFleetBlockVerdict>[0];
    const naiveFlatVerdict = (input: Input): string | undefined => {
      if ((input.claimable ?? 0) > 0 && input.idleMemberCount > 0) return 'members';
      if (input.claimable === 0 && (input.matchedByFilter ?? 0) > 0) return 'claim-floors';
      if (input.matchedByFilter === 0) return 'spec-scope';
      return undefined;
    };
    // The exact live 2026-08-09T02:31Z shape: starved pool, full queue, six idle members.
    const inversion = {
      claimable: 293,
      matchedByFilter: 457,
      idleMemberCount: 6,
      lanelessIdleCount: 0,
      poolCapacity: congestedPool,
    };

    it('the naive reading gets the inversion WRONG (this is what regressing looks like)', () => {
      expect(naiveFlatVerdict(inversion)).toBe('members');
    });

    it('the real function gets it RIGHT — so the precedence test is not vacuous', () => {
      expect(computeFleetBlockVerdict(inversion)?.layer).toBe('inference-pool');
      expect(computeFleetBlockVerdict(inversion)?.layer).not.toBe(naiveFlatVerdict(inversion));
    });

    it('CALIBRATION: the two agree wherever precedence is not in play', () => {
      // Without this, "they differ" could be satisfied by a real function that is simply
      // broken everywhere rather than one that is correctly ordered.
      const noPrecedenceConflict = {
        claimable: 0,
        matchedByFilter: 108,
        idleMemberCount: 0,
        lanelessIdleCount: 5,
        poolCapacity: healthyPool,
      };
      expect(computeFleetBlockVerdict(noPrecedenceConflict)?.layer).toBe(
        naiveFlatVerdict(noPrecedenceConflict),
      );
    });
  });

  it('every layer ships a falsifier that is read-only', () => {
    const inputs = [
      { ...working, fleetPaused: true },
      { ...working, idleMemberCount: 6, poolCapacity: congestedPool },
      { ...working, idleMemberCount: 0, lanelessIdleCount: 4, matchedByFilter: 0, claimable: 0 },
      { ...working, idleMemberCount: 0, lanelessIdleCount: 5, claimable: 0 },
      { ...working, idleMemberCount: 6 },
      { ...working, idleMemberCount: 6, poolCapacity: null },
    ];
    const layers = new Set<string>();
    for (const input of inputs) {
      const v = computeFleetBlockVerdict(input);
      expect(v).toBeDefined();
      layers.add(v!.layer);
      expect(FALSIFIER_FORBIDDEN_TOOLS).not.toContain(v!.falsifier.tool);
      expect(v!.falsifier.check.length).toBeGreaterThan(0);
      expect(v!.falsifier.kills.length).toBeGreaterThan(0);
      expect(v!.remedy.length).toBeGreaterThan(0);
    }
    // calibration: the six inputs must actually exercise all five layers, or the
    // read-only assertion above is passing on a set that never reached most of them
    expect(layers).toEqual(
      new Set(['fleet-paused', 'inference-pool', 'spec-scope', 'claim-floors', 'members']),
    );
  });
});
