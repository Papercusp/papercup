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
}));

vi.mock("../log", () => ({
  coordLog: { readLines: M.readLines },
  coordSql: () => {
    throw new Error("no PG in this test");
  },
  coordWorkspaceId: () => "ws-test",
  coordHasPgFastPath: () => false,
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

beforeEach(() => {
  vi.clearAllMocks();
  M.readLines.mockImplementation(async () => []);
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
      last_seen: at(5),
      latest_summary: "latest",
      resolved_at: null,
    });
  });

  it("alarm + later resolution ⇒ RESOLVED; re-alarm after ⇒ re-OPEN", () => {
    const resolved = computeConditionStates([alarm(1, "k"), resolution(2, "k")]);
    expect(resolved[0]).toMatchObject({ open: false, resolved_at: at(2) });

    const reopened = computeConditionStates([
      alarm(1, "k"),
      resolution(2, "k"),
      alarm(3, "k"),
    ]);
    expect(reopened[0]).toMatchObject({ open: true, alarm_count: 2, last_seen: at(3) });
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
});

describe("coord:conditions handler", () => {
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
