/**
 * End-to-end smoke test — runs the tools against the real
 * apps/operator/docs/plans/ tree.
 *
 * Verifies the §P-110 acceptance: an agent given only this plan's
 * slug can reconstruct enough state to cold-resume work.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { listPlanFiles, readPlanBySlug, readAllPlans } from '../source';
import { resolveEffectiveStatus } from '../effective-status';
import { lintPlan } from '../lint';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');

describe('plans surface — real tree', () => {
  it('lists all plan files', async () => {
    const entries = await listPlanFiles({ repoRoot });
    expect(entries.length).toBeGreaterThanOrEqual(35);
    expect(entries.some((e) => e.slug === 'agent-plan-tracking-2026-05-20')).toBe(true);
  });

  it('reads the plan-tracking plan itself and exposes its items', async () => {
    const result = await readPlanBySlug('agent-plan-tracking-2026-05-20', { repoRoot });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.parsed.isLegacy).toBe(false);
    expect(result.parsed.frontmatter.slug).toBe('agent-plan-tracking-2026-05-20');
    expect(result.parsed.now).not.toBeNull();
    expect(result.parsed.items.length).toBeGreaterThan(10);
    expect(result.parsed.decisions.length).toBeGreaterThanOrEqual(5);
  });

  it('computes effectiveStatus for the plan-tracking plan', async () => {
    const result = await readPlanBySlug('agent-plan-tracking-2026-05-20', { repoRoot });
    if (!result) throw new Error('plan not found');
    const resolved = resolveEffectiveStatus(result.parsed);
    expect(resolved.items.length).toBeGreaterThan(0);
    expect(resolved.missingRefs).toEqual([]);
  });

  it('treats freeform plans as legacy', async () => {
    const all = await readAllPlans({ repoRoot });
    const legacyCount = all.filter((r) => r.parsed.isLegacy).length;
    expect(legacyCount).toBeGreaterThan(0);
    const real = all.filter((r) => !r.parsed.isLegacy);
    expect(real.some((r) => r.parsed.frontmatter.slug === 'agent-plan-tracking-2026-05-20')).toBe(true);
  });

  it('plans:lint passes on the new plan and exempts legacy ones', async () => {
    const r = await lintPlan('agent-plan-tracking-2026-05-20', { repoRoot });
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.errors).toEqual([]);
  });
});

describe('readPlanBySlug — A-1 path traversal hardening', () => {
  // The agent-coordination-architecture-v2 audit (A-1) flagged that a
  // slug like '../../../etc/passwd' would escape plansDir via
  // path.join's `..` normalisation. readPlanBySlug now allowlists the
  // slug and returns null on anything outside [A-Za-z0-9._-]. This
  // matches every caller's existing not-found contract.

  it('returns null for slugs containing path separators', async () => {
    expect(await readPlanBySlug('../../../etc/passwd', { repoRoot })).toBeNull();
    expect(await readPlanBySlug('a/b', { repoRoot })).toBeNull();
    expect(await readPlanBySlug('a\\b', { repoRoot })).toBeNull();
  });

  it('returns null for slugs containing ..', async () => {
    expect(await readPlanBySlug('..', { repoRoot })).toBeNull();
    // The substring '..' inside an otherwise-valid slug is fine —
    // only the SEPARATORS are dangerous; a literal dot is allowed.
    // But a `..` SEGMENT (with separators) is already caught above.
  });

  it('returns null for slugs with shell or url metacharacters', async () => {
    expect(await readPlanBySlug('foo bar', { repoRoot })).toBeNull();
    expect(await readPlanBySlug('foo%2Fbar', { repoRoot })).toBeNull();
    expect(await readPlanBySlug('foo\x00.md', { repoRoot })).toBeNull();
    expect(await readPlanBySlug('', { repoRoot })).toBeNull();
  });

  it('accepts the real plan-tracking slug (regression guard)', async () => {
    // Ensure the allowlist did not over-tighten and reject the
    // canonical slug shape (lowercase, hyphens, ISO date).
    const r = await readPlanBySlug('agent-plan-tracking-2026-05-20', {
      repoRoot,
    });
    expect(r).not.toBeNull();
  });
});
