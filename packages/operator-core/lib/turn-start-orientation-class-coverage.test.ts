/**
 * turn-start-orientation-class-coverage.test.ts — P-001 of plan
 * `turn-start-memory-two-class-2026-09-21`: the COVERAGE GUARD.
 *
 * WHAT THIS EXISTS TO CATCH. The measured hole (0 renders across 334 sampled
 * turns) was not a bug in any one class — it was a class that was DECLARED on
 * `OrientationState`, populated by a resolver, and then never reached a rendered
 * prompt. Nothing failed. The state had the field, the read worked, and the line
 * simply never appeared, so the only way to notice was a periodic human audit of
 * real turns.
 *
 * This turns that audit into a BUILD-TIME INVARIANT: for every declared
 * orientation class, populating it alone on an otherwise-baseline state must add
 * at least one line to `renderOrientationLines`.
 *
 * WHY THE DECLARED SET IS PARSED, NOT LISTED (derived-truth ladder, rung 1).
 * A hand-maintained list of classes is a second copy of a truth
 * `OrientationState` already owns, and it WILL drift — the next agent adds a
 * field, forgets the list, and the guard reports full coverage of a set that no
 * longer describes the interface. So the declared set is read from the interface
 * itself with the TypeScript parser. Add a field to `OrientationState` and this
 * file goes RED until that field is either given a probe below or explicitly
 * excluded with a reason. A dropped class is then a DECISION, not a gap.
 *
 * REGISTERING A NEW CLASS (every later item of this plan does this): add one
 * entry to `CLASS_PROBES` whose `patch` populates only that field and whose
 * `marker` matches the line it is supposed to produce.
 *
 * FALSIFIABILITY. `it('fails when a declared class never renders')` is a
 * PERMANENT control: a class declared but deliberately left unrendered must make
 * `assertClassReachesRenderedPrompt` throw. If someone ever weakens that helper
 * into something that cannot fail, that test goes red — which is the only reason
 * the green of every other test here means anything.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { AgentObligationBrief } from './agent-obligation-reader';
import { renderOrientationLines, type OrientationState } from './turn-start-orientation';

const ORIENTATION_SOURCE = fileURLToPath(new URL('./turn-start-orientation.ts', import.meta.url));

/**
 * The DECLARED set, read from the interface rather than restated here.
 *
 * Throws instead of returning `[]` when it cannot find the interface or its
 * members: an empty declared set would make every coverage assertion below pass
 * vacuously, which is the precise failure this guard exists to prevent.
 */
function declaredOrientationClasses(): string[] {
  const text = readFileSync(ORIENTATION_SOURCE, 'utf8');
  const source = ts.createSourceFile(ORIENTATION_SOURCE, text, ts.ScriptTarget.Latest, true);
  let members: string[] | null = null;
  source.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'OrientationState') return;
    members = node.members
      .filter(ts.isPropertySignature)
      .map((member) => (ts.isIdentifier(member.name) ? member.name.text : null))
      .filter((name): name is string => Boolean(name));
  });
  if (!members) throw new Error('coverage guard is broken: interface OrientationState was not found');
  if ((members as string[]).length === 0) {
    throw new Error('coverage guard is broken: OrientationState parsed to zero property signatures');
  }
  return members;
}

/**
 * Classes that are deliberately NOT expected to reach a rendered prompt.
 *
 * Empty today, and that is the point: removing a class from the per-turn block
 * (plan P-017 does exactly that to the improvement-triage line) means moving its
 * name HERE with a reason, so the drop is recorded rather than silently
 * indistinguishable from the regression this file detects.
 */
const DELIBERATELY_UNRENDERED: Record<string, string> = {};

interface ClassProbe {
  /** Populates ONLY this class, over the baseline below. */
  patch: Partial<OrientationState>;
  /** The line this class is supposed to put on the rendered prompt. */
  marker: RegExp;
}

/**
 * A live-shaped, deliberately QUIET session: every class empty/false/null, so
 * any line a probe adds is attributable to the class that probe populated.
 * `loopArmed: true` because an armed loop is the healthy live shape — the
 * `loopArmed` probe flips it OFF, which is the direction that renders a warning.
 */
const BASELINE: OrientationState = {
  held: [],
  unansweredDirected: 0,
  unansweredStale: 0,
  inboxRecent: [],
  openAsks: null,
  announcedGates: [],
  loopArmed: true,
  loopFireWithheld: false,
  improvementTriage: null,
  executableFrontier: null,
  neverDropFacts: [],
  toolSurface: null,
  carryBlindWindow: null,
};

const OBLIGATION_BRIEF = {
  schemaVersion: 'agent-obligation-agenda-v1',
  evaluatedAt: '2026-09-21T16:00:00.000Z',
  sourceGeneration: '12',
  evaluations: [],
  primary: null,
  detailRef: "coord:orient { afterCompaction: true }",
  projection: {
    text: '- obligation: settle the pending owner directive',
    receipt: { entriesOmitted: 0 },
  },
} as unknown as AgentObligationBrief;

const CLASS_PROBES: Record<string, ClassProbe> = {
  held: {
    patch: { held: [{ id: 'WI-10002196', status: 'wip', checkpoint: 'coverage guard in progress' }] },
    marker: /holding: WI-10002196/,
  },
  ownerDirectives: {
    patch: { ownerDirectives: [{ id: 17, captureStatus: 'pending', verbatimText: 'implement hybrid capture' }] },
    marker: /owner directive #17/,
  },
  historyUpdates: {
    patch: { historyUpdates: [{ workItemId: 'WI-10002196', harness: 'papercusp', count: 2, newestPostId: 9 }] },
    marker: /post-claim history update/,
  },
  effortUpdates: {
    patch: { effortUpdates: [{ level: 'plan', ref: 'turn-start-memory-two-class-2026-09-21', count: 1, newestPostId: 4 }] },
    marker: /post-claim plan\/goal revision/,
  },
  unansweredDirected: {
    patch: { unansweredDirected: 3 },
    marker: /directed msg\(s\) awaiting YOUR reply/,
  },
  unansweredStale: {
    patch: { unansweredStale: 2 },
    marker: /from ENDED senders/,
  },
  inboxRecent: {
    patch: { inboxRecent: [{ msgId: 'm-1', from: 'su-091ad703', summary: 'identity wedge answered in-thread' }] },
    marker: /^- inbox /,
  },
  openAsks: {
    patch: { openAsks: { count: 2, oldestAgeMs: 3_600_000, oldestTo: 'su-bb42b259' } },
    marker: /open ask\(s\) sent/,
  },
  announcedGates: {
    patch: { announcedGates: [{ event: 'fleet:demo:phase1-green' }] },
    marker: /announced gates:/,
  },
  loopArmed: {
    patch: { loopArmed: false },
    marker: /engine loop: not armed/,
  },
  loopFireWithheld: {
    patch: { loopFireWithheld: true },
    marker: /withheld for interactive turn/,
  },
  improvementTriage: {
    patch: {
      improvementTriage: {
        pending: 100,
        considered: 100,
        lowerBound: true,
        top: { id: 'EI-23817792409764138', title: 'live SMTP rejection contradicts cached OK', lane: 'human' },
      },
    },
    marker: /improvement triage:/,
  },
  executableFrontier: {
    patch: { executableFrontier: { planSlug: 'turn-start-memory-two-class-2026-09-21', executableWidth: 3 } },
    marker: /frontier: 3 executable/,
  },
  obligations: {
    patch: { obligations: OBLIGATION_BRIEF },
    marker: /obligation/,
  },
  neverDropFacts: {
    patch: { neverDropFacts: ['dead-end:gate-lastfiredat-not-evidence'] },
    marker: /never-drop facts:/,
  },
  toolSurface: {
    patch: { toolSurface: { hookCalls: 24, windowMinutes: 31 } },
    marker: /MCP TOOLS NOT REGISTERED/,
  },
  carryBlindWindow: {
    patch: {
      carryBlindWindow: {
        snapshotAtMs: Date.parse('2026-09-21T16:10:38.858Z'),
        cutAtMs: Date.parse('2026-09-21T16:11:01.000Z'),
        windowMs: 22_142,
        callsAfter: 4,
        lastCallAtMs: Date.parse('2026-09-21T16:10:59.000Z'),
        lastToolName: 'loop:checkpoint',
      },
    },
    marker: /carry blind window:/,
  },
};

/**
 * The permanent CONTROL: a class that IS declared to this guard but that the
 * renderer has no path for. It must make the assertion below throw.
 */
const CONTROL_CLASS = '__control_declared_but_unrendered';
const CONTROL_PROBE: ClassProbe = {
  // Not a member of OrientationState, so renderOrientationLines cannot read it —
  // which is exactly the shape of a class that was declared and never wired.
  patch: { [CONTROL_CLASS]: ['present but unrendered'] } as unknown as Partial<OrientationState>,
  marker: /control-marker-that-is-never-rendered/,
};

function linesAddedBy(probe: ClassProbe): string[] {
  const baseline = renderOrientationLines(BASELINE);
  const populated = renderOrientationLines({ ...BASELINE, ...probe.patch });
  return populated.filter((line) => !baseline.includes(line));
}

/** THROWS when a declared class does not reach the rendered prompt. */
function assertClassReachesRenderedPrompt(name: string, probe: ClassProbe): void {
  const added = linesAddedBy(probe);
  if (added.length === 0) {
    throw new Error(`declared orientation class '${name}' produced no rendered line`);
  }
  if (!added.some((line) => probe.marker.test(line))) {
    throw new Error(
      `declared orientation class '${name}' rendered ${added.length} line(s) but none matched ${probe.marker}: ` +
        JSON.stringify(added),
    );
  }
}

describe('turn-start orientation class coverage', () => {
  const declared = declaredOrientationClasses();

  it('reads a non-trivial declared set from OrientationState (instrument calibration)', () => {
    // Without this, a parser that silently returns a short list would make every
    // assertion below pass while measuring almost nothing.
    expect(declared.length).toBeGreaterThanOrEqual(17);
    expect(declared).toContain('held');
    expect(declared).toContain('neverDropFacts');
    expect(declared).toContain('obligations');
  });

  it('has a probe or an explicit exclusion for every declared class', () => {
    const covered = new Set([...Object.keys(CLASS_PROBES), ...Object.keys(DELIBERATELY_UNRENDERED)]);
    const unregistered = declared.filter((name) => !covered.has(name));
    expect(
      unregistered,
      'a new OrientationState field must get a probe in CLASS_PROBES, or a reason in DELIBERATELY_UNRENDERED',
    ).toEqual([]);
  });

  it('has no probe for a class that OrientationState no longer declares', () => {
    const declaredSet = new Set(declared);
    const orphaned = Object.keys(CLASS_PROBES).filter((name) => !declaredSet.has(name));
    expect(orphaned, 'a probe outlived its class — delete it rather than testing a field nothing populates').toEqual([]);
  });

  it.each(Object.keys(CLASS_PROBES))('declared class %s reaches a rendered prompt', (name) => {
    expect(() => assertClassReachesRenderedPrompt(name, CLASS_PROBES[name]!)).not.toThrow();
  });

  it('fails when a declared class never renders (permanent falsifiability control)', () => {
    expect(() => assertClassReachesRenderedPrompt(CONTROL_CLASS, CONTROL_PROBE)).toThrow(
      /produced no rendered line/,
    );
  });

  it('fails when a declared class renders something other than its own line', () => {
    // The second half of the assertion: reaching SOME line is not enough, or a
    // class could be credited for a neighbour's output.
    expect(() =>
      assertClassReachesRenderedPrompt('held', { patch: CLASS_PROBES.held!.patch, marker: /never-drop facts:/ }),
    ).toThrow(/none matched/);
  });
});
