/**
 * coord:conditions — folding condition-keyed severe-event broadcasts into live
 * open/resolved STATE (EI-6138; the WI-1444 lifecycle reader). Pure fold +
 * handler pins with the coord log seam mocked (non-PG path). Pins:
 *   • an un-resolved alarm is OPEN; alarm+later-resolution is RESOLVED;
 *   • a re-alarm AFTER the latest resolution re-OPENS the key;
 *   • repeated alarms fold: alarm_count, first_seen, last_seen, latest summary;
 *   • a resolution for a never-seen key records as resolved, never open;
 *   • ordering: open first, then most-recently-active;
 *   • handler: open/resolved split, include_resolved:false, resolved_limit.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conditions.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const M = vi.hoisted(() => ({
  readLines: vi.fn(async () => [] as unknown[]),
  pgFastPath: false,
  pgQuery: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));

vi.mock("../log", () => ({
  coordLog: { readLines: M.readLines },
  coordSql: () => M.pgQuery,
  coordWorkspaceId: () => "ws-test",
  coordHasPgFastPath: () => M.pgFastPath,
}));

import tool, { computeConditionStates } from "./conditions";

const ctx = (): never =>
  ({ ownerId: "owner-a", workspaceId: "ws-test", metadata: vi.fn(), log: vi.fn(), progress: vi.fn() }) as never;

type Out = {
  open_count: number;
  open: Array<Record<string, unknown>>;
  resolved_count: number;
  resolved: Array<Record<string, unknown>>;
};
const call = async (args: Record<string, unknown> = {}): Promise<Out> => {
  const res = (await tool.handler(args as never, ctx())) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0]!.text) as Out;
};

const at = (m: number) => `2026-07-01T10:${String(m).padStart(2, "0")}:00.000Z`;
const alarm = (m: number, key: string, summary = `alarm ${key}`) => ({
  ts: at(m),
  msg_id: `a-${key}-${m}`,
  from: "system-watchdog",
  to: ["*"],
  kind: "message",
  category: "severe-event",
  summary,
  condition_key: key,
});
const resolution = (m: number, key: string, summary = `recovered ${key}`) => ({
  ts: at(m),
  msg_id: `r-${key}-${m}`,
  from: "system-watchdog",
  to: ["*"],
  kind: "message",
  category: "severe-event-resolved",
  summary,
  condition_key: key,
  resolves_condition: key,
});
/** EI-9030b batched resolution — broadcastSevereEventResolvedMany's shape:
 *  `resolves_conditions` (plural array) naming every key it supersedes, PLUS the
 *  singular `resolves_condition`/`condition_key` stamped to the first key only
 *  (byte-compat for a reader that only knows the singular shape). */
const resolutionMany = (m: number, keys: string[], summary = `RECOVERED (${keys.join(", ")})`) => ({
  ts: at(m),
  msg_id: `rm-${m}`,
  from: "system-watchdog",
  to: ["*"],
  kind: "message",
  category: "severe-event-resolved",
  summary,
  resolves_conditions: keys,
  resolves_condition: keys[0],
  condition_key: keys[0],
});

beforeEach(() => {
  vi.clearAllMocks();
  M.readLines.mockImplementation(async () => []);
  M.pgFastPath = false;
  M.pgQuery.mockImplementation(async (..._args: unknown[]) => []);
});

describe("computeConditionStates (pure)", () => {
  it("an un-resolved alarm is OPEN with fold fields", () => {
    const [s] = computeConditionStates([
      alarm(1, "k", "first"),
      alarm(5, "k", "latest"),
      alarm(3, "k", "middle"),
    ]);
    expect(s).toMatchObject({
      condition_key: "k",
      open: true,
      alarm_count: 3,
      first_seen: at(1),
      // never-resolved ⇒ the current episode began at the first alarm.
      open_since: at(1),
      last_seen: at(5),
      latest_summary: "latest",
      resolved_at: null,
    });
  });

  it("alarm + later resolution ⇒ RESOLVED; re-alarm after ⇒ re-OPEN", () => {
    const resolved = computeConditionStates([alarm(1, "k"), resolution(2, "k")]);
    // resolved ⇒ no current open episode.
    expect(resolved[0]).toMatchObject({ open: false, resolved_at: at(2), open_since: null });

    const reopened = computeConditionStates([
      alarm(1, "k"),
      resolution(2, "k"),
      alarm(3, "k"),
    ]);
    // EI-10653: the re-alarm opens a FRESH episode — open_since tracks the reopen
    // (at 3), not the first-ever alarm (at 1) which first_seen still pins.
    expect(reopened[0]).toMatchObject({
      open: true,
      alarm_count: 2,
      first_seen: at(1),
      open_since: at(3),
      last_seen: at(3),
    });
  });

  it("EI-14072: a batched resolution naming N keys (resolves_conditions) closes EVERY named key, not just the first", () => {
    const states = computeConditionStates([
      alarm(1, "panel:workItems"),
      alarm(1, "dead-routines"),
      alarm(1, "infra-liveness:panel:overwatch"),
      resolutionMany(5, ["panel:workItems", "dead-routines", "infra-liveness:panel:overwatch"]),
    ]);
    const byKey = new Map(states.map((s) => [s.condition_key, s]));
    for (const key of ["panel:workItems", "dead-routines", "infra-liveness:panel:overwatch"]) {
      expect(byKey.get(key)).toMatchObject({ open: false, resolved_at: at(5), open_since: null });
    }
  });

  it("EI-14072: a batched resolution for keys never seen still records each resolved, never open", () => {
    const states = computeConditionStates([resolutionMany(2, ["ghost-a", "ghost-b"])]);
    expect(states).toHaveLength(2);
    for (const st of states) {
      expect(st).toMatchObject({ open: false, resolved_at: at(2) });
    }
  });

  it("a resolution for a never-seen key records resolved, never open", () => {
    const [s] = computeConditionStates([resolution(2, "ghost")]);
    expect(s).toMatchObject({
      condition_key: "ghost",
      open: false,
      alarm_count: 0,
      resolved_at: at(2),
    });
  });

  it("orders open first, then most-recently-active", () => {
    const states = computeConditionStates([
      alarm(1, "resolved-new"),
      resolution(8, "resolved-new"),
      alarm(2, "open-old"),
      alarm(9, "open-new"),
    ]);
    expect(states.map((s) => s.condition_key)).toEqual([
      "open-new",
      "open-old",
      "resolved-new",
    ]);
  });

  it("WI-6228: folds the emitter's one_shot declaration onto the state", () => {
    const [s] = computeConditionStates([
      { ...alarm(1, "origin-freshness:papercusp"), one_shot: true },
    ]);
    expect(s!.one_shot).toBe(true);
  });

  it("WI-6228: an undeclared alarm folds to one_shot false (legacy emitters unchanged)", () => {
    const [s] = computeConditionStates([alarm(1, "git-sync-stall:pot")]);
    expect(s!.one_shot).toBe(false);
  });

  it("WI-6228: the LATEST alarm decides one_shot — a re-alarm that drops the flag clears it", () => {
    // An emitter converted from one-shot to level-triggered must stop being
    // exempt from absence-resolution; the newest alarm describes it.
    const [s] = computeConditionStates([
      { ...alarm(1, "green-stall:pot"), one_shot: true },
      alarm(5, "green-stall:pot"),
    ]);
    expect(s!.one_shot).toBe(false);
    expect(s!.last_seen).toBe(at(5));
  });

  // ── P-007 (converge-frozen-candidate-by-fix-only-admission-2026-08-27) ──────────
  // The fold is what carries an emitter's `body` — "evidence + the recommended first
  // step" — onto the work-item the condition bridge mints. Folding only `summary`
  // discarded it for every condition family; measured live 2026-08-29, real bodies of
  // 543–1097 chars were being dropped on the floor.
  describe("latest_body — the emitter's fuller body survives the fold", () => {
    it("folds the alarm body alongside its summary", () => {
      const [s] = computeConditionStates([
        { ...alarm(1, "gate-red-streak:papercusp"), body: "WHERE TO FIX IT: the repair worktree" },
      ]);
      expect(s!.latest_body).toBe("WHERE TO FIX IT: the repair worktree");
      // Control: without the fold this field is undefined, not merely empty — so a
      // regression that removed it fails here rather than reading as "no body sent".
      expect(s!.latest_body).not.toBeUndefined();
    });

    it("is null when the emitter sent no body (most watchdogs)", () => {
      const [s] = computeConditionStates([alarm(1, "gate-red-streak:papercusp")]);
      expect(s!.latest_body).toBeNull();
    });

    it("CLEARS on a body-less re-alarm rather than carrying stale evidence forward", () => {
      // latest_body and latest_summary must always describe the SAME alarm. Carrying a
      // previous episode's evidence onto a fresh failure is worse than carrying none:
      // the claimant would act on a recommended first step for a different incident.
      const [s] = computeConditionStates([
        { ...alarm(1, "gate-red-streak:papercusp"), body: "old evidence" },
        alarm(5, "gate-red-streak:papercusp", "a fresh red"),
      ]);
      expect(s!.latest_summary).toBe("a fresh red");
      expect(s!.latest_body).toBeNull();
    });

    it("keeps the OLDER body when an out-of-order envelope is not the latest", () => {
      // The fold guards latest_* on `ts >= last_seen`; body must ride that same guard.
      const [s] = computeConditionStates([
        { ...alarm(5, "gate-red-streak:papercusp"), body: "current evidence" },
        { ...alarm(1, "gate-red-streak:papercusp"), body: "stale evidence" },
      ]);
      expect(s!.latest_body).toBe("current evidence");
    });
  });
});

describe("coord:conditions handler", () => {
  it("keeps recent PG resolutions inside the capped window and folds it chronologically", async () => {
    const key = "bounded-condition";
    M.pgFastPath = true;
    M.pgQuery.mockImplementation(async (..._args: unknown[]) => [
      { body: resolution(2, key) },
      { body: alarm(1, key) },
    ]);

    const out = await call();

    const template = M.pgQuery.mock.calls[0]?.[0] as TemplateStringsArray | undefined;
    expect(template?.join(" ")).toContain("ORDER BY id DESC");
    expect(out.open_count).toBe(0);
    expect(out.resolved[0]).toMatchObject({
      condition_key: key,
      first_seen: at(1),
      last_seen: at(1),
      latest_summary: "alarm " + key,
      resolved_at: at(2),
    });
  });

  it("splits open vs resolved over the seam read", async () => {
    M.readLines.mockImplementation(async () => [
      alarm(1, "git-sync-stall:papercusp"),
      resolution(2, "git-sync-stall:papercusp"),
      alarm(3, "green-stall:papercusp"),
      { ts: at(4), msg_id: "noise", from: "peer", to: ["*"], kind: "message", summary: "unrelated" },
    ]);
    const out = await call();
    expect(out.open_count).toBe(1);
    expect(out.open[0]).toMatchObject({
      condition_key: "green-stall:papercusp",
      open: true,
    });
    expect(out.resolved_count).toBe(1);
    expect(out.resolved[0]).toMatchObject({
      condition_key: "git-sync-stall:papercusp",
      resolved_at: at(2),
    });
  });

  it("include_resolved:false returns open only; resolved_limit caps the list", async () => {
    M.readLines.mockImplementation(async () => [
      alarm(1, "a"),
      resolution(2, "a"),
      alarm(3, "b"),
      resolution(4, "b"),
      alarm(5, "c"),
      resolution(6, "c"),
    ]);
    const openOnly = await call({ include_resolved: false });
    expect(openOnly.resolved).toEqual([]);
    expect(openOnly.resolved_count).toBe(3);

    const capped = await call({ resolved_limit: 2 });
    expect(capped.resolved).toHaveLength(2);
    // most recent first
    expect(capped.resolved.map((s) => s.condition_key)).toEqual(["c", "b"]);
  });
});
