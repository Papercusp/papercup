/**
 * P-006 coverage — the plan-agent brief's DELEGATION POSTURE block
 * (plan generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20, bars R-5 and R-6).
 *
 * R-5: the four counts are rendered from the shared live provider at render time,
 *      not from a constant baked into the prompt source.
 * R-6: with no actionable plan the brief directs an IDLE report rather than a launch,
 *      under a stated priority order that puts acceptance FIRST and delegation second.
 *
 * Two structural choices here are deliberate, because both bars are falsifiable only
 * if the assertions can actually discriminate:
 *
 *  1. `STALE_CONSTANT_CONTROL` is a deliberately-wrong renderer kept PERMANENTLY in
 *     this file. R-5's real content is "this value tracks the provider", and the only
 *     way to show an assertion detects a baked constant is to run the same assertion
 *     against one that fails. Without it, `tracksProvider` could be vacuously true.
 *  2. The unknown/residue cases are asserted in BOTH directions — no launch AND no
 *     idle claim. Asserting only "did not spawn" would pass for a renderer that
 *     always reports idle, which is the opposite bug and equally wrong.
 */

import { describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ read: vi.fn(), history: vi.fn() }));
vi.mock('../source', async (original) => ({
  ...(await original<typeof import('../source')>()),
  readPlanBySlug: io.read,
  resolvePlanScope: async () => ({ workspaceId: 'ws-delegation', harnessSlug: 'papercusp' }),
}));
vi.mock('../revisions', async (original) => ({
  ...(await original<typeof import('../revisions')>()),
  listPlanRevisions: async () => [],
}));
vi.mock('../../../prior-attempt-context', async (original) => ({
  ...(await original<typeof import('../../../prior-attempt-context')>()),
  readPlanHistoryContext: io.history,
}));

import {
  assemblePlanContextBundleText,
  buildPlanContextBundle,
  renderDelegationPostureBlock,
} from '../context-bundle';
import { DELEGATION_COUNTS_SCHEMA_VERSION, type DelegationCounts, type PopulationCount } from '../../../delegation-counts';
import type { ProviderRead } from '../../../agent-obligation-providers';

const known = (count: number, unmeasured = 0): ProviderRead<PopulationCount> => ({
  status: 'known',
  value: { count, unmeasured },
});

const unreadable = (label: string): ProviderRead<PopulationCount> => ({
  status: 'unknown',
  failure: {
    code: `delegation-count-unreadable:${label}`,
    detail: 'source unavailable',
    retry: `this count is NOT zero, it was not measured (source ${label})`,
  },
});

/** A fully-settled, fully-idle baseline; each test overrides only what it is about. */
function counts(over: Partial<DelegationCounts> = {}): DelegationCounts {
  return {
    schemaVersion: DELEGATION_COUNTS_SCHEMA_VERSION,
    workspaceId: 'ws-delegation',
    observedAt: '2026-09-22T12:00:00.000Z',
    elapsedMs: 12,
    planExecutionAgents: known(0),
    plansAwaitingDelegation: known(0),
    plansAwaitingAcceptance: known(0),
    activeDrainFleets: known(0),
    degradedSources: [],
    ...over,
  };
}

/** The DIRECTED NEXT ACTION section only — the bars are about what the brief TELLS
 *  the agent to do, so the surrounding explanation must not satisfy an assertion. */
function directedAction(block: string): string {
  const marker = 'DIRECTED NEXT ACTION';
  const start = block.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = block.slice(start + marker.length);
  const end = rest.indexOf('⚠ `actionable plans awaiting delegation`');
  return end >= 0 ? rest.slice(0, end) : rest;
}

/** The launch instruction, verbatim. Asserting on this exact phrase (rather than the
 *  word "launch", which also appears in "DO NOT launch an agent") is what keeps a
 *  no-spawn assertion from passing on a block that plainly directs a spawn. */
const LAUNCH_DIRECTIVE = 'select the next\nactionable plan and launch or attach a plan fleet';

function directsALaunch(block: string): boolean {
  const action = directedAction(block).replace(/\s+/g, ' ');
  return action.includes('select the next actionable plan and launch or attach a plan fleet');
}

function claimsIdle(block: string): boolean {
  return directedAction(block).includes('REPORT IDLE');
}

/**
 * R-5's real content as a reusable assertion: the rendered text must CHANGE when the
 * provider's value changes. Applied to the real renderer (must hold) and to the stale
 * control below (must not) — see the file header.
 */
function assertTracksProvider(render: (c: DelegationCounts | null) => string): void {
  const seven = render(counts({ planExecutionAgents: known(7) }));
  const six = render(counts({ planExecutionAgents: known(6) }));
  expect(seven).toContain('7');
  expect(six).toContain('6');
  expect(seven).not.toEqual(six);
}

/**
 * ⛔ DELIBERATELY WRONG — do not "fix" this, and do not delete it.
 *
 * This is exactly the defect R-5 forbids: a posture block whose counts are baked into
 * the prompt source and ignore the provider entirely. It exists so the test below can
 * demonstrate that `assertTracksProvider` FAILS on a constant, which is the only thing
 * that makes its passing on the real renderer meaningful.
 */
function STALE_CONSTANT_CONTROL(_counts: DelegationCounts | null): string {
  return [
    'DELEGATION POSTURE — live at launch, not a prompt constant',
    '  live plan-execution agents            : 1',
    '  actionable plans awaiting delegation  : 3',
    '  plans awaiting acceptance             : 0',
    '  active drain fleets                   : 0',
    'DIRECTED NEXT ACTION',
    '  DELEGATE — select the next actionable plan and launch or attach a plan fleet.',
  ].join('\n');
}

describe('R-5 — the four counts come from the live provider, not a prompt constant', () => {
  it('renders all four populations with their provider values', () => {
    const block = renderDelegationPostureBlock(
      counts({
        planExecutionAgents: known(8),
        plansAwaitingDelegation: known(140),
        plansAwaitingAcceptance: known(2),
        activeDrainFleets: known(3),
      }),
    );

    expect(block).toMatch(/live plan-execution agents\s+: 8/);
    expect(block).toMatch(/actionable plans awaiting delegation\s+: 140/);
    expect(block).toMatch(/plans awaiting acceptance\s+: 2/);
    expect(block).toMatch(/active drain fleets\s+: 3/);
    // The read's own provenance rides along, so a reader can tell how old it is.
    expect(block).toContain('2026-09-22T12:00:00.000Z');
    expect(block).toContain(DELEGATION_COUNTS_SCHEMA_VERSION);
  });

  it('tracks the provider across reads — and the stale-constant control proves that assertion discriminates', () => {
    expect(() => assertTracksProvider(renderDelegationPostureBlock)).not.toThrow();
    // Same assertion, deliberately-wrong renderer. If this ever stops throwing, the
    // assertion above has gone vacuous and R-5 is no longer covered.
    expect(() => assertTracksProvider(STALE_CONSTANT_CONTROL)).toThrow();
  });

  it('preserves an unmeasured residue on the aggregate instead of reporting a bare count', () => {
    const block = renderDelegationPostureBlock(counts({ planExecutionAgents: known(4, 3) }));
    expect(block).toMatch(/live plan-execution agents\s+: 4 \(\+3 unmeasured\)/);
  });

  it('renders an unreadable count as unknown, never as 0', () => {
    const block = renderDelegationPostureBlock(
      counts({
        plansAwaitingDelegation: unreadable('plans-awaiting-delegation'),
        degradedSources: ['plans-awaiting-delegation'],
      }),
    );
    expect(block).toMatch(/actionable plans awaiting delegation\s+: unknown \(not measured\)/);
    expect(block).not.toMatch(/actionable plans awaiting delegation\s+: 0/);
    expect(block).toContain('degraded to unknown on this read: plans-awaiting-delegation');
  });

  it('carries the plan-level upper-bound caveat so the count is not read as a pickable-item count', () => {
    const block = renderDelegationPostureBlock(counts({ plansAwaitingDelegation: known(140) }));
    expect(block).toContain('UPPER BOUND');
    expect(block).toContain('plans:items { actionable: true }');
  });
});

describe('R-6 — acceptance-first priority order, idle reporting, and no idle spawning', () => {
  it('states the priority order with acceptance first, delegation second, idle third', () => {
    const block = renderDelegationPostureBlock(counts());
    const acceptance = block.indexOf('1. ACCEPTANCE');
    const delegation = block.indexOf('2. DELEGATION');
    const idle = block.indexOf('3. IDLE');

    expect(acceptance).toBeGreaterThan(-1);
    expect(acceptance).toBeLessThan(delegation);
    expect(delegation).toBeLessThan(idle);
  });

  it('directs an IDLE report — not a spawn — when no actionable plan exists', () => {
    // R-6's falsifier, executed directly: the actionable count forced to zero.
    const block = renderDelegationPostureBlock(counts({ plansAwaitingDelegation: known(0) }));

    expect(claimsIdle(block)).toBe(true);
    expect(directsALaunch(block)).toBe(false);
    expect(directedAction(block)).toContain('DO NOT launch an agent');
  });

  it('puts a pending acceptance ahead of delegation even when delegation is otherwise ready', () => {
    // The starvation case: agents at 0 and actionable plans waiting would ordinarily
    // authorize a launch, but a pending acceptance outranks it.
    const block = renderDelegationPostureBlock(
      counts({
        plansAwaitingAcceptance: known(1),
        planExecutionAgents: known(0),
        plansAwaitingDelegation: known(4),
      }),
    );

    expect(directedAction(block)).toContain('ACCEPTANCE FIRST');
    expect(directsALaunch(block)).toBe(false);
  });

  it('directs a launch only when acceptance is settled, agents are zero, and a plan is actionable', () => {
    const block = renderDelegationPostureBlock(
      counts({
        plansAwaitingAcceptance: known(0),
        planExecutionAgents: known(0),
        plansAwaitingDelegation: known(4),
      }),
    );
    expect(directsALaunch(block)).toBe(true);
  });

  it('withholds the launch when plan execution is already staffed', () => {
    const block = renderDelegationPostureBlock(
      counts({ planExecutionAgents: known(3), plansAwaitingDelegation: known(4) }),
    );
    expect(directsALaunch(block)).toBe(false);
    expect(directedAction(block)).toContain('HOLD');
  });

  it('treats an UNKNOWN actionable count as neither a launch signal nor an idle report', () => {
    const block = renderDelegationPostureBlock(
      counts({
        plansAwaitingDelegation: unreadable('plans-awaiting-delegation'),
        degradedSources: ['plans-awaiting-delegation'],
      }),
    );

    expect(directsALaunch(block)).toBe(false);
    // The opposite-direction half: an unknown must not be laundered into "idle" either.
    expect(claimsIdle(block)).toBe(false);
    expect(directedAction(block)).toContain('DO NOT SPAWN');
  });

  it('treats an UNKNOWN agent count as not-zero, so it cannot authorize a launch', () => {
    const block = renderDelegationPostureBlock(
      counts({ planExecutionAgents: unreadable('plan-execution-agents'), plansAwaitingDelegation: known(4) }),
    );
    expect(directsALaunch(block)).toBe(false);
  });

  it('treats a zero WITH an unmeasured residue as an unestablished zero, not an idle state', () => {
    // { count: 0, unmeasured: 3 } is a floor over a partly-classified population.
    // Reading it as a settled zero is the bounded-measurement-as-verdict error.
    const block = renderDelegationPostureBlock(counts({ plansAwaitingDelegation: known(0, 3) }));

    expect(claimsIdle(block)).toBe(false);
    expect(directsALaunch(block)).toBe(false);
  });

  it('refuses both a launch and an idle claim when the provider itself was unreachable', () => {
    const block = renderDelegationPostureBlock(null);

    expect(directsALaunch(block)).toBe(false);
    expect(claimsIdle(block)).toBe(false);
    expect(block).toContain('could not be read');
    // The policy is stated even on the failure path — it does not depend on the read.
    expect(block).toContain('1. ACCEPTANCE');
  });
});

describe('seed assembly and the live read', () => {
  const PLAN_INPUT = {
    title: 'A plan',
    slug: 'a-plan',
    status: 'active' as const,
    planMarkdown: '# A plan\n\n## Now\nDo the thing.',
    rationales: [],
  };

  it('places the posture block above the plan body, where it is read before any instruction', () => {
    const text = assemblePlanContextBundleText({ ...PLAN_INPUT, delegation: counts() });
    expect(text.indexOf('DELEGATION POSTURE')).toBeLessThan(text.indexOf('# A plan'));
  });

  it('omits the block entirely when no delegation read was attempted', () => {
    const withoutField = assemblePlanContextBundleText(PLAN_INPUT);
    expect(withoutField).not.toContain('DELEGATION POSTURE');

    // ...but an ATTEMPTED-and-FAILED read still renders, because a silent omission
    // would read exactly like "nothing is pending".
    const failed = assemblePlanContextBundleText({ ...PLAN_INPUT, delegation: null });
    expect(failed).toContain('DELEGATION POSTURE');
  });

  it('reads the counts at build time against the resolved workspace', async () => {
    io.read.mockResolvedValue({
      parsed: { frontmatter: { title: 'A plan' }, raw: '# A plan' },
      row: { status: 'active', harnessSlug: 'papercusp' },
      archived: false,
    });
    io.history.mockResolvedValue(undefined);

    const readDelegation = vi.fn(async () => counts({ plansAwaitingDelegation: known(9) }));
    const bundle = await buildPlanContextBundle('a-plan', { harnessSlug: 'papercusp', readDelegation });

    expect(readDelegation).toHaveBeenCalledTimes(1);
    expect(readDelegation).toHaveBeenCalledWith('ws-delegation');
    expect(bundle?.text).toMatch(/actionable plans awaiting delegation\s+: 9/);
  });

  it('degrades a throwing delegation read to the explicit measurement-failed block, not a missing one', async () => {
    io.read.mockResolvedValue({
      parsed: { frontmatter: { title: 'A plan' }, raw: '# A plan' },
      row: { status: 'active', harnessSlug: 'papercusp' },
      archived: false,
    });
    io.history.mockResolvedValue(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const bundle = await buildPlanContextBundle('a-plan', {
      harnessSlug: 'papercusp',
      readDelegation: async () => {
        throw new Error('provider down');
      },
    });

    expect(bundle?.text).toContain('DELEGATION POSTURE');
    expect(bundle?.text).toContain('could not be read');
    expect(directsALaunch(bundle!.text)).toBe(false);
    warn.mockRestore();
  });
});

// Referenced so the verbatim launch directive stays in one place and a reword of the
// renderer that breaks `directsALaunch` fails loudly here instead of silently.
describe('assertion instrument', () => {
  it('the launch directive the no-spawn assertions match on is still the one the renderer emits', () => {
    const launching = renderDelegationPostureBlock(
      counts({ plansAwaitingDelegation: known(4), planExecutionAgents: known(0) }),
    );
    expect(launching.replace(/\s+/g, ' ')).toContain(LAUNCH_DIRECTIVE.replace(/\s+/g, ' '));
  });
});
