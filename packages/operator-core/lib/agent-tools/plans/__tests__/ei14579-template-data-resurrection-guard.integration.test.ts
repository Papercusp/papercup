/**
 * ei14579-template-data-resurrection-guard.integration.test.ts — the EI-14579
 * regression.
 *
 * EI-14579 (forensics 2026-07-17, during the WI-5244 PG-discovery-hijack
 * recovery window): a template-bearing plan row (a rubric) was deleted, then
 * silently RESURRECTED by an ordinary content write with `template_data` reset
 * to SQL NULL and ZERO attributable `plan_revisions` row — because (a)
 * `withPlanLock`'s content-write INSERT omits `template_data` from its column
 * list (fine on an actual UPDATE — omitted-from-SET preserves the existing
 * value — but silently defaults to NULL on a fresh INSERT), and (b)
 * `planRevisionCapture`'s `afterWrite` best-effort no-ops whenever the caller's
 * ctx carries no resolvable identity (D-014), so the loss left no trail at all.
 *
 * The fix: `withPlanLock` now detects this exact shape — no current row, the
 * new content declares a `template`, no `templateData` supplied on THIS write,
 * and the slug already has `plan_revisions` history (i.e. this is a
 * RESURRECTION, not a first-ever creation) — and lands an UNCONDITIONAL,
 * system-authored `plan_revisions` marker in the SAME transaction as the
 * content write, so the loss is never silent again regardless of the caller's
 * ctx identity.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { withPlanLock } from '../with-plan-lock';
import { listPlanRevisions, planRevisionCapture, type PlanRevisionCtx } from '../revisions';
import {
  setupPlanPgFixture,
  cleanupPlans,
  registerHarnessProject,
  type PlanPgFixture,
} from './_pg-tool-fixture';

const HARNESS = `zzz-ei14579-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let fx: PlanPgFixture;
let admin: postgres.Sql;
let wsId: string;

const rubricBody = (slug: string, marker: string) => `---
title: ${slug}
slug: ${slug}
status: active
template: rubric
created: 2026-07-17
updated: 2026-07-17
---

# ${slug}

## Now

**State:** ${marker}
**Next:** ${marker}
`;

const plainBody = (slug: string, marker: string) => `---
title: ${slug}
slug: ${slug}
status: active
created: 2026-07-17
updated: 2026-07-17
---

# ${slug}

## Now

**State:** ${marker}
**Next:** ${marker}
`;

/** A content-only write with NO afterWrite wired — mirrors a caller whose ctx
 *  identity does not resolve (D-014's silent-skip case), which is exactly the
 *  shape the original incident hit. */
async function anonymousContentWrite(slug: string, body: string): Promise<void> {
  const res = await withPlanLock<{ ok: true }>(
    null,
    { slug, intent: 'ei14579 anonymous write', harnessSlug: HARNESS, workspaceId: wsId, ttlSec: 30 },
    async () => ({ newBody: body, value: { ok: true } }),
  );
  expect(res.kind).toBe('applied');
}

const CTX = {
  isSuperuser: true,
  uiClientId: `ei14579-regression-${Math.random().toString(36).slice(2, 10)}`,
} as unknown as PlanRevisionCtx;

/** A combined content + template_data write (mirrors proposeRubric) — a real
 *  identity, so it builds genuine plan_revisions history (the seed step). */
async function rubricPropose(slug: string, marker: string, criteria: unknown[]): Promise<void> {
  const rev = planRevisionCapture(CTX, slug, `seed ${marker}`, { harnessSlug: HARNESS });
  const res = await withPlanLock<{ ok: true }>(
    null,
    { slug, intent: 'ei14579 seed rubric', harnessSlug: HARNESS, workspaceId: wsId, ttlSec: 30, afterWrite: rev.afterWrite },
    async () => ({
      newBody: rubricBody(slug, marker),
      templateData: { data: { criteria } },
      value: { ok: true },
    }),
  );
  expect(res.kind).toBe('applied');
}

async function rawRow(slug: string): Promise<{
  template: string | null;
  template_data: unknown;
} | null> {
  const [r] = await admin<Array<{ template: string | null; template_data: unknown }>>`
    SELECT template, template_data FROM harness_shared.harness_plans
     WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  return r ?? null;
}

async function hardDeleteRow(slug: string): Promise<void> {
  await admin`
    DELETE FROM harness_shared.harness_plans
     WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  wsId = fx.workspaceId;
}, 60_000);

beforeEach(async () => {
  await registerHarnessProject(admin, wsId, HARNESS);
});

afterEach(async () => {
  await cleanupPlans(admin, wsId, HARNESS);
});

afterAll(async () => {
  await fx?.dispose();
});

describe('EI-14579 — a resurrected template-bearing plan is never silently stripped of template_data', () => {
  it('row deleted then an anonymous content write resurrects it → template_data NULL but an attributable system marker is recorded', async () => {
    const slug = `zzz-ei14579-rubric-${Math.random().toString(36).slice(2, 8)}`;

    // Seed a real rubric row with template_data + a genuine revision.
    await rubricPropose(slug, 'seed', [{ key: 'c1', title: 'criterion 1' }]);
    expect((await rawRow(slug))!.template_data).toEqual({ criteria: [{ key: 'c1', title: 'criterion 1' }] });

    const chainBefore = await listPlanRevisions(slug, { harnessSlug: HARNESS, workspaceId: wsId });
    expect(chainBefore.length).toBeGreaterThan(0);

    // Simulate the row vanishing out from under a concurrent process (the
    // WI-5244-shaped race) — plan_revisions history survives (it never
    // referenced the deleted row via FK).
    await hardDeleteRow(slug);
    expect(await rawRow(slug)).toBeNull();

    // An ordinary content write with no ctx identity (afterWrite unwired) —
    // exactly the shape that made the original incident silent. The guard
    // deliberately makes this LOUD (console.warn), so the expected warning
    // is asserted explicitly rather than left to fail the suite's
    // no-unexpected-console-warn guard.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await anonymousContentWrite(slug, rubricBody(slug, 'resurrected'));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/EI-14579/);
      expect(warn.mock.calls[0]?.[0]).toMatch(new RegExp(slug));
    } finally {
      warn.mockRestore();
    }

    // The row is back (title/body/template intact) but template_data is
    // genuinely unrecoverable — that limitation is expected and documented.
    const after = await rawRow(slug);
    expect(after).not.toBeNull();
    expect(after!.template).toBe('rubric');
    expect(after!.template_data).toBeNull();

    // The loss is no longer silent: a system-authored marker revision landed
    // in the SAME transaction, independent of the caller's (missing) identity.
    const chainAfter = await listPlanRevisions(slug, { harnessSlug: HARNESS, workspaceId: wsId });
    const marker = chainAfter.find((r) => r.authorId === 'with-plan-lock:template-data-loss-guard');
    expect(marker).toBeDefined();
    expect(marker!.authorKind).toBe('system');
    expect(marker!.rationale).toMatch(/EI-14579/);
    expect(marker!.rationale).toMatch(new RegExp(slug));
  }, 60_000);

  it('sanity — resurrecting a NON-template plan never emits the marker', async () => {
    const slug = `zzz-ei14579-plain-${Math.random().toString(36).slice(2, 8)}`;
    await anonymousContentWrite(slug, plainBody(slug, 'seed'));
    await hardDeleteRow(slug);
    await anonymousContentWrite(slug, plainBody(slug, 'resurrected'));

    const chain = await listPlanRevisions(slug, { harnessSlug: HARNESS, workspaceId: wsId });
    expect(chain.find((r) => r.authorId === 'with-plan-lock:template-data-loss-guard')).toBeUndefined();
  }, 60_000);

  it('sanity — an ordinary content edit on a STILL-LIVE rubric row never emits the marker (no resurrection, no data loss)', async () => {
    const slug = `zzz-ei14579-live-${Math.random().toString(36).slice(2, 8)}`;
    await rubricPropose(slug, 'seed', [{ key: 'c1', title: 'criterion 1' }]);

    // A plain content edit — the row still exists, so this is an UPDATE, not
    // an INSERT; template_data must stay untouched (existing "preserved on
    // conflict" behavior) and no marker should fire.
    await anonymousContentWrite(slug, rubricBody(slug, 'edited-in-place'));

    const after = await rawRow(slug);
    expect(after!.template_data).toEqual({ criteria: [{ key: 'c1', title: 'criterion 1' }] });

    const chain = await listPlanRevisions(slug, { harnessSlug: HARNESS, workspaceId: wsId });
    expect(chain.find((r) => r.authorId === 'with-plan-lock:template-data-loss-guard')).toBeUndefined();
  }, 60_000);

  it('sanity — a resurrection write that ITSELF supplies templateData never emits the marker', async () => {
    const slug = `zzz-ei14579-selfheal-${Math.random().toString(36).slice(2, 8)}`;
    await rubricPropose(slug, 'seed', [{ key: 'c1', title: 'criterion 1' }]);
    await hardDeleteRow(slug);

    // A resurrection that carries its OWN template_data (e.g. a re-run of
    // proposeRubric) is a legitimate self-heal, not a loss — no marker.
    await rubricPropose(slug, 'resurrected-with-data', [{ key: 'c1', title: 'criterion 1' }]);

    const after = await rawRow(slug);
    expect(after!.template_data).toEqual({ criteria: [{ key: 'c1', title: 'criterion 1' }] });

    const chain = await listPlanRevisions(slug, { harnessSlug: HARNESS, workspaceId: wsId });
    expect(chain.find((r) => r.authorId === 'with-plan-lock:template-data-loss-guard')).toBeUndefined();
  }, 60_000);
});
