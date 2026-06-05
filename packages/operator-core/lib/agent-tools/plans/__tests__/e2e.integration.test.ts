/**
 * e2e.integration.test.ts — end-to-end smoke for the plans surface, now PG-backed.
 *
 * Plans live in `harness_shared.harness_plans` (plans-pg-canonical-migration-
 * 2026-06-03); the old filesystem `apps/operator/docs/plans/` tree is gone, so
 * this seeds plan rows directly (admin) and drives the REAL read/parse/lint/
 * effective-status stack through `readPlanBySlug` / `listPlanFiles` /
 * `readAllPlans` against real Postgres.
 *
 * Verifies the §P-110 acceptance — an agent given only a plan's slug can
 * reconstruct enough state to cold-resume — plus the A-1 slug path-traversal
 * hardening (still a pure guard: an invalid slug returns null before any query).
 *
 * Runs against the integration-tier baseline schema DB via the shared fixture.
 * Cleans up its throwaway plan rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { listPlanFiles, readPlanBySlug, readAllPlans } from '../source';
import { resolveEffectiveStatus } from '../effective-status';
import { lintPlan } from '../lint';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const MAIN_SLUG = 'zzz-plan-tracking-2026-05-20';

let fx: PlanPgFixture;
let admin: postgres.Sql;
let wsId: string;
let opts: { harnessSlug: string; workspaceId: string };

// A structured plan with frontmatter, a Now block, ≥11 items, ≥5 decisions —
// mirrors the shape the old test asserted against the real plan-tracking plan.
function structuredPlanBody(slug: string): string {
  const items = Array.from({ length: 12 }, (_, i) => {
    const id = `P-${String(i + 1).padStart(3, '0')}`;
    const status = i < 4 ? 'done' : i < 8 ? 'wip' : 'todo';
    return `- **${id}** \`${status}\` Item number ${i + 1}.`;
  }).join('\n');
  const decisions = Array.from({ length: 6 }, (_, i) => {
    const id = `D-${String(i + 1).padStart(3, '0')}`;
    return `### ${id} — Decision ${i + 1}\nDate: 2026-05-20\nRationale for decision ${i + 1}.\n`;
  }).join('\n');
  return `---
title: Plan tracking smoke
slug: ${slug}
status: active
created: 2026-05-20
updated: 2026-05-20
owner: someone@example.com
---

# Plan tracking smoke

## Now

**State:** mid-flight
**Next:** finish phase 2

## Phase 1 — foundations

${items}

## Decisions

${decisions}
`;
}

// A freeform (no-frontmatter) plan → parser flags it legacy.
const LEGACY_SLUG = 'zzz-legacy-freeform';
const LEGACY_BODY = `# Some freeform notes

This plan has no frontmatter, so the parser treats it as legacy.
`;

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  wsId = fx.workspaceId;
  opts = { harnessSlug: HARNESS, workspaceId: wsId };
  await seedPlan(admin, wsId, HARNESS, MAIN_SLUG, structuredPlanBody(MAIN_SLUG));
  await seedPlan(admin, wsId, HARNESS, LEGACY_SLUG, LEGACY_BODY);
}, 60_000);

afterAll(async () => {
  await cleanupPlans(admin, wsId, HARNESS).catch(() => {});
  await fx?.dispose();
});

describe('plans surface — PG-backed', () => {
  it('lists all plan files for the harness', async () => {
    const entries = await listPlanFiles(opts);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.some((e) => e.slug === MAIN_SLUG)).toBe(true);
    expect(entries.some((e) => e.slug === LEGACY_SLUG)).toBe(true);
  });

  it('reads the structured plan and exposes its items + decisions', async () => {
    const result = await readPlanBySlug(MAIN_SLUG, opts);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.parsed.isLegacy).toBe(false);
    expect(result.parsed.frontmatter.slug).toBe(MAIN_SLUG);
    expect(result.parsed.now).not.toBeNull();
    expect(result.parsed.items.length).toBeGreaterThan(10);
    expect(result.parsed.decisions.length).toBeGreaterThanOrEqual(5);
    // The raw row rides along (new PG-canonical shape).
    expect(result.row.planSlug).toBe(MAIN_SLUG);
    expect(result.row.version).toBeGreaterThanOrEqual(1);
  });

  it('computes effectiveStatus for the structured plan', async () => {
    const result = await readPlanBySlug(MAIN_SLUG, opts);
    if (!result) throw new Error('plan not found');
    const resolved = resolveEffectiveStatus(result.parsed);
    expect(resolved.items.length).toBeGreaterThan(0);
    expect(resolved.missingRefs).toEqual([]);
  });

  it('treats freeform plans as legacy', async () => {
    const all = await readAllPlans(opts);
    const legacyCount = all.filter((r) => r.parsed.isLegacy).length;
    expect(legacyCount).toBeGreaterThan(0);
    const real = all.filter((r) => !r.parsed.isLegacy);
    expect(real.some((r) => r.parsed.frontmatter.slug === MAIN_SLUG)).toBe(true);
  });

  it('plans:lint passes on the structured plan and exempts legacy ones', async () => {
    const r = await lintPlan(MAIN_SLUG, opts);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.errors).toEqual([]);

    const legacyReport = await lintPlan(LEGACY_SLUG, opts);
    expect(legacyReport?.exempt).toBe(true);
  });
});

describe('readPlanBySlug — A-1 path traversal hardening (pure slug guard)', () => {
  // The slug allowlist (VALID_PLAN_SLUG) rejects anything outside [A-Za-z0-9._-]
  // and returns null BEFORE any PG query — the same not-found contract every
  // caller already expects. (No DB round-trip happens for an invalid slug.)
  it('returns null for slugs containing path separators', async () => {
    expect(await readPlanBySlug('../../../etc/passwd', opts)).toBeNull();
    expect(await readPlanBySlug('a/b', opts)).toBeNull();
    expect(await readPlanBySlug('a\\b', opts)).toBeNull();
  });

  it('returns null for slugs containing .. segments', async () => {
    expect(await readPlanBySlug('..', opts)).toBeNull();
  });

  it('returns null for slugs with shell or url metacharacters', async () => {
    expect(await readPlanBySlug('foo bar', opts)).toBeNull();
    expect(await readPlanBySlug('foo%2Fbar', opts)).toBeNull();
    expect(await readPlanBySlug('foo\x00.md', opts)).toBeNull();
    expect(await readPlanBySlug('', opts)).toBeNull();
  });

  it('accepts a canonical slug shape (regression guard against over-tightening)', async () => {
    const r = await readPlanBySlug(MAIN_SLUG, opts);
    expect(r).not.toBeNull();
  });
});
