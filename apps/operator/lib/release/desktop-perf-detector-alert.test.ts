/**
 * WI-39685 / cutover-plan D-013: the desktop-perf DETECTOR alert.
 *
 * THE BUG THIS GUARDS. D-008 stopped an UNMEASURED desktop-perf invariant from
 * holding promotion — correct on its own terms, because an unmeasurable sample is
 * not evidence of a regression. But it left the failure SILENT: a permanently
 * absent detector became indistinguishable from a permanently healthy one, and the
 * gate advances forever on an invariant nobody is checking.
 *
 * The alert closing that hole has THREE ways to be born dead, and each is a
 * plausible copy-paste from the gate's own escalation right beside it. All three
 * are asserted here, because an alert that never fires is worse than no alert:
 * it reads as evidence of health.
 *
 *   1. SELF-CLEARING (the close bar, D-013 rev 52). `clearEscalation()` sweeps by
 *      SOURCE — every open row with `source === 'green-checkpoint'` — and it runs
 *      on the ADVANCE path. Post-D-008 an unmeasured leg no longer holds, so the
 *      run ALWAYS reaches that sweep: an alert sharing the gate's source would
 *      open and resolve ~120 lines later in the SAME run. A page that clears
 *      itself is no page.
 *   2. SPAM (D-013 rev 54, trap 1). The gate's dedup guard also matches on the
 *      gate's own source, so it does not see a detector row — without a dedup of
 *      its own the alert re-opens on every hourly tick, and an hourly page for a
 *      standing condition is one the operator learns to dismiss.
 *   3. IMMORTAL (D-013 rev 54, trap 2). The row opts OUT of the attention TTL
 *      sweep, and `clearEscalation()` will never touch it — so if nothing else
 *      closes it, it stays open forever and the next real absence is invisible.
 *
 * Note the shape of 2 and 3: they are OPPOSITE failures with the same cause — the
 * detector borrowing a lifecycle that is not its own. That is why the fix is a
 * distinct source plus its own open/clear pair, not a tweak to the gate's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = { msg_id: string; source?: unknown };

const store: { rows: Row[]; resolved: string[]; opened: unknown[] } = {
  rows: [],
  resolved: [],
  opened: [],
};

vi.mock(
  "@papercusp/operator-core/lib/agent-tools/coordination/escalations",
  () => ({
    listEscalations: async () => store.rows,
    resolveEscalation: async (input: { msg_id: string }) => {
      store.resolved.push(input.msg_id);
      return {};
    },
    openEscalation: async (identity: unknown, input: unknown) => {
      store.opened.push(input);
      return {};
    },
  }),
);

vi.mock("@papercusp/operator-core/lib/attention/reconcile-escalations", () => ({
  SELF_RECONCILING_META_KEY: "selfReconciling",
}));

const {
  desktopPerfDetectorAbsent,
  openDetectorEscalation,
  clearDetectorEscalation,
  realCheckpointDeps,
  GATE_ESCALATION_SOURCE,
  DETECTOR_ESCALATION_SOURCE,
} = await import("./green-checkpoint");
const { releaseConfig } = await import("./release-config");

const SHA = "d8cf3aa0c00b1111222233334444555566667777";

/** The two sources must differ — every property below is downstream of that. */
it("the detector's source is DISTINCT from the gate's", () => {
  expect(DETECTOR_ESCALATION_SOURCE).not.toBe(GATE_ESCALATION_SOURCE);
});

describe("D-013 discriminant — desktopPerfDetectorAbsent", () => {
  it("FIRES on the dangerous case: the gate ran, could not measure, no longer holds", () => {
    expect(
      desktopPerfDetectorAbsent({ action: "warn", verdictStatus: "unknown" }),
    ).toBe(true);
  });

  it("is SILENT on the D-007 no-desktop-app skip (action=pass, verdictStatus=unknown)", () => {
    // The single-field simplification D-013 exists to forbid would page here, on a
    // correct and permanent state — the fastest way to train a reader to ignore it.
    expect(
      desktopPerfDetectorAbsent({ action: "pass", verdictStatus: "unknown" }),
    ).toBe(false);
  });

  it("is SILENT on an ordinary MEASURED warn or block (the gate already escalates those)", () => {
    expect(
      desktopPerfDetectorAbsent({ action: "warn", verdictStatus: "warn" }),
    ).toBe(false);
    expect(
      desktopPerfDetectorAbsent({ action: "block", verdictStatus: "crit" }),
    ).toBe(false);
  });

  it("is SILENT when there is no verdict to read at all", () => {
    expect(desktopPerfDetectorAbsent(undefined)).toBe(false);
    // A legacy stub reporting no verdictStatus tells us nothing; "nothing" must
    // never be read as "unmeasured".
    expect(desktopPerfDetectorAbsent({ action: "warn" })).toBe(false);
  });
});

describe("detector lifecycle — dedup (trap 1) and clear (trap 2)", () => {
  beforeEach(() => {
    store.rows = [];
    store.resolved = [];
    store.opened = [];
  });

  const io = {
    list: async () => store.rows,
    open: async (summary: string) => {
      store.rows.push({ msg_id: `m${store.rows.length}`, source: DETECTOR_ESCALATION_SOURCE });
      store.opened.push(summary);
    },
    resolve: async (msg_id: string) => {
      store.resolved.push(msg_id);
    },
  };

  it("DEDUPS on its own source — a standing condition pages once, not hourly", async () => {
    await openDetectorEscalation(io, "detector absent", "body");
    await openDetectorEscalation(io, "detector absent", "body");
    await openDetectorEscalation(io, "detector absent", "body");
    expect(store.opened).toHaveLength(1);
  });

  it("is NOT suppressed by an open GATE escalation — the lifecycles are independent", async () => {
    // The inverse of the sweep bug: if the detector deduped on the gate's source,
    // a red gate would MASK the detector alert exactly when both are true.
    store.rows.push({ msg_id: "gate-1", source: GATE_ESCALATION_SOURCE });
    await openDetectorEscalation(io, "detector absent", "body");
    expect(store.opened).toHaveLength(1);
  });

  it("CLEARS its own row when the invariant is measured again", async () => {
    store.rows.push({ msg_id: "det-1", source: DETECTOR_ESCALATION_SOURCE });
    await clearDetectorEscalation(io);
    expect(store.resolved).toEqual(["det-1"]);
  });

  it("clearing the detector does NOT touch the gate's own escalation", async () => {
    store.rows.push({ msg_id: "gate-1", source: GATE_ESCALATION_SOURCE });
    store.rows.push({ msg_id: "det-1", source: DETECTOR_ESCALATION_SOURCE });
    await clearDetectorEscalation(io);
    expect(store.resolved).toEqual(["det-1"]);
  });
});

describe("SURVIVES THE RUN (D-013 rev 52 close bar)", () => {
  beforeEach(() => {
    store.rows = [];
    store.resolved = [];
    store.opened = [];
  });

  it("the REAL green-recovery sweep resolves the gate's row and leaves the detector's OPEN", async () => {
    // This drives the REAL `clearEscalation` dep — the very sweep that runs on the
    // advance path — not a re-implementation of its predicate. Widen that sweep to
    // match the detector source (a prefix match, a source-agnostic clear) and this
    // goes red, which is the entire point of asserting it here.
    store.rows = [
      { msg_id: "gate-1", source: GATE_ESCALATION_SOURCE },
      { msg_id: "det-1", source: DETECTOR_ESCALATION_SOURCE },
    ];

    const deps = realCheckpointDeps(releaseConfig({}));
    await deps.clearEscalation!();

    expect(store.resolved).toContain("gate-1");
    expect(store.resolved).not.toContain("det-1");
  });

  it("the real escalateDetector stamps the DETECTOR source, not the gate's", async () => {
    // The copy-paste failure mode: cloning the gate's escalate() and forgetting to
    // change meta.source produces an alert that looks correct in review and is
    // swept out of existence on every run.
    const deps = realCheckpointDeps(releaseConfig({}));
    await deps.escalateDetector!("detector absent", "body");

    expect(store.opened).toHaveLength(1);
    const meta = (store.opened[0] as { meta?: Record<string, unknown> }).meta;
    expect(meta?.source).toBe(DETECTOR_ESCALATION_SOURCE);
    expect(meta?.source).not.toBe(GATE_ESCALATION_SOURCE);
    // Opting out of the TTL sweep is only safe BECAUSE clearDetectorEscalation
    // exists; assert the opt-out so the pairing stays visible.
    expect(meta?.selfReconciling).toBe(true);
  });

  it("the real clearDetectorEscalation resolves a detector row through the real store", async () => {
    store.rows = [{ msg_id: "det-9", source: DETECTOR_ESCALATION_SOURCE }];
    const deps = realCheckpointDeps(releaseConfig({}));
    await deps.clearDetectorEscalation!();
    expect(store.resolved).toEqual(["det-9"]);
  });
});

/** Guards the call-site placement: the detector must observe the BLOCK outcome
 *  too, and the block branch returns. Asserted at the discriminant level because
 *  a block with an unknown verdict is exactly the case that would be skipped if
 *  the detector were placed after the early return. */
it("the discriminant fires for a BLOCK whose verdict is unmeasured", () => {
  expect(
    desktopPerfDetectorAbsent({ action: "block", verdictStatus: "unknown" }),
  ).toBe(true);
  void SHA;
});
