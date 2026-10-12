import { describe, expect, it, vi } from 'vitest';
import { ROUTINE_FALLBACK_MIGRATION_CASES } from './routine-fallback-migration-cases';
import { listDegradationMechanisms } from '../system-health/degradation-watchdog';
import * as recorder from './fallback-observations';

describe('P-009 original routine fallback producers', () => {
  for (const testCase of ROUTINE_FALLBACK_MIGRATION_CASES) {
    it(testCase.id, async () => {
      const sink = vi.spyOn(recorder, 'observeFallback').mockReturnValue(true);
      try {
        expect(listDegradationMechanisms().map((m) => m.mechanism)).toContain(testCase.mechanism);
        const result = await testCase.run();
        expect(result.route).toBe('observation');
        if (result.route !== 'observation') throw new Error('wrong route');
        expect(result.observations.some((o) => o.applied === 0)).toBe(true);
        expect(result.observations.some((o) => o.applied === 1)).toBe(true);
      } finally { sink.mockRestore(); }
    });
  }
});
