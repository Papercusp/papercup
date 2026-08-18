/**
 * get-shape.test.ts — work_items:get payload-tier shapers (EI-19447969329510166).
 *
 * The defect these guard: with no shaper declared, a trimmed session fell through
 * to the framework's generic bounded projection, which clipped the CHECKPOINT —
 * the one field this tool exists to deliver on a post-respawn re-orient — to 800
 * chars, silently. The tests below pin the two properties that matter: the
 * checkpoint survives, and anything that does NOT survive says so.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/work_items/get-shape.test.ts
 */
import { describe, expect, it } from "vitest";
import { PAYLOAD_TIER_HARD_CEILING_CHARS } from "@papercusp/agent-mcp";
import { CHARS_PER_TOKEN_ESTIMATE } from "../../context-doors";
import { RESULT_DOOR_TOKENS } from "../../result-door";
import { shapeWorkItemsGet } from "./get-shape";

type Envelope = {
  ok: boolean;
  results: Array<Record<string, unknown>>;
  counts: { ok: number; failed: number };
  _shapeNote?: { dropped: string[]; checkpointCharsPerRow: number; next: string };
};

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    id: "WI-1",
    workItem: {
      id: "WI-1",
      kind: "bug",
      state: "open",
      title: "a title",
      severity: "major",
      assignee: "su-1",
      summary: "S".repeat(4_000),
      payload: { big: "P".repeat(4_000) },
    },
    checkpoint: null,
    checkpointAgeMs: null,
    checkpointUpdatedAtMs: null,
    ...over,
  };
}

function envelope(rows: Array<Record<string, unknown>>): Envelope {
  return { ok: true, results: rows, counts: { ok: rows.length, failed: 0 } };
}

describe("shapeWorkItemsGet — the checkpoint is the payload, degraded last", () => {
  it("keeps a large single-item checkpoint WHOLE (the post-respawn read that was broken)", () => {
    const checkpoint = "C".repeat(5_000);
    const out = shapeWorkItemsGet(envelope([row({ checkpoint })]), "trimmed") as Envelope;

    // Byte-identical: this is the case the generic projection served at 800 chars.
    expect(out.results[0].checkpoint).toBe(checkpoint);
    expect(String(out.results[0].checkpoint)).not.toMatch(/TRUNCATED/);
  });

  it("spends the budget on the checkpoint by DROPPING summary + payload, and names both", () => {
    const out = shapeWorkItemsGet(envelope([row({ checkpoint: "C".repeat(5_000) })]), "trimmed") as Envelope;
    const w = out.results[0].workItem as Record<string, unknown>;

    expect(w.summary).toBeUndefined();
    expect(w.payload).toBeUndefined();
    // D-004: no silent caps. A reader must be able to tell what is missing.
    expect(out._shapeNote?.dropped).toEqual(
      expect.arrayContaining(["workItem.summary", "workItem.payload"]),
    );
    // Identity survives so the row is still usable + correlatable.
    expect(w).toMatchObject({ id: "WI-1", kind: "bug", state: "open", severity: "major" });
  });

  it("clips an over-budget checkpoint WITH the loud in-band marker, never a bare ellipsis", () => {
    const checkpoint = "C".repeat(40_000);
    const out = shapeWorkItemsGet(envelope([row({ checkpoint })]), "trimmed") as Envelope;
    const got = String(out.results[0].checkpoint);

    expect(got.length).toBeLessThan(checkpoint.length);
    expect(got).toMatch(/…\[TRUNCATED \+\d+ chars — re-read with payloadTier:'full'\]$/);
    expect(out._shapeNote?.dropped).toEqual(expect.arrayContaining(["checkpoint(clipped)"]));
  });

  it("keeps every 'read before acting' warning the tool's returns-contract promises", () => {
    const out = shapeWorkItemsGet(
      envelope([
        row({
          checkpoint: "C".repeat(1_000),
          planItemClaimCollision: { planSlug: "p", itemId: "P-007", claimedBy: "su-2" },
          planItemBlocked: { reason: "needs-human", planSlug: "p" },
          checkpointFreshness: { verdict: "stale", changed: [{ dep: "file:a.ts" }] },
          checkpointStale: { stale: true },
          checkpointBgJobWarning: "cites a background job",
          priorWorkWarning: "ALREADY WORKED",
          holder: { goalRef: "g", agreement: "divergent" },
        }),
      ]),
      "trimmed",
    ) as Envelope;
    const r = out.results[0];

    // Each of these changes how the checkpoint above must be read — dropping any
    // of them to save bytes would reintroduce the confidently-wrong-state failure
    // from a different direction.
    expect(r.planItemClaimCollision).toBeDefined();
    expect(r.planItemBlocked).toBeDefined();
    expect(r.checkpointFreshness).toMatchObject({ verdict: "stale" });
    expect(r.checkpointStale).toBeDefined();
    expect(r.checkpointBgJobWarning).toBeDefined();
    expect(r.priorWorkWarning).toBeDefined();
    expect(r.holder).toMatchObject({ agreement: "divergent" });
  });

  it("caps lifecycle events but NEVER drops the coverage/flags that qualify them", () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ at: `t${i}`, kind: "blocked" }));
    const out = shapeWorkItemsGet(
      envelope([
        row({
          lifecycle: { events, coverage: { notRecorded: ["x"], degraded: false }, flags: { claimHold: true } },
        }),
      ]),
      "trimmed",
    ) as Envelope;
    const lc = out.results[0].lifecycle as Record<string, unknown>;

    expect((lc.events as unknown[]).length).toBe(4);
    expect(lc.eventsTruncated).toMatchObject({ shown: 4, total: 30 });
    // An empty/partial `events` is only safely readable alongside `coverage`.
    expect(lc.coverage).toMatchObject({ degraded: false });
    expect(lc.flags).toMatchObject({ claimHold: true });
  });
});

describe("shapeWorkItemsGet — bulk reads stay under the transport ceiling", () => {
  it("keeps a default single-item read below the MCP result-door budget", () => {
    const out = shapeWorkItemsGet(
      envelope([
        row({
          checkpoint: "C".repeat(5_000),
          holder: {
            goalRef: "EI-20243922284675857",
            goalText: "The holder is actively fixing the default read overflow.",
            assumptions: { count: 1, keys: ["launch-provenance"] },
            declaredAt: "2026-08-12T10:56:00.000Z",
            stale: false,
            agreement: "sole",
            competing: [],
          },
        }),
      ]),
      "trimmed",
    ) as Envelope;
    const serialized = JSON.stringify(out);

    // The real MCP result door measures this same serialized text and spills
    // anything over its universal floor. The shaper must leave valid JSON for
    // the door, rather than relying on the door's lossy footer after the fact.
    expect(serialized).toMatch(/^\{[\s\S]*\}$/);
    expect(serialized.length).toBeLessThanOrEqual(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
  });

  it("bounds a 100-id read below the hard ceiling while preserving EVERY id", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      row({
        id: `WI-${i}`,
        workItem: { id: `WI-${i}`, kind: "bug", state: "open", title: `t${i}`, summary: "S".repeat(3_000) },
        checkpoint: "C".repeat(2_000),
      }),
    );
    const out = shapeWorkItemsGet(envelope(rows), "trimmed") as Envelope;
    const size = JSON.stringify(out).length;

    // Over the ceiling, applyPayloadTier force-re-applies this shaper and, on
    // failing to shrink, falls back to the generic projection this file exists
    // to avoid — so exceeding it would silently undo the whole fix.
    expect(size).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
    // Correlation is the one thing a caller cannot reconstruct. Every requested
    // id comes back, even when its detail does not.
    expect(out.results).toHaveLength(100);
    expect(out.results.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    // And a degraded row SAYS it is degraded rather than looking like a thin item.
    const stub = out.results.at(-1) as Record<string, unknown>;
    expect(stub._stub).toMatch(/re-read this id alone/);
    expect(stub.hasCheckpoint).toBe(true);
    expect(out._shapeNote?.dropped.some((d) => d.startsWith("rows("))).toBe(true);
  });

  it("a 10-id read preserves every id when the result door requires stubs", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ id: `WI-${i}`, workItem: { id: `WI-${i}`, state: "open" }, checkpoint: "C".repeat(1_000) }),
    );
    const out = shapeWorkItemsGet(envelope(rows), "trimmed") as Envelope;

    expect(out.results).toHaveLength(10);
    expect(out.results.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(out.results.some((r) => r._stub)).toBe(true);
    expect(out.results.filter((r) => r.hasCheckpoint).length).toBeGreaterThan(0);
    expect(out._shapeNote?.dropped.some((d) => d.startsWith("rows("))).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
  });
});

describe("shapeWorkItemsGet — tier differences and defensive behaviour", () => {
  // EI-20743148487714069 REPLACED this test's contract. It used to assert
  // "standard keeps a clipped summary; trimmed drops it entirely" — which pinned
  // the defect: a trimmed read returned the TITLE and no sentence of the body, on
  // a payload using ~15% of its door budget. The tier difference is now one of
  // BUDGET, not presence: both carry the summary when the rung has slack, standard
  // simply affords more of it.
  it("both tiers carry the summary when there is slack; standard affords more", () => {
    const env = envelope([row({ checkpoint: "C".repeat(500) })]);
    const std = shapeWorkItemsGet(env, "standard") as Envelope;
    const trm = shapeWorkItemsGet(env, "trimmed") as Envelope;
    const stdSummary = String((std.results[0].workItem as Record<string, unknown>).summary);
    const trmSummary = String((trm.results[0].workItem as Record<string, unknown>).summary);

    expect(stdSummary.length).toBeGreaterThan(trmSummary.length);
    // Neither is the useless head the old flat cap produced.
    expect(trmSummary.length).toBeGreaterThan(1_000);
    // A clip still says so in-band, and the small checkpoint is untouched at both.
    expect(trmSummary).toMatch(/TRUNCATED/);
    expect(trm.results[0].checkpoint).toBe("C".repeat(500));
    expect(std.results[0].checkpoint).toBe("C".repeat(500));
  });

  it("passes an error row through untouched — it is already tiny and self-describing", () => {
    const err = { ok: false, id: "WI-9", error: "not_found" };
    const out = shapeWorkItemsGet(envelope([err]), "trimmed") as Envelope;
    expect(out.results[0]).toEqual(err);
  });

  it("returns non-envelope data unchanged rather than mangling it", () => {
    expect(shapeWorkItemsGet(null, "trimmed")).toBeNull();
    expect(shapeWorkItemsGet({ ok: true }, "trimmed")).toEqual({ ok: true });
    expect(shapeWorkItemsGet("nope", "trimmed")).toBe("nope");
  });

  it("emits NO _shapeNote when nothing was dropped — the note must mean something", () => {
    const out = shapeWorkItemsGet(
      envelope([{ ok: true, id: "WI-1", workItem: { id: "WI-1", state: "open" }, checkpoint: "short" }]),
      "trimmed",
    ) as Envelope;
    expect(out._shapeNote).toBeUndefined();
  });
});

describe("citedFacts survives the shaper (EI-19465127338264010)", () => {
  const citedFacts = {
    dangling: 1,
    decayed: 2,
    note: "This item's prose cites 3 fact key(s) as its authority; 3 no longer resolve live.",
    cited: Array.from({ length: 8 }, (_, i) => ({
      key: `some-cited-key-${i}`,
      condition: i === 0 ? "dangling" : "retracted",
      ref: i === 0 ? null : `fact:workspace:some-cited-key-${i}@v${i}`,
      scope: i === 0 ? null : "workspace",
      scopeRef: null,
      versionId: i === 0 ? null : i,
      ...(i === 0 ? {} : { excerpt: "E".repeat(400) }),
    })),
  };

  // THE DEFECT THIS PINS: projectRow rebuilds each row from a WHITELIST, so a new
  // conditional field added to get.ts is dropped SILENTLY unless it is added here
  // too — the exact class of loss this whole file was filed for, one field over.
  for (const tier of ["trimmed", "standard"] as const) {
    it(`keeps the finding and its note at the '${tier}' tier`, () => {
      const out = shapeWorkItemsGet(
        { ok: true, results: [row({ citedFacts })], counts: { ok: 1, failed: 0 } },
        tier,
      ) as Envelope;
      const cf = out.results[0].citedFacts as Record<string, unknown>;
      expect(cf).toBeDefined();
      // The counts and the note ARE the finding — never degraded.
      expect(cf.dangling).toBe(1);
      expect(cf.decayed).toBe(2);
      expect(cf.note).toBe(citedFacts.note);
      // The bulk (per-key excerpts) is capped, and never silently.
      const kept = cf.cited as Array<Record<string, unknown>>;
      expect(kept.length).toBeLessThan(citedFacts.cited.length);
      expect(cf.citedTruncated).toEqual({ shown: kept.length, total: 8 });
      expect(out._shapeNote?.dropped).toContain("citedFacts.cited");
      // A clipped excerpt carries the loud in-band marker, not a bare ellipsis.
      const withExcerpt = kept.find((k) => typeof k.excerpt === "string");
      expect(withExcerpt?.excerpt).toContain("TRUNCATED");
      // Identity survives clipping — the key is what a reader looks up.
      expect(kept[0].key).toBe("some-cited-key-0");
    });
  }

  it("is absent when the handler emitted no finding", () => {
    const out = shapeWorkItemsGet(
      { ok: true, results: [row()], counts: { ok: 1, failed: 0 } },
      "trimmed",
    ) as Envelope;
    expect(out.results[0].citedFacts).toBeUndefined();
  });

  it("CONTROL: an unlisted field really is dropped, so the test above is not vacuous", () => {
    // Without this, `citedFacts` surviving could look like a property of the
    // shaper rather than of the whitelist entry that was added for it — and the
    // test would still pass if the shaper stopped projecting rows at all.
    // A sibling field of identical shape, deliberately NOT whitelisted, must
    // vanish; the same call keeps citedFacts.
    const out = shapeWorkItemsGet(
      {
        ok: true,
        results: [row({ citedFacts, notAWhitelistedField: { dangling: 1, note: "should vanish" } })],
        counts: { ok: 1, failed: 0 },
      },
      "trimmed",
    ) as Envelope;
    expect(out.results[0].notAWhitelistedField).toBeUndefined();
    expect(out.results[0].citedFacts).toBeDefined();
  });
});

/**
 * EI-20106094931898818 / EI-20190481053365787 — the SAME whitelist-drop class as
 * the block above, one whitelist over: `projectWorkItem`, not `projectRow`.
 *
 * `detail:true` folds the coord substrate onto the workItem (work-items.ts:1156
 * returns `{ ...wi, topics, posts, links }`) and all three were dropped with
 * nothing added to `dropped` — so a detail read whose ONLY loss was the comment
 * thread emitted no `_shapeNote` at all. A caller who explicitly asked for
 * comments and got neither comments nor a marker reads "this item has none".
 * That has already produced a false report here.
 */
describe("detail:true — content out, evidence-of-content IN", () => {
  const detailRow = (id = "WI-1", posts = 7) => ({
    ok: true,
    id,
    workItem: {
      id,
      state: "open",
      title: "a title",
      topics: ["coord-dx", "git-sync"],
      posts: Array.from({ length: posts }, (_, i) => ({ post_id: i, body: "B".repeat(600) })),
      links: [{ rel: "blocks", dst: { kind: "work_item", ref: "WI-2" } }],
    },
    checkpoint: "short",
  });
  const emptyDetail = () => ({
    ok: true,
    id: "WI-1",
    workItem: { id: "WI-1", state: "open", topics: [], posts: [], links: [] },
    checkpoint: "short",
  });
  const wi = (e: Envelope, i = 0) => e.results[i].workItem as Record<string, unknown>;

  it("discloses the COUNT of every dropped detail array, per row and in _shapeNote", () => {
    const out = shapeWorkItemsGet(envelope([detailRow()]), "trimmed") as Envelope;

    // The content is still dropped — that shaping decision stands.
    expect(wi(out).posts).toBeUndefined();
    expect(wi(out).topics).toBeUndefined();
    expect(wi(out).links).toBeUndefined();
    // But nobody can now conclude "this item has no comments" from the shape.
    expect(wi(out).detailOmitted).toEqual({ posts: 7, topics: 2, links: 1 });
    expect(out._shapeNote?.dropped).toEqual(
      expect.arrayContaining(["workItem.posts", "workItem.topics", "workItem.links"]),
    );
  });

  it("EMPTY arrays are a real answer — no marker, and no _shapeNote at all", () => {
    // THE PROPERTY THAT MAKES THE MARKER WORTH ANYTHING: its absence is a
    // positive claim of completeness. A marker on `posts: []` would report
    // "comments were withheld" about an item that genuinely has none.
    const out = shapeWorkItemsGet(envelope([emptyDetail()]), "trimmed") as Envelope;
    expect(wi(out).detailOmitted).toBeUndefined();
    expect(out._shapeNote).toBeUndefined();
  });

  it("a detail:false read (fields absent entirely) carries no marker either", () => {
    const out = shapeWorkItemsGet(
      envelope([{ ok: true, id: "WI-1", workItem: { id: "WI-1", state: "open" }, checkpoint: "short" }]),
      "trimmed",
    ) as Envelope;
    expect(wi(out).detailOmitted).toBeUndefined();
  });

  it("attributes the counts to the RIGHT row — payload-level _shapeNote cannot", () => {
    const out = shapeWorkItemsGet(
      envelope([emptyDetail(), detailRow("WI-loud", 3)]),
      "trimmed",
    ) as Envelope;
    expect(wi(out, 0).detailOmitted).toBeUndefined();
    expect(wi(out, 1).detailOmitted).toMatchObject({ posts: 3 });
  });

  it("stays under the hard ceiling on a 100-row detail read, with ONE label per field", () => {
    const out = shapeWorkItemsGet(
      envelope(Array.from({ length: 100 }, (_, i) => detailRow(`WI-${i}`, 20))),
      "trimmed",
    ) as Envelope;

    expect(JSON.stringify(out).length).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
    expect(out.results).toHaveLength(100);
    // Pins the label design: interpolating the count into the `dropped` label
    // would emit up to 100 distinct strings here, spending the budget this
    // shaper exists to protect. The count belongs per row instead.
    expect(out._shapeNote?.dropped.filter((d) => d === "workItem.posts")).toHaveLength(1);
  });

  it("CONTROL: a DEFENSIVE always-emit implementation fails the completeness property", () => {
    // Kept PERMANENTLY. `noteDroppedDetail` is valuable only because it stays
    // silent on an empty array. If someone later "hardens" it to always emit,
    // this suite must go red rather than quietly accept a marker that means
    // nothing. Modelling the wrong implementation here proves the assertion in
    // the empty-array test is the one that catches it, and that the passing
    // tests above are not passing vacuously.
    const defensive = (w: Record<string, unknown>) => {
      const omitted: Record<string, number> = {};
      for (const f of ["posts", "topics", "links"] as const) {
        omitted[f] = Array.isArray(w[f]) ? (w[f] as unknown[]).length : 0;
      }
      return omitted; // always emits — the bug
    };

    const empty = emptyDetail();
    expect(defensive(empty.workItem)).toEqual({ posts: 0, topics: 0, links: 0 });
    // The REAL implementation says nothing on that same input.
    const out = shapeWorkItemsGet(envelope([empty]), "trimmed") as Envelope;
    expect(wi(out).detailOmitted).toBeUndefined();
    // Calibration: and it DOES speak when there is something to disclose, so
    // "says nothing" is not simply broken.
    const loud = shapeWorkItemsGet(envelope([detailRow()]), "trimmed") as Envelope;
    expect(wi(loud).detailOmitted).toMatchObject({ posts: 7 });
  });
});

describe("threadLimit — bounded diagnostic thread stays consumable", () => {
  it("keeps the bounded window, counts it, and marks large post bodies", () => {
    const threadWindow = {
      posts: Array.from({ length: 6 }, (_, i) => ({
        id: i + 1,
        thread_id: "thread-1",
        author_id: "su-peer",
        body: "B".repeat(800),
        created_ts: `2026-08-12T10:0${i}:00.000Z`,
      })),
      total: 12,
      topics: ["release-gate"],
      createdAt: "2026-08-12T09:00:00.000Z",
    };
    const out = shapeWorkItemsGet(envelope([row({ threadWindow })]), "trimmed") as Envelope;
    const thread = out.results[0].threadWindow as Record<string, any>;

    expect(thread.shown).toBe(5);
    expect(thread.total).toBe(12);
    expect(thread.posts[0].id).toBe(2);
    expect(thread.posts[0].bodyTruncated).toBe(true);
    expect(thread.posts[0].bodyChars).toBe(800);
    expect(thread.posts[0].body).toMatch(/TRUNCATED/);
    expect(out._shapeNote?.dropped).toEqual(
      expect.arrayContaining(["threadWindow.posts", "threadWindow.postBodies"]),
    );
  });

  it("does not invent a missing-comment warning for a measured empty thread", () => {
    const out = shapeWorkItemsGet(
      envelope([
        row({
          workItem: { id: "WI-1", state: "open", topics: [], posts: [], links: [] },
          threadWindow: { posts: [], total: 0, topics: [], createdAt: "2026-08-12T09:00:00.000Z" },
        }),
      ]),
      "trimmed",
    ) as Envelope;
    expect(out.results[0].threadWindow).toMatchObject({ shown: 0, total: 0, posts: [] });
    expect(out._shapeNote?.dropped ?? []).not.toEqual(
      expect.arrayContaining(["threadWindow.posts", "threadWindow.postBodies", "threadWindow.topics"]),
    );
  });

  it("preserves an explicit failed bounded read instead of rendering silence", () => {
    const out = shapeWorkItemsGet(envelope([row({ threadWindow: null, threadWindowReadFailed: true })]), "trimmed") as Envelope;
    expect(out.results[0]).toMatchObject({ threadWindow: null, threadWindowReadFailed: true });
  });
});
