import { describe, expect, it } from 'vitest';
import { RECORDED_TEST_LAYERS, recordedTestLayer } from '@papercusp/test-config/execution-details';
import {
  acceptanceBarContractGaps,
  checkFileTestLayers,
  isExplicitlyManualCheck,
  type AcceptanceBarContractGapInput,
} from './acceptance-bar-contract-completeness';

const complete: AcceptanceBarContractGapInput = {
  role: 'outcome',
  method: 'Run the focused proof and read its verdict.',
  check: { kind: 'tests', files: ['packages/operator-core/lib/foo.integration.test.ts'] },
  requiredTestLayers: ['integration'],
  automatedProofRequired: true,
};

const gapsOf = (input: Partial<AcceptanceBarContractGapInput>) =>
  acceptanceBarContractGaps({ ...complete, ...input }).map((finding) => finding.gap);

describe('checkFileTestLayers — the repo test taxonomy, from the path alone', () => {
  it('classifies each canonical framework and refuses to guess for non-test paths', () => {
    expect([...checkFileTestLayers('lib/a.test.ts')!]).toEqual(['unit']);
    expect([...checkFileTestLayers('lib/a.integration.test.ts')!]).toEqual(['integration']);
    expect([...checkFileTestLayers('lib/a.browser.test.tsx')!]).toEqual(['browser']);
    expect([...checkFileTestLayers('apps/operator/e2e/flow.spec.ts')!]).toEqual(['e2e']);
    expect([...checkFileTestLayers('lib/llm-testing/scenarios/su/a.test.ts')!].sort()).toEqual(['llm', 'unit']);
    expect(checkFileTestLayers('lib/a.ts')).toBeNull();
  });
});

// EI-24434635346407728 — a BAR may require only layers the ledger recorder can write.
// Before, the recorder knew unit|integration|browser while BARs required e2e|llm, so
// those clauses could never pass correct-layer.
describe('one test-layer taxonomy for BAR contracts and the ledger recorder', () => {
  const everyClassifiedLayer = new Set(
    ['a.test.ts', 'a.integration.test.ts', 'a.browser.test.tsx', 'e2e/a.spec.ts', 'llm-testing/a.test.ts', 'a.llm.test.ts']
      .flatMap((path) => [...(checkFileTestLayers(path) ?? [])]),
  );

  it('every layer a check file can prove is a layer the recorder persists and reads back', () => {
    expect([...everyClassifiedLayer].sort()).toEqual([...RECORDED_TEST_LAYERS].sort());
    for (const layer of RECORDED_TEST_LAYERS) {
      expect(recordedTestLayer({ schemaVersion: 1, testLayer: layer })).toBe(layer);
      expect(recordedTestLayer(JSON.stringify({ schemaVersion: 1, testLayer: layer }))).toBe(layer);
    }
  });

  it('still refuses a layer outside the taxonomy rather than widening silently', () => {
    expect(recordedTestLayer({ schemaVersion: 1, testLayer: 'mutation' })).toBeUndefined();
    expect(recordedTestLayer({ schemaVersion: 2, testLayer: 'llm' })).toBeUndefined();
  });
});

describe('acceptanceBarContractGaps', () => {
  it('passes a complete contract', () => {
    expect(gapsOf({})).toEqual([]);
  });

  it('names METHOD, check and layers separately — the late-amendment shape of an unrefined seed', () => {
    expect(gapsOf({ method: '  ', check: undefined, requiredTestLayers: undefined })).toEqual([
      'method_missing',
      'check_missing',
      'test_layers_missing',
    ]);
  });

  it('demands layers only from an outcome that owes automated proof', () => {
    expect(gapsOf({ requiredTestLayers: [], automatedProofRequired: false })).toEqual([]);
    expect(gapsOf({ requiredTestLayers: [], role: 'disclosure' })).toEqual([]);
  });

  // docs/evidence/review-system-time-audit-2026-09-23.md: R-6 declared integration while
  // its check named a string-level unit test, and nothing flagged it until vetting.
  it('refuses a check file that cannot satisfy a declared layer (the R-6 shape)', () => {
    const findings = acceptanceBarContractGaps({
      ...complete,
      check: { kind: 'tests', files: ['lib/foo.test.ts'] },
    });
    expect(findings.map((finding) => finding.gap)).toEqual(['check_layer_mismatch']);
    expect(findings[0]!.detail).toContain('integration');
    expect(findings[0]!.detail).toContain('lib/foo.test.ts is unit');
  });

  it('accepts a check whose files jointly cover every declared layer', () => {
    expect(
      gapsOf({
        check: { kind: 'tests', files: ['lib/a.test.ts', 'lib/a.integration.test.ts'] },
        requiredTestLayers: ['unit', 'integration'],
      }),
    ).toEqual([]);
  });

  it('claims no mismatch when a file or a declared layer has no naming convention', () => {
    expect(gapsOf({ check: { kind: 'tests', files: ['scripts/probe.mjs'] } })).toEqual([]);
    expect(gapsOf({ check: { kind: 'tests', files: ['lib/a.test.ts'] }, requiredTestLayers: ['mutation'] })).toEqual([]);
  });

  // goal-agent-behavior-feedback-2026-09-06 carried seven BARs of exactly this shape.
  it('refuses an explicitly manual check that still declares test layers', () => {
    const manual = { kind: 'instrument', instrumentKey: 'none' } as const;
    expect(isExplicitlyManualCheck(manual)).toBe(true);
    const findings = acceptanceBarContractGaps({
      ...complete,
      check: manual,
      requiredTestLayers: ['llm', 'e2e'],
    });
    expect(findings.map((finding) => finding.gap)).toEqual(['check_layer_mismatch']);
    expect(findings[0]!.detail).toContain('omit the `requiredTestLayers` field');
    // The truly manual BAR (no layers, no automated obligation) is complete.
    expect(gapsOf({ check: manual, requiredTestLayers: [], automatedProofRequired: false })).toEqual([]);
  });
});
