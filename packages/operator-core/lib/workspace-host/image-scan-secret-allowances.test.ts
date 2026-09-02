/**
 * THE FAILURE MODE OF AN ALLOWLIST IS A FALSE GREEN.
 *
 * Every other guard in the image-scan policy protects against a scan that measured too little.
 * This one protects against a policy that EXCUSES too much, which is worse: an over-broad
 * allowance turns a gate that would have caught a leaked credential into one that reports clean.
 * So the tests below are weighted toward the excusing direction — an entry that matches more than
 * it should, a finding list that is incomplete, a pattern that widens by accident.
 *
 * The happy path is pinned against the REAL measured population (31 findings, D-212), because an
 * allowlist that passes only synthetic input has never been shown to do its actual job.
 */
import { describe, expect, it } from 'vitest';

import {
  applySecretAllowances,
  WORKSPACE_HOST_SECRET_ALLOWANCES,
  type ImageScanSecretFinding,
} from './image-scan-secret-allowances';
import { AWS_IMAGE_SCAN_POLICY, evaluateImageScanPolicy, GCP_IMAGE_SCAN_POLICY } from './image-scan-policy';

/** The image-side path prefix the guest scanner reports, mount point and all. */
const BUNDLE = '/mnt/candidate/sda1/opt/papercusp/releases/0.0.18';

/**
 * The 0.0.18 candidate's real bundled population, reproduced 2026-08-30 by running the pinned
 * gitleaks 8.30.1 over the published bundle at .papercusp/p046-r14-publication/extracted/ — the
 * same artifact baked into the candidate image, confirmed by the content-hashed filename
 * chunk-ZUYEQ4TG-50072df8.js appearing in both, and RE-MEASURED 2026-09-02 against the r19
 * bundle (pin aea66c75) whose sidecar rebuild added one entropy match to serve.mjs:
 * 2 gcp-api-key + 30 generic-api-key = 32, which matches the image scan's own bundled census
 * to the unit. Both numbers are reproductions of a real scan, never a count chosen to pass.
 */
function realBundledFindings(): ImageScanSecretFinding[] {
  return [
    { rule: 'gcp-api-key', file: `${BUNDLE}/spa/assets/chunk-ZUYEQ4TG-50072df8.js` },
    { rule: 'gcp-api-key', file: `${BUNDLE}/spa/excalidraw/chunk-ZUYEQ4TG.js` },
    ...Array.from({ length: 30 }, () => ({ rule: 'generic-api-key', file: `${BUNDLE}/serve.mjs` })),
  ];
}

/** A scan result carrying `findings`, otherwise clean and fully attributed. */
function scanWith(
  findings: readonly ImageScanSecretFinding[],
  overrides: Record<string, unknown> = {},
) {
  return {
    vulnerabilityFindings: 0,
    vulnerabilityBySeverity: {},
    secretFindings: findings.length,
    mountedFilesystems: 3,
    candidateRootProof: `${BUNDLE}/../../../etc/os-release`,
    vulnerabilityByScope: { 'papercusp-bundled': 0, 'inherited-base-image': 0 },
    vulnerabilityCriticalHighByScope: { 'papercusp-bundled': 0, 'inherited-base-image': 0 },
    secretsByScope: { 'papercusp-bundled': findings.length, 'inherited-base-image': 0 },
    bundleCatalogedArtifacts: 289,
    secretBundledSample: findings,
    secretBundledSampleComplete: true,
    ...overrides,
  };
}

describe('workspace-host secret allowances — the real population', () => {
  it('accounts for every one of the 32 measured findings, leaving nothing to judge', () => {
    const outcome = applySecretAllowances(realBundledFindings(), WORKSPACE_HOST_SECRET_ALLOWANCES);
    expect(outcome.unjustified).toEqual([]);
    expect(outcome.overflowed).toEqual([]);
    // A stale entry is not a security hole, but it is a lie about what the bundle contains, and
    // it is how a list drifts into justifying things nobody has looked at in months.
    expect(outcome.unused).toEqual([]);
  });

  it('accepts the real 0.0.18 bundled population at the GCP gate, with maxSecretFindings still 0', () => {
    const verdict = evaluateImageScanPolicy(scanWith(realBundledFindings()), GCP_IMAGE_SCAN_POLICY);
    expect(verdict.failures).toEqual([]);
    expect(verdict.accepted).toBe(true);
    // The bar itself never moved. That is the whole claim of this mechanism.
    expect(GCP_IMAGE_SCAN_POLICY.maxSecretFindings).toBe(0);
  });

  it('every entry carries a real justification, not a rubber stamp', () => {
    for (const allowance of WORKSPACE_HOST_SECRET_ALLOWANCES) {
      expect(allowance.reason.length).toBeGreaterThan(80);
      expect(allowance.maxFindings).toBeGreaterThan(0);
      // "not a secret" / "false positive" alone explains nothing to the next reader; the entry
      // has to say WHY, which in practice means naming the thing it actually is.
      expect(allowance.reason).toMatch(/[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/i);
    }
  });
});

describe('workspace-host secret allowances — the excusing direction', () => {
  it('DENIES a finding that matches no entry, and names it', () => {
    const findings = [
      ...realBundledFindings(),
      { rule: 'private-key', file: `${BUNDLE}/config/id_ed25519` },
    ];
    const verdict = evaluateImageScanPolicy(scanWith(findings), GCP_IMAGE_SCAN_POLICY);
    expect(verdict.accepted).toBe(false);
    const failure = verdict.failures.find((f) => f.code === 'secret-unjustified');
    expect(failure).toBeDefined();
    // Naming it matters: a bare count sends the reader back to a scan of an image that may
    // already be deleted.
    expect(failure?.message).toContain('config/id_ed25519');
  });

  it('DENIES a NEW secret hiding in an already-justified file', () => {
    // The realistic leak: serve.mjs is justified for 30 entropy matches, so a real credential
    // bundled into it would arrive as a 31st. maxFindings is what stops it being absorbed.
    // This boundary moves with the justified count and must never be raised without one:
    // the r19 bump 29→30 was paid for by identifying the added match as the minified form of
    // `const verdictFns = await import(...)`, not by widening the number to clear a red gate.
    const findings = [
      ...realBundledFindings(),
      { rule: 'generic-api-key', file: `${BUNDLE}/serve.mjs` },
    ];
    const verdict = evaluateImageScanPolicy(scanWith(findings), GCP_IMAGE_SCAN_POLICY);
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.some((f) => f.code === 'secret-allowance-overflow')).toBe(true);
  });

  it('DENIES when the finding list is not proven complete', () => {
    for (const complete of [false, undefined, 'true', 1]) {
      const verdict = evaluateImageScanPolicy(
        scanWith(realBundledFindings(), { secretBundledSampleComplete: complete }),
        GCP_IMAGE_SCAN_POLICY,
      );
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.some((f) => f.code === 'secret-allowance-unusable')).toBe(true);
    }
  });

  it('DENIES when the enumeration and the census disagree', () => {
    // Two projections of one scan. If they differ, one is wrong and nothing says which — so
    // trusting the shorter one would excuse whatever the difference is.
    const verdict = evaluateImageScanPolicy(
      scanWith(realBundledFindings(), {
        secretsByScope: { 'papercusp-bundled': 40, 'inherited-base-image': 0 },
        secretFindings: 40,
      }),
      GCP_IMAGE_SCAN_POLICY,
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.some((f) => f.code === 'secret-allowance-unusable')).toBe(true);
  });

  it('DENIES a malformed finding row instead of skipping it', () => {
    // A dropped row shrinks the population the allowlist is checked against — the false-GREEN
    // direction, and the row that failed to parse is precisely the one nobody then judges.
    for (const row of [null, 'generic-api-key', { rule: 'generic-api-key' }, { file: 'x' }, {}]) {
      const verdict = evaluateImageScanPolicy(
        scanWith(realBundledFindings(), {
          secretBundledSample: [...realBundledFindings(), row],
          secretsByScope: { 'papercusp-bundled': 32, 'inherited-base-image': 0 },
          secretFindings: 32,
        }),
        GCP_IMAGE_SCAN_POLICY,
      );
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.some((f) => f.code === 'secret-allowance-unusable')).toBe(true);
    }
  });
});

describe('workspace-host secret allowances — matching cannot widen by accident', () => {
  const entry = [
    { rule: 'generic-api-key', filePattern: '*/serve.mjs', maxFindings: 5, reason: 'test fixture' },
  ];

  it('treats glob metacharacters literally except *', () => {
    // If the pattern were compiled as a regex, '.' would match any character and
    // '/servexmjs' would be excused. This is the typo that silently widens an allowlist.
    const outcome = applySecretAllowances([{ rule: 'generic-api-key', file: '/a/servexmjs' }], entry);
    expect(outcome.unjustified).toHaveLength(1);
  });

  it('is anchored at both ends', () => {
    const outcome = applySecretAllowances(
      [{ rule: 'generic-api-key', file: '/a/serve.mjs.backup' }],
      entry,
    );
    expect(outcome.unjustified).toHaveLength(1);
  });

  it('requires the rule to match exactly, so one file\'s justification is not another rule\'s', () => {
    const outcome = applySecretAllowances([{ rule: 'private-key', file: '/a/serve.mjs' }], entry);
    expect(outcome.unjustified).toHaveLength(1);
  });

  it('consumes each finding once, so overlapping entries cannot double the budget', () => {
    const overlapping = [
      { rule: 'generic-api-key', filePattern: '*/serve.mjs', maxFindings: 1, reason: 'first' },
      { rule: 'generic-api-key', filePattern: '*', maxFindings: 1, reason: 'second' },
    ];
    const outcome = applySecretAllowances(
      [
        { rule: 'generic-api-key', file: '/a/serve.mjs' },
        { rule: 'generic-api-key', file: '/a/serve.mjs' },
      ],
      overlapping,
    );
    // Both land on the FIRST entry, which overflows, rather than one silently spilling into
    // the second and both appearing satisfied.
    expect(outcome.overflowed).toHaveLength(1);
    expect(outcome.overflowed[0]?.matched).toBe(2);
  });
});

describe('workspace-host secret allowances — scope of the mechanism', () => {
  it('leaves a policy with no allowances behaving exactly as before', () => {
    // AWS/Azure carry none, and must keep denying on the raw bundled count.
    expect(AWS_IMAGE_SCAN_POLICY.secretAllowances ?? []).toEqual([]);
    const verdict = evaluateImageScanPolicy(
      {
        vulnerabilityFindings: 0,
        vulnerabilityBySeverity: {},
        secretFindings: 1,
        mountedFilesystems: 3,
        candidateRootProof: '/mnt/candidate/sda1/etc/os-release',
      },
      AWS_IMAGE_SCAN_POLICY,
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.some((f) => f.code === 'secret-threshold')).toBe(true);
  });

  it('degrades to the PRE-ALLOWANCE behaviour when the list is unusable, not to a weaker one', () => {
    // The designed property: an allowlist that cannot be applied soundly excuses NOTHING and
    // leaves the raw bundled count to be judged, so the image still denies through the ordinary
    // secret bar on the honest number. An earlier draft returned early with only
    // 'secret-allowance-unusable', which replaced a true "this image exceeds the bar" with a
    // narrower complaint about the instrument — strictly less actionable, and it silently
    // changed the failure taxonomy every existing caller reads.
    const verdict = evaluateImageScanPolicy(
      scanWith(realBundledFindings(), { secretBundledSampleComplete: false }),
      GCP_IMAGE_SCAN_POLICY,
    );
    expect(verdict.accepted).toBe(false);
    const codes = verdict.failures.map((failure) => failure.code);
    expect(codes).toContain('secret-allowance-unusable');
    expect(codes).toContain('secret-threshold');
    // All 32 judged — none quietly excused by a list that could not be trusted.
    expect(verdict.policyViolatingSecrets).toBe(32);
  });

  it('does not require a sample when the bundle is clean', () => {
    // Zero bundled findings needs no enumeration to justify: there is nothing to excuse, so
    // demanding the field would red a green image on a technicality.
    const verdict = evaluateImageScanPolicy(
      scanWith([], { secretBundledSample: undefined, secretBundledSampleComplete: undefined }),
      GCP_IMAGE_SCAN_POLICY,
    );
    expect(verdict.accepted).toBe(true);
  });
});
