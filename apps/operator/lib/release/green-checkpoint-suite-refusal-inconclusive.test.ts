/**
 * WI-1761602 — a suite that REFUSED to run must render INCONCLUSIVE, never a code RED.
 *
 * THE INCIDENT (2026-08-31, candidate 3c15ff5b496c): the affected-tests runner spent its whole
 * 45-minute shared-admission budget queued behind another test process, refused, and emitted
 * `status=refused reason=admission-starved tasks=130 failed=0 … undeterminedTasks=130`. Zero
 * test files executed (`grep -c 'Test Files'` = 0). The gate nonetheless published
 * `{"green":false,"reason":"not-green"}`, incremented consecutiveReds, and DISPATCHED A RELEASE
 * FIXER against a red with an empty failing-file signature — a fixer sent to repair nothing.
 *
 * The mechanism to prevent this ALREADY EXISTED: `runGreen`'s result carries an optional
 * `infraFault`, whose presence makes `runGreenCheckpoint` render `green: null`
 * (reason `infra-inconclusive`) and skip the entire red apparatus — re-triage, auto-refire,
 * prefix salvage, fixer dispatch — "because every one of those acts on failing files this run
 * cannot vouch for". `classifyInfraFault` simply had no case for a refusal. This suite covers
 * the case that was added, and — via the permanent wrong-controls below — the specificity that
 * makes it safe.
 *
 * ⚠ SELF-REFERENCE NOTE: these fixtures contain the very marker the subject matches, and this
 * file's own output can end up inside a gate run's captured output when it fails. That is safe
 * ONLY because the matcher is anchored at LINE START on the bare marker: a Vitest assertion
 * diff renders such a line prefixed (`+ `/`- `) and quoted, which cannot match. The last test
 * in this file pins that property so it can never be loosened by accident.
 */
import { describe, expect, it } from "vitest";
import { classifyInfraFault, parseSuiteRefusal } from "./green-checkpoint";

/** The REAL terminal line from the WI-1761602 incident log, byte-for-byte. */
const ADMISSION_STARVED = [
  'AFFECTED_TESTS_REFUSAL kind=admission-starved detail=Timed out after 2700000ms waiting for fs-mutex "papercusp-test-process-admission"',
  "AFFECTED_TESTS_RESULT status=refused reason=admission-starved tasks=130 failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=130",
  "NOT MEASURED — this run spent its whole shared-admission budget queued behind another test process and never got to run its tasks. Nothing here is a test verdict.",
].join("\n");

/** The insufficient-deadline refusal path (affected-tests.mjs :5634). */
const DEADLINE_INSUFFICIENT = [
  "AFFECTED_TESTS_REFUSAL kind=deadline-insufficient detail=TASK_DEADLINE_REFUSAL",
  "AFFECTED_TESTS_RESULT status=refused reason=deadline-insufficient tasks=58 failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=58",
].join("\n");

/**
 * The pre-launch cgroup/pids-ceiling path (affected-tests.mjs :665). Deliberately included
 * because its field ORDER differs — `reason=` trails the counters instead of leading them, and
 * `failed=n/a` replaces `failed=0` — which is exactly what a single positional pattern would
 * miss while looking like it worked.
 */
const TASK_BUDGET_REFUSAL =
  "AFFECTED_TESTS_RESULT status=refused tasks=0 failed=n/a quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=0 reason=TASK_BUDGET_REFUSAL pids.max=0 below one task envelope";

/**
 * ⭐ THE LOAD-BEARING NEGATIVE: a genuine code RED that also happens to contain the word
 * "refused" in a test name. If the classifier swallows this, the gate stops reporting real
 * breakage — a far worse failure than the bug being fixed.
 */
const REAL_RED_MENTIONING_REFUSED = [
  "FAIL libs/generic/template-kit/src/composition.test.ts > union-of-checks",
  " ✓ admission is refused when the ceiling is zero",
  " × refused forks are counted",
  "AFFECTED_TESTS_FAILING_FILES libs/generic/template-kit/src/composition.test.ts",
  "AFFECTED_TESTS_RESULT status=failed tasks=130 failed=3 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=0",
].join("\n");

/** A clean pass — nothing to withdraw. */
const REAL_GREEN =
  "AFFECTED_TESTS_RESULT status=passed tasks=130 failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=0";

/**
 * A malformed/contradictory marker: it claims a refusal while ALSO reporting measured
 * failures. Those failures were measured, so the verdict must stand as a red.
 */
const CONTRADICTORY_REFUSAL =
  "AFFECTED_TESTS_RESULT status=refused reason=admission-starved tasks=130 failed=3 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=130";

// ---------------------------------------------------------------------------
// PERMANENT WRONG-CONTROLS — deliberately-wrong implementations kept in this file forever.
// They are never imported by production code. Their job is to prove this suite can FAIL:
// each is the plausible shortcut a future edit might collapse the real predicate into, and
// each test below shows the control giving the WRONG answer where the real subject is right.
// Without them, every assertion here would also pass against a trivially-broken predicate.
// ---------------------------------------------------------------------------

/** WRONG #1 — the prose-sniffing shortcut: "the log says refused, so it refused". */
const naiveWordDetector = (output: string): boolean =>
  output.includes("refused");

/** WRONG #2 — the marker without its invariant: trusts `status=refused` on its own. */
const laxStatusDetector = (output: string): boolean =>
  /status=refused/.test(output);

describe("parseSuiteRefusal — the machine marker, not the prose", () => {
  it("CALIBRATION: classifies the real admission-starved incident line", () => {
    // If this fails, the instrument is broken and every negative below is meaningless.
    expect(parseSuiteRefusal(ADMISSION_STARVED)).toEqual({
      reason: "admission-starved",
      tasks: 130,
      undeterminedTasks: 130,
    });
  });

  it("classifies the insufficient-deadline refusal", () => {
    expect(parseSuiteRefusal(DEADLINE_INSUFFICIENT)).toMatchObject({
      reason: "deadline-insufficient",
      tasks: 58,
      undeterminedTasks: 58,
    });
  });

  it("classifies the pre-launch ceiling refusal, whose field order differs", () => {
    expect(parseSuiteRefusal(TASK_BUDGET_REFUSAL)).toEqual({
      reason: "TASK_BUDGET_REFUSAL",
      tasks: 0,
      undeterminedTasks: 0,
    });
  });

  it("leaves a REAL red alone even when its output says 'refused'", () => {
    expect(parseSuiteRefusal(REAL_RED_MENTIONING_REFUSED)).toBeNull();
    // The control that would have swallowed it. This is the whole reason the subject
    // reads the marker's fields instead of scanning for a word.
    expect(naiveWordDetector(REAL_RED_MENTIONING_REFUSED)).toBe(true);
  });

  it("leaves a green run alone", () => {
    expect(parseSuiteRefusal(REAL_GREEN)).toBeNull();
  });

  it("refuses to withdraw a verdict that reported MEASURED failures", () => {
    expect(parseSuiteRefusal(CONTRADICTORY_REFUSAL)).toBeNull();
    // The control that ignores the invariant would have withdrawn it.
    expect(laxStatusDetector(CONTRADICTORY_REFUSAL)).toBe(true);
  });

  it("ignores a marker that cannot show its counters", () => {
    expect(parseSuiteRefusal("AFFECTED_TESTS_RESULT status=refused")).toBeNull();
  });
});

describe("classifyInfraFault — a refusal is an INFRA fault, so the gate renders no verdict", () => {
  it("returns a suite-refused classification carrying the runner's own reason", () => {
    const fault = classifyInfraFault(ADMISSION_STARVED);
    expect(fault).toMatchObject({
      kind: "suite-refused",
      refusalReason: "admission-starved",
      tasks: 130,
      undeterminedTasks: 130,
    });
    // The note is what a human triager reads off the verdict, so it must say plainly
    // that this is not a statement about the code.
    expect(fault?.note).toMatch(/NOTHING HERE IS A TEST VERDICT/);
  });

  it("does NOT classify a real red as an infra fault", () => {
    expect(classifyInfraFault(REAL_RED_MENTIONING_REFUSED)).toBeNull();
  });

  it("does NOT classify a green run as an infra fault", () => {
    expect(classifyInfraFault(REAL_GREEN)).toBeNull();
  });
});

describe("the marker is anchored at line start", () => {
  it("does not match a QUOTED or diff-prefixed occurrence of its own fixture", () => {
    // This is the shape this very file's fixtures take inside a Vitest assertion diff, and
    // inside any JSON-quoted log payload. If the anchoring is ever loosened to a bare
    // `includes`, this test fails and the self-reference hazard is caught here rather than
    // by a gate that mysteriously stops reporting reds.
    const diffRendered = [
      '+   "AFFECTED_TESTS_RESULT status=refused reason=admission-starved tasks=130 failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=130"',
      '-   "AFFECTED_TESTS_RESULT status=refused reason=admission-starved tasks=130 failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=130"',
    ].join("\n");
    expect(parseSuiteRefusal(diffRendered)).toBeNull();
    // …while the same marker, unquoted at line start, still classifies.
    expect(laxStatusDetector(diffRendered)).toBe(true);
  });
});
