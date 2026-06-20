/**
 * EI-479 vaporware guard — the SCOPED active-plans lint (proposal-plan-claim-guard.md, option C).
 *
 * Runs the pure `verifyPlanClaims` core over a small ALLOWLIST of in-flight plans, asserting no
 * shipped/done claim names a missing repo file. Scoped on purpose: a whole-corpus scan is too noisy
 * (the apps/operator→packages/operator-core migration + un-checked-out submodule paths produce ~35
 * historical false positives — see the proposal's UPDATE 2). Active plans use current paths, so this
 * is GREEN today and only fires on a NEW vaporware claim landing in one of these plans.
 *
 * HOME: option (C) — CONSENSUS-APPROVED 2026-06-20 (pr1-impl, the finding's originator, concurred
 * after an independent corpus scan reached the same "whole-corpus gate is a non-starter, allowlist is
 * the only viable scoping" conclusion). The lint is fail-SOFT (a moved/renamed plan file is skipped,
 * never an error) and trivially adjustable (edit ACTIVE_PLANS). The longer-term complement is a
 * `plans:set-status` preflight (option A) — and per pr1-impl's refinement, that preflight should verify
 * a CITED ARTIFACT (merged-PR URL / commit SHA / a named test that resolves+passes), not a file path
 * (paths are churn-fragile); tracked as the (A) enhancement, wired when the coord/plans MCP is back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { verifyPlanClaims, formatPlanClaimViolations } from './plan-claim-guard';

// packages/operator-core/lib → repo root (papercup/)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');

/** In-flight plans whose shipped path-claims must point at current files. Grow as lanes opt in.
 *  Each added plan was verified clean (0 violations) at add-time; the lint is fail-soft, so a
 *  later moved/renamed plan file is skipped rather than reddening the suite. */
const ACTIVE_PLANS = [
  // PR-system arc (the EI-479 origin)
  'shared-hive-release-testing/PLAN-pr-system-completion-dogfood.md',
  'apps/operator/docs/plans/papercusp-dogfood-phase7-pr-lifecycle-2026-05-24.md',
  'apps/operator/docs/plans/non-collaborator-join-fork-pr-2026-06-02.md',
  // In-flight federation / owner-enforcement / hive plans (verified clean 2026-06-20)
  'shared-hive-release-testing/PLAN-owner-enforcement-layer.md',
  'apps/operator/docs/plans/hive-from-github-url-2026-06-11.md',
  'apps/operator/docs/plans/shared-hive-federation-2026-06-08.md',
];

describe('EI-479 vaporware guard — active plans have no shipped-but-missing file claims', () => {
  const fileExists = (p: string) => existsSync(resolve(REPO_ROOT, p));
  for (const rel of ACTIVE_PLANS) {
    it(rel, () => {
      const abs = resolve(REPO_ROOT, rel);
      if (!existsSync(abs)) return; // fail-soft: a moved/renamed plan must not red the suite
      const result = verifyPlanClaims(readFileSync(abs, 'utf8'), fileExists);
      expect(result.ok, formatPlanClaimViolations(rel, result)).toBe(true);
    });
  }
});
