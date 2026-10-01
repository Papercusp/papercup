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
  it('reads ticks that completed the due-routine step, not successful early returns', async () => {
    let queryText = '';
    const mockSql = (strings: TemplateStringsArray) => {
      queryText = strings.join(' ');
      return Promise.resolve([{ last_tick_ms: NOW_MS - 2_000 }]);
    };

    const result = await readRoutineEngineLiveness(mockSql as unknown as Sql, { nowMs: NOW_MS });

    expect(result).toMatchObject({ stale: false, unknown: false, staleMs: 2_000 });
    expect(queryText).toContain('MAX(tick.completed_at)');
    expect(queryText).toContain("status = 'SUCCESS'");
    expect(queryText).toContain('dbos.operation_outputs');
    expect(queryText).toContain("function_name = 'list-due-routines'");
    expect(queryText).toContain('operation.error IS NULL');
    expect(queryText).not.toContain('MAX(created_at)');
  });

  it('parses the PostgreSQL timestamp string returned by the pooled getOrgPg client', async () => {
    const mockSql = () => Promise.resolve([{ last_tick_ms: '2026-09-23 01:32:58.000-04' }]);

    const result = await readRoutineEngineLiveness(mockSql as unknown as Sql, { nowMs: NOW_MS });

    expect(result).toMatchObject({
      lastTickMs: NOW_MS - 2_000,
      stale: false,
      unknown: false,
      staleMs: 2_000,
    });
  });

  it('keeps an unparseable timestamp unknown', async () => {
    const mockSql = () => Promise.resolve([{ last_tick_ms: 'not-a-timestamp' }]);

    await expect(readRoutineEngineLiveness(mockSql as unknown as Sql, { nowMs: NOW_MS })).resolves.toMatchObject({
      stale: false,
      unknown: true,
      lastTickMs: null,
      staleMs: null,
    });
  });

  it('keeps an early-return SUCCESS with no due-routine step unknown', async () => {
    let queryText = '';
    const mockSql = (strings: TemplateStringsArray) => {
      queryText = strings.join(' ');
      return Promise.resolve([{ last_tick_ms: null }]);
    };

    const result = await readRoutineEngineLiveness(mockSql as unknown as Sql, { nowMs: NOW_MS });

    expect(result).toMatchObject({ stale: false, unknown: true, lastTickMs: null, staleMs: null });
    expect(queryText).toContain("function_name = 'list-due-routines'");
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
