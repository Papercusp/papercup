/**
 * Corpus seeding tests — verify seedCorpus populates iq_battery_cases idempotently.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTestPg } from '@papercusp/test-config';
import { seedCorpus, AllCases } from './corpus';

describe('seedCorpus', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    const adminUri = await getTestPg();
    const dbName = `iq_battery_seed_${randomBytes(5).toString('hex')}`;
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    const u = new URL(adminUri);
    u.pathname = `/${dbName}`;
    sql = postgres(u.toString(), { max: 8, onnotice: () => {} });

    // Apply the migration DDL
    let ddl = '';
    const basePath = __dirname.includes('dist') ? '../' : '';
    const paths = [
      join(__dirname, basePath + '../../../../libs/papercusp/libs/db/sql/179-iq-battery-corpus.sql'),
      join(__dirname, basePath + '../../../libs/papercusp/libs/db/sql/179-iq-battery-corpus.sql'),
      '/home/marsh-office/papercupai-workspace/papercup/libs/papercusp/libs/db/sql/179-iq-battery-corpus.sql',
    ];
    for (const path of paths) {
      try {
        ddl = readFileSync(path, 'utf8');
        break;
      } catch (e) {
        // Continue to next path
      }
    }
    if (!ddl) {
      throw new Error(`Could not find migration file in any of the expected locations: ${paths.join(', ')}`);
    }
    await sql.unsafe(ddl);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    // Clear tables before each test (cascade to handle foreign keys)
    await sql.unsafe('TRUNCATE TABLE iq_battery_metrics, iq_battery_cases');
  });

  it('populates iq_battery_cases table from AllCases', async () => {
    await seedCorpus(sql);

    const cases = await sql<Array<{ id: string; variant: string; title: string }>>`
      SELECT id, variant, title FROM iq_battery_cases ORDER BY variant, id
    `;

    expect(cases.length).toBe(AllCases.length);
    expect(cases[0].variant).toBeDefined();
    expect(cases[0].title).toBeDefined();
    expect(cases[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('is idempotent — second run does not duplicate rows', async () => {
    await seedCorpus(sql);
    const firstCount = await sql<Array<{ count: number }>>`
      SELECT COUNT(*) as count FROM iq_battery_cases
    `;

    await seedCorpus(sql);
    const secondCount = await sql<Array<{ count: number }>>`
      SELECT COUNT(*) as count FROM iq_battery_cases
    `;

    expect(secondCount[0].count).toBe(firstCount[0].count);
  });

  it('stores ground_truth and rubric as jsonb', async () => {
    await seedCorpus(sql);

    const cases = await sql<
      Array<{
        ground_truth: Record<string, unknown>;
        rubric: Record<string, unknown>;
      }>
    >`
      SELECT ground_truth, rubric FROM iq_battery_cases LIMIT 1
    `;

    expect(cases[0]).toBeDefined();
    expect(cases[0].ground_truth).toBeDefined();
    expect(typeof cases[0].ground_truth).toBe('object');
    expect(cases[0].rubric).toBeDefined();
    expect(typeof cases[0].rubric).toBe('object');
    const rubric = cases[0].rubric as Record<string, unknown>;
    expect(Array.isArray(rubric.dimensions)).toBe(true);
  });

  it('sets rotation_index correctly for each variant', async () => {
    await seedCorpus(sql);

    const indices = await sql<Array<{ variant: string; rotation_index: number; count: number }>>`
      SELECT variant, rotation_index, COUNT(*) as count
      FROM iq_battery_cases
      GROUP BY variant, rotation_index
      ORDER BY variant, rotation_index
    `;

    const variantGroups = new Map<string, number[]>();
    for (const row of indices) {
      if (!variantGroups.has(row.variant)) {
        variantGroups.set(row.variant, []);
      }
      variantGroups.get(row.variant)!.push(row.rotation_index);
    }

    for (const [variant, indices] of variantGroups) {
      const sorted = [...indices].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length; i++) {
        expect(sorted[i]).toBe(i);
      }
    }
  });
});
