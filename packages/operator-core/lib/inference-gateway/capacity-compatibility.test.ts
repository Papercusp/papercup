import { describe, expect, it } from 'vitest';
import {
  CAPACITY_COMPATIBILITY_MATRIX,
  INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_FIELDS,
  INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_GROUPS,
  INFERENCE_GATEWAY_CAPACITY_INVENTORY,
  INFERENCE_GATEWAY_CAPACITY_ROLLBACK_FORBIDDEN_VALUES,
  INFERENCE_GATEWAY_COMPATIBILITY_MATRIX_SCHEMA_VERSION,
  compatibilityForInferenceGatewayWriter,
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
    const row = compatibilityForInferenceGatewayWriter('gateway-claude-default-concurrency');
    expect(row?.groupId).toBe('gateway-concurrency');
    expect(row?.writerIds).toEqual(['gateway-claude-default-concurrency']);
    expect(row?.stateConsumers.some((path) => path.includes('resource-governor'))).toBe(true);
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
