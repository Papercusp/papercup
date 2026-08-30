import { describe, expect, it } from 'vitest';
import {
  CAPACITY_COMPATIBILITY_MATRIX,
  INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_FIELDS,
  INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_GROUPS,
  INFERENCE_GATEWAY_CAPACITY_INVENTORY,
  INFERENCE_GATEWAY_CAPACITY_ROLLBACK_FORBIDDEN_VALUES,
  INFERENCE_GATEWAY_COMPATIBILITY_MATRIX_SCHEMA_VERSION,
  TERMINAL_CAPACITY_COMPATIBILITY_DISPOSITIONS,
  compatibilityForInferenceGatewayWriter,
  validateInferenceGatewayCapacityCompatibilityGroups,
  validateInferenceGatewayCapacityCompatibilityMatrix,
} from './capacity-inventory';

describe('inference-gateway compatibility/deletion matrix (P-004)', () => {
  it('is versioned and covers every P-001 writer exactly once', () => {
    expect(INFERENCE_GATEWAY_COMPATIBILITY_MATRIX_SCHEMA_VERSION).toBe(
      'inference-gateway-capacity-compatibility-v1',
    );
    expect(INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_GROUPS.length).toBeGreaterThanOrEqual(10);
    expect(CAPACITY_COMPATIBILITY_MATRIX).toHaveLength(INFERENCE_GATEWAY_CAPACITY_INVENTORY.length);
    expect(new Set(CAPACITY_COMPATIBILITY_MATRIX.map((row) => row.writerId)).size).toBe(
      INFERENCE_GATEWAY_CAPACITY_INVENTORY.length,
    );
    expect(validateInferenceGatewayCapacityCompatibilityMatrix()).toEqual([]);
  });

  it('names the requested legacy field families and their release consumers', () => {
    const fields = INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_FIELDS.join('\n');
    for (const expected of [
      'PAPERCUSP_GATEWAY_CONCURRENCY',
      'PAPERCUSP_GATEWAY_CODEX_CONCURRENCY',
      'MAX_QUEUED',
      'per-account',
      'AIMD',
      'priority',
      'rate-limit',
      'resource-profile',
      'local-backend',
      'UI/API/state',
    ]) {
      expect(fields.toLowerCase()).toContain(expected.toLowerCase());
    }
    for (const row of CAPACITY_COMPATIBILITY_MATRIX) {
      expect(row.observeOnlyMigration.length).toBeGreaterThan(20);
      expect(row.warningReadback.length).toBeGreaterThan(20);
      expect(row.removalRelease).toMatch(/^P-\d{3}/);
      expect(row.docsRunbookConsumers.length).toBeGreaterThan(0);
      expect(row.apiConsumers.length).toBeGreaterThan(0);
      expect(row.stateConsumers.length).toBeGreaterThan(0);
    }
  });

  it('makes rollback safety machine-checkable and preserves the legacy forbidden set', () => {
    expect(INFERENCE_GATEWAY_CAPACITY_ROLLBACK_FORBIDDEN_VALUES).toEqual([24, 3, 4, 45, 64, 256]);
    for (const row of CAPACITY_COMPATIBILITY_MATRIX) {
      expect(row.rollbackNeverReinstatesNumericCap).toBe(true);
      expect(row.rollbackBehavior.toLowerCase()).toContain('observe-only');
      expect(row.rollbackBehavior.toLowerCase()).toContain('never reinstate');
      expect(row.rollbackForbiddenValues).toEqual(INFERENCE_GATEWAY_CAPACITY_ROLLBACK_FORBIDDEN_VALUES);
    }
  });

  it('joins an exact writer to its family policy without exposing a second governor', () => {
    const row = compatibilityForInferenceGatewayWriter('provider-admission-initial-window');
    expect(row?.groupId).toBe('provider-admission-seed');
    expect(row?.writerIds).toEqual(['provider-admission-initial-window']);
    expect(row?.stateConsumers.some((path) => path.includes('resource-governor'))).toBe(true);
    // P-010 deleted `gateway-claude-default-concurrency` (and the Codex slot writers)
    // outright. A join against a retired writer must answer "no such writer", not a
    // stale policy row — that is what makes the deletion observable here.
    expect(compatibilityForInferenceGatewayWriter('gateway-claude-default-concurrency')).toBeUndefined();
    expect(compatibilityForInferenceGatewayWriter('gateway-codex-slots-per-account')).toBeUndefined();
  });

  it('rejects missing contracts, unknown writers, and rollback-cap regressions', () => {
    const baseline = CAPACITY_COMPATIBILITY_MATRIX[0];
    const findings = validateInferenceGatewayCapacityCompatibilityMatrix([
      {
        ...baseline,
        id: 'broken',
        writerId: 'not-in-inventory',
        observeOnlyMigration: '',
        rollbackNeverReinstatesNumericCap: false,
        docsRunbookConsumers: [],
      },
    ]);
    expect(findings).toContain('compatibility-unknown-writer:not-in-inventory');
    expect(findings).toContain('compatibility-missing:broken:observeOnlyMigration');
    expect(findings).toContain('compatibility-missing:broken:docsRunbookConsumers');
    expect(findings).toContain('compatibility-rollback-cap-allowed:broken');
    expect(findings).toContain('compatibility-uncovered-writer:' + INFERENCE_GATEWAY_CAPACITY_INVENTORY[1].id);
  });
});

describe('terminal disposition contract (P-015)', () => {
  const liveGroup = INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_GROUPS[0];

  it('every family is terminal and carries dated, falsifiable evidence', () => {
    expect(validateInferenceGatewayCapacityCompatibilityGroups()).toEqual([]);
    for (const group of INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_GROUPS) {
      expect(TERMINAL_CAPACITY_COMPATIBILITY_DISPOSITIONS.has(group.disposition)).toBe(true);
      const evidence = group.dispositionEvidence;
      expect(evidence, group.id).toBeDefined();
      // A recheck that names no probe is prose, not evidence — the whole point of the field is
      // that a later reader can re-run it instead of taking the verdict on trust.
      expect(evidence!.recheck.length, group.id).toBeGreaterThan(40);
      expect(evidence!.measurement.length, group.id).toBeGreaterThan(40);
    }
  });

  it('the group validator is FALSIFIABLE — controls for each way a disposition can lie', () => {
    // Control 1: a family still parked on a pending gate after the last gate ran.
    expect(
      validateInferenceGatewayCapacityCompatibilityGroups([
        { ...liveGroup, id: 'pending', disposition: 'remove-after-gate', dispositionEvidence: undefined },
      ]),
    ).toContain('compatibility-non-terminal:pending');

    // Control 2: terminal, but asserted with no measurement behind it.
    expect(
      validateInferenceGatewayCapacityCompatibilityGroups([
        { ...liveGroup, id: 'bare', disposition: 'readback-only', dispositionEvidence: undefined },
      ]),
    ).toContain('compatibility-evidence-missing:bare');

    // Control 3: "deleted" claimed while the census still lists a live writer for the family.
    expect(
      validateInferenceGatewayCapacityCompatibilityGroups([
        {
          ...liveGroup,
          id: 'ghost',
          disposition: 'removed',
          writerIds: ['gateway-aimd-floor'],
          dispositionEvidence: {
            verdict: 'deleted',
            measuredAt: '2026-08-30',
            measurement: 'x'.repeat(50),
            recheck: 'y'.repeat(50),
          },
        },
      ]),
    ).toContain('compatibility-evidence-verdict-deleted-has-writers:ghost');

    // Control 4: "non-capacity" claimed about a family that has no live writer left to measure.
    expect(
      validateInferenceGatewayCapacityCompatibilityGroups([
        {
          ...liveGroup,
          id: 'phantom',
          disposition: 'feedback-only',
          writerIds: [],
          dispositionEvidence: {
            verdict: 'non-capacity',
            measuredAt: '2026-08-30',
            measurement: 'x'.repeat(50),
            recheck: 'y'.repeat(50),
          },
        },
      ]),
    ).toContain('compatibility-evidence-verdict-live-has-no-writers:phantom');

    // Control 5: an undated measurement — "this no longer binds" with no when is unfalsifiable.
    expect(
      validateInferenceGatewayCapacityCompatibilityGroups([
        {
          ...liveGroup,
          id: 'undated',
          disposition: 'readback-only',
          dispositionEvidence: {
            verdict: 'non-capacity',
            measuredAt: 'recently',
            measurement: 'x'.repeat(50),
            recheck: 'y'.repeat(50),
          },
        },
      ]),
    ).toContain('compatibility-evidence-date:undated');
  });

  it('the matrix validator FOLDS IN the group contract, including zero-writer families', () => {
    // gateway-codex-concurrency flattens to zero rows because P-010 deleted every writer in it,
    // so the per-writer validator cannot see it. This is the check that it is still governed.
    const codex = INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_GROUPS.find(
      (g) => g.id === 'gateway-codex-concurrency',
    );
    expect(codex?.writerIds).toEqual([]);
    expect(CAPACITY_COMPATIBILITY_MATRIX.some((row) => row.groupId === 'gateway-codex-concurrency')).toBe(false);
    expect(codex?.disposition).toBe('removed');
    expect(codex?.dispositionEvidence?.verdict).toBe('deleted');
    // The default-matrix call reaches the group contract; an explicit row list does not.
    expect(validateInferenceGatewayCapacityCompatibilityMatrix()).toEqual([]);
  });
});
