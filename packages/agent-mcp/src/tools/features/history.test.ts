/**
 * features:history — bulk keyed-array contract + rendering tests
 * (bulk-endpoint-standardization-2026-06-21).
 *
 * The per-item op fires three PG reads (notes / debug notes / audit rows) and
 * assembles a markdown block. We mock `ctx.tx` as a sql template tag that
 * routes on the table name in the query text, so each section can be fed
 * independently. The compound key is `(slug, feature_id)` and the per-section
 * caps ride per item; the handler returns the house envelope
 * `{ ok, results:[{ ok, slug, feature_id, history? | error }], counts }`.
 *
 * The logic under test:
 *   - inline `{ slug, feature_id }` (n=1) → a single result keyed by (slug, feature_id)
 *   - invalid slug → that item's `{ ok:false, error:'invalid slug …' }` (no query fired)
 *   - all-empty → that item's `{ ok:false, error:'no history yet …' }`
 *   - section assembly: Notes / Debugger findings / Recent activity appear
 *     iff their source has content (whitespace-only notes are dropped)
 *   - per-section truncation appends the `[…truncated…]` marker
 *   - audit-row formatting: ms-epoch → second-precision ISO, quoted
 *     old/new values unwrapped, null old → `→ new`, actor in parens
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

type Out = { data: any };
const env = async (over: Record<string, unknown> = {}) =>
  ((await tool.handler(ARGS(over), CTX())) as Out).data;
// The single result's `history` string (the n=1 path always has one result).
const md = async (over: Record<string, unknown> = {}) => (await env(over)).results[0].history as string;

beforeEach(() => {
  notesRows = [];
  debugRows = [];
  auditRows = [];
  auditValues = [];
  queriesFired = 0;
});

describe('features:history — keyed-array envelope + failure items', () => {
  it('inline { slug, feature_id } returns a single result keyed by (slug, feature_id)', async () => {
    notesRows = [{ content: 'the notes body' }];
    const b = await env();
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, slug: 'sheets', feature_id: 'F-001' });
    expect(b.results[0].history).toContain('### Notes');
  });

  it('rejects an invalid slug as that item without querying', async () => {
    const b = await env({ slug: 'bad slug!' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({
      ok: false,
      slug: 'bad slug!',
      feature_id: 'F-001',
      error: 'invalid slug "bad slug!"',
    });
    expect(queriesFired).toBe(0);
  });

  it('returns a "no history yet" failure item when every section is empty', async () => {
    const b = await env();
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, error: 'no history yet for F-001 in sheets' });
  });

  it('treats whitespace-only notes as empty', async () => {
    notesRows = [{ content: '   \n  ' }];
    const b = await env();
    expect(b.results[0].ok).toBe(false);
  });

  it('items:[…] fetches many; an invalid-slug item fails only itself', async () => {
    notesRows = [{ content: 'body' }];
    const b = await env({}); // baseline single, then re-run a real bulk below
    expect(b.counts.ok).toBe(1);
    const bulk = (
      (await tool.handler(
        tool.args.parse({
          items: [
            { slug: 'sheets', feature_id: 'F-001' },
            { slug: 'bad slug', feature_id: 'F-002' },
          ],
        }) as never,
        CTX(),
      )) as Out
    ).data;
    expect(bulk.ok).toBe(true);
    expect(bulk.counts).toEqual({ ok: 1, failed: 1 });
    expect(bulk.results.map((r: { feature_id: string; ok: boolean }) => [r.feature_id, r.ok])).toEqual([
      ['F-001', true],
      ['F-002', false],
    ]);
    expect(bulk.results[1].error).toBe('invalid slug "bad slug"');
  });
});

describe('features:history — section assembly', () => {
  it('renders only the sections that have content, under the header', async () => {
    notesRows = [{ content: 'the notes body' }];
    const out = await md();
    expect(out.startsWith("## This feature's history (F-001)")).toBe(true);
    expect(out).toContain('### Notes');
    expect(out).toContain('the notes body');
    expect(out).not.toContain('### Debugger findings');
    expect(out).not.toContain('### Recent activity');
  });

  it('renders all three sections when populated', async () => {
    notesRows = [{ content: 'n' }];
    debugRows = [{ content: 'd' }];
    auditRows = [{ ts: 1765000000000, field: 'status', old_value: '"todo"', new_value: '"passed"', actor: 'validator' }];
    const out = await md();
    const iNotes = out.indexOf('### Notes');
    const iDebug = out.indexOf('### Debugger findings');
    const iAudit = out.indexOf('### Recent activity');
    expect(iNotes).toBeGreaterThan(-1);
    expect(iDebug).toBeGreaterThan(iNotes);
    expect(iAudit).toBeGreaterThan(iDebug);
  });

  it('truncates a long notes body at notes_max_chars with the marker', async () => {
    notesRows = [{ content: 'x'.repeat(5000) }];
    const out = await md({ notes_max_chars: 100 });
    expect(out).toContain('x'.repeat(100));
    expect(out).not.toContain('x'.repeat(101));
    expect(out).toContain('[…truncated, exceeded 100 chars]');
  });

  it('does not truncate a body at exactly the cap', async () => {
    debugRows = [{ content: 'y'.repeat(80) }];
    const out = await md({ debug_max_chars: 80 });
    expect(out).toContain('y'.repeat(80));
    expect(out).not.toContain('truncated');
  });
});

describe('features:history — audit-row formatting', () => {
  it('formats ts as second-precision ISO, unwraps quoted values, keeps the actor', async () => {
    auditRows = [
      { ts: Date.UTC(2026, 0, 2, 3, 4, 5, 678), field: 'status', old_value: '"todo"', new_value: '"passed"', actor: 'validator' },
    ];
    const out = await md();
    expect(out).toContain('- 2026-01-02T03:04:05Z `status` todo → passed (validator)');
  });

  it('renders a null old_value as a bare arrow to the new value', async () => {
    auditRows = [{ ts: 0, field: 'title', old_value: null, new_value: '"First title"', actor: 'scoper' }];
    const out = await md();
    expect(out).toContain('`title` → First title (scoper)');
    expect(out).not.toContain(' → First title (scoper) →');
  });

  it('leaves unquoted values as-is (no unwrap)', async () => {
    auditRows = [{ ts: 0, field: 'attempts', old_value: '1', new_value: '2', actor: 'worker' }];
    const out = await md();
    expect(out).toContain('`attempts` 1 → 2 (worker)');
  });

  it('binds audit_rows as the audit LIMIT', async () => {
    auditRows = [{ ts: 0, field: 'f', old_value: null, new_value: 'v', actor: 'a' }];
    await md({ audit_rows: 33 });
    expect(auditValues).toContain(33);
  });
});

describe('features:history — arg schema', () => {
  it('defaults the caps to 4000/4000/10 (single-call shape)', () => {
    const parsed = tool.args.parse({ slug: 's', feature_id: 'F-1' });
    expect(parsed.notes_max_chars).toBe(4000);
    expect(parsed.debug_max_chars).toBe(4000);
    expect(parsed.audit_rows).toBe(10);
  });

  it('defaults the per-item caps to 4000/4000/10 (items shape)', () => {
    const parsed = tool.args.parse({ items: [{ slug: 's', feature_id: 'F-1' }] });
    expect(parsed.items![0].notes_max_chars).toBe(4000);
    expect(parsed.items![0].debug_max_chars).toBe(4000);
    expect(parsed.items![0].audit_rows).toBe(10);
  });

  it('rejects over-cap values instead of clamping', () => {
    expect(() => tool.args.parse({ slug: 's', feature_id: 'F-1', notes_max_chars: 20001 })).toThrow();
    expect(() => tool.args.parse({ slug: 's', feature_id: 'F-1', audit_rows: 101 })).toThrow();
    expect(() => tool.args.parse({ slug: 's', feature_id: 'F-1', audit_rows: 0 })).toThrow();
  });

  it('rejects a call with neither a single key nor items', () => {
    expect(() => tool.args.parse({ notes_max_chars: 1000 })).toThrow();
  });
});
