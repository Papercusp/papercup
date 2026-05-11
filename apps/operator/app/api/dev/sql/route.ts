/**
 * POST /api/dev/sql — read-only SQL playground (Unlock 2: Monaco composer).
 *
 * Runs free-form SQL inside a transaction with the harness_admin pool
 * (default) or the harness_app pool with workspace GUC set (role=app).
 * Wrapped in a 10-second statement_timeout and rolled back at the end so
 * even read-only-by-name statements with side-effects (e.g. a stray
 * `SELECT * FROM tbl FOR UPDATE`) can't escape the connection.
 *
 * Safety gate: only statements whose first non-comment, non-whitespace
 * token is `SELECT`, `WITH`, `EXPLAIN`, `SHOW`, `TABLE`, or `VALUES` are
 * accepted. Multi-statement bodies (split by top-level semicolons) get
 * the same check per statement. DDL/DML rejected — this is a dev tool,
 * not a write surface; admins write via `/admin` or direct psql.
 *
 * Request: { sql: string, role?: 'admin' | 'app' }
 * Response: { columns: string[], rows: Record<string,unknown>[], rowCount, durationMs }
 *           or { error: string, sqlState?: string }
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrgPg, withWorkspace } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  sql: z.string().min(1).max(64 * 1024),
  role: z.enum(['admin', 'app']).optional().default('admin'),
});

const STATEMENT_TIMEOUT_MS = 10_000;
const MAX_ROWS_RETURNED = 1000;
// Permitted leading keywords. SHOW + TABLE + VALUES included for parity
// with psql; everything else (INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/
// GRANT/COPY/CALL/DO/...) is rejected.
const ALLOWED_LEADING = new Set([
  'SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'TABLE', 'VALUES',
]);

/** Strip leading SQL comments + whitespace and return the first keyword. */
function leadingKeyword(sql: string): string | null {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    // Skip whitespace
    while (i < n && /\s/.test(sql[i])) i++;
    // Skip -- line comment
    if (i + 1 < n && sql[i] === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    // Skip /* block comment */
    if (i + 1 < n && sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    break;
  }
  if (i >= n) return null;
  const m = sql.slice(i).match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : null;
}

/** Split on top-level semicolons (ignoring those inside quotes / dollar tags). */
function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      // single-quoted string — find matching close, doubled-up '' is escape
      buf += c;
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { buf += "''"; i += 2; continue; }
        buf += sql[i];
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '"') {
      buf += c; i++;
      while (i < n && sql[i] !== '"') { buf += sql[i]; i++; }
      if (i < n) { buf += sql[i]; i++; }
      continue;
    }
    if (c === '$') {
      // dollar-quoted string $tag$...$tag$
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        buf += tag; i += tag.length;
        const close = sql.indexOf(tag, i);
        if (close === -1) { buf += sql.slice(i); i = n; continue; }
        buf += sql.slice(i, close + tag.length);
        i = close + tag.length;
        continue;
      }
    }
    if (c === ';') {
      const trimmed = buf.trim();
      if (trimmed) parts.push(trimmed);
      buf = ''; i++; continue;
    }
    buf += c; i++;
  }
  const last = buf.trim();
  if (last) parts.push(last);
  return parts;
}

export async function POST(req: Request) {
  let raw: unknown;
  try { raw = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation failed', issues: parsed.error.issues }, { status: 400 });
  }
  const { sql: sqlText, role } = parsed.data;

  // Safety gate.
  const stmts = splitStatements(sqlText);
  if (stmts.length === 0) {
    return NextResponse.json({ error: 'empty sql' }, { status: 400 });
  }
  for (const s of stmts) {
    const kw = leadingKeyword(s);
    if (!kw || !ALLOWED_LEADING.has(kw)) {
      return NextResponse.json(
        { error: `rejected: ${kw ?? '?'} statements are not allowed (read-only playground; SELECT/WITH/EXPLAIN/SHOW/TABLE/VALUES only)` },
        { status: 400 },
      );
    }
  }

  const start = Date.now();
  let columns: string[] = [];
  let rows: Record<string, unknown>[] = [];
  let truncated = false;

  try {
    if (role === 'app') {
      const ws = activeWorkspaceId();
      await withWorkspace(ws, async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        // Only the LAST statement's rows are returned (matches psql behavior).
        for (let i = 0; i < stmts.length - 1; i++) {
          await tx.unsafe(stmts[i]);
        }
        const last = stmts[stmts.length - 1];
        const result = await tx.unsafe(last);
        const arr = result as unknown as Array<Record<string, unknown>>;
        rows = arr.slice(0, MAX_ROWS_RETURNED);
        if (arr.length > MAX_ROWS_RETURNED) truncated = true;
        columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        // Force rollback even though we only ran read-only statements.
        throw new __ReadOnlyRollback();
      }).catch((e: unknown) => {
        if (e instanceof __ReadOnlyRollback) return;
        throw e;
      });
    } else {
      const { sql: pgSql } = getOrgPg();
      // postgres-js's begin() commits unless we throw; throw to rollback.
      await pgSql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        for (let i = 0; i < stmts.length - 1; i++) {
          await tx.unsafe(stmts[i]);
        }
        const last = stmts[stmts.length - 1];
        const result = await tx.unsafe(last);
        const arr = result as unknown as Array<Record<string, unknown>>;
        rows = arr.slice(0, MAX_ROWS_RETURNED);
        if (arr.length > MAX_ROWS_RETURNED) truncated = true;
        columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        throw new __ReadOnlyRollback();
      }).catch((e: unknown) => {
        if (e instanceof __ReadOnlyRollback) return;
        throw e;
      });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const sqlState = (e as { code?: string })?.code;
    return NextResponse.json({ error: msg, sqlState }, { status: 400 });
  }

  // Best-effort serialization (bigints → number, dates → ISO).
  const safeRows = rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (v instanceof Date) out[k] = v.toISOString();
      else if (typeof v === 'bigint') out[k] = Number(v);
      else out[k] = v;
    }
    return out;
  });

  return NextResponse.json({
    columns,
    rows: safeRows,
    rowCount: safeRows.length,
    truncated,
    durationMs: Date.now() - start,
    role,
    statements: stmts.length,
  });
}

class __ReadOnlyRollback extends Error {
  constructor() {
    super('__readonly_rollback');
    this.name = '__ReadOnlyRollback';
  }
}
