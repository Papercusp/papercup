/**
 * scan.integration.test.ts — the negative-space miner's live artifact probe
 * (frontier P-044 / FB-18, + the FB-18 follow-on memory-anchor leg) against a
 * real MIGRATED Postgres.
 *
 * probeDemandArtifact is the IO half of the kind-fidelity split: exists +
 * zero-hit = resolution gap (kind=bug, EI-397 shape), absent = missing
 * knowledge (kind=change). The unit tests fake the probe (scan.test.ts); this
 * pins the THREE real legs end-to-end, each with its exists→ref / absent→null
 * pair plus the degrade-to-null guards that keep a probe miss from ever
 * manufacturing a falsely-confident bug:
 *   plans  — exact plan_slug anywhere in harness_shared.harness_plans (the
 *            cross-scope EI-397 case);
 *   docs   — MDX slug match in a corpus dir (basename + section/slug path,
 *            missing-corpus degrade);
 *   memory — exact memory_anchors.value on an ACTIVE memory_canonical row
 *            (the identifier-keyed leg; non-active = deliberate removal, null).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { probeDemandArtifact } from './scan';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('probeDemandArtifact — plans leg (frontier P-044, EI-397 cross-scope shape)', () => {
  it('an exact plan_slug present in harness_plans resolves to plan:<slug>, regardless of owning scope', async () => {
    const slug = 'fb18-probe-plan-2026-06-13';
    // Deliberately a DIFFERENT workspace/harness than the searcher — the probe
    // is cross-scope on purpose (the EI-397 case: a harness-scoped agent
    // zero-hitting an operator-scope plan it names exactly).
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
      VALUES ('some-other-ws', 'some-harness', ${slug})`;
    expect(await probeDemandArtifact(db.adminSql, 'plans', slug)).toBe(`plan:${slug}`);
  });

  it('an absent plan_slug is null (missing knowledge, not a resolution gap)', async () => {
    expect(await probeDemandArtifact(db.adminSql, 'plans', 'no-such-plan-xyz-2026')).toBeNull();
  });
});

describe('probeDemandArtifact — docs leg', () => {
  let docsDir: string;

  beforeAll(async () => {
    docsDir = await mkdtemp(join(tmpdir(), 'fb18-docs-'));
    await writeFile(join(docsDir, 'top-level-page.mdx'), '# top');
    await mkdir(join(docsDir, 'system'), { recursive: true });
    await writeFile(join(docsDir, 'system', 'nested-page.md'), '# nested');
  });

  afterAll(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  it('a basename slug match resolves to doc:<slug>', async () => {
    expect(await probeDemandArtifact(db.adminSql, 'docs', 'top-level-page', docsDir)).toBe('doc:top-level-page');
  });

  it('a section/slug path match resolves to doc:<section/slug>', async () => {
    expect(await probeDemandArtifact(db.adminSql, 'docs', 'system/nested-page', docsDir)).toBe('doc:system/nested-page');
  });

  it('an absent slug is null', async () => {
    expect(await probeDemandArtifact(db.adminSql, 'docs', 'no-such-doc', docsDir)).toBeNull();
  });

  it('a missing corpus dir degrades to null (the stripped-deploy-tree rule), never throws', async () => {
    expect(await probeDemandArtifact(db.adminSql, 'docs', 'top-level-page', join(docsDir, 'does-not-exist'))).toBeNull();
  });
});

describe('probeDemandArtifact — memory leg (FB-18 follow-on: anchors are the identifier-keyed index)', () => {
  it('an ACTIVE memory anchored to the exact query resolves to memory-anchor:<value>', async () => {
    const value = 'lib/replay/regret/mine.ts';
    const [m] = await db.adminSql<{ id: string }[]>`
      INSERT INTO harness_shared.memory_canonical (payload, state)
      VALUES ('{"name":"regret miner file note"}'::jsonb, 'active')
      RETURNING id`;
    await db.adminSql`
      INSERT INTO harness_shared.memory_anchors (memory_id, kind, value)
      VALUES (${m!.id}, 'file', ${value})`;
    expect(await probeDemandArtifact(db.adminSql, 'memory', value)).toBe(`memory-anchor:${value}`);
  });

  it('matches case-insensitively and returns the stored-case value (the query is normalized lowercase)', async () => {
    const [m] = await db.adminSql<{ id: string }[]>`
      INSERT INTO harness_shared.memory_canonical (state) VALUES ('active') RETURNING id`;
    await db.adminSql`
      INSERT INTO harness_shared.memory_anchors (memory_id, kind, value)
      VALUES (${m!.id}, 'feature', 'F-204')`;
    expect(await probeDemandArtifact(db.adminSql, 'memory', 'f-204')).toBe('memory-anchor:F-204');
  });

  it('an anchor on a NON-active (forgotten) memory does NOT resolve — a deliberate removal is not a gap', async () => {
    const value = 'deliberately-forgotten-plan-2026-06-13';
    const [m] = await db.adminSql<{ id: string }[]>`
      INSERT INTO harness_shared.memory_canonical (state) VALUES ('forgotten') RETURNING id`;
    await db.adminSql`
      INSERT INTO harness_shared.memory_anchors (memory_id, kind, value)
      VALUES (${m!.id}, 'plan', ${value})`;
    expect(await probeDemandArtifact(db.adminSql, 'memory', value)).toBeNull();
  });

  it('no anchor match is null (missing knowledge)', async () => {
    expect(await probeDemandArtifact(db.adminSql, 'memory', 'never/anchored.ts')).toBeNull();
  });
});
