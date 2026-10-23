import { describe, expect, inject, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { integrationNeedsPostgres } from '../test/_integration-substrate.globalSetup';
import type {} from '../test/_integration-substrate.globalSetup';

// Exercises the real integration config/globalSetup selection. If the baseline
// database is selected alongside this canary, its baseline must still be ready.
describe('integration selection without a PostgreSQL dependency', () => {
  it('enrolls filesystem/parser native fixtures while retaining mixed and full database setup', () => {
    const native = fileURLToPath(new URL('./agent-tools/plans/plan-native-declarations.integration.test.ts', import.meta.url));
    const canary = fileURLToPath(new URL('./integration-substrate-selection.integration.test.ts', import.meta.url));
    const privateCoverage = fileURLToPath(new URL('./code-intelligence/test-coverage-map.integration.test.ts', import.meta.url));
    expect(integrationNeedsPostgres([native])).toBe(false);
    expect(integrationNeedsPostgres([native, canary])).toBe(false);
    expect(integrationNeedsPostgres([privateCoverage, canary])).toBe(false);
    expect(integrationNeedsPostgres([privateCoverage, native + '.unknown'])).toBe(true);
    expect(integrationNeedsPostgres([native, native + '.unknown'])).toBe(true);
    expect(integrationNeedsPostgres([])).toBe(true);
  });
  it('keeps integration evidence and matches the selected database substrate', () => {
    expect(inject('papercuspTestLayer')).toBe('integration');
    const substrate = inject('operatorIntegrationSubstrate');
    expect(['none', 'postgres']).toContain(substrate);
    if (substrate === 'none') expect(inject('baselineSchemaDsn')).toBeUndefined();
    else expect(inject('baselineSchemaDsn')).toEqual(expect.stringMatching(/^postgres(?:ql)?:\/\//));
  });
});
