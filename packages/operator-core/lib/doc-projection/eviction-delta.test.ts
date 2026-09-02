import { describe, expect, it } from "vitest";
import {
  applyEditInMemory,
  evictionDelta,
  identityProblemDelta,
  renderImpact,
  type ClientImpact,
  type IdentityProblem,
  type ProjectClientFn,
  type ProjectionRow,
} from "./eviction-delta";
// The REAL rule, not a restatement of it — these tests are worthless if they pin a
// second copy of the heuristic instead of the one the projector actually refuses on.
// ⚠ ONE LINE, deliberately. `@ts-expect-error` suppresses the NEXT LINE only, and on a
// multi-line import the TS7016 lands on the module-specifier line at the bottom — so the
// directive goes unused (TS2578) AND the real error still fires (EI-19389216343173748).
// @ts-expect-error — .mjs script, no type declarations by design (it is a scripts/ tool).
import { docPartIdentityProblems, FULL_PRECOMPRESSION_MARKER } from "../../../../scripts/project-doc-parts.mjs";

const row = (
  part_key: string,
  body: string,
  project_rank = 100,
  ordinal = 1,
): ProjectionRow => ({
  part_key,
  kind: "prose",
  body,
  ordinal,
  client_scope: ["all"],
  target_section: null,
  project_rank,
});

const CLIENTS = [{ client: "claude", file: "CLAUDE.md", reader: "Claude Code" }];

/**
 * A faithful-enough stand-in for `projectClient`: compose every part, and while the
 * composition exceeds the budget drop parts in the real cut order (project_rank DESC —
 * the highest rank is dropped first). This mirrors the property the delta depends on,
 * without a database or the real 57k-char corpus.
 */
const fakeProjectClient: ProjectClientFn = (allParts, { budget, client }) => {
  // Scope-filter FIRST, exactly as the real projector's `partTargetsClient` does. Without
  // it every part would look like it reaches every file, and the per-client half of
  // `deprojected` would pass here while being wrong against the real projector.
  const parts = allParts.filter(
    (p) => p.client_scope.includes("all") || p.client_scope.includes(client),
  );
  const candidates = [...parts].sort(
    (a, b) => b.project_rank - a.project_rank || a.part_key.localeCompare(b.part_key),
  );
  const dropped: ProjectionRow[] = [];
  const compose = (): string =>
    parts
      .filter((p) => !dropped.some((d) => d.part_key === p.part_key))
      .map((p) => p.body)
      .join("");
  let text = compose();
  for (const victim of candidates) {
    if (text.length <= budget) break;
    dropped.push(victim);
    text = compose();
  }
  // `kept` is what the real projector returns and what `deprojected` is decided from:
  // the parts that actually REACH this file. Modelling it as "every candidate minus the
  // cut ones" is the same relation the real projectClient holds.
  const kept = parts.filter(
    (p) => !dropped.some((d) => d.part_key === p.part_key),
  );
  return { text, dropped, kept };
};

const impactFor = (
  before: ProjectionRow[],
  after: ProjectionRow[],
  budget: number,
  projectClient: ProjectClientFn = fakeProjectClient,
  partKey = "edited",
): ClientImpact =>
  evictionDelta({
    before,
    after,
    clients: CLIENTS,
    docId: "claude-md",
    budget,
    projectClient,
    partKey,
  })[0];

describe("evictionDelta", () => {
  it("names the parts an edit newly pushes out, and nothing that was already cut", () => {
    // `stale` is over budget in BOTH projections: it was already cut, so it is not an
    // eviction caused by this edit. Only `victim` is.
    // Ranks matter: the cut order drops the HIGHEST project_rank first, so `edited` is
    // ranked low enough to survive and `stale` high enough to be gone in both passes.
    const before = [
      row("edited", "a".repeat(10), 10),
      row("victim", "b".repeat(10), 500),
      row("stale", "c".repeat(10), 900),
    ];
    const after = applyEditInMemory(
      before,
      "edited",
      row("edited", "a".repeat(20)),
    );

    const impact = impactFor(before, after, 25);

    expect(impact.evicted).toEqual(["victim"]);
    expect(impact.restored).toEqual([]);
    // The already-cut part must never be reported as this edit's doing.
    expect(impact.evicted).not.toContain("stale");
  });

  it("HEADROOM ALONE CANNOT DETECT AN EVICTION — the list is the load-bearing output", () => {
    // Dropping a part frees more space than the edit consumed, so headroom after an
    // eviction can hold steady or even RISE. An author (or a future guard) watching only
    // the headroom number would read this edit as harmless while it silently removed a
    // rule from every agent's context. This is why the gate keys on `evicted`, never on
    // the sign of the headroom delta.
    const before = [
      row("edited", "a".repeat(10), 10),
      row("victim", "b".repeat(10), 500),
      row("stale", "c".repeat(10), 900),
    ];
    const after = applyEditInMemory(
      before,
      "edited",
      row("edited", "a".repeat(20), 10),
    );

    const impact = impactFor(before, after, 25);

    expect(impact.evicted).toEqual(["victim"]);
    expect(impact.headroomAfter).toBeGreaterThanOrEqual(impact.headroomBefore);
  });

  it("reports the reverse direction: a shrinking edit RESTORES parts", () => {
    const before = [
      row("edited", "a".repeat(20), 10),
      row("comeback", "b".repeat(10), 900),
    ];
    const after = applyEditInMemory(
      before,
      "edited",
      row("edited", "a".repeat(5), 10),
    );

    const impact = impactFor(before, after, 25);

    expect(impact.restored).toEqual(["comeback"]);
    expect(impact.evicted).toEqual([]);
    expect(impact.headroomAfter).toBeGreaterThan(impact.headroomBefore);
  });

  it("reports no cut-set change for an edit that fits", () => {
    const before = [row("edited", "a".repeat(10))];
    const after = applyEditInMemory(
      before,
      "edited",
      row("edited", "a".repeat(11)),
    );

    const impact = impactFor(before, after, 1_000);

    expect(impact.evicted).toEqual([]);
    expect(impact.restored).toEqual([]);
    expect(impact.headroomBefore - impact.headroomAfter).toBe(1);
  });

  it("captures a projector refusal instead of propagating it", () => {
    const exploding: ProjectClientFn = () => {
      throw new Error("budget too small to be honoured");
    };
    const rows = [row("edited", "a")];

    const impact = impactFor(rows, rows, 10, exploding);

    expect(impact.failed).toMatch(/budget too small/);
    expect(impact.evicted).toEqual([]);
    expect(Number.isNaN(impact.headroomAfter)).toBe(true);
  });

  it("CONTROL: a delta computed as the absolute cut list misreports the already-cut part", () => {
    // This is the pre-fix behaviour the work-item describes, kept as a live control. If
    // the real implementation ever regresses to reporting the absolute cut set, the
    // first test above fails while this one still passes — which is what makes that
    // test's assertion meaningful rather than merely satisfied.
    // Ranks matter: the cut order drops the HIGHEST project_rank first, so `edited` is
    // ranked low enough to survive and `stale` high enough to be gone in both passes.
    const before = [
      row("edited", "a".repeat(10), 10),
      row("victim", "b".repeat(10), 500),
      row("stale", "c".repeat(10), 900),
    ];
    const after = applyEditInMemory(
      before,
      "edited",
      row("edited", "a".repeat(20)),
    );
    const absoluteCutList = fakeProjectClient(after, {
      client: "claude",
      docId: "claude-md",
      file: "CLAUDE.md",
      reader: "Claude Code",
      budget: 25,
    }).dropped.map((p) => p.part_key);

    expect(absoluteCutList).toContain("stale");
    expect(impactFor(before, after, 25).evicted).not.toContain("stale");
  });
});

describe("deprojected — the edit removes the edited part from the projection", () => {
  it("REPORTS A SCOPE-EMPTYING EDIT THAT `evicted` STRUCTURALLY CANNOT SEE", () => {
    // The bug (EI-22179257919368370). Emptying client_scope takes the part out of the
    // candidate set, so the projector never considers it and never CUTS it — it appears
    // in no `dropped` list, and `evicted` is derived from `dropped`. Assert the whole
    // misleading shape, not just the new field: without `deprojected` an author sees an
    // empty eviction list, a RISING headroom, and a part that silently left the file.
    const before = [row("edited", "a".repeat(10), 10)];
    const after = applyEditInMemory(before, "edited", null);

    const impact = impactFor(before, after, 1_000);

    expect(impact.deprojected).toBe(true);
    expect(impact.evicted).toEqual([]);
    expect(impact.headroomAfter).toBeGreaterThan(impact.headroomBefore);
  });

  it("does NOT fire for an ordinary budget eviction of the edited part", () => {
    // Still a candidate, merely cut — that is already reported by `evicted` with its
    // "<- the part you are editing" annotation. Reporting it twice, under a name that
    // says the scope was emptied, would make the new signal untrustworthy.
    const before = [row("edited", "a".repeat(5), 900), row("other", "b".repeat(10), 10)];
    const after = applyEditInMemory(
      before,
      "edited",
      row("edited", "a".repeat(40), 900),
    );

    const impact = impactFor(before, after, 25);

    expect(impact.evicted).toContain("edited");
    expect(impact.deprojected).toBe(false);
  });

  it("does NOT fire for a part that was never reaching this file anyway", () => {
    // Scoped to codex only: emptying its scope changes nothing about CLAUDE.md, so
    // claiming a de-projection here would be a false alarm — and false alarms are what
    // make an author pass the override flag reflexively.
    const codexOnly: ProjectionRow = {
      ...row("edited", "a".repeat(10), 10),
      client_scope: ["codex"],
    };
    const before = [codexOnly, row("other", "b", 10)];
    const after = applyEditInMemory(before, "edited", null);

    const impacts = evictionDelta({
      before,
      after,
      clients: [
        { client: "claude", file: "CLAUDE.md", reader: "Claude Code" },
        { client: "codex", file: "AGENTS.md", reader: "Codex" },
      ],
      docId: "claude-md",
      budget: 1_000,
      projectClient: fakeProjectClient,
      partKey: "edited",
    });

    expect(impacts.find((i) => i.file === "CLAUDE.md")?.deprojected).toBe(false);
    expect(impacts.find((i) => i.file === "AGENTS.md")?.deprojected).toBe(true);
  });

  it("does NOT fire when the part is merely edited and still projects", () => {
    const before = [row("edited", "a".repeat(10), 10)];
    const after = applyEditInMemory(
      before,
      "edited",
      row("edited", "a".repeat(11), 10),
    );

    expect(impactFor(before, after, 1_000).deprojected).toBe(false);
  });
});

describe("applyEditInMemory", () => {
  it("REMOVES the part when the edit empties its client scope", () => {
    const rows = [row("a", "x"), row("b", "y")];
    expect(applyEditInMemory(rows, "a", null).map((r) => r.part_key)).toEqual([
      "b",
    ]);
  });

  it("ADDS a part that did not exist, in ordinal order", () => {
    const rows = [row("a", "x", 100, 1), row("c", "z", 100, 3)];
    const next = row("b", "y", 100, 2);
    expect(
      applyEditInMemory(rows, "b", next).map((r) => r.part_key),
    ).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [row("a", "x")];
    applyEditInMemory(rows, "a", null);
    expect(rows).toHaveLength(1);
  });
});

describe("renderImpact", () => {
  it("NEVER truncates the eviction list — the whole point of a delta", () => {
    // The projector truncates its absolute cut list at MAX_SPILL_ENTRIES (12). A delta
    // must not, or a newly-evicted rule can land in the elided tail — the exact blind
    // spot this report exists to remove.
    const evicted = Array.from({ length: 40 }, (_, i) => `evicted-part-${i}`);
    const text = renderImpact(
      [
        {
          file: "CLAUDE.md",
          evicted,
          restored: [],
          deprojected: false,
          headroomBefore: 30,
          headroomAfter: 5,
        },
      ],
      "some-other-part",
    );

    for (const key of evicted) expect(text).toContain(key);
    expect(text).not.toMatch(/\(\+\d+ more\)|\.\.\.|…/);
  });

  it("flags the author's OWN part when it is what no longer fits", () => {
    const text = renderImpact(
      [
        {
          file: "CLAUDE.md",
          evicted: ["mine"],
          restored: [],
          deprojected: false,
          headroomBefore: 30,
          headroomAfter: 100,
        },
      ],
      "mine",
    );

    expect(text).toContain("<- the part you are editing");
    expect(text).toContain("your own part does not fit");
  });

  it("does not claim a self-eviction when someone else's part was cut", () => {
    const text = renderImpact(
      [
        {
          file: "CLAUDE.md",
          evicted: ["theirs"],
          restored: [],
          deprojected: false,
          headroomBefore: 30,
          headroomAfter: 100,
        },
      ],
      "mine",
    );

    expect(text).not.toContain("your own part does not fit");
    expect(text).toContain("EVICTS 1 part(s)");
  });

  it("LEADS WITH THE DE-PROJECTION INSTEAD OF THE GREEN `restores` LINE", () => {
    // The failure mode is not silence, it is REASSURANCE: a de-projecting edit frees its
    // own bytes, so previously-cut parts fit again and the honest-looking report is
    // `✓ restores 2 part(s)` with a rising headroom. Pin that the removal is what the
    // block leads with, and that the restored parts are not presented as a net win.
    const text = renderImpact(
      [
        {
          file: "CLAUDE.md",
          evicted: [],
          restored: ["comeback-a", "comeback-b"],
          deprojected: true,
          headroomBefore: 5,
          headroomAfter: 900,
        },
      ],
      "mine",
    );

    expect(text).toContain("DE-PROJECTED");
    expect(text).toContain("'mine'");
    expect(text).toContain("NO LONGER REACHES THIS FILE");
    // The restored parts are still listed — but only under the de-projection heading,
    // never as the ✓ line that would read as success.
    expect(text).toContain("comeback-a");
    expect(text).not.toContain("✓ restores");
    expect(text.indexOf("DE-PROJECTED")).toBeLessThan(text.indexOf("comeback-a"));
  });

  it("surfaces a projector refusal rather than printing meaningless headroom", () => {
    const text = renderImpact(
      [
        {
          file: "CLAUDE.md",
          evicted: [],
          restored: [],
          deprojected: false,
          headroomBefore: Number.NaN,
          headroomAfter: Number.NaN,
          failed: "budget too small to be honoured",
        },
      ],
      "mine",
    );

    expect(text).toContain("projector refused");
    expect(text).not.toContain("NaN");
  });
});

describe("identityProblemDelta", () => {
  const problem = (
    part_key: string,
    code = "key-body-mismatch",
  ): IdentityProblem => ({ part_key, code, detail: `${part_key} ${code}` });

  /** Detector stand-in keyed on the row set it is handed (before = [], after = [_]). */
  const detecting = (before: IdentityProblem[], after: IdentityProblem[]) => (
    rows: ProjectionRow[],
  ) => (rows.length === 0 ? before : after);

  it("carries a problem present BEFORE the edit as pre-existing, never as the author's", () => {
    const { introduced, preexisting } = identityProblemDelta({
      before: [],
      after: [row("mine", "x")],
      detect: detecting([problem("theirs")], [problem("theirs")]),
    });
    expect(introduced).toEqual([]);
    expect(preexisting).toEqual([problem("theirs")]);
  });

  it("CONTROL — a problem absent before and present after IS attributed to the edit", () => {
    const { introduced, preexisting } = identityProblemDelta({
      before: [],
      after: [row("mine", "x")],
      detect: detecting([], [problem("mine")]),
    });
    expect(introduced).toEqual([problem("mine")]);
    expect(preexisting).toEqual([]);
  });

  it("treats a DIFFERENT code on the same row as newly introduced", () => {
    const { introduced, preexisting } = identityProblemDelta({
      before: [],
      after: [row("mine", "x")],
      detect: detecting(
        [problem("mine", "key-body-mismatch")],
        [
          problem("mine", "key-body-mismatch"),
          problem("mine", "orphaned-full-precompression-evidence"),
        ],
      ),
    });
    expect(introduced).toEqual([
      problem("mine", "orphaned-full-precompression-evidence"),
    ]);
    expect(preexisting).toEqual([problem("mine", "key-body-mismatch")]);
  });
});

/**
 * EI-21968678099053129 — the same delta, driven by the projector's REAL detector.
 *
 * These are the cases `set-doc-part` now refuses on. They matter more than the
 * stand-in tests above because they pin the INJECTION CONTRACT: if
 * `docPartIdentityProblems` ever changes shape, this fails here rather than in a
 * `✓ written` that the next command rejects.
 */
describe("identityProblemDelta against the real doc-part identity rule", () => {
  const identityRow = (
    part_key: string,
    body: string,
    client_scope: string[] = ["claude"],
  ): ProjectionRow => ({
    part_key,
    kind: "prose",
    body,
    ordinal: 1,
    client_scope,
    target_section: "Section A",
    project_rank: 100,
  });

  const KEY = "section-a-pgrep-q-does-not-ex";
  const edit = (rows: ProjectionRow[], next: ProjectionRow) =>
    identityProblemDelta({
      before: rows,
      after: applyEditInMemory(rows, next.part_key, next),
      detect: docPartIdentityProblems,
    });

  it("refuses the reported case: a rewrite that drops every discriminating key token", () => {
    const before = [identityRow(KEY, "The pgrep command is not supported here.")];
    const { introduced, preexisting } = edit(
      before,
      identityRow(KEY, "Use find-newermt only with bfs 4.1.1."),
    );
    expect(introduced).toMatchObject([
      { part_key: KEY, code: "key-body-mismatch" },
    ]);
    expect(preexisting).toEqual([]);
    // The refusal must name the token the body has to keep — that string is what
    // `set-doc-part` prints, and without it the author is told "no" with no repair.
    expect(introduced[0].detail).toContain("pgrep");
  });

  it("NEGATIVE CONTROL — a rewrite that keeps the token is accepted", () => {
    const before = [identityRow(KEY, "The pgrep command is not supported here.")];
    const { introduced, preexisting } = edit(
      before,
      identityRow(KEY, "The pgrep command is still refused, for a new reason."),
    );
    expect(introduced).toEqual([]);
    expect(preexisting).toEqual([]);
  });

  it("catches an edit that breaks a SIBLING row — the case key-matching would miss", () => {
    // The problem this introduces is reported under `<KEY>#evidence`, NOT under the
    // key being edited, so filtering findings by the edited part_key would report a
    // clean write for an edit that blocks the whole projection.
    const evidence = identityRow(
      `${KEY}#evidence`,
      `${FULL_PRECOMPRESSION_MARKER}\n\nA uniquely worded clause about throttling.`,
      [],
    );
    const before = [
      identityRow(KEY, "The pgrep command is not supported here, with throttling."),
      evidence,
    ];
    const { introduced, preexisting } = edit(
      before,
      // Keeps its OWN key token, so the edited row itself stays legal.
      identityRow(KEY, "The pgrep command is not supported here."),
    );
    expect(preexisting).toEqual([]);
    expect(introduced).toMatchObject([
      { part_key: `${KEY}#evidence`, code: "evidence-not-backed-by-projected-sibling" },
    ]);
  });

  it("does not blame the author for a row that was ALREADY inconsistent", () => {
    const before = [
      identityRow(KEY, "The pgrep command is not supported here."),
      identityRow("section-a-throttling-clause", "Nothing about the subject at all."),
    ];
    const { introduced, preexisting } = edit(
      before,
      identityRow(KEY, "The pgrep command is still refused, for a new reason."),
    );
    expect(introduced).toEqual([]);
    expect(preexisting).toMatchObject([
      { part_key: "section-a-throttling-clause", code: "key-body-mismatch" },
    ]);
  });
});
