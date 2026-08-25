import { describe, expect, it } from "vitest";
import {
  applyEditInMemory,
  evictionDelta,
  renderImpact,
  type ClientImpact,
  type ProjectClientFn,
  type ProjectionRow,
} from "./eviction-delta";

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
const fakeProjectClient: ProjectClientFn = (parts, { budget }) => {
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
  return { text, dropped };
};

const impactFor = (
  before: ProjectionRow[],
  after: ProjectionRow[],
  budget: number,
  projectClient: ProjectClientFn = fakeProjectClient,
): ClientImpact =>
  evictionDelta({
    before,
    after,
    clients: CLIENTS,
    docId: "claude-md",
    budget,
    projectClient,
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
          headroomBefore: 30,
          headroomAfter: 100,
        },
      ],
      "mine",
    );

    expect(text).not.toContain("your own part does not fit");
    expect(text).toContain("EVICTS 1 part(s)");
  });

  it("surfaces a projector refusal rather than printing meaningless headroom", () => {
    const text = renderImpact(
      [
        {
          file: "CLAUDE.md",
          evicted: [],
          restored: [],
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
