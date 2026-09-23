/**
 * acceptance-runtime-plane-not-main-2026-09-23 P-004/P-006 — graders name the runtime and
 * sha behind an unknown/mismatch rating; rubric vetting flags live BARs with no runtime.
 */
import { describe, expect, it } from 'vitest';
import {
  ratingNeedsRuntimeCitation,
  runtimeCitationRefusal,
  runtimeVettingFindings,
  validateRuntimeCitation,
} from './acceptance-runtime-citation';

const BG_PATH = 'packages/operator-core/lib/harness/routines/psu-pty-host-events-ingest.ts';

describe('which ratings need a runtime citation', () => {
  it('unknown / mismatch / not-deployed ratings do; passing ratings do not', () => {
    for (const r of ['unknown', 'generation-mismatch', 'not-deployed', 'not yet live', 'pending-deploy', 'Mismatch']) {
      expect(ratingNeedsRuntimeCitation(r)).toBe(true);
    }
    for (const r of ['healthy', 'pass', 'broken', 'degraded', '', null]) {
      expect(ratingNeedsRuntimeCitation(r)).toBe(false);
    }
  });
});

describe('validateRuntimeCitation', () => {
  it('the 2026-09-23 rating — mismatch, "wait for deployed:true", no runtime, no sha — is refused on both counts', () => {
    expect(
      validateRuntimeCitation({
        rating: 'generation-mismatch',
        evidence: 'pipeline_position says deployed:false; wait for deployed:true before grading',
        evidencePlane: 'live',
      }),
    ).toEqual({ missing: ['runtime', 'sha'], runtimesCited: [] });
  });

  it('a cited runtime + build sha passes', () => {
    expect(
      validateRuntimeCitation({
        rating: 'generation-mismatch',
        evidence: 'bg-host /api/health on :3271 reports 9536482f31, which lacks the ingest fix blob',
        evidencePlane: 'live',
      }),
    ).toBeNull();
  });

  it('a runtime without a sha, or a sha without a runtime, is still refused', () => {
    expect(
      validateRuntimeCitation({ rating: 'unknown', evidence: 'measured on :3070, not reachable', evidencePlane: 'deployed' })
        ?.missing,
    ).toEqual(['sha']);
    expect(
      validateRuntimeCitation({ rating: 'unknown', evidence: 'build be8396c6dd lacks it', evidencePlane: 'live' })?.missing,
    ).toEqual(['runtime']);
  });

  it('tree-plane BARs and passing ratings are out of scope', () => {
    expect(validateRuntimeCitation({ rating: 'unknown', evidence: '', evidencePlane: 'tree' })).toBeNull();
    expect(validateRuntimeCitation({ rating: 'healthy', evidence: '', evidencePlane: 'live' })).toBeNull();
  });
});

describe('runtimeCitationRefusal — the scorecards:emit wiring', () => {
  const criteria = [
    { key: 'r-1', barKey: 'R-1', evidencePlane: 'live' as const, method: `census from ${BG_PATH}` },
    { key: 'r-2', barKey: 'R-2', evidencePlane: 'tree' as const },
  ];

  it('refuses a card with an uncited mismatch on a live BAR and names the runtime the BAR is about', () => {
    const refusal = runtimeCitationRefusal(criteria, {
      'r-1': { rating: 'generation-mismatch', evidence: 'wait for deployed:true' },
      'r-2': { rating: 'unknown', evidence: 'n/a' },
    });
    expect(refusal?.code).toBe('acceptance_runtime_citation_missing');
    expect(refusal?.error).toMatch(/'R-1' rated 'generation-mismatch' without runtime and sha \(this BAR is measured on bg-host\)/);
    expect(refusal?.error).not.toMatch(/R-2/);
    expect(refusal?.error).toMatch(/servingRuntimes/);
  });

  it('accepts a card whose ratings are all passing or properly cited', () => {
    expect(
      runtimeCitationRefusal(criteria, {
        'r-1': { rating: 'healthy', evidence: 'ok' },
        'r-2': { rating: 'unknown', evidence: 'n/a' },
      }),
    ).toBeNull();
    expect(
      runtimeCitationRefusal(criteria, {
        'r-1': { rating: 'unknown', evidence: 'bg-host build 635c4bd49f: routine has not fired since restart' },
      }),
    ).toBeNull();
    expect(runtimeCitationRefusal(criteria, undefined)).toBeNull();
  });
});

describe('runtimeVettingFindings — rubrics:propose / rubrics:amend', () => {
  it('flags every live/deployed criterion without evidenceRuntime, and nothing else', () => {
    const findings = runtimeVettingFindings([
      { key: 'r-1', barKey: 'R-1', evidencePlane: 'live', method: `census from ${BG_PATH}` },
      { key: 'r-2', barKey: 'R-2', evidencePlane: 'deployed', method: 'eyeball the dashboard' },
      { key: 'r-3', barKey: 'R-3', evidencePlane: 'live', evidenceRuntime: 'staging-operator' },
      { key: 'r-4', barKey: 'R-4', evidencePlane: 'tree' },
    ]);
    expect(findings.map((f) => f.barKey)).toEqual(['R-1', 'R-2']);
    expect(findings[0]!.finding).toMatch(/inferred bg-host/);
    expect(findings[1]!.finding).toMatch(/default to :3070 and wait on main/);
    expect(findings[1]!.resolution.runtime).toBeNull();
  });
});
