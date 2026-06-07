/**
 * features:history — pure rendering + degraded-path tests.
 *
 * The handler fires three PG reads (notes / debug notes / audit rows) and
 * assembles a markdown block. We mock `ctx.tx` as a sql template tag that
 * routes on the table name in the query text, so each section can be fed
 * independently. The logic under test:
 *   - invalid slug → `{ data: '', degraded: true }` (no query fired)
 *   - all-empty → degraded `no history yet for <id> in <slug>`
 *   - section assembly: Notes / Debugger findings / Recent activity appear
 *     iff their source has content (whitespace-only notes are dropped)
 *   - per-section truncation appends the `[…truncated…]` marker
 *   - audit-row formatting: ms-epoch → second-precision ISO, quoted
 *     old/new values unwrapped, null old → `→ new` (no leading arrow side),
 *     actor in parens
 *   - `audit_rows` is bound as the audit LIMIT
 *   - arg-schema defaults (4000/4000/10) + caps (20000/20000/100)
 *
 * SQL filtering itself isn't exercised (no live PG) — only the JS logic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import tool from './history';

interface AuditRow {
  ts: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor: string;
}

let notesRows: Array<{ content: string }> = [];
let debugRows: Array<{ content: string }> = [];
let auditRows: AuditRow[] = [];
let auditValues: unknown[] = [];
let queriesFired = 0;

const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
  queriesFired += 1;
  const text = strings.join('');
  if (text.includes('harness_feature_notes')) return Promise.resolve(notesRows);
  if (text.includes('harness_feature_debug_notes')) return Promise.resolve(debugRows);
  if (text.includes('feature_audit_consolidated')) {
    auditValues = values;
    return Promise.resolve(auditRows);
  }
  throw new Error(`unexpected query: ${text}`);
};

const CTX = () =>
  ({
    principal: { slug: 'op', workspaceId: 'ws_1' },
    tx,
    log: vi.fn(),
  }) as never;

const ARGS = (over: Record<string, unknown> = {}) =>
  tool.args.parse({ slug: 'sheets', feature_id: 'F-001', ...over }) as never;

beforeEach(() => {
  notesRows = [];
  debugRows = [];
  auditRows = [];
  auditValues = [];
  queriesFired = 0;
});

describe('features:history — degraded paths', () => {
  it('rejects an invalid slug without querying', async () => {
    const res = await tool.handler(ARGS({ slug: 'bad slug!' }), CTX());
    expect(res).toEqual({
      data: '',
      degraded: true,
      degradedReasons: ['invalid slug "bad slug!"'],
    });
    expect(queriesFired).toBe(0);
  });

  it('returns degraded "no history yet" when every section is empty', async () => {
    const res = await tool.handler(ARGS(), CTX());
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toEqual(['no history yet for F-001 in sheets']);
    expect(res.data).toBe('');
  });

  it('treats whitespace-only notes as empty', async () => {
    notesRows = [{ content: '   \n  ' }];
    const res = await tool.handler(ARGS(), CTX());
    expect(res.degraded).toBe(true);
  });
});

describe('features:history — section assembly', () => {
  it('renders only the sections that have content, under the header', async () => {
    notesRows = [{ content: 'the notes body' }];
    const res = await tool.handler(ARGS(), CTX());
    expect(res.degraded).toBeUndefined();
    const md = res.data as string;
    expect(md.startsWith("## This feature's history (F-001)")).toBe(true);
    expect(md).toContain('### Notes');
    expect(md).toContain('the notes body');
    expect(md).not.toContain('### Debugger findings');
    expect(md).not.toContain('### Recent activity');
  });

  it('renders all three sections when populated', async () => {
    notesRows = [{ content: 'n' }];
    debugRows = [{ content: 'd' }];
    auditRows = [{ ts: 1765000000000, field: 'status', old_value: '"todo"', new_value: '"passed"', actor: 'validator' }];
    const md = (await tool.handler(ARGS(), CTX())).data as string;
    const iNotes = md.indexOf('### Notes');
    const iDebug = md.indexOf('### Debugger findings');
    const iAudit = md.indexOf('### Recent activity');
    expect(iNotes).toBeGreaterThan(-1);
    expect(iDebug).toBeGreaterThan(iNotes);
    expect(iAudit).toBeGreaterThan(iDebug);
  });

  it('truncates a long notes body at notes_max_chars with the marker', async () => {
    notesRows = [{ content: 'x'.repeat(5000) }];
    const md = (await tool.handler(ARGS({ notes_max_chars: 100 }), CTX())).data as string;
    expect(md).toContain('x'.repeat(100));
    expect(md).not.toContain('x'.repeat(101));
    expect(md).toContain('[…truncated, exceeded 100 chars]');
  });

  it('does not truncate a body at exactly the cap', async () => {
    debugRows = [{ content: 'y'.repeat(80) }];
    const md = (await tool.handler(ARGS({ debug_max_chars: 80 }), CTX())).data as string;
    expect(md).toContain('y'.repeat(80));
    expect(md).not.toContain('truncated');
  });
});

describe('features:history — audit-row formatting', () => {
  it('formats ts as second-precision ISO, unwraps quoted values, keeps the actor', async () => {
    auditRows = [
      { ts: Date.UTC(2026, 0, 2, 3, 4, 5, 678), field: 'status', old_value: '"todo"', new_value: '"passed"', actor: 'validator' },
    ];
    const md = (await tool.handler(ARGS(), CTX())).data as string;
    expect(md).toContain('- 2026-01-02T03:04:05Z `status` todo → passed (validator)');
  });

  it('renders a null old_value as a bare arrow to the new value', async () => {
    auditRows = [{ ts: 0, field: 'title', old_value: null, new_value: '"First title"', actor: 'scoper' }];
    const md = (await tool.handler(ARGS(), CTX())).data as string;
    expect(md).toContain('`title` → First title (scoper)');
    expect(md).not.toContain(' → First title (scoper) →');
  });

  it('leaves unquoted values as-is (no unwrap)', async () => {
    auditRows = [{ ts: 0, field: 'attempts', old_value: '1', new_value: '2', actor: 'worker' }];
    const md = (await tool.handler(ARGS(), CTX())).data as string;
    expect(md).toContain('`attempts` 1 → 2 (worker)');
  });

  it('binds audit_rows as the audit LIMIT', async () => {
    auditRows = [{ ts: 0, field: 'f', old_value: null, new_value: 'v', actor: 'a' }];
    await tool.handler(ARGS({ audit_rows: 33 }), CTX());
    expect(auditValues).toContain(33);
  });
});

describe('features:history — arg schema', () => {
  it('defaults the caps to 4000/4000/10', () => {
    const parsed = tool.args.parse({ slug: 's', feature_id: 'F-1' });
    expect(parsed.notes_max_chars).toBe(4000);
    expect(parsed.debug_max_chars).toBe(4000);
    expect(parsed.audit_rows).toBe(10);
  });

  it('rejects over-cap values instead of clamping', () => {
    expect(() => tool.args.parse({ slug: 's', feature_id: 'F-1', notes_max_chars: 20001 })).toThrow();
    expect(() => tool.args.parse({ slug: 's', feature_id: 'F-1', audit_rows: 101 })).toThrow();
    expect(() => tool.args.parse({ slug: 's', feature_id: 'F-1', audit_rows: 0 })).toThrow();
  });
});
