/**
 * The GCP image-scan SCOPE prose must not claim the scope fields are inert while
 * `GCP_IMAGE_SCAN_POLICY` judges the `papercusp-bundled` scope.
 *
 * Sibling of `freeze-and-converge.test.ts` / `gate-candidate-ref.test.ts`, same doc-claims
 * family and the same discipline: the FIXTURE controls carry the weight, because once the live
 * assertion is green it stops being evidence that the detector works at all. The first fixture
 * reproduces the exact wording that was live and wrong.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GCP_IMAGE_SCAN_POLICY } from '../workspace-host/image-scan-policy';
import {
  judgeImageScanScopeDocs,
  SCOPE_ATTRIBUTION_FIELDS,
} from './image-scan-scope-enforcement';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const EVIDENCE_MODULE = join(
  ROOT,
  'packages/operator-core/lib/workspace-host/gcp-image-family.ts',
);

/** The comment as it actually read while the policy was already scoped. */
const STALE_PROSE = `
  vulnerabilityByScope, vulnerabilityCriticalHighByScope, secretsByScope, bundleCatalogedArtifacts
  EVIDENCE ONLY — no policy reads them yet, deliberately. D-202 section 4 sequences the npm
  remediation BEFORE the gate changes what it accepts.
`;

describe('fixture controls (the detector must be able to FAIL)', () => {
  it('catches the exact wording that was live and wrong', () => {
    const verdict = judgeImageScanScopeDocs(STALE_PROSE, 'papercusp-bundled');
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join('\n')).toMatch(/carry-only/);
  });

  it('catches "not read by policy" phrasing too, not just the one literal sentence', () => {
    const verdict = judgeImageScanScopeDocs(
      `${SCOPE_ATTRIBUTION_FIELDS.join(' ')} — these are not read by policy.`,
      'papercusp-bundled',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.staleAssertions).not.toHaveLength(0);
  });

  it('catches prose that silently stops naming a required field', () => {
    const partial = SCOPE_ATTRIBUTION_FIELDS.slice(0, 3).join(' ');
    const verdict = judgeImageScanScopeDocs(partial, 'papercusp-bundled');
    expect(verdict.ok).toBe(false);
    expect(verdict.unnamedFields).toEqual(['bundleCatalogedArtifacts']);
  });

  it('imposes nothing while the policy is unscoped — carry-only wording is then accurate', () => {
    const verdict = judgeImageScanScopeDocs(STALE_PROSE, 'all');
    expect(verdict.ok).toBe(true);
    expect(verdict.violations).toEqual([]);
  });

  it('accepts prose that names every field and does not claim inertness', () => {
    const verdict = judgeImageScanScopeDocs(
      `The gate READS ${SCOPE_ATTRIBUTION_FIELDS.join(', ')} under a scoped policy.`,
      'papercusp-bundled',
    );
    expect(verdict.ok).toBe(true);
  });

  it('does not fire on prose that explicitly retracts the old claim', () => {
    // "NO LONGER EVIDENCE ONLY" must read as a correction, not as the claim it corrects.
    const verdict = judgeImageScanScopeDocs(
      `NO LONGER EVIDENCE ONLY — the gate reads ${SCOPE_ATTRIBUTION_FIELDS.join(', ')}.`,
      'papercusp-bundled',
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('the live claim', () => {
  it('GCP still judges the papercusp-bundled scope (the premise of the whole guard)', () => {
    // If this ever legitimately changes, the guard below relaxes on its own rather than
    // demanding prose about a scope the policy no longer evaluates.
    expect(GCP_IMAGE_SCAN_POLICY.evaluatedScope).toBe('papercusp-bundled');
  });

  it('the evidence module does not describe the scope fields as carry-only', () => {
    const verdict = judgeImageScanScopeDocs(
      readFileSync(EVIDENCE_MODULE, 'utf8'),
      GCP_IMAGE_SCAN_POLICY.evaluatedScope,
    );
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});
