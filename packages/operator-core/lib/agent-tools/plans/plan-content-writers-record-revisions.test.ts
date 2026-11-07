/**
 * WI-10006321 — every raw writer of `harness_plans.content` records a plan_revisions row.
 *
 * `withPlanLock` enforces the revision spine for plan writes that go through it (the
 * WI-10002881 guard). Writers that use raw SQL bypass that guard. Measured 2026-10-06: 115 live
 * local plans had no revision at all (108 of them `@run-` instances cloned by
 * plan-run-action.ts), so the plan-parts reconcile sweep had no content clock for them and
 * fell back to `updated_at`, which non-content writes also bump.
 *
 * The bug class is a source file that writes plan content with raw SQL and never records a
 * revision. The SQL lives in template literals, so strings are kept and only comments are
 * stripped: a comment that quotes the SQL must not count as a writer. The population is
 * DERIVED by walking the tree, never hand-listed; the positive control below fails if the
 * walk stops finding the writers it is known to contain.
 *
 * Granularity is per FILE: a file with one recorded writer and one unrecorded writer passes.
 * Per-statement pairing would need a parser; the file-level rule still catches the observed
 * class, which is a file with no revision recorder at all.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripCommentsOnly } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';
import {
  PLAN_WRITER_SCAN_ROOTS as SCAN_ROOTS,
  PLAN_WRITER_EXEMPTIONS as EXEMPT,
  contentWritesWithoutHash,
  isPlanWriterSourcePath,
  recordsRevision,
  scanPlanContentWriter,
  writesPlanContent,
  type PlanContentWriter,
} from './plan-content-writer-census';

const REPO_ROOT = resolve(__dirname, '../../../../..');

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (isPlanWriterSourcePath(relative(REPO_ROOT, full))) {
      out.push(full);
    }
  }
}

let writerCensus: PlanContentWriter[] | undefined;
function contentWriters(): PlanContentWriter[] {
  if (writerCensus) return writerCensus;
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), files);
  const writers: PlanContentWriter[] = [];
  for (const full of files) {
    const rel = relative(REPO_ROOT, full);
    const raw = readFileSync(full, 'utf8');
    const writer = scanPlanContentWriter(rel, raw);
    if (writer) writers.push(writer);
  }
  return writerCensus = writers;
}

describe('raw harness_plans content writers record a plan_revisions row', () => {
  it('calibration: the detector separates writers from non-writers, and comments are invisible', () => {
    const insert = 'await tx`INSERT INTO harness_shared.harness_plans (workspace_id, content) VALUES (${a}, ${b})`;';
    expect(writesPlanContent(insert)).toBe(true);
    expect(recordsRevision(insert)).toBe(false);
    expect(recordsRevision(`${insert}\nawait recordSystemPlanRevisionInTransaction(tx, args);`)).toBe(true);

    const contentUpdate = 'await sql`UPDATE harness_shared.harness_plans\n SET status = ${s}, content = ${b}\n WHERE x = 1`;';
    expect(writesPlanContent(contentUpdate)).toBe(true);
    // A status-only or hash-only UPDATE is not a content write.
    expect(writesPlanContent('await sql`UPDATE harness_shared.harness_plans SET status = ${s} WHERE x = 1`;')).toBe(false);
    expect(writesPlanContent('await sql`UPDATE harness_shared.harness_plans SET content_hash = ${h} WHERE x = 1`;')).toBe(false);
    // Neighbouring tables are not harness_plans.
    expect(writesPlanContent('await sql`INSERT INTO harness_shared.harness_plan_parts (content) VALUES (${b})`;')).toBe(false);

    const quoted = '// INSERT INTO harness_shared.harness_plans (content) VALUES (x)\nexport const n = 1;\n';
    expect(writesPlanContent(stripCommentsOnly(quoted, 'x.ts'))).toBe(false);
  });

  it('positive control: the walk finds the raw writers this tree is known to contain', () => {
    const files = contentWriters().map((w) => w.file);
    for (const known of [
      'packages/operator-core/lib/harness/routines/plan-run-action.ts',
      'packages/operator-core/lib/harness/routines/retire-run-instance-plan.ts',
      'packages/operator-core/lib/external-triggers/flagship-plan.ts',
      'packages/operator-core/lib/agent-tools/plans/adhoc-spec-scope.ts',
      'packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts',
    ]) {
      expect(files).toContain(known);
    }
  });

  it('every raw content writer records a revision (or is exempt with a reason)', () => {
    const offenders = contentWriters()
      .filter((w) => !w.recorded && !(w.file in EXEMPT))
      .map((w) => w.file);
    expect(offenders, `raw harness_plans.content writers with no plan_revisions recorder: ${offenders.join(', ')}`).toEqual([]);
  });

  it('calibration: a content write without content_hash is caught per statement', () => {
    const bare = 'INSERT INTO harness_shared.harness_plans (workspace_id, plan_slug, content)\n VALUES (${a}, ${b}, ${c})';
    expect(contentWritesWithoutHash(bare)).toHaveLength(1);
    expect(contentWritesWithoutHash(bare.replace('content)', 'content, content_hash)'))).toEqual([]);
    // content_hash alone is not "content": the hash-only column list is not a body write.
    expect(contentWritesWithoutHash('INSERT INTO harness_shared.harness_plans (plan_slug, content_hash) VALUES (1, 2)')).toEqual([]);
    expect(contentWritesWithoutHash('UPDATE harness_shared.harness_plans SET content = ${b}, version = 2 WHERE x = 1')).toHaveLength(1);
    expect(contentWritesWithoutHash('UPDATE harness_shared.harness_plans SET content = ${b}, content_hash = ${h} WHERE x = 1')).toEqual([]);
    // One file, two statements: the good one does not excuse the bad one.
    expect(contentWritesWithoutHash(`${bare};\nUPDATE harness_shared.harness_plans SET content = ${'${b}'}, content_hash = ${'${h}'} WHERE x = 1`)).toHaveLength(1);
  });

  it('every raw content write also writes content_hash', () => {
    const offenders: string[] = [];
    for (const { file } of contentWriters()) {
      if (file in EXEMPT) continue;
      const src = stripCommentsOnly(readFileSync(join(REPO_ROOT, file), 'utf8'), file);
      for (const stmt of contentWritesWithoutHash(src)) offenders.push(`${file}: ${stmt}`);
    }
    expect(offenders, `raw harness_plans.content writes that leave content_hash at its '' default:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every exemption still names a live writer', () => {
    const files = new Set(contentWriters().map((w) => w.file));
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(files.has(file), `${file} is exempt but no longer writes plan content`).toBe(true);
      expect(reason.trim()).not.toBe('');
      const source = stripCommentsOnly(readFileSync(join(REPO_ROOT, file), 'utf8'), file);
      // The exception is for a private seeded schema, not a canonical plan writer.
      expect(source).toMatch(/CREATE\s+TABLE\s+harness_shared\.harness_plans\b/);
      expect(source).toContain('CREATE DATABASE');
      expect(source).not.toMatch(/\bgetOrgPg\s*\(/);
    }
  });
});
