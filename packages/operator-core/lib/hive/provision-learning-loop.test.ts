/**
 * provisionHiveLearningLoop (per-hive-learning-loops-2026-06-14 P-020). PG-free:
 * a fake template-tag Sql records the writes. Pins the two load-bearing claims:
 *   (1) a DARK gym row (enabled:false, budget:null) keyed to the hive's OWN slug;
 *   (2) an INACTIVE scout routine under the hive's install_slug (NOT @singleton)
 *       carrying a per-hive payload_template budget;
 * and that the returned `undo` removes exactly both rows.
 */
import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import {
  provisionHiveLearningLoop,
  teardownHiveLearningLoop,
  hiveScoutRoutineId,
  staggeredHiveScoutCron,
  HIVE_SCOUT_CADENCE_MIN,
  DEFAULT_HIVE_SCOUT_MAX_COST_USD,
  HIVE_SCOUT_ROUTINE_NAME,
  SCOUT_CYCLE_TARGET_ROLE,
} from './provision-learning-loop';

/** A fake `sql` template tag that records each call's reconstructed text + values. */
function makeFakeSql(): { sql: Sql; calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve([] as unknown[]);
  };
  return { sql: tag as unknown as Sql, calls };
}

describe('hiveScoutRoutineId', () => {
  it('sanitizes the install_slug into a routines id', () => {
    expect(hiveScoutRoutineId('My-Hive.1')).toBe('rt_my_hive_1_scout_cycle');
  });
});

describe('staggeredHiveScoutCron (P-050 — deterministic per-hive cron offset)', () => {
  /** Parse a 6-field "S M,M+30 * * * *" cron into its second + the two minute fields. */
  function parse(cron: string): { second: number; minutes: number[] } {
    const [sec, mins] = cron.split(' ');
    return { second: Number(sec), minutes: mins.split(',').map(Number) };
  }

  it('produces a 6-field seconds-resolution cron firing twice an hour, 30 min apart', () => {
    const { second, minutes } = parse(staggeredHiveScoutCron('alpha'));
    expect(second).toBeGreaterThanOrEqual(0);
    expect(second).toBeLessThan(60);
    expect(minutes).toHaveLength(2);
    const [m0, m1] = minutes;
    expect(m0).toBeGreaterThanOrEqual(0);
    expect(m0).toBeLessThan(HIVE_SCOUT_CADENCE_MIN);
    expect(m1 - m0).toBe(HIVE_SCOUT_CADENCE_MIN); // the second fire is exactly +30 min
  });

  it('is STABLE / idempotent — the same slug always yields the same cron', () => {
    expect(staggeredHiveScoutCron('hive-acme')).toBe(staggeredHiveScoutCron('hive-acme'));
    // Independent of how many times we ask (no clock / no randomness).
    const once = staggeredHiveScoutCron('hive-acme');
    for (let i = 0; i < 5; i++) expect(staggeredHiveScoutCron('hive-acme')).toBe(once);
  });

  it('gives two DIFFERENT slugs DISTINCT offsets (the anti-burst guarantee)', () => {
    // The load-bearing P-050 claim: distinct hives fire at distinct cron boundaries.
    expect(staggeredHiveScoutCron('hive-acme')).not.toBe(staggeredHiveScoutCron('hive-beta'));
    expect(staggeredHiveScoutCron('alpha')).not.toBe(staggeredHiveScoutCron('omega'));
  });

  it('scatters a realistic fleet across many distinct (minute,second) slots — no mass collision', () => {
    const slugs = Array.from({ length: 50 }, (_, i) => `hive-${i}`);
    const offsets = new Set(slugs.map((s) => staggeredHiveScoutCron(s).split(' ').slice(0, 2).join(' ')));
    // 1800 slots in the window ⇒ 50 hives should spread to (near-)all distinct boundaries.
    expect(offsets.size).toBeGreaterThanOrEqual(48);
  });
});

describe('provisionHiveLearningLoop', () => {
  it('writes a DARK gym row + an INACTIVE scout routine keyed to the hive slug', async () => {
    const { sql, calls } = makeFakeSql();
    const res = await provisionHiveLearningLoop({ sql, workspaceId: 'w1', hiveSlug: 'alpha', now: 123 });

    expect(res.ok).toBe(true);
    expect(res.gymAutoloop).toBe(true);
    expect(res.scoutRoutine).toBe(true);
    expect(res.scoutRoutineId).toBe('rt_alpha_scout_cycle');
    expect(res.scoutMaxCostUsd).toBe(DEFAULT_HIVE_SCOUT_MAX_COST_USD);

    // setAutoloop does a getAutoloop SELECT then an INSERT; the scout routine is one INSERT.
    const gymInsert = calls.find((c) => c.text.includes('INSERT INTO harness_shared.gym_autoloop_config'));
    expect(gymInsert).toBeTruthy();
    // The DARK row: enabled false, budget null, keyed to the hive's own slug + ws.
    expect(gymInsert!.values).toContain('alpha');
    expect(gymInsert!.values).toContain('w1');
    expect(gymInsert!.values).toContain(false); // enabled:false
    expect(gymInsert!.values).toContain(null); // budget:null

    const routineInsert = calls.find((c) => c.text.includes('INSERT INTO harness_shared.routines'));
    expect(routineInsert).toBeTruthy();
    expect(routineInsert!.values).toContain('rt_alpha_scout_cycle');
    expect(routineInsert!.values).toContain('alpha'); // install_slug = the hive's OWN slug, NOT @singleton
    expect(routineInsert!.values).not.toContain('@singleton');
    expect(routineInsert!.values).toContain(HIVE_SCOUT_ROUTINE_NAME);
    expect(routineInsert!.values).toContain(SCOUT_CYCLE_TARGET_ROLE);
    // active is a literal `false` in the SQL text (not interpolated) — INACTIVE.
    expect(routineInsert!.text).toMatch(/'skip', 'skip-old', false, now\(\)/);
    // The per-hive budget rides payload_template.budget.maxCostUsd.
    const payload = routineInsert!.values.find(
      (v) => typeof v === 'string' && v.includes('maxCostUsd'),
    ) as string;
    expect(JSON.parse(payload)).toEqual({ budget: { maxCostUsd: DEFAULT_HIVE_SCOUT_MAX_COST_USD } });

    // P-050: the cron defaults to the DETERMINISTIC per-hive stagger (not the
    // legacy fixed :05/:35), a stable function of the hive slug.
    const cron = routineInsert!.values.find((v) => typeof v === 'string' && v.includes('"cron"')) as string;
    expect(JSON.parse(cron)).toEqual({ cron: staggeredHiveScoutCron('alpha') });
  });

  it('staggers the scout cron PER-HIVE — two hives provision DISTINCT cron offsets (P-050)', async () => {
    const cronFor = async (hiveSlug: string): Promise<string> => {
      const { sql, calls } = makeFakeSql();
      await provisionHiveLearningLoop({ sql, workspaceId: 'w1', hiveSlug });
      const routineInsert = calls.find((c) => c.text.includes('INSERT INTO harness_shared.routines'));
      const cron = routineInsert!.values.find((v) => typeof v === 'string' && v.includes('"cron"')) as string;
      return JSON.parse(cron).cron as string;
    };
    const acme = await cronFor('hive-acme');
    const beta = await cronFor('hive-beta');
    expect(acme).not.toBe(beta); // distinct boundaries ⇒ no shared-boundary burst
    // ...and idempotent: re-provisioning the same hive lays down the SAME cron.
    expect(await cronFor('hive-acme')).toBe(acme);
  });

  it('honors a per-hive budget + cron override', async () => {
    const { sql, calls } = makeFakeSql();
    const res = await provisionHiveLearningLoop({
      sql,
      workspaceId: 'w1',
      hiveSlug: 'beta',
      scoutMaxCostUsd: 0.25,
      scoutCron: '0 0 * * * *',
    });
    expect(res.scoutMaxCostUsd).toBe(0.25);
    const routineInsert = calls.find((c) => c.text.includes('INSERT INTO harness_shared.routines'));
    const payload = routineInsert!.values.find(
      (v) => typeof v === 'string' && v.includes('maxCostUsd'),
    ) as string;
    expect(JSON.parse(payload)).toEqual({ budget: { maxCostUsd: 0.25 } });
    const cron = routineInsert!.values.find((v) => typeof v === 'string' && v.includes('"cron"')) as string;
    expect(JSON.parse(cron)).toEqual({ cron: '0 0 * * * *' });
  });

  it('undo deletes both rows (best-effort, never throws)', async () => {
    const { sql, calls } = makeFakeSql();
    const res = await provisionHiveLearningLoop({ sql, workspaceId: 'w1', hiveSlug: 'gamma' });
    calls.length = 0; // isolate the undo's writes
    await res.undo();

    const gymDelete = calls.find((c) => c.text.includes('DELETE FROM harness_shared.gym_autoloop_config'));
    const routineDelete = calls.find((c) => c.text.includes('DELETE FROM harness_shared.routines'));
    expect(gymDelete).toBeTruthy();
    expect(gymDelete!.values).toContain('gamma');
    expect(routineDelete).toBeTruthy();
    expect(routineDelete!.values).toContain('gamma');
    expect(routineDelete!.values).toContain(HIVE_SCOUT_ROUTINE_NAME);
  });

  it('undo swallows a delete error (rollback must not throw)', async () => {
    // A sql that rejects every DELETE — undo must still resolve (a create rollback
    // can never throw, or it masks the original failure).
    const tag = (strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      if (text.includes('DELETE')) return Promise.reject(new Error('pg down'));
      return Promise.resolve([] as unknown[]);
    };
    const res = await provisionHiveLearningLoop({ sql: tag as unknown as Sql, workspaceId: 'w1', hiveSlug: 'delta' });
    await expect(res.undo()).resolves.toBeUndefined();
  });
});

describe('teardownHiveLearningLoop (P-021 — the hive:dissolve inverse)', () => {
  it('deletes the gym row, the scout routine, AND the gym:<hive>/scout:<hive> governor registrants', async () => {
    const { sql, calls } = makeFakeSql();
    const res = await teardownHiveLearningLoop({ sql, workspaceId: 'w1', hiveSlug: 'alpha' });

    expect(res).toEqual({
      hiveSlug: 'alpha',
      gymAutoloop: true,
      scoutRoutine: true,
      governorRegistrants: true,
      gitSyncRoutines: true,
    });

    const gymDelete = calls.find((c) => c.text.includes('DELETE FROM harness_shared.gym_autoloop_config'));
    expect(gymDelete).toBeTruthy();
    expect(gymDelete!.values).toContain('alpha');
    expect(gymDelete!.values).toContain('w1');

    const scoutDelete = calls.find(
      (c) => c.text.includes('DELETE FROM harness_shared.routines') && c.values.includes(HIVE_SCOUT_ROUTINE_NAME),
    );
    expect(scoutDelete).toBeTruthy();
    expect(scoutDelete!.values).toContain('alpha');

    // P-007 (git-sync-dx-hardening): the git-sync pipeline routines for this install are
    // ALSO reaped on dissolve (by target_role), scoped to this hive's install_slug.
    const gitSyncDelete = calls.find(
      (c) => c.text.includes('DELETE FROM harness_shared.routines') && c.text.includes('target_role'),
    );
    expect(gitSyncDelete).toBeTruthy();
    expect(gitSyncDelete!.text).toContain('system:git-sync');
    expect(gitSyncDelete!.values).toContain('alpha');
    expect(gitSyncDelete!.values).toContain('w1');

    // The two governor registrant deletes — keyed gym:<hive> and scout:<hive>.
    const govDeletes = calls.filter((c) =>
      c.text.includes('DELETE FROM harness_shared.learning_governor_loops'),
    );
    expect(govDeletes).toHaveLength(2);
    const govLoopIds = govDeletes.flatMap((c) => c.values);
    expect(govLoopIds).toContain('gym:alpha');
    expect(govLoopIds).toContain('scout:alpha');
  });

  it('is best-effort per-removal: a failing gym delete does NOT block the scout/governor removals', async () => {
    // The gym_autoloop_config delete rejects; the others still run + report.
    const tag = (strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      if (text.includes('gym_autoloop_config')) return Promise.reject(new Error('pg down'));
      return Promise.resolve([] as unknown[]);
    };
    const res = await teardownHiveLearningLoop({
      sql: tag as unknown as Sql,
      workspaceId: 'w1',
      hiveSlug: 'beta',
    });
    expect(res.gymAutoloop).toBe(false); // the failed removal
    expect(res.scoutRoutine).toBe(true); // unaffected
    expect(res.governorRegistrants).toBe(true); // unaffected
  });

  it('reports a governor-registrant delete failure without throwing', async () => {
    const tag = (strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      if (text.includes('learning_governor_loops')) return Promise.reject(new Error('pg down'));
      return Promise.resolve([] as unknown[]);
    };
    const res = await teardownHiveLearningLoop({
      sql: tag as unknown as Sql,
      workspaceId: 'w1',
      hiveSlug: 'gamma',
    });
    expect(res.gymAutoloop).toBe(true);
    expect(res.scoutRoutine).toBe(true);
    expect(res.governorRegistrants).toBe(false);
  });
});
