/**
 * EI-19493603840800478 — REMOTE-ORIGIN marking on coord:inbox entries.
 *
 * The defect this pins: a federated severe-event names only a HARNESS SLUG
 * ("git-sync FAULTING on papercusp"), and slugs are identical on every federated
 * node. So a peer's alarm about ITS OWN install renders locally as a claim about
 * the tree the reader is standing in, and is locally UNFALSIFIABLE — healthy local
 * state cannot distinguish "already recovered" from "never was about this machine".
 * Measured 2026-08-04: every "git-sync FAULTING on papercusp" row back to
 * 2026-07-17 carried origin='remote' while the local routine read last_error=NULL
 * and wd_error_sweeps=0. Two agents in a row mis-attributed it to a local cause.
 *
 * These are PURE tests of the annotation. The DB half (getRemoteOriginMsgIds) is
 * fail-soft by construction and integration-covered with the rest of messages.ts.
 */
import { describe, it, expect } from "vitest";
import { annotateRemoteOrigin, REMOTE_ORIGIN_NOTE } from "./inbox";

const alarm = (msgId: string, key = "git-sync-stall:papercusp") => ({
  ts: "2026-08-04T04:00:51.672Z",
  msg_id: msgId,
  kind: "message",
  from: "system-watchdog",
  category: "severe-event",
  condition_key: key,
  summary: "git-sync FAULTING on papercusp — commits may not be landing.",
});

const plainMessage = (msgId: string) => ({
  ts: "2026-08-04T04:00:51.672Z",
  msg_id: msgId,
  kind: "message",
  from: "su-peer",
  summary: "just a note from a peer agent",
});

describe("annotateRemoteOrigin (pure)", () => {
  it("marks a remote severe-event with BOTH origin and the warning note", () => {
    const a = alarm("m-remote");
    const out = annotateRemoteOrigin([a], new Set(["m-remote"]));
    expect(out[0]).toMatchObject({
      origin: "remote",
      remote_origin_note: REMOTE_ORIGIN_NOTE,
    });
    // the original entry is never mutated (entries can be live coord-log refs)
    expect((a as Record<string, unknown>)["origin"]).toBeUndefined();
  });

  it("a remote PLAIN message gets origin but NOT the infra warning", () => {
    const p = plainMessage("m-remote");
    const out = annotateRemoteOrigin([p], new Set(["m-remote"]));
    expect(out[0]!["origin"]).toBe("remote");
    // Warning on ordinary peer chatter would train the reader to skip the marker.
    expect(out[0]!["remote_origin_note"]).toBeUndefined();
  });

  it("CONTROL: a LOCAL entry is passed through by IDENTITY — never marked", () => {
    // The failure that matters most is a false positive: marking a genuinely local
    // alarm remote would teach agents to ignore real local stalls.
    const local = alarm("m-local");
    const out = annotateRemoteOrigin([local], new Set(["m-remote"]));
    expect(out[0]).toBe(local);
    expect(out[0]!["origin"]).toBeUndefined();
    expect(out[0]!["remote_origin_note"]).toBeUndefined();
  });

  it("CONTROL: an empty remote set returns the SAME array reference (no churn)", () => {
    const entries = [alarm("m-a"), plainMessage("m-b")];
    expect(annotateRemoteOrigin(entries, new Set())).toBe(entries);
  });

  it("marks only the remote members of a mixed page", () => {
    const remote = alarm("m-remote");
    const local = alarm("m-local", "git-sync-stall:other");
    const out = annotateRemoteOrigin([remote, local], new Set(["m-remote"]));
    expect(out[0]!["origin"]).toBe("remote");
    expect(out[1]).toBe(local);
  });

  it("treats a condition_key entry as infra-asserting even without a category", () => {
    const e = {
      ts: "2026-08-04T04:00:51.672Z",
      msg_id: "m-remote",
      kind: "message",
      condition_key: "git-sync-stall:papercusp",
    };
    const out = annotateRemoteOrigin([e], new Set(["m-remote"]));
    expect(out[0]!["remote_origin_note"]).toBe(REMOTE_ORIGIN_NOTE);
  });

  it("an entry with no msg_id is passed through untouched", () => {
    const e = { ts: "2026-08-04T04:00:51.672Z", kind: "message", category: "severe-event" };
    const out = annotateRemoteOrigin([e], new Set(["m-remote"]));
    expect(out[0]).toBe(e);
  });

  it("CONTROL IS FALSIFIABLE: the plausible wrong implementation FAILS the checks above", () => {
    // A guard that has never failed is a guard that has not been tested. The most
    // likely wrong implementation is "mark every entry on a page that contains any
    // remote row" — it looks right, passes the happy path, and would re-create the
    // original defect with the sign flipped (real LOCAL stalls dismissed as remote).
    // Proving THIS is rejected is what gives the local-identity control its teeth.
    const markEverything = <T extends Record<string, unknown>>(
      entries: readonly T[],
      remoteMsgIds: ReadonlySet<string>,
    ): Array<Record<string, unknown>> =>
      remoteMsgIds.size === 0
        ? (entries as unknown as Array<Record<string, unknown>>)
        : entries.map((e) => ({ ...e, origin: "remote" }));

    const local = alarm("m-local");
    const remoteSet = new Set(["m-remote"]);

    // The real implementation leaves a local entry identical...
    expect(annotateRemoteOrigin([local], remoteSet)[0]).toBe(local);
    // ...while the naive one marks it remote — so the control discriminates.
    expect(markEverything([local], remoteSet)[0]!["origin"]).toBe("remote");
    expect(markEverything([local], remoteSet)[0]).not.toBe(local);
  });

  it("the note names the misreading AND the destructive act it prevents", () => {
    // Both were observed on the real incident; a note that omits either lets the
    // reader keep the belief that caused the misdiagnosis.
    expect(REMOTE_ORIGIN_NOTE).toMatch(/DIFFERENT node/i);
    expect(REMOTE_ORIGIN_NOTE).toMatch(/rescue-commit/i);
  });
});
