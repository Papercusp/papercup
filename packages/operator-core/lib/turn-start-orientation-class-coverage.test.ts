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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  defineAgentObligation,
  evaluateAgentObligations,
  type AgentObligation,
  type AgentObligationFamily,
} from './agent-obligations';
import { ownerDirectiveObligations } from './agent-obligation-providers';
import {
  projectAgentTurnStartObligationBrief,
  type AgentObligationBrief,
} from './agent-obligation-reader';
import { renderOrientationLines, type OrientationState } from './turn-start-orientation';

const ORIENTATION_SOURCE = fileURLToPath(new URL('./turn-start-orientation.ts', import.meta.url));
const OBLIGATIONS_SOURCE = fileURLToPath(new URL('./agent-obligations.ts', import.meta.url));

/**
 * PROVENANCE OF THE PARSED INPUT — a diagnostic, never a failure.
 *
 * Every coverage assertion below derives its DECLARED set by reading
 * `turn-start-orientation.ts` / `agent-obligations.ts` off disk at test time.
 * That is deliberate (a hand-listed copy of a union the code owns drifts), but
 * it makes the declared set an input that can MOVE: on the shared checkout a
 * peer can be mid-edit in exactly those files.
 *
 * Measured 2026-09-22T00:45Z, while plan item P-023 was re-homing the
 * orientation classes into a shared declaration: this file reported 20 of 32
 * assertions failing, then 32 of 32 passing four minutes later, with no edit of
 * my own in between and `turn-start-orientation.ts` carrying an uncommitted
 * change throughout. A moving declared set fails the render probes with
 * ORDINARY assertion text, so that transient red is indistinguishable from the
 * real coverage regression this guard exists to catch — and the natural next
 * move is to go "fix" render paths that were never broken.
 *
 * So the failure message says which input was moving. This NEVER changes a
 * verdict: the note is EMPTY when every parsed source is committed-clean, which
 * is the only state the green-checkpoint gate ever runs in (an isolated checkout
 * at a frozen candidate). It buys nothing there and everything for an ad-hoc
 * local run on a tree ~100 agents are mutating.
 */
type ParsedSourceProvenance =
  | { status: 'clean' }
  | { status: 'uncommitted'; paths: string[] }
  | { status: 'unknown'; reason: string };

function readParsedSourceProvenance(absolutePaths: string[]): ParsedSourceProvenance {
  try {
    const stdout = execFileSync('git', ['status', '--porcelain', '--', ...absolutePaths], {
      cwd: dirname(ORIENTATION_SOURCE),
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Porcelain v1 is `XY <path>`; a diagnostic does not need rename parsing.
    const paths = stdout
      .split('\n')
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim());
    return paths.length === 0 ? { status: 'clean' } : { status: 'uncommitted', paths };
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}

const PARSED_SOURCE_PROVENANCE = readParsedSourceProvenance([ORIENTATION_SOURCE, OBLIGATIONS_SOURCE]);

/**
 * '' exactly when every parsed source is committed-clean, so a genuine failure
 * on a clean tree reads precisely as it did before this diagnostic existed.
 *
 * Takes its reading as a PARAMETER so the control test below can exercise all
 * three branches without depending on the state of the tree it runs on.
 */
function parsedSourceNote(provenance: ParsedSourceProvenance): string {
  if (provenance.status === 'clean') return '';
  if (provenance.status === 'unknown') {
    return (
      ` [parsed-source provenance UNKNOWN (${provenance.reason}) — could not establish whether the` +
      ` declared set above was read from a committed blob]`
    );
  }
  return (
    ` [⚠ the declared set above was parsed from UNCOMMITTED source: ${provenance.paths.join(', ')} —` +
    ` a peer may be mid-edit, so this failure can be a MOVING INPUT rather than a coverage` +
    ` regression. Re-run against a clean tree before believing it]`
  );
}

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
const DELIBERATELY_UNRENDERED: Record<string, string> = {
  improvementTriage:
    'P-017 (plan turn-start-memory-two-class-2026-09-21, rationale D-003): withdrawn from the ' +
    'per-turn block after rendering on every turn with zero observed action — the canonical ' +
    'signal-decay case. The field and its provider REMAIN on OrientationState so the full ' +
    'coord:orient payload still serves it on demand; only the unconditional per-turn line is ' +
    'gone. This entry is what makes that a recorded DECISION rather than a coverage gap.',
};

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
 * A POPULATING patch for every DELIBERATELY_UNRENDERED class. Without one the
 * withdrawal is only asserted in prose: the class would be excused from the
 * coverage test and nothing would notice if its line came back, or if it had
 * never actually been removed. With one, "deliberately unrendered" becomes a
 * measured claim — populate the class, and the renderer must stay silent.
 */
const UNRENDERED_PROBES: Record<string, Partial<OrientationState>> = {
  improvementTriage: {
    improvementTriage: {
      pending: 100,
      considered: 100,
      lowerBound: true,
      top: { id: 'EI-23817792409764138', title: 'live SMTP rejection contradicts cached OK', lane: 'human' },
    },
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
function assertClassReachesRenderedPrompt(
  name: string,
  probe: ClassProbe,
  note = parsedSourceNote(PARSED_SOURCE_PROVENANCE),
): void {
  const added = linesAddedBy(probe);
  if (added.length === 0) {
    throw new Error(`declared orientation class '${name}' produced no rendered line` + note);
  }
  if (!added.some((line) => probe.marker.test(line))) {
    throw new Error(
      `declared orientation class '${name}' rendered ${added.length} line(s) but none matched ${probe.marker}: ` +
        JSON.stringify(added) +
        note,
    );
  }
}

// ── Obligation-family coverage (P-006 registers `owner-directive` here) ───────
//
// `obligations` is ONE OrientationState field carrying a whole SUB-TAXONOMY:
// every provider family funnels through it. So the probe above ("populating
// `obligations` adds a line") cannot distinguish a family that renders from one
// that is built, evaluated, and then silently dropped before the prompt — the
// 0/334 failure mode, one level down. A new family is a new CLASS, and this is
// where every later item of this plan registers it.
//
// The declared set is PARSED from the `AgentObligationFamily` union for the same
// reason the orientation classes are: a hand-listed copy of a union the code
// already owns drifts the moment someone adds a member and forgets the list.

/** The declared family set, read from the union rather than restated here. */
function declaredObligationFamilies(): string[] {
  const text = readFileSync(OBLIGATIONS_SOURCE, 'utf8');
  const source = ts.createSourceFile(OBLIGATIONS_SOURCE, text, ts.ScriptTarget.Latest, true);
  let members: string[] | null = null;
  source.forEachChild((node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== 'AgentObligationFamily') return;
    if (!ts.isUnionTypeNode(node.type)) return;
    members = node.type.types
      .map((member) =>
        ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : null,
      )
      .filter((name): name is string => Boolean(name));
  });
  if (!members) throw new Error('coverage guard is broken: type AgentObligationFamily was not found');
  if ((members as string[]).length === 0) {
    throw new Error('coverage guard is broken: AgentObligationFamily parsed to zero string members');
  }
  return members;
}

const FAMILY_OBSERVED_AT = '2026-09-21T16:00:00.000Z';

/**
 * A minimal ACTIONABLE obligation of one family.
 *
 * Synthetic for families whose own providers are already covered by their own
 * suites: what this registry measures is the RENDER path per family, not the
 * provider's arithmetic. `owner-directive` below deliberately uses its REAL
 * provider instead, because that path is what P-006 adds and an end-to-end
 * probe is strictly stronger where it is cheap.
 */
function syntheticFamilyObligation(family: AgentObligationFamily, marker: string): AgentObligation {
  return defineAgentObligation({
    ruleId: `coverage-probe-${family}`,
    ruleRevision: 'coverage-probe-v1',
    family,
    title: marker,
    scope: { workspaceId: 'papercusp-workspace', ownerId: 'su-coverage-probe' },
    responsibleOwnerId: 'su-coverage-probe',
    episode: `probe:${family}`,
    status: 'due',
    authority: { kind: 'policy', sourceRef: `coverage-probe:${family}`, revision: 'coverage-probe-v1' },
    reason: `coverage probe for the ${family} family`,
    priority: 'high',
    causalRank: 0,
    applicableDemand: 1,
    sourceGeneration: 'coverage-probe',
    evidence: [],
    action: { kind: 'inspect', summary: `probe action for ${family}` },
    clearsWhen: {
      id: `coverage-probe-${family}`,
      summary: 'the probe is removed',
      evidenceKind: 'state',
      sourceRef: `coverage-probe:${family}`,
    },
  });
}

interface FamilyProbe {
  /** Obligations of exactly this family, as a real agenda would carry them. */
  build: () => AgentObligation[];
  /** The text this family is supposed to put on the rendered prompt. */
  marker: RegExp;
}

const FAMILY_PROBES: Record<string, FamilyProbe> = {
  'plan-placement': {
    build: () => [syntheticFamilyObligation('plan-placement', 'plan-placement coverage probe')],
    marker: /plan-placement coverage probe/,
  },
  'owner-report': {
    build: () => [syntheticFamilyObligation('owner-report', 'owner-report coverage probe')],
    marker: /owner-report coverage probe/,
  },
  'independent-verification': {
    build: () => [
      syntheticFamilyObligation('independent-verification', 'independent-verification coverage probe'),
    ],
    marker: /independent-verification coverage probe/,
  },
  // P-006: the real provider, on a real pending row. This asserts the whole
  // chain the item specifies — a pending directive becomes a class-B row whose
  // disposition verb and `orders:get` recovery pointer reach the prompt.
  'owner-directive': {
    build: () =>
      ownerDirectiveObligations({
        workspaceId: 'papercusp-workspace',
        ownerId: 'su-coverage-probe',
        observedAt: FAMILY_OBSERVED_AT,
        sourceGeneration: 'coverage-probe',
        read: {
          status: 'known',
          value: [
            {
              id: 17,
              state: 'pending',
              excerpt: 'Implement owner-directive capture as HYBRID',
              recordedAt: '2026-09-21T15:27:44.000Z',
              recordedBy: 'su-c03852cb',
              capturedByHook: true,
            },
          ],
        },
      }),
    marker: /owner directive .*#17|#17/,
  },
};

function obligationBriefFor(obligations: AgentObligation[]): AgentObligationBrief {
  return projectAgentTurnStartObligationBrief(evaluateAgentObligations(obligations, FAMILY_OBSERVED_AT));
}

function linesAddedByFamily(probe: FamilyProbe): string[] {
  const baseline = renderOrientationLines(BASELINE);
  const populated = renderOrientationLines({ ...BASELINE, obligations: obligationBriefFor(probe.build()) });
  return populated.filter((line) => !baseline.includes(line));
}

/** THROWS when a declared obligation family does not reach the rendered prompt. */
function assertFamilyReachesRenderedPrompt(
  name: string,
  probe: FamilyProbe,
  note = parsedSourceNote(PARSED_SOURCE_PROVENANCE),
): void {
  const added = linesAddedByFamily(probe);
  if (added.length === 0) {
    throw new Error(`declared obligation family '${name}' produced no rendered line` + note);
  }
  if (!added.some((line) => probe.marker.test(line))) {
    throw new Error(
      `declared obligation family '${name}' rendered ${added.length} line(s) but none matched ${probe.marker}: ` +
        JSON.stringify(added) +
        note,
    );
  }
}

/**
 * The permanent CONTROL for the family registry: a family whose only obligation
 * is `not-applicable` is never actionable, so it never enters `agenda.primary`
 * and the turn-start projection has nothing to render. If the helper above is
 * ever weakened into something that cannot fail, this goes red.
 */
const FAMILY_CONTROL_PROBE: FamilyProbe = {
  build: () => [
    defineAgentObligation({
      ruleId: 'coverage-probe-control',
      ruleRevision: 'coverage-probe-v1',
      family: 'owner-directive',
      title: 'control-family-that-is-never-rendered',
      scope: { workspaceId: 'papercusp-workspace', ownerId: 'su-coverage-probe' },
      responsibleOwnerId: 'su-coverage-probe',
      episode: 'probe:control',
      status: 'not-applicable',
      authority: { kind: 'policy', sourceRef: 'coverage-probe:control', revision: 'coverage-probe-v1' },
      reason: 'the permanent non-actionable control',
      priority: 'low',
      causalRank: 0,
      applicableDemand: 0,
      sourceGeneration: 'coverage-probe',
      evidence: [],
      clearsWhen: {
        id: 'coverage-probe-control',
        summary: 'the probe is removed',
        evidenceKind: 'state',
        sourceRef: 'coverage-probe:control',
      },
    }),
  ],
  marker: /control-family-that-is-never-rendered/,
};

describe('turn-start orientation obligation-family coverage', () => {
  const families = declaredObligationFamilies();

  it('reads a non-trivial declared family set from AgentObligationFamily (instrument calibration)', () => {
    expect(families.length).toBeGreaterThanOrEqual(4);
    expect(families).toContain('owner-directive');
  });

  it('has a probe for every declared obligation family', () => {
    const unregistered = families.filter((name) => !FAMILY_PROBES[name]);
    expect(
      unregistered,
      'a new AgentObligationFamily must register a probe in FAMILY_PROBES, or nothing notices when it never renders',
    ).toEqual([]);
  });

  it('has no probe for a family AgentObligationFamily no longer declares', () => {
    const declaredSet = new Set(families);
    const orphaned = Object.keys(FAMILY_PROBES).filter((name) => !declaredSet.has(name));
    expect(orphaned, 'a probe outlived its family — delete it rather than testing a family nothing emits').toEqual([]);
  });

  it.each(Object.keys(FAMILY_PROBES))('declared obligation family %s reaches a rendered prompt', (name) => {
    expect(() => assertFamilyReachesRenderedPrompt(name, FAMILY_PROBES[name]!)).not.toThrow();
  });

  it('fails when a declared family never renders (permanent falsifiability control)', () => {
    expect(() => assertFamilyReachesRenderedPrompt('__control', FAMILY_CONTROL_PROBE)).toThrow(
      /produced no rendered line/,
    );
  });

  it('carries the owner-directive disposition verb and recovery pointer into the agenda', () => {
    // The class-B row contract P-006 specifies: id, verbatim excerpt, the
    // disposition verb, and the `orders:get` recovery pointer. The turn-start
    // sink is budgeted to the ACTION line, so the pointer is asserted on the
    // agenda entry the recovery reader retains, not on the 400-char slice.
    const [pending] = FAMILY_PROBES['owner-directive']!.build();
    expect(pending!.status).toBe('due');
    expect(pending!.action?.tool).toBe('orders:resolve-pending');
    expect(pending!.action?.targetRef).toBe('orders:get #17');
    expect(pending!.reason).toContain('Implement owner-directive capture as HYBRID');
  });
});

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

  it('has a populating patch for every deliberately-unrendered class', () => {
    // Calibration: without a patch, the assertion below would trivially pass on
    // an empty state and "deliberately unrendered" would measure nothing.
    const unmeasured = Object.keys(DELIBERATELY_UNRENDERED).filter((name) => !UNRENDERED_PROBES[name]);
    expect(
      unmeasured,
      'a DELIBERATELY_UNRENDERED entry needs a patch in UNRENDERED_PROBES, or its withdrawal is never measured',
    ).toEqual([]);
  });

  it.each(Object.keys(DELIBERATELY_UNRENDERED))(
    'deliberately-unrendered class %s adds no line to the per-turn block',
    (name) => {
      const added = linesAddedBy({ patch: UNRENDERED_PROBES[name]!, marker: /(?!)/ });
      expect(
        added,
        `'${name}' is recorded as deliberately unrendered, but populating it still produced a line`,
      ).toEqual([]);
    },
  );

  it.each(Object.keys(CLASS_PROBES))('declared class %s reaches a rendered prompt', (name) => {
    expect(() => assertClassReachesRenderedPrompt(name, CLASS_PROBES[name]!)).not.toThrow();
  });

  it('fails when a declared class never renders (permanent falsifiability control)', () => {
    expect(() => assertClassReachesRenderedPrompt(CONTROL_CLASS, CONTROL_PROBE)).toThrow(
      /produced no rendered line/,
    );
  });

  it('labels a failure with its parsed-source provenance, and stays silent when clean (permanent control)', () => {
    // All three branches, driven by synthetic readings so this control cannot go
    // vacuous on a clean tree (or on a dirty one). Weaken `parsedSourceNote`
    // into something that always returns '' and three of these fail.
    expect(parsedSourceNote({ status: 'clean' })).toBe('');
    const dirty = parsedSourceNote({ status: 'uncommitted', paths: ['lib/turn-start-orientation.ts'] });
    expect(dirty).toContain('UNCOMMITTED source');
    expect(dirty).toContain('lib/turn-start-orientation.ts');
    expect(parsedSourceNote({ status: 'unknown', reason: 'git missing' })).toContain('UNKNOWN');

    // Calibration: the LIVE reading resolves to one of the three and never throws,
    // so the diagnostic cannot itself become the reason this file goes red.
    expect(['clean', 'uncommitted', 'unknown']).toContain(PARSED_SOURCE_PROVENANCE.status);
  });

  it('carries the parsed-source note into the message of a real coverage failure', () => {
    // Reuses the permanent control probe, so the wiring under test is the same
    // path an actual regression takes — not a parallel message built for a test.
    const note = parsedSourceNote({ status: 'uncommitted', paths: ['lib/agent-obligations.ts'] });
    expect(() => assertClassReachesRenderedPrompt(CONTROL_CLASS, CONTROL_PROBE, note)).toThrow(
      /parsed from UNCOMMITTED source: lib\/agent-obligations\.ts/,
    );
    expect(() => assertFamilyReachesRenderedPrompt('control', FAMILY_CONTROL_PROBE, note)).toThrow(
      /parsed from UNCOMMITTED source: lib\/agent-obligations\.ts/,
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
