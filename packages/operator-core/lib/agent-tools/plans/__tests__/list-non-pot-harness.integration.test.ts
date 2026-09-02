/**
 * list-non-pot-harness.integration.test.ts — EI-7864 regression.
 *
 * Root cause: `resolvePlanScope` (source.ts) throws TWO distinct messages for a
 * LIST read it refuses: "harness '…' is not registered" (WI-148) and "plans are
 * Hive-scoped, but '…' is not a Hive home" (WI-1992). plans:list's per-harness
 * batch loop (list.ts) already treats a refused LIST read as "empty, not an
 * error" — but its catch only matched the FIRST message
 * (`/not registered/i`), so a harness that IS registered in
 * `harness_shared.projects` but is NOT a Hive home (e.g. a standalone
 * scratch/verification harness like `pot-verify`, used for manual UI
 * verification — never assigned to a Hive) fell through to `throw err`
 * uncaught. The watchdog caught this as a recurring structural tool-error
 * (EI-7864: 4 hits on `resolvePlanScope: plans are Hive-scoped, but 'pot-verify'
 * is not a Hive home…`).
 *
 * This seeds a harness registered ONLY in `projects` (no `hives` row — the
 * exact non-Hive-standalone shape) and drives the REAL handler against real
 * Postgres, asserting the fixed behavior: no throw, empty `plans`, and the
 * harness surfaces in the `unknownHarnesses` metadata (mirroring the existing
 * not-registered-swallow contract) rather than raising.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import listTool from '../list';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, type PlanPgFixture } from './_pg-tool-fixture';

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-non-hive-${STAMP}`;
const WS = DEFAULT_WORKSPACE_ID;

let fx: PlanPgFixture;
let admin: postgres.Sql;

/** Register HARNESS in `projects` only — deliberately no `hives` row, so it
 *  resolves a workspace but is NOT a Hive home (the pot-verify shape). */
async function registerStandaloneNonHiveHarness(): Promise<void> {
  await admin`
    INSERT INTO harness_shared.projects
      (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES
      (${HARNESS}, ${HARNESS}, 'active', ${HARNESS}, ${WS}, 0, 0)
    ON CONFLICT DO NOTHING
  `;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  await registerStandaloneNonHiveHarness();
}, 180_000);

afterAll(async () => {
  await admin`
    DELETE FROM harness_shared.projects WHERE workspace_id = ${WS} AND slug = ${HARNESS}
  `.catch(() => {});
  await fx?.dispose();
});

describe('plans:list against a registered-but-non-Hive harness (EI-7864)', () => {
  it('does not throw; returns empty plans + surfaces the harness as unknown (not an error)', async () => {
    const metadata = vi.fn();
    const ctx = {
      harnessSlug: HARNESS,
      workspaceId: WS,
      metadata,
      log: vi.fn(),
      progress: vi.fn(),
    } as never;

    const res = (await listTool.handler({} as never, ctx)) as {
      data: { plans: unknown[] };
    };

    expect(res.data.plans).toEqual([]);
    expect(metadata).toHaveBeenCalledTimes(1);
    const meta = metadata.mock.calls[0][0] as { unknownHarnesses?: string[] };
    expect(meta.unknownHarnesses).toContain(HARNESS);
  });

  it('same result when the harness is passed explicitly via the harness arg', async () => {
    const metadata = vi.fn();
    const ctx = {
      metadata,
      log: vi.fn(),
      progress: vi.fn(),
    } as never;

    const res = (await listTool.handler({ harness: HARNESS } as never, ctx)) as {
      data: { plans: unknown[] };
    };

    expect(res.data.plans).toEqual([]);
    const meta = metadata.mock.calls[0][0] as { unknownHarnesses?: string[] };
    expect(meta.unknownHarnesses).toContain(HARNESS);
  });
});
