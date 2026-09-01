/**
 * selection-base.test.ts — P-011 / D-009 (gate-verdict-liveness-and-repair-reliability-2026-08-31).
 *
 * Guards the gate-side selection-base resolver. The whole feature is a fail-safe, and
 * the safe answer (`lastReady`) is ALSO what a completely broken implementation returns —
 * so every negative case here asserts the `reason` too (the P-047 test doctrine: `reason`
 * is what makes "refused because the anchor is behind main" and "refused because the
 * function does nothing" distinguishable at all).
 *
 * The subject is a pure function over an injected git runner, so these run with no git
 * fixture, no temp repo, and no mutation of the shared checkout.
 *
 * CONSTANT-SYNC GUARD: the ref + kill-switch names are a deliberate pair with
 * scripts/lib/test-certified-base.mjs (one switch, one semantic — D-009). A hand-copied
 * pair is exactly the drift the derived-truth ladder warns about, so this file imports
 * BOTH modules and compares — the same guard style P-047 uses for SCOPE_FLAGS.
 */
import { describe, expect, it } from "vitest";

import {
  DISABLE_ENV as MJS_DISABLE_ENV,
  TEST_CERTIFIED_REF as MJS_TEST_CERTIFIED_REF,
} from "../../../../scripts/lib/test-certified-base.mjs";

import {
  SELECTION_BASE_DISABLE_ENV,
  TEST_CERTIFIED_REF,
  resolveSelectionBase,
  selectionBaseGitFor,
  selectionBaseLine,
  type SelectionBaseResult,
} from "./selection-base";

const LAST_READY = "a".repeat(40);
const HEAD = "b".repeat(40);
const WATERMARK = "c".repeat(40);
const FROZEN = "d".repeat(40);

const REV_PARSE = `rev-parse --verify --quiet ${TEST_CERTIFIED_REF}^{commit}`;
const anchorAncestorOfHead = (anchor: string) =>
  `merge-base --is-ancestor ${anchor} ${HEAD}`;
const lastReadyAncestorOf = (anchor: string) =>
  `merge-base --is-ancestor ${LAST_READY} ${anchor}`;

/**
 * A git runner that answers only what it is told to and records what it was asked.
 *
 * `merge-base --is-ancestor` answers through its EXIT STATUS and prints nothing, so the
 * real runner returns `''` for a verified true and `null` for false-or-could-not-tell.
 * Reproducing that here is load-bearing: an implementation that tested truthiness
 * instead of `!== null` would read every verified ancestry as a failure, and the healthy
 * cases below would catch it (they are this suite's calibration control).
 */
function fakeGit(responses: Record<string, string | null>) {
  const calls: string[][] = [];
  const git = async (argv: string[]): Promise<string | null> => {
    calls.push(argv);
    const key = argv.join(" ");
    return key in responses ? responses[key] : null;
  };
  return { git, calls };
}

/** A watermark that exists, is on the judged history, and is at-or-ahead of lastReady. */
const HEALTHY_WATERMARK: Record<string, string | null> = {
  [REV_PARSE]: WATERMARK,
  [anchorAncestorOfHead(WATERMARK)]: "",
  [lastReadyAncestorOf(WATERMARK)]: "",
};

const HEALTHY_FROZEN: Record<string, string | null> = {
  [anchorAncestorOfHead(FROZEN)]: "",
  [lastReadyAncestorOf(FROZEN)]: "",
};

function base(overrides: Record<string, unknown> = {}) {
  return {
    lastReady: LAST_READY,
    judgedHead: HEAD,
    env: {},
    ...overrides,
  };
}

describe("selection base: constant sync with scripts/lib/test-certified-base.mjs (D-009)", () => {
  it("uses the exact P-047 watermark ref", () => {
    expect(TEST_CERTIFIED_REF).toBe(MJS_TEST_CERTIFIED_REF);
  });
  it("uses the exact P-047 kill-switch env var — one switch, one semantic", () => {
    expect(SELECTION_BASE_DISABLE_ENV).toBe(MJS_DISABLE_ENV);
  });
});

describe("selection base: fresh cuts (watermark anchor)", () => {
  it("advances to a healthy watermark", async () => {
    const { git } = fakeGit(HEALTHY_WATERMARK);
    const r = await resolveSelectionBase(base({ git }));
    expect(r).toEqual({ base: WATERMARK, source: "watermark", reason: "watermark" });
  });

  it("falls back when no watermark ref exists", async () => {
    const { git } = fakeGit({});
    const r = await resolveSelectionBase(base({ git }));
    expect(r.base).toBe(LAST_READY);
    expect(r.source).toBe("last-ready");
    expect(r.reason).toBe("no-watermark");
  });

  it("falls back when the watermark is not an ancestor of the judged head", async () => {
    const { git } = fakeGit({ ...HEALTHY_WATERMARK, [anchorAncestorOfHead(WATERMARK)]: null });
    const r = await resolveSelectionBase(base({ git }));
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("watermark-not-ancestor-of-head");
    expect(r.rejectedAnchor).toBe(WATERMARK);
  });

  it("falls back when the watermark is behind lastReady (anchor may only SHRINK the radius)", async () => {
    const { git } = fakeGit({ ...HEALTHY_WATERMARK, [lastReadyAncestorOf(WATERMARK)]: null });
    const r = await resolveSelectionBase(base({ git }));
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("watermark-behind-last-ready");
    expect(r.rejectedAnchor).toBe(WATERMARK);
  });

  it("falls back with a distinct reason when the watermark IS lastReady (no gain, mechanism alive)", async () => {
    const { git } = fakeGit({ [REV_PARSE]: LAST_READY });
    const r = await resolveSelectionBase(base({ git }));
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("anchor-at-last-ready");
  });
});

describe("selection base: repair runs (frozen-verdict anchor)", () => {
  it("advances to a healthy frozen candidate and never consults the watermark", async () => {
    const { git, calls } = fakeGit(HEALTHY_FROZEN);
    const r = await resolveSelectionBase(base({ git, frozenCandidate: FROZEN }));
    expect(r).toEqual({ base: FROZEN, source: "frozen-verdict", reason: "frozen-verdict" });
    // The red-verdict anchor outranks the watermark: a repair run must diff against the
    // sha whose failures the queue is tracking, not a possibly-newer green watermark.
    expect(calls.map((c) => c.join(" "))).not.toContain(REV_PARSE);
  });

  it("falls back when the frozen candidate is not an ancestor of the judged head", async () => {
    const { git } = fakeGit({ ...HEALTHY_FROZEN, [anchorAncestorOfHead(FROZEN)]: null });
    const r = await resolveSelectionBase(base({ git, frozenCandidate: FROZEN }));
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("frozen-verdict-not-ancestor-of-head");
    expect(r.rejectedAnchor).toBe(FROZEN);
  });

  it("falls back when the frozen candidate is behind lastReady", async () => {
    const { git } = fakeGit({ ...HEALTHY_FROZEN, [lastReadyAncestorOf(FROZEN)]: null });
    const r = await resolveSelectionBase(base({ git, frozenCandidate: FROZEN }));
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("frozen-verdict-behind-last-ready");
  });

  it("reports anchor-at-last-ready when the frozen candidate IS lastReady", async () => {
    const { git } = fakeGit({});
    const r = await resolveSelectionBase(base({ git, frozenCandidate: LAST_READY }));
    expect(r.reason).toBe("anchor-at-last-ready");
  });
});

describe("selection base: the unconditional fallbacks", () => {
  it("honors the shared kill-switch value '0'", async () => {
    const { git, calls } = fakeGit(HEALTHY_WATERMARK);
    const r = await resolveSelectionBase(
      base({ git, env: { [SELECTION_BASE_DISABLE_ENV]: "0" } }),
    );
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  it("does NOT disable on other env values", async () => {
    const { git } = fakeGit(HEALTHY_WATERMARK);
    const r = await resolveSelectionBase(
      base({ git, env: { [SELECTION_BASE_DISABLE_ENV]: "1" } }),
    );
    expect(r.source).toBe("watermark");
  });

  it("falls back when lastReady is null (no shrink-only guard is provable)", async () => {
    const { git } = fakeGit(HEALTHY_WATERMARK);
    const r = await resolveSelectionBase(base({ git, lastReady: null }));
    expect(r).toMatchObject({ base: null, source: "last-ready", reason: "no-last-ready" });
  });

  it("falls back when judgedHead is null", async () => {
    const { git } = fakeGit(HEALTHY_WATERMARK);
    const r = await resolveSelectionBase(base({ git, judgedHead: null }));
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("no-judged-head");
  });

  it("falls back when no git runner is supplied", async () => {
    const r = await resolveSelectionBase(base());
    expect(r.base).toBe(LAST_READY);
    expect(r.reason).toBe("no-git-runner");
  });
});

describe("selectionBaseGitFor", () => {
  it("returns null for ANY failure (nonexistent repo) instead of throwing", async () => {
    const git = selectionBaseGitFor("/nonexistent/selection-base-test-dir");
    await expect(git(["rev-parse", "HEAD"])).resolves.toBeNull();
  });
});

describe("selectionBaseLine (provenance is never silent)", () => {
  const shortOf = (s: string) => s.slice(0, 12);

  it("names source, base, and the advanced-from sha on an advanced resolution", () => {
    const r: SelectionBaseResult = { base: WATERMARK, source: "watermark", reason: "watermark" };
    const line = selectionBaseLine(r, LAST_READY);
    expect(line).toContain("SELECTION_BASE source=watermark");
    expect(line).toContain(`base=${shortOf(WATERMARK)}`);
    expect(line).toContain(`advancedFrom=${shortOf(LAST_READY)}`);
    expect(line).toContain(`${SELECTION_BASE_DISABLE_ENV}=0`);
  });

  it("names the refusal reason and the rejected anchor on a fallback", () => {
    const r: SelectionBaseResult = {
      base: LAST_READY,
      source: "last-ready",
      reason: "watermark-behind-last-ready",
      rejectedAnchor: WATERMARK,
    };
    const line = selectionBaseLine(r, LAST_READY);
    expect(line).toContain("source=last-ready");
    expect(line).toContain("reason=watermark-behind-last-ready");
    expect(line).toContain(`rejected=${shortOf(WATERMARK)}`);
  });
});
