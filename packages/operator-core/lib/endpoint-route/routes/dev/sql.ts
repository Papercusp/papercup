/**
 * POST /api/dev/sql — read-only SQL playground (Unlock 2: Monaco composer).
 *
 * Runs free-form SQL inside a transaction with the harness_admin pool
 * (default) or the harness_app pool with workspace GUC set (role=app).
 * Wrapped in a 10s statement_timeout and rolled back at the end so even
 * read-only-by-name statements with side-effects can't escape the
 * connection.
 *
 * Safety gate: only SELECT/WITH/EXPLAIN/SHOW/TABLE/VALUES allowed.
 *
 * Ported from app/api/dev/sql/route.ts. `auth: 'public'` — dev tool,
 * faithful port at current posture (D3 — flagged for auth-tightening).
 */
import { z } from 'zod';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const BodySchema = z.object({
  sql: z.string().min(1).max(64 * 1024),
  role: z.enum(['admin', 'app']).optional().default('admin'),
});

const STATEMENT_TIMEOUT_MS = 10_000;
const MAX_ROWS_RETURNED = 1000;
const ALLOWED_LEADING = new Set(['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'TABLE', 'VALUES']);

function leadingKeyword(sql: string): string | null {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    while (i < n && /\s/.test(sql[i])) i++;
    if (i + 1 < n && sql[i] === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
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

function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      buf += c; i++;
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

class ReadOnlyRollback extends Error {
  constructor() { super('__readonly_rollback'); this.name = 'ReadOnlyRollback'; }
}

export default defineTool({
  method: 'POST',
  path: '/dev/sql',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    let raw: unknown;
    try { raw = await req.json(); }
    catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: 'validation failed', issues: parsed.error.issues }, { status: 400 });
    }
    const { sql: sqlText, role } = parsed.data;

    const stmts = splitStatements(sqlText);
    if (stmts.length === 0) return Response.json({ error: 'empty sql' }, { status: 400 });
    for (const s of stmts) {
      const kw = leadingKeyword(s);
      if (!kw || !ALLOWED_LEADING.has(kw)) {
        return Response.json(
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
          for (let i = 0; i < stmts.length - 1; i++) await tx.unsafe(stmts[i]);
          const last = stmts[stmts.length - 1];
          const result = await tx.unsafe(last);
          const arr = result as unknown as Array<Record<string, unknown>>;
          rows = arr.slice(0, MAX_ROWS_RETURNED);
          if (arr.length > MAX_ROWS_RETURNED) truncated = true;
          columns = rows.length > 0 ? Object.keys(rows[0]) : [];
          throw new ReadOnlyRollback();
        }).catch((e: unknown) => {
          if (e instanceof ReadOnlyRollback) return;
          throw e;
        });
      } else {
        const { sql: pgSql } = getOrgPg();
        await pgSql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
          for (let i = 0; i < stmts.length - 1; i++) await tx.unsafe(stmts[i]);
          const last = stmts[stmts.length - 1];
          const result = await tx.unsafe(last);
          const arr = result as unknown as Array<Record<string, unknown>>;
          rows = arr.slice(0, MAX_ROWS_RETURNED);
          if (arr.length > MAX_ROWS_RETURNED) truncated = true;
          columns = rows.length > 0 ? Object.keys(rows[0]) : [];
          throw new ReadOnlyRollback();
        }).catch((e: unknown) => {
          if (e instanceof ReadOnlyRollback) return;
          throw e;
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const sqlState = (e as { code?: string })?.code;
      return Response.json({ error: msg, sqlState }, { status: 400 });
    }

    const safeRows = rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (v instanceof Date) out[k] = v.toISOString();
        else if (typeof v === 'bigint') out[k] = Number(v);
        else out[k] = v;
      }
      return out;
    });

    return Response.json({
      columns,
      rows: safeRows,
      rowCount: safeRows.length,
      truncated,
      durationMs: Date.now() - start,
      role,
      statements: stmts.length,
    });
  },
});
