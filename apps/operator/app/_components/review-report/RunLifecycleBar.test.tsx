/**
 * P-007 / D-004 — the run-lifecycle state machine.
 *
 * The defect this closes: `stop`, `restart`, `resume`, `recheck-finding` and
 * `dismiss-finding` all existed on the route and were reachable ONLY from the
 * progress strip — which the report takeover replaces the moment a run
 * settles. From inside the report the entire action set was Apply-selected and
 * Close, so a run that stopped halfway was a dead end and a run that
 * auto-applied everything rendered nothing at all.
 *
 * The priority ORDER is the part worth pinning: what is happening NOW outranks
 * what the run nominally is, and a resolver that stopped reporting outranks the
 * phase it is still recorded in.
 */
import { describe, expect, it } from "vitest";
import {
  REPORT_STALE_AFTER_MS,
  deriveRunLifecycleState,
  type RunLifecycleInput,
} from "./RunLifecycleBar";

const input = (overrides: Partial<RunLifecycleInput> = {}): RunLifecycleInput => ({
  phase: "review",
  total: 10,
  decided: 10,
  notAssessed: 0,
  autoApplied: 0,
  open: 4,
  ...overrides,
});

const intents = (state: { actions: Array<{ intent: string }> }) =>
  state.actions.map((action) => action.intent);

describe("deriveRunLifecycleState", () => {
  it("an in-flight apply outranks everything, including a dead resolver", () => {
    const state = deriveRunLifecycleState(
      input({
        applying: { done: 3, total: 8, current: "plan#P-002" },
        phase: "failed",
        liveness: { state: "stale", ageMs: 900_000, measuredFrom: "heartbeat" },
      }),
    );
    expect(state.tone).toBe("live");
    expect(state.headline).toContain("3 done");
    expect(state.detail).toContain("plan#P-002");
    expect(state.progress).toBeCloseTo(3 / 8);
    expect(intents(state)).toEqual(["stop"]);
  });

  it("a partial batch failure is reported as a batch, with a retry path", () => {
    const state = deriveRunLifecycleState(
      input({ applyResult: { applied: 5, failed: 2 } }),
    );
    expect(state.headline).toBe("5 applied, 2 failed");
    expect(state.detail).toContain("Nothing was left half-written");
    expect(intents(state)).toEqual(["recheck", "reveal"]);
  });

  it("a clean batch result does NOT hijack the bar", () => {
    // Only a FAILED count earns the summary state; an all-green apply falls
    // through to whatever the run now is.
    const state = deriveRunLifecycleState(
      input({ applyResult: { applied: 5, failed: 0 } }),
    );
    expect(state.headline).not.toContain("applied,");
  });

  it("a failed run states its own error and offers a re-run", () => {
    const state = deriveRunLifecycleState(
      input({ phase: "failed", error: "resolver OOM" }),
    );
    expect(state.tone).toBe("bad");
    expect(state.detail).toBe("resolver OOM");
    expect(intents(state)).toEqual(["rerun"]);
  });

  it("a failed run with no recorded error says so instead of rendering blank", () => {
    const state = deriveRunLifecycleState(
      input({ phase: "failed", error: "   " }),
    );
    expect(state.detail).toContain("not recorded");
  });

  it("a stale resolver outranks the phase the run is still recorded in", () => {
    // The run still says "running" precisely BECAUSE nothing is alive to
    // settle it — so reporting "Assessing…" would be the lie.
    const state = deriveRunLifecycleState(
      input({
        phase: "running",
        liveness: { state: "stale", ageMs: 3_600_000, measuredFrom: "heartbeat" },
        notAssessed: 6,
      }),
    );
    expect(state.headline).toBe("The resolver stopped reporting");
    expect(state.detail).toContain("6 findings were left unassessed");
    expect(intents(state)).toEqual(["restart", "stop"]);
  });

  it("distinguishes a resolver that never reported from one that went quiet", () => {
    const never = deriveRunLifecycleState(
      input({
        phase: "running",
        liveness: { state: "stale", ageMs: 600_000, measuredFrom: "start" },
      }),
    );
    expect(never.detail).toContain("never reported after launching");
  });

  it("reports live progress while the run is actually running", () => {
    const state = deriveRunLifecycleState(
      input({ phase: "running", total: 20, decided: 5, open: 0 }),
    );
    expect(state.headline).toBe("Assessing — 5 of 20");
    expect(state.progress).toBeCloseTo(0.25);
    expect(intents(state)).toEqual(["stop"]);
  });

  it("a running scan with nothing found yet has no measurable progress", () => {
    const state = deriveRunLifecycleState(
      input({ phase: "running", total: 0, decided: 0, open: 0 }),
    );
    expect(state.headline).toBe("Scanning…");
    expect(state.progress).toBeNull();
  });

  it("R5: a stopped run offers RESUME, not manual work", () => {
    // Unreached findings carry outcome `pending` and used to render as manual
    // — "no action is available" for work that just needs the run resumed.
    const state = deriveRunLifecycleState(
      input({ phase: "review", total: 10, decided: 4, notAssessed: 6 }),
    );
    expect(state.headline).toBe("This run stopped before it finished");
    expect(state.detail).toContain("6 findings were never judged");
    expect(intents(state)).toEqual(["resume", "rerun"]);
  });

  it("stale rows outrank a plain age warning", () => {
    const state = deriveRunLifecycleState(
      input({ staleRows: 3, ageMs: REPORT_STALE_AFTER_MS * 2 }),
    );
    expect(state.headline).toBe("3 rows changed since the scan");
    expect(intents(state)).toEqual(["recheck", "reveal"]);
  });

  it("warns on an old report only while something is still open", () => {
    const old = { ageMs: REPORT_STALE_AFTER_MS + 60_000 };
    expect(deriveRunLifecycleState(input({ ...old, open: 2 })).icon).toBe("⧗");
    // Nothing open means nothing to overwrite — the age is not the owner's
    // problem, so it must not shout at them.
    expect(
      deriveRunLifecycleState(input({ ...old, open: 0, autoApplied: 10 }))
        .headline,
    ).toContain("Papercup fixed");
  });

  it("D-004: a `complete` run renders a real state instead of nothing", () => {
    const state = deriveRunLifecycleState(
      input({ phase: "complete", total: 7, decided: 7, autoApplied: 7, open: 0 }),
    );
    expect(state.tone).toBe("good");
    expect(state.headline).toBe("Papercup fixed 7 findings on its own");
    expect(intents(state)).toEqual(["rerun"]);
  });

  it("an empty scan says nothing was wrong, not that nothing happened", () => {
    const state = deriveRunLifecycleState(
      input({ phase: "complete", total: 0, decided: 0, open: 0 }),
    );
    expect(state.headline).toBe("Nothing to clean up");
    expect(state.detail).toContain("no problems in this scope");
  });

  it("the ordinary review state names what is waiting on the owner", () => {
    const state = deriveRunLifecycleState(
      input({ phase: "review", open: 4, autoApplied: 6 }),
    );
    expect(state.headline).toBe("4 findings waiting on you");
    expect(state.detail).toContain("6 findings were fixed automatically");
  });

  it("uses the consumer's unit word, so Inbox does not say 'finding'", () => {
    const state = deriveRunLifecycleState(input({ open: 1, unit: "item" }));
    expect(state.headline).toBe("1 item waiting on you");
  });
});
