/**
 * inbox-intent-exclusion.test.ts — P-005 (fleet-member-dx-improvements-2026-07-10).
 *
 * Peers' auto `now working on:` intent-declares (lifecycle:'intent') are presence
 * state double-delivered as messages: on a busy fleet they dominate the default
 * inbox window and make `summary.total` meaningless (observed: the bulk of a
 * 2,332-message inbox). The pure rule under test: excluded from the DEFAULT read
 * (counted, like ambient), KEPT for an explicit `include_intents` opt-in OR a
 * sender-scoped `from` read (which wants that sender's status line). D-003: they
 * remain in the mid-turn `[coord+N]` injection — that path is wired in the
 * handler off the intent-INCLUSIVE list (asserted structurally here via the
 * exported rule; the injection wiring is exercised by the handler tests).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/inbox-intent-exclusion.test.ts
 */
import { describe, expect, it } from "vitest";
import { excludeIntentDeclares, prioritizedInboxWindow } from "./inbox";

const entries = [
  { msg_id: "m1", kind: "message", summary: "real directed message" },
  {
    msg_id: "m2",
    kind: "message",
    auto: true,
    lifecycle: "intent",
    summary: "now working on: something",
  },
  { msg_id: "m3", kind: "message", lifecycle: "claim", summary: "picked up WI-1" },
  {
    msg_id: "m4",
    kind: "message",
    auto: true,
    lifecycle: "intent",
    summary: "now working on: something else",
  },
];

describe("excludeIntentDeclares — P-005 fleet-member-dx", () => {
  it("default read drops lifecycle:'intent' rows and counts them", () => {
    const { kept, excluded } = excludeIntentDeclares(entries, {});
    expect(kept.map((e) => e.msg_id)).toEqual(["m1", "m3"]);
    expect(excluded).toBe(2);
  });

  it("include_intents keeps everything (opt-in)", () => {
    const { kept, excluded } = excludeIntentDeclares(entries, {
      includeIntents: true,
    });
    expect(kept).toHaveLength(4);
    expect(excluded).toBe(0);
  });

  it("a sender-scoped `from` read keeps them (that sender's status line is the point)", () => {
    const { kept, excluded } = excludeIntentDeclares(entries, {
      from: "su-63834d42",
    });
    expect(kept).toHaveLength(4);
    expect(excluded).toBe(0);
  });

  it("non-intent lifecycles (claim, …) always pass", () => {
    const { kept } = excludeIntentDeclares(entries, {});
    expect(kept.some((e) => e.lifecycle === "claim")).toBe(true);
  });

  it("keeps a manually-authored intent-labelled message", () => {
    const manual = {
      msg_id: "manual",
      kind: "message",
      lifecycle: "intent",
      to: ["owner-a"],
      summary: "please review this intent change",
    };
    const { kept, excluded } = excludeIntentDeclares([manual], {});
    expect(kept).toEqual([manual]);
    expect(excluded).toBe(0);
  });

  it("no intents ⇒ zero excluded, list untouched", () => {
    const plain = [{ msg_id: "a", kind: "message" }];
    const { kept, excluded } = excludeIntentDeclares(plain, {});
    expect(kept).toEqual(plain);
    expect(excluded).toBe(0);
  });

  it("P-009 priority window still keeps non-intent claim/dependency rows above ordinary messages", () => {
    const rows = [
      { msg_id: "ordinary", ts: "2026-08-27T00:03:00Z", kind: "message" },
      { msg_id: "claim", ts: "2026-08-27T00:01:00Z", kind: "message", lifecycle: "claim" },
      { msg_id: "ask", ts: "2026-08-27T00:02:00Z", kind: "message", expects: "answer" },
    ];
    expect(prioritizedInboxWindow(rows, 2).map((e) => e.msg_id)).toEqual([
      "ask",
      "claim",
    ]);
  });
});
