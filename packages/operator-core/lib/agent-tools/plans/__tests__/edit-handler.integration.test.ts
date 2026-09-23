/**
 * edit-handler.integration.test.ts — the plans:edit TOOL handler (edit.ts
 * default export) driven through real Postgres via withPlanLock.
 *
 * The pure decision core (evaluatePlanEdit) is exhaustively unit-tested in
 * plans-edit.test.ts; the HANDLER envelope is the gap. This exercises the full
 * acquire → read → mutate → upsert → afterWrite spine against a real
 * harness_plans row and asserts the side-effects the pure core can't see:
 *
 *   - A SUCCESSFUL edit records exactly ONE new plan_revisions row, and the
 *     handler result carries `revision.seq`.
 *   - A REJECTED edit (string_not_found) writes nothing AND records ZERO
 *     revisions — the afterWrite-only-on-write contract (withPlanLock only
 *     calls afterWrite when the mutator returned a non-null body).
 *   - string_not_unique (no replace_all) returns an isError payload carrying
 *     `count` + a `hint` mentioning replace_all.
 *   - would_orphan_frontmatter (stripping the `---` fence off a real plan)
 *     returns isError with that error code.
 *
 * Shared PG: uses the integration-tier baseline-schema DB via setupPlanPgFixture()
 * (inject('baselineSchemaDsn'), now wired into operator-core's integration config),
 * exactly like e2e.integration.test.ts — one baseline container for the whole run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import editTool from '../edit';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, seedPlan, cleanupPlans, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'zzz-edit-plan-2026-06-04';
const WS = DEFAULT_WORKSPACE_ID;

/** A minimal non-legacy plan that lints clean — mirrors plans-edit.test.ts's VALID. */
function validPlan(): string {
  return `---
title: Edit Handler Plan
slug: ${SLUG}
created: 2026-06-04
updated: 2026-06-04
status: active
---

# Edit Handler Plan

## Now

**State:** Where things stand. The widget runs at 22 fps.

**Next:** The next concrete action.

## Background

The widget runs at 22 fps in two places: 22 fps here.

## Decisions
`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

/** Build a ctx with a resolvable identity so revisions are attributable. */
function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    // A bearer principal → resolveAgentIdentity returns source:'principal'.
    principal: { kind: 'agent', slug: 'agent-edit-test', workspaceId: WS },
  } as never;
}

/** Run the plans:edit handler under the throwaway harness, parse its JSON result. */
async function runEdit(args: Record<string, unknown>): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const res = (await editTool.handler({ harness: HARNESS, slug: SLUG, ...args } as never, makeCtx())) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { data: JSON.parse(res.content[0].text), isError: res.isError === true };
}

async function revisionCount(): Promise<number> {
  const rows = await admin<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM harness_shared.plan_revisions
     WHERE harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  return Number(rows[0]?.n ?? 0);
}

async function liveVersion(): Promise<number> {
  const rows = await admin<{ version: number }[]>`
    SELECT version FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  return Number(rows[0]?.version ?? -1);
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 180_000);

afterAll(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  // Fresh single plan row, no revisions, for every case.
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await seedPlan(admin, WS, HARNESS, SLUG, validPlan());
});

describe('plans:edit handler — successful edit', () => {
  it('records exactly ONE plan_revisions row and returns revision.seq', async () => {
    expect(await revisionCount()).toBe(0);
    const before = await liveVersion();

    const { data, isError } = await runEdit({
      old_string: 'The next concrete action.',
      new_string: 'Ship the widget.',
    });

    expect(isError).toBe(false);
    expect(data.ok).toBe(true);
    expect(data.slug).toBe(SLUG);
    // The version bumped exactly once, and the result reports it.
    expect(data.version).toBe(before + 1);
    // Exactly one revision recorded, seq 1, surfaced in the result envelope.
    expect(await revisionCount()).toBe(1);
    expect(data.revision).toEqual({ seq: 1 });

    // The new content actually landed in the canonical blob.
    const [{ content }] = await admin<{ content: string }[]>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    expect(content).toContain('Ship the widget.');
    expect(content).not.toContain('The next concrete action.');
  });
});

describe('plans:edit handler — rejected edits write nothing', () => {
  it('string_not_found records ZERO revisions and leaves the row untouched (afterWrite-only-on-write)', async () => {
    const before = await liveVersion();

    const { data, isError } = await runEdit({
      old_string: 'this-substring-is-not-in-the-document',
      new_string: 'irrelevant',
    });

    expect(isError).toBe(true);
    expect(data.error).toBe('string_not_found');
    // No write happened → version unchanged, NO revision row.
    expect(await liveVersion()).toBe(before);
    expect(await revisionCount()).toBe(0);
  });

  it('string_not_unique (no replace_all) returns count + a replace_all hint, and writes nothing', async () => {
    const before = await liveVersion();

    const { data, isError } = await runEdit({
      old_string: '22 fps',
      new_string: '30 fps',
    });

    expect(isError).toBe(true);
    expect(data.error).toBe('string_not_unique');
    // "22 fps" appears 3× in the body.
    expect(data.count).toBe(3);
    expect(String(data.hint)).toContain('replace_all');
    // No write / no revision.
    expect(await liveVersion()).toBe(before);
    expect(await revisionCount()).toBe(0);
  });

  it('would_orphan_frontmatter (stripping the --- fence) returns isError and writes nothing', async () => {
    const before = await liveVersion();

    // Replace the opening fence so the parse degrades the real plan to legacy.
    const { data, isError } = await runEdit({
      old_string: '---\ntitle: Edit Handler Plan',
      new_string: 'title: Edit Handler Plan',
    });

    expect(isError).toBe(true);
    expect(data.error).toBe('would_orphan_frontmatter');
    expect(await liveVersion()).toBe(before);
    expect(await revisionCount()).toBe(0);
  });

  it('refuses lifecycle status changes before writing content or a revision', async () => {
    const before = await liveVersion();

    const { data, isError } = await runEdit({
      old_string: 'status: active',
      new_string: 'status: shipped',
    });

    expect(isError).toBe(true);
    expect(data.error).toBe('plan_status_change_requires_lifecycle_writer');
    expect(await liveVersion()).toBe(before);
    expect(await revisionCount()).toBe(0);
    const [{ content }] = await admin<{ content: string }[]>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    expect(content).toContain('status: active');
    expect(content).not.toContain('status: shipped');
  });
});
