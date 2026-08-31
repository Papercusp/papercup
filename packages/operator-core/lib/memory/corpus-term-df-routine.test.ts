/**
 * Unit tests for corpus-term-df-routine.ts (WI-1406487: the `corpus-term-df`
 * routine's 6h ephemeral cadence was structurally unfireable — the ephemeral
 * executor's in-process timer resets on every bg-host restart, and this box's
 * measured longest continuous uptime is shorter than the 6h interval, so the
 * timer never once reached its own deadline. Fixed by moving the row to
 * `tier='durable'` / `trigger_kind='cron'`, whose `next_fire_at` due-gate is a
 * Postgres column and survives a restart. A fake Sql tagged-template captures
 * the interpolated values — no real PG; mirrors hive-git-gc-routine.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  upsertCorpusTermDfRoutine,
  CORPUS_TERM_DF_ROUTINE_NAME,
  CORPUS_TERM_DF_TARGET,
  DEFAULT_CORPUS_TERM_DF_CRON,
} from './corpus-term-df-routine';

function fakeSql(rows: Array<Record<string, unknown>>) {
  const calls: unknown[][] = [];
  const fn = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return rows;
  });
  return { sql: fn as unknown as Sql, calls };
}

describe('upsertCorpusTermDfRoutine', () => {
  it('seeds a DURABLE cron row (WI-1406487: never ephemeral again)', async () => {
    const { sql, calls } = fakeSql([{ id: 'rt_papercusp_corpus_term_df' }]);
    const out = await upsertCorpusTermDfRoutine(sql, {
      workspaceId: 'ws-1',
      installSlug: 'papercusp',
    });
    expect(out).toEqual({ id: 'rt_papercusp_corpus_term_df' });

    // Only the `${...}` placeholders become interpolated params — `'cron'`,
    // `'skip'`, `'skip-old'`, `'durable'`, and `now()` are literal SQL text
    // in the template and are asserted separately below via the raw SQL.
    // Interpolation order: id, install_slug, name, trigger_config,
    // target_role, active, workspace_id.
    const values = calls[0];
    expect(values[0]).toBe('rt_papercusp_corpus_term_df');
    expect(values[1]).toBe('papercusp'); // install_slug
    expect(values[2]).toBe(CORPUS_TERM_DF_ROUTINE_NAME); // name

    const triggerConfig = JSON.parse(values[3] as string);
    expect(triggerConfig).toEqual({ cron: DEFAULT_CORPUS_TERM_DF_CRON });
    // No `interval_sec` anywhere in trigger_config — that key is what the
    // (now-removed) ephemeral executor read to arm its in-process timer;
    // its presence would silently resurrect the unfireable ephemeral shape
    // if a future edit ever re-added it as a stray key.
    expect(triggerConfig).not.toHaveProperty('interval_sec');

    expect(values[4]).toBe(CORPUS_TERM_DF_TARGET); // target_role
    expect(values[5]).toBe(true); // active default
    expect(values[6]).toBe('ws-1'); // workspace_id

    // The tier/trigger_kind/next_fire_at literals live in the SQL text, not
    // the params array — THE fix under test, so assert them directly.
    const rawStrings = (sql as unknown as { mock: { calls: [TemplateStringsArray][] } }).mock
      .calls[0][0];
    const fullSql = rawStrings.join('?');
    expect(fullSql).toMatch(/'cron'/);
    expect(fullSql).toMatch(/'durable'/); // tier — never 'ephemeral' again
    expect(fullSql).not.toMatch(/'ephemeral'/);
    expect(fullSql).toContain('now()'); // next_fire_at — never a bare NULL
  });

  it('honors an explicit cron override and optional sampleDocs / active:false', async () => {
    const { sql, calls } = fakeSql([{ id: 'rt_x' }]);
    await upsertCorpusTermDfRoutine(sql, {
      workspaceId: 'ws-1',
      installSlug: 'papercusp',
      cron: '*/5 * * * *',
      sampleDocs: 500,
      active: false,
    });
    const values = calls[0];
    const triggerConfig = JSON.parse(values[3] as string);
    expect(triggerConfig).toEqual({ cron: '*/5 * * * *', sample_docs: 500 });
    expect(values[5]).toBe(false); // active

    // tier stays 'durable' regardless of `active` — it is a literal in the
    // SQL text, not gated on the active flag.
    const rawStrings = (sql as unknown as { mock: { calls: [TemplateStringsArray][] } }).mock
      .calls[0][0];
    expect(rawStrings.join('?')).toMatch(/'durable'/);
  });

  it('re-applies tier + next_fire_at on conflict, but never active (EI-19301170070808928)', async () => {
    const { sql } = fakeSql([{ id: 'rt_x' }]);
    await upsertCorpusTermDfRoutine(sql, { workspaceId: 'ws-1', installSlug: 'papercusp' });
    const rawStrings = (sql as unknown as { mock: { calls: [TemplateStringsArray][] } }).mock
      .calls[0][0];
    const fullSql = rawStrings.join('?');
    expect(fullSql).toMatch(/ON CONFLICT[\s\S]*tier\s*=\s*EXCLUDED\.tier/);
    expect(fullSql).toMatch(/ON CONFLICT[\s\S]*next_fire_at\s*=\s*EXCLUDED\.next_fire_at/);
    // `active` must NOT be reassigned in the DO UPDATE SET clause — grep the
    // conflict clause specifically, since `active` legitimately appears in
    // the INSERT column list above it.
    const conflictClause = fullSql.slice(fullSql.indexOf('ON CONFLICT'));
    expect(conflictClause).not.toMatch(/\bactive\s*=\s*EXCLUDED\.active/);
  });
});
