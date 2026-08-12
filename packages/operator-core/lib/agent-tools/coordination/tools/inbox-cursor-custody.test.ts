/**
 * coord:inbox — server-side cursor custody, and the DELETION of the agent-facing
 * `since_ts` parameter (plan fleet-deltas-leader-primitives-2026-07-10, D-002
 * rollout item 3; decision D-013).
 *
 * WHAT THIS PINS, and why each one is a thing that can regress SILENTLY:
 *
 *  • D-013 R2 — `since_ts` is gone from the args schema. A re-add is the exact
 *    regression the plan exists to prevent (WI-1600: a caller that seeds a
 *    tail-poll to wall-clock `now` makes every earlier message invisible to
 *    every later poll, permanently). Nothing else fails if it comes back — the
 *    tool keeps working, agents just quietly get a footgun again.
 *
 *  • The WI-1600 CAUTION is gone from the description. That paragraph exists
 *    ONLY to police the parameter; leaving it after the parameter is deleted
 *    teaches agents to reach for an argument that no longer exists, which reads
 *    to them as a broken tool.
 *
 *  • D-013 R1 — the description states the VIEW contract. A cursor-derived floor
 *    would turn a second same-turn read into an empty result, which an agent
 *    reads as "my inbox is empty" — the same message-loss class this plan closes
 *    at the delivery layer (EI-20190140825808810). The sentence is the only
 *    place that promise is written down for the caller.
 *
 * These are deliberately CONTRACT assertions on the exported tool rather than
 * handler runs: the handler's behaviour is already covered by the sibling
 * inbox-*.test.ts files, and the property at risk here is the shape of the
 * agent-facing surface, not the read.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/inbox-cursor-custody.test.ts
 */
import { describe, expect, it } from "vitest";

import tool from "./inbox";
import { INBOX_CURSOR_SURFACE } from "../../activity/hook-bundle";

describe("EI-20224626485772812 — direct coord:inbox argument naming", () => {
  it("teaches direct callers to use limit, while reserving inboxLimit for coord:orient", () => {
    const keys = Object.keys(tool.args.shape);
    expect(keys).toContain("limit");
    expect(keys).not.toContain("inboxLimit");
    expect(tool.description).toMatch(/direct bound is `limit`/i);
    expect(tool.description).toMatch(/coord:orient\.inboxLimit.*maps/i);
    expect(JSON.stringify(tool.guidance ?? {})).toMatch(/bound a direct read with `limit`/i);
    expect(JSON.stringify(tool.guidance ?? {})).toMatch(/`inboxLimit` belongs to the `coord:orient` wrapper/i);
  });

  it("enumerates the supported direct filters and rejects the stale includeRead key", () => {
    const keys = Object.keys(tool.args.shape);
    for (const accepted of [
      "kinds",
      "from",
      "limit",
      "include_ambient",
      "includeAmbient",
      "include_intents",
      "max_body_chars",
      "unanswered_only",
    ]) {
      expect(keys).toContain(accepted);
    }
    expect(keys).not.toContain("includeRead");
    expect(tool.args.safeParse({ includeRead: false }).success).toBe(false);
    // The compact guidance intentionally omits the stale key; the strict args
    // schema above remains the enforcement surface for rejecting it.
    expect(JSON.stringify(tool.guidance ?? {})).not.toMatch(/includeRead/i);
  });

  it("documents that free-text q belongs to coord:feed, not coord:inbox", () => {
    expect(tool.description).toMatch(/free-text `q` is not an inbox argument/i);
    expect(tool.description).toMatch(/use `coord:feed`.*query matching/i);
    expect(Object.keys(tool.args.shape)).not.toContain("q");
  });
});

describe("coord:inbox — agent-facing since_ts is deleted (D-013 R2)", () => {
  it("does not declare a `since_ts` argument", () => {
    expect(Object.keys(tool.args.shape)).not.toContain("since_ts");
  });

  it("keeps the filters that are genuinely the caller's to choose", () => {
    // The deletion is scoped to the cursor. Narrowing filters are not cursors and
    // must survive it — removing them too would be a silent capability loss.
    const keys = Object.keys(tool.args.shape);
    for (const kept of ["kinds", "from", "limit", "unanswered_only"]) {
      expect(keys).toContain(kept);
    }
  });

  it("no longer carries the WI-1600 since_ts CAUTION in its description", () => {
    expect(tool.description).not.toMatch(/WI-1600/);
    expect(tool.description).not.toMatch(/since_ts/);
  });

  it("does not steer callers to a since_ts poll in its guidance", () => {
    const guidance = JSON.stringify(tool.guidance ?? {});
    expect(guidance).not.toMatch(/since_ts/);
  });
});

describe("coord:inbox — the VIEW contract is stated to the caller (D-013 R1)", () => {
  it("tells the caller a re-read re-shows the window rather than emptying out", () => {
    // Cheap-but-load-bearing: this is the promise that makes a same-turn second
    // read safe to interpret. Assert the PROMISE, not the prose, so the sentence
    // can be rewritten without failing here.
    expect(tool.description).toMatch(/VIEW/);
    expect(tool.description).toMatch(/not a delta/i);
  });
});

describe("coord:inbox — machine-readable result contract (EI-20243434212359053)", () => {
  it("skips the generic result door for programmatic inbox consumers", () => {
    expect((tool as { skipResultDoor?: string }).skipResultDoor).toBe("programmatic-caller");
  });
});

describe("read-cursor custody stays with the delivery path (D-013 R2/R3)", () => {
  it("the delivery surface is a single named constant, not a literal per call site", () => {
    // Two writers on one (owner, surface) two-phase cursor would promote a
    // pending floor the other never delivered against — at-least-once becomes
    // at-most-once, i.e. dropped mail. A shared constant is what keeps the
    // delivery path the sole custodian of this surface.
    expect(INBOX_CURSOR_SURFACE).toBe("inbox");
  });
});
