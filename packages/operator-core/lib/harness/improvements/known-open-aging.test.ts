import { describe, it, expect, vi } from 'vitest';
import {
  KNOWN_OPEN_AGING_GENERAL_THRESHOLD_MS,
  KNOWN_OPEN_AGING_INFRA_THRESHOLD_MS,
  KNOWN_OPEN_REESCALATE_INTERVAL_MS,
  KNOWN_OPEN_CONTINUITY_GAP_MS,
  isInfraClassKey,
  agingOptionsFromTick,
  computeKnownOpenRuns,
  parseAgingState,
  bumpedSeverity,
  planKnownOpenAging,
  processKnownOpenAging,
  agingConditionKey,
  currentEvidenceBlock,
  splitAgingInputs,
  type KnownOpenTickSample,
  type AgingItemInput,
  type KnownOpenAgingDeps,
} from './known-open-aging';
import { readFile } from 'node:fs/promises';
import type { EngineerIssue } from '../../issues-engineer';

const NOW = Date.parse('2026-06-12T12:00:00.000Z');
const hoursAgo = (h: number): number => NOW - h * 3_600_000;

/** History: the key observed every 15 min from `fromHoursAgo` until `toHoursAgo`. */
function steadyHistory(key: string, fromHoursAgo: number, toHoursAgo = 0): KnownOpenTickSample[] {
  const out: KnownOpenTickSample[] = [];
  for (let t = hoursAgo(toHoursAgo); t >= hoursAgo(fromHoursAgo); t -= 15 * 60_000) {
    out.push({ tickAtMs: t, keys: [key] });
  }
  return out; // newest-first by construction
}

function item(p: Partial<AgingItemInput> & { id: string }, watchdogKey: string): AgingItemInput {
  return {
    state: 'open',
    severity: 'major',
    title: `Improvement ${p.id}`,
    payload: { watchdogKey },
    ...p,
  };
}

const keyOf = (i: AgingItemInput): string | undefined =>
  (i.payload as Record<string, unknown> | null)?.watchdogKey as string | undefined;

describe('D-004 PROPOSED defaults (P-004 ratification pending — values are tunables, not law)', () => {
  it('general 3d / infra 24h / re-escalate weekly / continuity gap 2h', () => {
    expect(KNOWN_OPEN_AGING_GENERAL_THRESHOLD_MS).toBe(3 * 24 * 3_600_000);
    expect(KNOWN_OPEN_AGING_INFRA_THRESHOLD_MS).toBe(24 * 3_600_000);
    expect(KNOWN_OPEN_REESCALATE_INTERVAL_MS).toBe(7 * 24 * 3_600_000);
    expect(KNOWN_OPEN_CONTINUITY_GAP_MS).toBe(2 * 3_600_000);
  });

  it('infra-class = service-down + fire-circuit-open keys (D-002 classes)', () => {
    expect(isInfraClassKey('service-down:shop')).toBe(true);
    expect(isInfraClassKey('fire-circuit-open:circuit:gymloopharness:gym-cycle')).toBe(true);
    expect(isInfraClassKey('red-test:lib/a.test.ts')).toBe(false);
    expect(isInfraClassKey('insight-staleness:some-insight')).toBe(false);
  });

  it('agingOptionsFromTick converts the routine-payload units (hours/days/minutes) to ms', () => {
    expect(agingOptionsFromTick({
      agingGeneralThresholdHours: 48,
      agingInfraThresholdHours: 12,
      agingReescalateDays: 3,
      agingContinuityGapMinutes: 90,
      maxAgingEscalationsPerTick: 5,
    })).toEqual({
      generalThresholdMs: 48 * 3_600_000,
      infraThresholdMs: 12 * 3_600_000,
      reescalateIntervalMs: 3 * 86_400_000,
      continuityGapMs: 90 * 60_000,
      maxPerTick: 5,
    });
    expect(agingOptionsFromTick({})).toEqual({});
  });
});

describe('computeKnownOpenRuns — continuity from the tick history', () => {
  it('a steady 15-min cadence extends the run to the oldest observation', () => {
    const runs = computeKnownOpenRuns(['service-down:shop'], steadyHistory('service-down:shop', 50), NOW);
    expect(runs.get('service-down:shop')).toBe(hoursAgo(50));
  });

  it('a silence longer than the gap RESETS the run (remission, not continuity)', () => {
    // Observed 10h..0h ago, then a 5h hole, then more history 20h..15h ago.
    const history = [...steadyHistory('k', 10), ...steadyHistory('k', 20, 15)];
    const runs = computeKnownOpenRuns(['k'], history, NOW, 2 * 3_600_000);
    expect(runs.get('k')).toBe(hoursAgo(10));
  });

  it('no history → the run starts now', () => {
    expect(computeKnownOpenRuns(['k'], [], NOW).get('k')).toBe(NOW);
  });

  it('only rows containing the key count toward its run', () => {
    const history: KnownOpenTickSample[] = [
      { tickAtMs: hoursAgo(1), keys: ['other'] },
      { tickAtMs: hoursAgo(1.5), keys: ['k'] },
    ];
    expect(computeKnownOpenRuns(['k'], history, NOW, 2 * 3_600_000).get('k')).toBe(hoursAgo(1.5));
  });
});

describe('parseAgingState / bumpedSeverity', () => {
  it('absent or malformed payload parses to never-escalated', () => {
    expect(parseAgingState(null)).toEqual({ lastEscalatedAtMs: null, escalations: 0, severityBumped: false });
    expect(parseAgingState({ watchdogKey: 'x' })).toEqual({ lastEscalatedAtMs: null, escalations: 0, severityBumped: false });
    expect(parseAgingState({ knownOpenAging: 'junk' })).toEqual({ lastEscalatedAtMs: null, escalations: 0, severityBumped: false });
  });

  it('round-trips a real stamp', () => {
    const s = parseAgingState({
      knownOpenAging: {
        firstSeenAt: '2026-06-10T00:00:00.000Z',
        lastEscalatedAt: '2026-06-11T00:00:00.000Z',
        escalations: 2,
        severityBumped: { from: 'minor', to: 'major', at: '2026-06-11T00:00:00.000Z' },
      },
    });
    expect(s.lastEscalatedAtMs).toBe(Date.parse('2026-06-11T00:00:00.000Z'));
    expect(s.escalations).toBe(2);
    expect(s.severityBumped).toBe(true);
  });

  it('bumps one rank toward critical; critical has nowhere to go', () => {
    expect(bumpedSeverity('nit')).toBe('minor');
    expect(bumpedSeverity('minor')).toBe('major');
    expect(bumpedSeverity('major')).toBe('critical');
    expect(bumpedSeverity('critical')).toBeUndefined();
  });
});

describe('planKnownOpenAging — the threshold/cool-down rules', () => {
  it('a general key under 3d does NOT escalate; over 3d it does, with a one-rank bump', () => {
    const items = [item({ id: 'EI-1' }, 'red-test:lib/a.test.ts')];
    const young = new Map([['red-test:lib/a.test.ts', hoursAgo(48)]]);
    expect(planKnownOpenAging(young, items, keyOf, { nowMs: NOW })).toEqual([]);
    const old = new Map([['red-test:lib/a.test.ts', hoursAgo(73)]]);
    const out = planKnownOpenAging(old, items, keyOf, { nowMs: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ issueId: 'EI-1', bumpTo: 'critical', infra: false, reescalation: false, escalationNumber: 1 });
  });

  it('an INFRA key crosses at 24h while the same age as a general key would not (D-002)', () => {
    const runs = new Map([
      ['service-down:shop', hoursAgo(25)],
      ['insight-staleness:x', hoursAgo(25)],
    ]);
    const items = [item({ id: 'EI-I' }, 'service-down:shop'), item({ id: 'EI-G' }, 'insight-staleness:x')];
    const out = planKnownOpenAging(runs, items, keyOf, { nowMs: NOW });
    expect(out.map((d) => d.issueId)).toEqual(['EI-I']);
    expect(out[0].infra).toBe(true);
  });

  it('the re-escalation cool-down suppresses; past it, re-escalates WITHOUT a second bump', () => {
    const runs = new Map([['service-down:shop', hoursAgo(300)]]);
    const stamped = (escalatedHoursAgo: number): AgingItemInput[] => [item({
      id: 'EI-1',
      payload: {
        watchdogKey: 'service-down:shop',
        knownOpenAging: {
          firstSeenAt: 'x',
          lastEscalatedAt: new Date(hoursAgo(escalatedHoursAgo)).toISOString(),
          escalations: 1,
          severityBumped: { from: 'major', to: 'critical', at: 'x' },
        },
      },
    }, 'service-down:shop')];
    // 2 days since the last escalation → inside the weekly cap → nothing.
    expect(planKnownOpenAging(runs, stamped(48), keyOf, { nowMs: NOW })).toEqual([]);
    // 8 days since → re-escalate, bump already spent.
    const out = planKnownOpenAging(runs, stamped(8 * 24), keyOf, { nowMs: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ reescalation: true, escalationNumber: 2, priorSeverityBumped: true });
    expect(out[0].bumpTo).toBeUndefined();
  });

  it('an already-critical item escalates with no bump', () => {
    const runs = new Map([['service-down:shop', hoursAgo(48)]]);
    const out = planKnownOpenAging(runs, [item({ id: 'EI-1', severity: 'critical' }, 'service-down:shop')], keyOf, { nowMs: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].bumpTo).toBeUndefined();
    expect(out[0].priorSeverityBumped).toBe(false);
  });

  it('EI-14763: a freshly re-minted item does NOT inherit the KEY\'s old run (clock clamps to createdAt)', () => {
    // The watchdogKey fired continuously for 73h, but the CURRENT item was minted
    // 18 min ago (a resolve→re-mint within a cooldown). The per-KEY run says 73h;
    // the clamp restarts the clock at the item's own creation → no phantom escalate.
    const key = 'coordination:stalled-claim';
    const runs = new Map([[key, hoursAgo(73)]]);
    const freshMint = item({ id: 'EI-NEW', createdAt: new Date(NOW - 18 * 60_000).toISOString() }, key);
    expect(planKnownOpenAging(runs, [freshMint], keyOf, { nowMs: NOW })).toEqual([]);

    // Control: a genuinely long-open item (createdAt precedes the run) still escalates,
    // and its reported clock reflects the item, not a clock older than it existed.
    const genuinelyOld = item({ id: 'EI-OLD', createdAt: new Date(hoursAgo(100)).toISOString() }, key);
    const out = planKnownOpenAging(runs, [genuinelyOld], keyOf, { nowMs: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].issueId).toBe('EI-OLD');
    expect(out[0].firstSeenMs).toBe(hoursAgo(73)); // the run start, not the older createdAt
    expect(out[0].openForMs).toBe(73 * 3_600_000);

    // Absent createdAt → no clamp (older callers unchanged): the 73h run escalates.
    const noCreated = item({ id: 'EI-NC' }, key);
    expect(planKnownOpenAging(runs, [noCreated], keyOf, { nowMs: NOW })).toHaveLength(1);
  });

  it('caps per tick, longest-open first; resolved items are ignored', () => {
    const runs = new Map([
      ['service-down:a', hoursAgo(30)],
      ['service-down:b', hoursAgo(60)],
      ['service-down:c', hoursAgo(90)],
      ['service-down:resolved', hoursAgo(90)],
    ]);
    const items = [
      item({ id: 'EI-A' }, 'service-down:a'),
      item({ id: 'EI-B' }, 'service-down:b'),
      item({ id: 'EI-C' }, 'service-down:c'),
      item({ id: 'EI-R', state: 'resolved' }, 'service-down:resolved'),
    ];
    const out = planKnownOpenAging(runs, items, keyOf, { nowMs: NOW, maxPerTick: 2 });
    expect(out.map((d) => d.issueId)).toEqual(['EI-C', 'EI-B']);
  });
});

describe('processKnownOpenAging — the brief\'s synthetic end-to-end (escalates EXACTLY once)', () => {
  function recordingDeps(items: AgingItemInput[], history: KnownOpenTickSample[]) {
    const calls: string[] = [];
    const stamps: Record<string, unknown>[] = [];
    const escalations: {
      severity: string;
      summary: string;
      body: string;
      meta?: { dedupKind?: string; subjectSignature?: string };
    }[] = [];
    const bumps: { id: string; to: string }[] = [];
    const comments: string[] = [];
    const deps: Partial<KnownOpenAgingDeps> = {
      readHistory: async () => history,
      readItems: async () => items as EngineerIssue[],
      stampPayload: async (_id, patch) => { calls.push('stamp'); stamps.push(patch); },
      bumpSeverity: async (id, to) => { calls.push('bump'); bumps.push({ id, to }); },
      comment: async (_id, body) => { calls.push('comment'); comments.push(body); },
      escalate: async (input) => { calls.push('escalate'); escalations.push(input); },
    };
    return { calls, stamps, escalations, bumps, comments, deps };
  }

  it('a synthetic known-open key crossing the threshold escalates exactly once', async () => {
    const key = 'service-down:shop';
    const history = steadyHistory(key, 30); // 30h continuous > the 24h infra threshold
    const synthetic = item({ id: 'EI-99', severity: 'major' }, key);
    const r1 = recordingDeps([synthetic], history);

    // Tick 1 — crosses the threshold: ONE escalation, ONE bump, payload stamped.
    const out1 = await processKnownOpenAging('ws', [key], { nowMs: NOW }, r1.deps);
    expect(out1).toEqual([{ issueId: 'EI-99', watchdogKey: key, reescalation: false, bumped: 'critical' }]);
    expect(r1.escalations).toHaveLength(1);
    expect(r1.escalations[0].severity).toBe('advisory');
    expect(r1.escalations[0].summary).toContain(key);
    expect(r1.bumps).toEqual([{ id: 'EI-99', to: 'critical' }]);
    expect(r1.comments).toHaveLength(1);
    const stamp = (r1.stamps[0] as { knownOpenAging: Record<string, unknown> }).knownOpenAging;
    expect(stamp).toMatchObject({ escalations: 1, lastEscalatedAt: new Date(NOW).toISOString() });

    // Tick 2 (15 min later) — the key STILL fires, but the stamp suppresses: ZERO new escalations.
    const stampedItem = item({ id: 'EI-99', severity: 'critical', payload: { watchdogKey: key, knownOpenAging: stamp } }, key);
    const r2 = recordingDeps([stampedItem], [{ tickAtMs: NOW, keys: [key] }, ...history]);
    const out2 = await processKnownOpenAging('ws', [key], { nowMs: NOW + 15 * 60_000 }, r2.deps);
    expect(out2).toEqual([]);
    expect(r2.escalations).toHaveLength(0);
    expect(r2.bumps).toHaveLength(0);
  });

  it('the STAMP lands first; a stamp failure skips that escalation entirely (no double-bump, no owner storm)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const key = 'service-down:shop';
      const r = recordingDeps([item({ id: 'EI-99' }, key)], steadyHistory(key, 30));
      r.deps.stampPayload = async () => { throw new Error('pg down'); };
      const out = await processKnownOpenAging('ws', [key], { nowMs: NOW }, r.deps);
      expect(out).toEqual([]);
      expect(r.escalations).toHaveLength(0);
      expect(r.bumps).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/aging stamp failed/));
    } finally {
      warn.mockRestore();
    }
  });

  it('a coord:escalate failure is logged; the bump + comment still land (the stamp already gates retries)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const key = 'service-down:shop';
      const r = recordingDeps([item({ id: 'EI-99' }, key)], steadyHistory(key, 30));
      r.deps.escalate = async () => { throw new Error('coord log down'); };
      const out = await processKnownOpenAging('ws', [key], { nowMs: NOW }, r.deps);
      expect(out).toHaveLength(1);
      expect(r.bumps).toEqual([{ id: 'EI-99', to: 'critical' }]);
      expect(r.comments).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/aging coord:escalate failed/));
    } finally {
      warn.mockRestore();
    }
  });

  it('a weekly re-escalation carries the SPENT bump forward in the new stamp', async () => {
    const key = 'service-down:shop';
    const spentBump = { from: 'major', to: 'critical', at: '2026-06-01T00:00:00.000Z' };
    const stamped = item({
      id: 'EI-99',
      severity: 'critical',
      payload: {
        watchdogKey: key,
        knownOpenAging: {
          firstSeenAt: '2026-06-01T00:00:00.000Z',
          lastEscalatedAt: new Date(hoursAgo(8 * 24)).toISOString(),
          escalations: 1,
          severityBumped: spentBump,
        },
      },
    }, key);
    const r = recordingDeps([stamped], steadyHistory(key, 30));
    const out = await processKnownOpenAging('ws', [key], { nowMs: NOW }, r.deps);
    expect(out).toEqual([{ issueId: 'EI-99', watchdogKey: key, reescalation: true }]);
    expect(r.bumps).toHaveLength(0); // no second bump, ever
    const stamp = (r.stamps[0] as { knownOpenAging: Record<string, unknown> }).knownOpenAging;
    expect(stamp).toMatchObject({ escalations: 2, severityBumped: spentBump });
  });

  it('no known-open keys → no reads, no writes', async () => {
    const readHistory = vi.fn();
    expect(await processKnownOpenAging('ws', [], {}, { readHistory })).toEqual([]);
    expect(readHistory).not.toHaveBeenCalled();
  });

  it('EI-14854: aging escalations for one condition carry a STABLE conditionKey (they coalesce), independent of duration + re-minted issueId', async () => {
    const key = 'stalled-claim:stalled-work-item-claims'; // the live flooding condition
    // createdAt predates the run so the EI-14763 clamp never interferes — both
    // ticks escalate, isolating the coalescing-key behaviour under test.
    const oldCreated = new Date(hoursAgo(200)).toISOString();

    // Tick 1 — the condition has fired continuously for ~96h; item EI-FIRST open.
    const first = item({ id: 'EI-FIRST', severity: 'critical', createdAt: oldCreated }, key);
    const r1 = recordingDeps([first], steadyHistory(key, 96));
    await processKnownOpenAging('ws', [key], { nowMs: NOW }, r1.deps);
    expect(r1.escalations).toHaveLength(1);

    // Tick 2 (~1h later) — the underlying item was resolved + RE-MINTED as EI-SECOND
    // (a NEW issueId, no prior aging stamp) and the duration advanced to ~98h.
    const second = item({ id: 'EI-SECOND', severity: 'critical', createdAt: oldCreated }, key);
    const r2 = recordingDeps([second], steadyHistory(key, 98));
    await processKnownOpenAging('ws', [key], { nowMs: NOW + 3_600_000 }, r2.deps);
    expect(r2.escalations).toHaveLength(1);

    // The two SUMMARIES differ (live duration + re-minted issueId) — EXACTLY what
    // made the old summary-derived subjectSignature never match, minting a fresh
    // un-coalesced escalation (and EI) every ~30-min tick (the EI-14854 flood)...
    expect(r1.escalations[0].summary).not.toBe(r2.escalations[0].summary);
    // ...but the coalescing key (meta.subjectSignature) is IDENTICAL + scoped to the
    // CONDITION (the watchdogKey), so openEscalation dedups both onto ONE open row
    // (bumping repeatCount) instead of proliferating.
    const sig1 = r1.escalations[0].meta?.subjectSignature;
    const sig2 = r2.escalations[0].meta?.subjectSignature;
    expect(sig1).toBe(agingConditionKey(key));
    expect(sig2).toBe(agingConditionKey(key));
    expect(sig1).toBe(sig2);
    // The stable key is duration/issueId-free — it depends ONLY on the watchdogKey.
    expect(agingConditionKey(key)).toBe('known-open-aging:stalled-claim:stalled-work-item-claims');
  });
});

// ── EI-19920080383279759: an escalation must carry RE-MEASURED evidence ───────
//
// The defect this pins: a re-firing signal declines its capture
// (`dedupScope:'open'`), so the filed item's body is frozen at first-fire while
// aging keeps escalating it. Measured live — EI-19920080383279759 was bumped to
// CRITICAL naming pool `brief/user`, a surface dead for 10 days, while the pools
// actually breaching the gate were `mid-turn/hive` and `injection/harness` with
// the OPPOSITE remedy. The evidence must reach the reader, or the assignee works
// a fossil.
describe('known-open aging carries the CURRENT evidence, not just the age', () => {
  const key = 'memory-recall-pool:recall-pool-starved';
  const FRESH = 'mid-turn/hive [rrf]: returned nothing on 200906/234134 recalls (86%).';

  function deps(items: AgingItemInput[], history: KnownOpenTickSample[]) {
    const escalations: { body: string }[] = [];
    const comments: string[] = [];
    return {
      escalations,
      comments,
      d: {
        readHistory: async () => history,
        readItems: async () => items as EngineerIssue[],
        stampPayload: async () => {},
        bumpSeverity: async () => {},
        comment: async (_id: string, body: string) => { comments.push(body); },
        escalate: async (input: { body: string }) => { escalations.push(input); },
      } as Partial<KnownOpenAgingDeps>,
    };
  }

  // 80h continuous — past the 72h GENERAL threshold. This key is not
  // infra-class, so the 24h infra threshold the sibling suite relies on does
  // not apply and a 30h history would never escalate.
  const history = steadyHistory(key, 80);
  const synthetic = () => item({ id: 'EI-199', severity: 'major' }, key);

  it('renders the re-measured body into BOTH the comment and the coord escalation', async () => {
    const r = deps([synthetic()], history);
    const out = await processKnownOpenAging('ws', [{ key, evidence: FRESH }], { nowMs: NOW }, r.d);

    expect(out).toHaveLength(1);
    for (const text of [r.comments[0], r.escalations[0].body]) {
      expect(text).toContain('CURRENT EVIDENCE');
      expect(text).toContain('mid-turn/hive');
      // The reader must be told WHY the filed body may disagree — that sentence
      // is the whole remedy for the fossil-body class, not decoration.
      expect(text).toContain('never rewritten');
    }
  });

  it('a bare string[] caller still works and emits NO evidence header', async () => {
    const r = deps([synthetic()], history);
    const out = await processKnownOpenAging('ws', [key], { nowMs: NOW }, r.d);

    expect(out).toHaveLength(1);
    // An empty header would read as "re-measured and found nothing" — the exact
    // opposite of "this caller passed no evidence".
    expect(r.comments[0]).not.toContain('CURRENT EVIDENCE');
    expect(r.escalations[0].body).not.toContain('CURRENT EVIDENCE');
  });

  it('blank/whitespace evidence is treated as ABSENT, not as an empty measurement', () => {
    expect(currentEvidenceBlock('   \n  ')).toBe('');
    expect(currentEvidenceBlock(undefined)).toBe('');
    expect(splitAgingInputs([{ key, evidence: '  ' }]).evidenceByKey.has(key)).toBe(false);
    expect(splitAgingInputs([{ key, evidence: FRESH }]).evidenceByKey.get(key)).toBe(FRESH);
  });

  it('clips a huge body instead of flooding the escalation', () => {
    const block = currentEvidenceBlock('x'.repeat(50_000));
    expect(block).toContain('evidence clipped');
    expect(block.length).toBeLessThan(2_500);
  });

  it('splitAgingInputs keeps key order and drops blank keys', () => {
    const { keys } = splitAgingInputs(['a', { key: 'b', evidence: 'e' }, '', { key: '  ' }, 'c']);
    expect(keys).toEqual(['a', 'b', 'c']);
  });

  // CONTROL (permanent, per the tier-1 falsifiability discipline): a
  // deliberately-wrong renderer that drops the evidence. It must FAIL the
  // property the real one passes — otherwise the assertions above are vacuous
  // and would keep passing if `currentEvidenceBlock` regressed to a stub.
  it('CONTROL: an evidence-dropping renderer fails the property the real one passes', () => {
    const brokenRenderer = (_evidence: string | undefined): string => '';
    // Calibration — the control is a PLAUSIBLE near-miss: it has the real
    // signature and is correct on the absent-evidence case, so it is only
    // distinguishable by the behaviour under test.
    expect(brokenRenderer(undefined)).toBe(currentEvidenceBlock(undefined));
    // The discriminating case: real renders the body, control silently does not.
    expect(currentEvidenceBlock(FRESH)).toContain('mid-turn/hive');
    expect(brokenRenderer(FRESH)).not.toContain('mid-turn/hive');
  });

  // WIRING guard: `currentEvidenceBlock` can be perfect and exported while the
  // watchdog still discards the body at the call site — the inert-rail class
  // (a feature unit-tested, green, and CALLED BY NOTHING). Pin the call site to
  // source so dropping `evidence` there fails HERE rather than silently.
  it('WIRING: watchdog.ts passes the signal body, not just the key', async () => {
    const src = await readFile(new URL('./watchdog.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/processAging\(\s*workspaceId,\s*partition\.knownOpen\.map\(\(s\) => \(\{ key: watchdogKeyOf\(s\), evidence: s\.body \}\)\)/);
    // Negative control: the OLD key-only shape must be gone from THE AGING CALL.
    // Scoped to `processAging(` deliberately — the tick RECORD legitimately
    // stores `knownOpenKeys: partition.knownOpen.map(watchdogKeyOf)`, so a bare
    // substring check matches that line and fails on correct code.
    expect(src).not.toMatch(/processAging\(\s*workspaceId,\s*partition\.knownOpen\.map\(watchdogKeyOf\)/);
  });
});
