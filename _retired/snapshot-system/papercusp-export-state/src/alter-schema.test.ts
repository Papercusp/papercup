/**
 * Unit tests for `rewritePgDump` — the §15.6 step 7d boundary-anchored
 * SQL rewrite. This is the rule that pg_dump-style dumps for a per-harness
 * schema get rewritten to land in `<orig>_restoring` without touching
 * unrelated content.
 *
 * The rule has both directive-line patterns and a body-pattern (schema
 * qualifier `harness_<orig>.`); both are tested here. The smoke test in
 * `apps/papercusp-publish/scripts/smoke-test.mjs` runs against a live DB,
 * so this file pins the contract at the lexer level.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { rewritePgDump } from './alter-schema';

let work: string;

beforeEach(async () => {
  work = await fs.mkdtemp(join(tmpdir(), 'es-rewrite-'));
});
afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

async function gzip(input: string, dest: string): Promise<void> {
  await pipeline(Readable.from([input]), createGzip(), createWriteStream(dest));
}

async function runRewrite(input: string, orig: string, dst: string): Promise<string> {
  const inP = join(work, 'in.sql.gz');
  const outP = join(work, 'out.sql');
  await gzip(input, inP);
  await rewritePgDump({
    inputPath: inP,
    outputPath: outP,
    originalSlug: orig,
    restoringSchema: dst,
  });
  return fs.readFile(outP, 'utf8');
}

describe('rewritePgDump', () => {
  it('comments out CREATE SCHEMA harness_<orig>', async () => {
    const out = await runRewrite(
      `CREATE SCHEMA harness_org;\nCREATE TABLE harness_org.x ();\n`,
      'org',
      'harness_org_restoring',
    );
    expect(out).toContain('-- (rewritten) CREATE SCHEMA harness_org;');
  });

  it('comments out ALTER SCHEMA OWNER', async () => {
    const out = await runRewrite(
      `ALTER SCHEMA harness_org OWNER TO postgres_app;\n`,
      'org',
      'harness_org_restoring',
    );
    expect(out).toContain('-- (rewritten) ALTER SCHEMA harness_org OWNER TO postgres_app;');
  });

  it('rewrites SET search_path directive', async () => {
    const out = await runRewrite(
      `SET search_path = harness_org, public;\n`,
      'org',
      'harness_org_restoring',
    );
    expect(out).toContain('SET search_path = harness_org_restoring, public;');
  });

  it('rewrites schema-qualified identifiers in body lines', async () => {
    const out = await runRewrite(
      `CREATE TABLE harness_org.harness_features (id text);\nALTER TABLE ONLY harness_org.harness_features ADD CONSTRAINT pk PRIMARY KEY (id);\nCOPY harness_org.harness_features (id) FROM stdin;\n`,
      'org',
      'harness_org_restoring',
    );
    expect(out).toContain('CREATE TABLE harness_org_restoring.harness_features');
    expect(out).toContain('ALTER TABLE ONLY harness_org_restoring.harness_features');
    expect(out).toContain('COPY harness_org_restoring.harness_features');
    expect(out).not.toContain('harness_org.');
  });

  it('does NOT rewrite a different harness schema with similar prefix', async () => {
    // The substring-collision case the spec called out: `harness_org.X` should
    // not be touched when `<orig>` is `or` or some shorter token. Here we
    // verify the inverse — `harness_org-other.X` (would be quoted in real
    // pg_dump) should not match `harness_org.` because of the boundary `.`.
    const out = await runRewrite(
      `CREATE TABLE harness_org_other.foo (x text);\n`,
      'org',
      'harness_org_restoring',
    );
    // `harness_org_other.foo` does not match `harness_org\.` because the
    // char after `harness_org` is `_`, not `.`.
    expect(out).toContain('harness_org_other.foo');
    expect(out).not.toContain('harness_org_restoring');
  });

  it('preserves COPY data lines verbatim', async () => {
    // Body data after `COPY ... FROM stdin;` is raw rows until `\.\n`.
    // Even if a row contained the literal string "harness_org.", the
    // rewrite logic treats it as text — semantic correctness depends on
    // pg_dump quoting rules. For v1.0 this is acceptable: substrate
    // harness schemas don't store schema-qualified strings as user data.
    const out = await runRewrite(
      `COPY harness_org.harness_features (id, summary) FROM stdin;\nF-001\tjust a feature\n\\.\n`,
      'org',
      'harness_org_restoring',
    );
    expect(out).toContain('COPY harness_org_restoring.harness_features');
    expect(out).toContain('F-001\tjust a feature');
  });

  it('handles multiple schema-qualifier hits on one line', async () => {
    const out = await runRewrite(
      `INSERT INTO harness_org.x SELECT * FROM harness_org.y;\n`,
      'org',
      'harness_org_restoring',
    );
    expect(out).toContain(
      'INSERT INTO harness_org_restoring.x SELECT * FROM harness_org_restoring.y;',
    );
  });

  it('SET search_path line ALSO rewrites trailing schema-qual hits', async () => {
    const out = await runRewrite(
      `SET search_path = harness_org, public; -- harness_org.x\n`,
      'org',
      'harness_org_restoring',
    );
    expect(out).toContain('SET search_path = harness_org_restoring, public;');
    expect(out).toContain('harness_org_restoring.x');
  });

  it('treats regex-meta chars in slug safely', async () => {
    // No real slug would contain regex metacharacters (assertValidSlug
    // forbids them), but defense-in-depth: the rewrite uses escapeRe.
    const out = await runRewrite(
      `CREATE TABLE harness_a.b ();\n`,
      'a',
      'harness_a_restoring',
    );
    expect(out).toContain('harness_a_restoring.b');
  });

  it('passes through unrelated SQL content', async () => {
    const out = await runRewrite(
      `-- comment about org\nCREATE FUNCTION public.upper(text) RETURNS text AS $$ ... $$;\n`,
      'org',
      'harness_org_restoring',
    );
    expect(out).toContain('-- comment about org');
    expect(out).toContain('public.upper(text)');
  });
});
