import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  evaluateRoutineEngineLiveness,
  readRoutineEngineLiveness,
} from './routine-engine-liveness';

const NOW_MS = Date.parse('2026-09-23T05:33:00.000Z');

describe('evaluateRoutineEngineLiveness', () => {
  it('considers a recent successful tick live', () => {
    expect(evaluateRoutineEngineLiveness(NOW_MS - 30_000, NOW_MS)).toMatchObject({
      stale: false,
      unknown: false,
      staleMs: 30_000,
    });
  });

  it('considers an old successful tick stale', () => {
    expect(evaluateRoutineEngineLiveness(NOW_MS - 7 * 60_000, NOW_MS)).toMatchObject({
      stale: true,
      unknown: false,
      staleMs: 7 * 60_000,
    });
  });

  it('keeps a missing tick measurement unknown', () => {
    expect(evaluateRoutineEngineLiveness(null, NOW_MS)).toMatchObject({
      stale: false,
      unknown: true,
      lastTickMs: null,
      staleMs: null,
    });
  });
});

describe('readRoutineEngineLiveness', () => {
  it('reads completed successful ticks, not merely newly enqueued workflows', async () => {
    let queryText = '';
    const mockSql = (strings: TemplateStringsArray) => {
      queryText = strings.join(' ');
      return Promise.resolve([{ last_tick_ms: NOW_MS - 2_000 }]);
    };

    const result = await readRoutineEngineLiveness(mockSql as unknown as Sql, { nowMs: NOW_MS });

    expect(result).toMatchObject({ stale: false, unknown: false, staleMs: 2_000 });
    expect(queryText).toContain('MAX(completed_at)');
    expect(queryText).toContain("status = 'SUCCESS'");
    expect(queryText).not.toContain('MAX(created_at)');
  });

  it('keeps query failures unknown rather than inventing scheduler liveness', async () => {
    const mockSql = () => Promise.reject(new Error('database unavailable'));

    await expect(readRoutineEngineLiveness(mockSql as unknown as Sql, { nowMs: NOW_MS })).resolves.toMatchObject({
      stale: false,
      unknown: true,
      lastTickMs: null,
      staleMs: null,
    });
  });
});
