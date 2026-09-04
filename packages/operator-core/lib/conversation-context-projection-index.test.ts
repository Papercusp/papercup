/**
 * Regression contract for the P-003 activity-report session lookup.
 *
 * The reader and migration have to agree on the exact expression and partial
 * predicate.  A semantically equivalent rewrite can silently make PostgreSQL
 * fall back to the time-ordered telemetry index, so keep this small source
 * guard next to the projection tests.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const MIGRATION = join(
  REPO_ROOT,
  'libs/papercusp/libs/db/sql/1114-activity-report-session-lookup-index.sql.DRAFT',
);
const SOURCE = join(REPO_ROOT, 'packages/operator-core/lib/conversation-context-projection.ts');
const INDEX = 'tool_invocations_activity_session_lookup_idx';
const SESSION_EXPRESSION = "COALESCE(args_json->>'session_id', args_json->>'sessionId')";

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*(?:--|\/\/).*$/gm, '')
    .replace(/(?:--|\/\/).*$/gm, '');
}

describe('P-003 activity-report session lookup contract', () => {
  it('keeps the migration expression and partial predicate aligned', () => {
    const sql = stripComments(readFileSync(MIGRATION, 'utf8')).replace(/\s+/g, ' ');
    expect(sql).toContain(INDEX);
    expect(sql).toContain(SESSION_EXPRESSION);
    expect(sql).toMatch(/WHERE tool_name IN \('activity:report', 'activity_report'\)/i);
    expect(sql).toMatch(/\(args_json \? 'session_id' OR args_json \? 'sessionId'\)/i);
  });

  it('states both partial-index predicates beside the reader equality', () => {
    const source = stripComments(readFileSync(SOURCE, 'utf8')).replace(/\s+/g, ' ');
    const toolPredicate = source.indexOf("tool_name IN ('activity:report', 'activity_report')");
    const keyPredicate = source.indexOf("(args_json ? 'session_id' OR args_json ? 'sessionId')");
    const expression = source.indexOf(SESSION_EXPRESSION);
    expect(toolPredicate).toBeGreaterThan(-1);
    expect(keyPredicate).toBeGreaterThan(toolPredicate);
    expect(expression).toBeGreaterThan(keyPredicate);
  });
});
