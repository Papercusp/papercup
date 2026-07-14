import { createHash } from 'node:crypto';

export type SessionCursorTool = 'sessions:list' | 'sessions:search' | 'sessions:timeline';

const CURSOR_VERSION = 1;
const MAX_CURSOR_OFFSET = 500;

interface SessionCursorPayload {
  v: number;
  tool: SessionCursorTool;
  offset: number;
  fingerprint: string;
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)]),
  );
};

/** Bind a cursor to the query/filter contract while allowing the page size to change. */
export function sessionCursorFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex').slice(0, 24);
}

export function encodeSessionCursor(
  tool: SessionCursorTool,
  offset: number,
  fingerprint: string,
): string {
  const payload: SessionCursorPayload = { v: CURSOR_VERSION, tool, offset, fingerprint };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeSessionCursor(
  cursor: string | undefined,
  tool: SessionCursorTool,
  fingerprint: string,
): { ok: true; offset: number } | { ok: false; error: 'invalid_cursor'; message: string } {
  if (!cursor) return { ok: true, offset: 0 };
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<SessionCursorPayload>;
    if (
      payload.v !== CURSOR_VERSION ||
      payload.tool !== tool ||
      payload.fingerprint !== fingerprint ||
      !Number.isInteger(payload.offset) ||
      (payload.offset ?? -1) < 0 ||
      (payload.offset ?? 0) > MAX_CURSOR_OFFSET
    ) {
      return {
        ok: false,
        error: 'invalid_cursor',
        message: 'Cursor is stale, belongs to another sessions tool/query, or exceeds the bounded pagination window.',
      };
    }
    return { ok: true, offset: payload.offset as number };
  } catch {
    return { ok: false, error: 'invalid_cursor', message: 'Cursor is malformed.' };
  }
}
