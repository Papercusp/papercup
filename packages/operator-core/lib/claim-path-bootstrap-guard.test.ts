/**
 * WI-10005130 recurrence guard — every hand-built claim-path integration fixture must
 * apply the shared claim-path read dependencies.
 *
 * Each claim door (claimNextWorkItem, claimIssue, getNextWorkItem, …) reads relations
 * beyond the base work-item tables: the trust list, the dependency table, the operation
 * worker claim binding (`adv_sessions`, which fails CLOSED when absent: every claim is
 * refused with "operation claim authority unavailable"), the event-await substrate and
 * the Scout idea ledger. Each was added to the claim path at a different time, and each
 * time every fixture that built its schema by hand went red. Integration files sit outside
 * the gate's affected radius, so nothing noticed until a sweep ran them.
 *
 * `applyClaimPathReadDeps` (test/_work-items-schema.ts) is the single list. This guard
 * fails an integration test under lib/ that calls a claim door AND builds its schema by
 * hand (inline `CREATE TABLE` or the `_work-items-schema` fixture) without calling it.
 * Files that apply the real migration chain get the full schema and are exempt.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  stripCommentsAndStrings,
  stripCommentsOnly,
} from '../../../scripts/lib/strip-comments-and-strings.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);

const CLAIM_DOOR_RE =
  /\b(?:claimNextWorkItem|claimWorkItem|claimIssue|claimNextIssueWorkItem|getNextWorkItem|getNextForBee)\s*\(/;
const HELPER_CALL_RE = /\bapplyClaimPathReadDeps\s*\(/;
const REAL_MIGRATIONS_RE = /\bapplyMigrationsForTest\s*\(/;
const INLINE_DDL_RE = /\bCREATE\s+TABLE\b/i;
const SCHEMA_FIXTURE_IMPORT_RE = /from\s+['"][^'"]*test\/_work-items-schema['"]/;

/**
 * Files that call a claim door with a hand-built schema but are known not to reach a
 * claim-path read dependency. Each entry needs a reason; remove it once the file calls
 * applyClaimPathReadDeps.
 */
const ALLOW: ReadonlyMap<string, string> = new Map<string, string>([]);

export type Classification =
  | { kind: 'not-claim-path' }
  | { kind: 'real-migrations' }
  | { kind: 'ok' }
  | { kind: 'violation' };

/** Classify one integration test source. Exported for the self-check below. */
export function classify(raw: string, fileName: string): Classification {
  // Calls and helper use: strings AND comments removed, so prose or a SQL literal that
  // names a door cannot count as a call.
  const code = stripCommentsAndStrings(raw, fileName) as string;
  if (!CLAIM_DOOR_RE.test(code)) return { kind: 'not-claim-path' };
  if (REAL_MIGRATIONS_RE.test(code)) return { kind: 'real-migrations' };
  if (HELPER_CALL_RE.test(code)) return { kind: 'ok' };
  // Schema building: DDL lives inside template literals, so only comments are removed.
  const commentless = stripCommentsOnly(raw, fileName) as string;
  const handBuilt = INLINE_DDL_RE.test(commentless) || SCHEMA_FIXTURE_IMPORT_RE.test(commentless);
  return handBuilt ? { kind: 'violation' } : { kind: 'not-claim-path' };
}

function integrationTests(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) integrationTests(full, out);
    else if (entry.name.endsWith('.integration.test.ts')) out.push(full);
  }
  return out;
}

describe('claim-path fixture bootstrap guard (WI-10005130)', () => {
  const files = integrationTests(HERE);
  const results = files.map((full) => {
    const rel = path.relative(HERE, full);
    return { rel, verdict: classify(readFileSync(full, 'utf8'), full) };
  });

  it('scans a real population of claim-path fixtures (positive control)', () => {
    const covered = results.filter((r) => r.verdict.kind === 'ok').length;
    // The sweep that introduced the helper converted ~38 files. A detector that silently
    // stops matching (a renamed door, a broken strip) would drop this to zero and pass.
    expect(covered).toBeGreaterThanOrEqual(30);
  });

  it('every hand-built claim-path fixture calls applyClaimPathReadDeps', () => {
    const violations = results
      .filter((r) => r.verdict.kind === 'violation' && !ALLOW.has(r.rel))
      .map((r) => r.rel)
      .sort();
    expect(
      violations,
      'These integration tests call a claim door on a hand-built schema without ' +
        'applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple()) from test/_work-items-schema. ' +
        'Add the call after the base schema; every statement is IF NOT EXISTS.',
    ).toEqual([]);
  });

  it('allowlist entries still exist and still need the exemption', () => {
    for (const rel of ALLOW.keys()) {
      const hit = results.find((r) => r.rel === rel);
      expect(hit, `${rel} is allowlisted but no longer exists`).toBeDefined();
      expect(hit?.verdict.kind, `${rel} no longer needs its allowlist entry`).toBe('violation');
    }
  });

  describe('detector self-check', () => {
    const door = ['claim', 'NextWorkItem'].join('');
    const helper = ['applyClaim', 'PathReadDeps'].join('');
    const ddl = 'CREATE TABLE harness_shared.work_items (id text);';

    it('flags a claim door on a hand-built schema without the helper', () => {
      const src = `await db.sql.unsafe(\`${ddl}\`);\nconst r = await ${door}({ harness: 'h' });\n`;
      expect(classify(src, 'fixture.ts').kind).toBe('violation');
    });

    it('passes the same fixture once it calls the helper', () => {
      const src =
        `await db.sql.unsafe(\`${ddl}\`);\nawait ${helper}((d) => db.sql.unsafe(d).simple());\n` +
        `const r = await ${door}({ harness: 'h' });\n`;
      expect(classify(src, 'fixture.ts').kind).toBe('ok');
    });

    it('ignores a claim door named only in a comment or a string', () => {
      const src = `// calls ${door}( in prose\nconst s = '${door}(';\nawait db.sql.unsafe(\`${ddl}\`);\n`;
      expect(classify(src, 'fixture.ts').kind).toBe('not-claim-path');
    });

    it('does not count a helper named only in a comment', () => {
      const src = `// ${helper}( is applied elsewhere\nawait db.sql.unsafe(\`${ddl}\`);\nawait ${door}({});\n`;
      expect(classify(src, 'fixture.ts').kind).toBe('violation');
    });
  });
});
