/**
 * Unit tests for the overwatch wake-state + liveness primitives
 * (overwatch-role-2026-06-15 B-09). The DB writes (`upsertRoutine`/`setRoutineActive`)
 * are mocked; the routine reads use a fake tagged-template. These pin the SHARED
 * SEAM B-04's declare-next-wake reuses: the routine name + target action, the
 * one-shot shape, the floor clamp, and the liveness staleness math.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const upsertRoutine = vi.fn();
const deleteRoutine = vi.fn();
const h = vi.hoisted(() => ({
  isWorkspaceCoordinationOn: vi.fn(async () => false),
}));
vi.mock("@papercusp/db-org", () => ({
  upsertRoutine: (...a: unknown[]) => upsertRoutine(...a),
  deleteRoutine: (...a: unknown[]) => deleteRoutine(...a),
}));
vi.mock("../workspace-brain-scope", async (importActual) => {
  const actual =
    await importActual<typeof import("../workspace-brain-scope")>();
  return {
    ...actual,
    isWorkspaceCoordinationOn: () => h.isWorkspaceCoordinationOn(),
  };
});

import {
  OVERWATCH_WAKE_ROUTINE_NAME,
  OVERWATCH_WAKE_TARGET_ACTION,
  OVERWATCH_ROLE,
  clampOverwatchWakeAt,
  declareOverwatchTimeWake,
  clearOverwatchTimeWake,
  getOverwatchTimeWake,
  overwatchLivenessCheck,
  overwatchWakeFloorSec,
} from "./liveness";

const NOW = 1_750_000_000_000;
const WS = "ws-1";
const SLUG = "papercup-hive";

/** A callable tagged-template stub that resolves to `rows` (the routine reads). */
const fakeSqlReturning = (rows: unknown[]) =>
  ((_s: TemplateStringsArray, ..._v: unknown[]) =>
    Promise.resolve(rows)) as never;

beforeEach(() => {
  vi.clearAllMocks();
  upsertRoutine.mockResolvedValue({});
  deleteRoutine.mockResolvedValue(true);
  h.isWorkspaceCoordinationOn.mockResolvedValue(false);
});

describe("clampOverwatchWakeAt (the anti-spin floor)", () => {
  it("clamps a too-soon wake up to now + the floor", () => {
    const now = new Date(NOW);
    const { at, clamped } = clampOverwatchWakeAt(new Date(NOW + 1_000), now);
    expect(clamped).toBe(true);
    expect(at.getTime()).toBe(NOW + overwatchWakeFloorSec() * 1_000);
  });

  it("leaves a far-enough wake unchanged", () => {
    const now = new Date(NOW);
    const far = NOW + (overwatchWakeFloorSec() + 100) * 1_000;
    const { at, clamped } = clampOverwatchWakeAt(new Date(far), now);
    expect(clamped).toBe(false);
    expect(at.getTime()).toBe(far);
  });
});

describe("declareOverwatchTimeWake (the shared declare-next-wake seam)", () => {
  it("upserts a one-shot routine on the dedicated overwatch wake channel", async () => {
    await declareOverwatchTimeWake(fakeSqlReturning([]), {
      workspaceId: WS,
      installSlug: SLUG,
      at: new Date(NOW + 600_000),
      now: new Date(NOW),
    });
    expect(upsertRoutine).toHaveBeenCalledTimes(1);
    const input = upsertRoutine.mock.calls[0][1] as {
      installSlug: string;
      name: string;
      targetRole: string;
      triggerConfig: Record<string, unknown>;
      payloadTemplate: { role: string; blueprintId: string };
      nextFireAt: Date;
      active: boolean;
    };
    expect(input.installSlug).toBe(SLUG);
    // Distinct from the hive's `hive-wake` (the channels must never collide).
    expect(input.name).toBe(OVERWATCH_WAKE_ROUTINE_NAME);
    expect(input.name).not.toBe("hive-wake");
    // Targets the dedicated overwatch launch action, NOT system:blueprint-run
    // (which would fire the Queen, the wrong role).
    expect(input.targetRole).toBe(OVERWATCH_WAKE_TARGET_ACTION);
    expect(input.targetRole).not.toBe("system:blueprint-run");
    expect(input.payloadTemplate.role).toBe(OVERWATCH_ROLE);
    expect(input.triggerConfig).toEqual({}); // no cron expr ⇒ one-shot
    expect(input.active).toBe(true);
    expect(input.nextFireAt.getTime()).toBe(NOW + 600_000);
  });

  it("a custom kickoff overrides the default self-announcement", async () => {
    await declareOverwatchTimeWake(fakeSqlReturning([]), {
      workspaceId: WS,
      installSlug: SLUG,
      at: new Date(NOW + 600_000),
      kickoff: "custom kickoff",
      now: new Date(NOW),
    });
    const input = upsertRoutine.mock.calls[0][1] as {
      payloadTemplate: { kickoff: string };
    };
    expect(input.payloadTemplate.kickoff).toBe("custom kickoff");
  });

  // EI-1472: the wake is a singleton keyed by (install_slug, name). When per-workspace
  // ON CONFLICT (F-E1) is on, the upsert must target the EXISTING row's workspace so it
  // UPDATEs in place — otherwise a declare under a different ctx workspace misses the
  // composite conflict and collides with the global routines_install_slug_name_key.
  it("pins the upsert to the EXISTING singleton row workspace, not the caller ctx", async () => {
    await declareOverwatchTimeWake(
      fakeSqlReturning([{ workspace_id: "ws-owner" }]),
      {
        workspaceId: "ws-different-caller",
        installSlug: SLUG,
        at: new Date(NOW + 600_000),
        now: new Date(NOW),
      },
    );
    const input = upsertRoutine.mock.calls[0][1] as { workspaceId: string };
    expect(input.workspaceId).toBe("ws-owner");
  });

  it("falls back to the caller workspace when no singleton row exists yet", async () => {
    await declareOverwatchTimeWake(fakeSqlReturning([]), {
      workspaceId: WS,
      installSlug: SLUG,
      at: new Date(NOW + 600_000),
      now: new Date(NOW),
    });
    const input = upsertRoutine.mock.calls[0][1] as { workspaceId: string };
    expect(input.workspaceId).toBe(WS);
  });

  it("flag ON upserts the workspace-sentinel wake row", async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    await declareOverwatchTimeWake(fakeSqlReturning([]), {
      workspaceId: WS,
      installSlug: SLUG,
      at: new Date(NOW + 600_000),
      now: new Date(NOW),
    });
    const input = upsertRoutine.mock.calls[0][1] as {
      installSlug: string;
      workspaceId: string;
    };
    expect(input.installSlug).toBe(WS);
    expect(input.workspaceId).toBe(WS);
  });
});

describe("clearOverwatchTimeWake", () => {
  it("clears the overwatch wake routine by DELETING the row (EI-1477: avoids stale-row dup-key on re-arm)", async () => {
    await clearOverwatchTimeWake({} as never, SLUG);
    expect(deleteRoutine).toHaveBeenCalledWith(
      {},
      SLUG,
      OVERWATCH_WAKE_ROUTINE_NAME,
    );
  });

  it("flag ON clears both the workspace-sentinel and legacy wake rows", async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    await clearOverwatchTimeWake({} as never, SLUG, { workspaceId: WS });
    expect(deleteRoutine).toHaveBeenCalledWith(
      {},
      WS,
      OVERWATCH_WAKE_ROUTINE_NAME,
    );
    expect(deleteRoutine).toHaveBeenCalledWith(
      {},
      SLUG,
      OVERWATCH_WAKE_ROUTINE_NAME,
    );
  });
});

describe("getOverwatchTimeWake + overwatchLivenessCheck", () => {
  it("null when no routine row exists", async () => {
    expect(await getOverwatchTimeWake(fakeSqlReturning([]), SLUG)).toBeNull();
  });

  it("normalises string timestamps (EI-257 boot-pool returns strings)", async () => {
    const sql = fakeSqlReturning([
      {
        active: true,
        next_fire_at: new Date(NOW + 1000).toISOString(),
        last_fired_at: new Date(NOW - 1000).toISOString(),
      },
    ]);
    const row = await getOverwatchTimeWake(sql, SLUG);
    expect(row?.nextFireAt).toBeInstanceOf(Date);
    expect(row?.lastFiredAt).toBeInstanceOf(Date);
    expect(row?.nextFireAt?.getTime()).toBe(NOW + 1000);
  });

  it("flag ON reads the workspace-sentinel wake before falling back to legacy", async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    const queried: string[] = [];
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      queried.push(values[0] as string);
      if (values[0] === WS) {
        return Promise.resolve([
          {
            active: true,
            next_fire_at: new Date(NOW + 1000),
            last_fired_at: new Date(NOW - 1000),
          },
        ]);
      }
      return Promise.resolve([]);
    }) as never;
    const row = await getOverwatchTimeWake(sql, SLUG, { workspaceId: WS });
    expect(row?.active).toBe(true);
    expect(queried).toEqual([WS]);
  });

  it("flag ON falls back to the legacy wake row before the sentinel is written", async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    const queried: string[] = [];
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      queried.push(values[0] as string);
      if (values[0] === SLUG) {
        return Promise.resolve([
          {
            active: true,
            next_fire_at: new Date(NOW + 1000),
            last_fired_at: new Date(NOW - 1000),
          },
        ]);
      }
      return Promise.resolve([]);
    }) as never;
    const row = await getOverwatchTimeWake(sql, SLUG, { workspaceId: WS });
    expect(row?.active).toBe(true);
    expect(queried).toEqual([WS, SLUG]);
  });

  it("armed ⇔ active routine row with a next_fire_at", async () => {
    let live = await overwatchLivenessCheck(
      fakeSqlReturning([
        {
          active: true,
          next_fire_at: new Date(NOW + 60_000),
          last_fired_at: null,
        },
      ]),
      SLUG,
      { now: NOW },
    );
    expect(live.armed).toBe(true);

    live = await overwatchLivenessCheck(
      fakeSqlReturning([
        {
          active: false,
          next_fire_at: new Date(NOW + 60_000),
          last_fired_at: null,
        },
      ]),
      SLUG,
      { now: NOW },
    );
    expect(live.armed).toBe(false);

    live = await overwatchLivenessCheck(fakeSqlReturning([]), SLUG, {
      now: NOW,
    });
    expect(live.armed).toBe(false);
  });

  it("staleForMs = since the last fire; null when never fired", async () => {
    let live = await overwatchLivenessCheck(
      fakeSqlReturning([
        {
          active: false,
          next_fire_at: null,
          last_fired_at: new Date(NOW - 90_000),
        },
      ]),
      SLUG,
      { now: NOW },
    );
    expect(live.staleForMs).toBe(90_000);

    live = await overwatchLivenessCheck(
      fakeSqlReturning([
        { active: false, next_fire_at: null, last_fired_at: null },
      ]),
      SLUG,
      { now: NOW },
    );
    expect(live.staleForMs).toBeNull();
  });
});
