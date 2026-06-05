/**
 * Local-account auth + per-user session lookup.
 *
 * Replaces the legacy magic-link system (per project_operator_auth_loopback —
 * magic links were removed; loopback bind + Host check is the perimeter).
 * This module is the multi-user layer on top of loopback security: which
 * user is the current session for? Memory and per-user preferences key
 * off `getSessionUser().id`.
 *
 * Design:
 *   - Server-side opaque session tokens (32-byte hex). No JWT — we're
 *     loopback only; no distributed verification need.
 *   - Optional password (NULL = passwordless login). bcrypt via pgcrypto.
 *   - On fresh install, `ensureDefaultUser` seeds username='default'.
 *
 * See PLAN-operator-arc-2026-05-12.md and migration 058.
 */

import { randomBytes } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';

export const SESSION_COOKIE = 'papercusp_session';
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface User {
  id: string;
  username: string;
  display_name: string;
  has_password: boolean;
}

export interface Session {
  token: string;
  user_id: string;
  expires_at: number; // ms
}

function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** Parse a `Cookie` request header into a name→value map. */
function parseCookieHeader(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    out.set(k, decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return out;
}

/**
 * Resolve the session token. The Next-free path: pass the request's
 * `Headers` (every `defineTool` handler does — `req.headers`) and the
 * token is read from the `Cookie` header. The legacy path: omit `headers`
 * and the token comes from Next's ambient `cookies()` — used only by
 * `route.ts` handlers still served by Next during the endpoint migration.
 *
 * The Next fallback is a *dynamic* import so a fully-ported, Next-removed
 * build carries no static `next/headers` dependency, and is wrapped in
 * try/catch because `cookies()` throws outside a Next request scope.
 */
async function resolveSessionToken(headers?: Headers): Promise<string | undefined> {
  if (headers) {
    return parseCookieHeader(headers.get('cookie')).get(SESSION_COOKIE);
  }
  try {
    const { cookies } = await import('next/headers');
    const jar = await cookies();
    return jar.get(SESSION_COOKIE)?.value;
  } catch {
    return undefined;
  }
}

/**
 * Look up the current session user from the request cookie. Returns null
 * if no session, expired, or user inactive. Updates last_seen_at on hit.
 *
 * Pass `headers` from a `defineTool` handler (`req.headers`); omit it
 * only from legacy Next `route.ts` handlers (ambient-cookie fallback).
 */
export async function getSessionUser(headers?: Headers): Promise<User | null> {
  const { sql } = getOrgPg();
  const token = await resolveSessionToken(headers);
  if (!token) return null;

  const rows = await sql<{
    user_id: string;
    expires_at: Date;
    id: string;
    username: string;
    display_name: string;
    password_hash: string | null;
  }>`
    SELECT s.user_id, s.expires_at,
           u.id, u.username, u.display_name, u.password_hash
      FROM harness_shared.user_sessions s
      JOIN harness_shared.users u ON u.id = s.user_id
     WHERE s.token = ${token}
       AND s.expires_at > now()
       AND u.is_active = true
     LIMIT 1
  `;
  if (rows.length === 0) return null;

  const row = rows[0];
  // Best-effort last_seen_at update; failure is non-fatal
  await sql`
    UPDATE harness_shared.user_sessions
       SET last_seen_at = now()
     WHERE token = ${token}
  `.catch(() => { /* non-fatal */ });

  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    has_password: row.password_hash !== null,
  };
}

/**
 * Resolve current user OR fall back to 'default' when no session present.
 * Used by routes that always need a user_id for per-user data (memory,
 * preferences) but want to silently use the default user when unauthenticated
 * (single-user installs).
 */
export async function getSessionUserOrDefault(headers?: Headers): Promise<User> {
  const { sql } = getOrgPg();
  const user = await getSessionUser(headers);
  if (user) return user;
  await ensureDefaultUser();
  const rows = await sql<{ id: string; username: string; display_name: string; password_hash: string | null }>`
    SELECT id, username, display_name, password_hash
      FROM harness_shared.users
     WHERE username = 'default'
       AND is_active = true
     LIMIT 1
  `;
  if (rows.length === 0) {
    throw new Error('default user not present after ensureDefaultUser');
  }
  const r = rows[0];
  return { id: r.id, username: r.username, display_name: r.display_name, has_password: r.password_hash !== null };
}

/**
 * Authenticate a username + optional password, return new session token on
 * success. Throws { code: 'unknown_user' | 'bad_password' | 'inactive' }
 * on failure.
 */
export async function login(
  username: string,
  password: string | null,
  meta?: { user_agent?: string; remote_addr?: string; ttl_ms?: number },
): Promise<{ token: string; user: User; expires_at: Date }> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string; display_name: string; password_hash: string | null; is_active: boolean }>`
    SELECT id, display_name, password_hash, is_active
      FROM harness_shared.users
     WHERE username = ${username}
     LIMIT 1
  `;
  if (rows.length === 0) throw Object.assign(new Error('unknown user'), { code: 'unknown_user' });
  const u = rows[0];
  if (!u.is_active) throw Object.assign(new Error('inactive'), { code: 'inactive' });

  if (u.password_hash !== null) {
    if (!password) throw Object.assign(new Error('password required'), { code: 'bad_password' });
    const check = await sql<{ ok: boolean }>`
      SELECT crypt(${password}, ${u.password_hash}) = ${u.password_hash} AS ok
    `;
    if (!check[0]?.ok) throw Object.assign(new Error('bad password'), { code: 'bad_password' });
  }

  const token = newToken();
  const ttl = meta?.ttl_ms ?? DEFAULT_SESSION_TTL_MS;
  const expires = new Date(Date.now() + ttl);
  // postgres.js in this version doesn't accept Date instances directly
  // for timestamptz params — pass ISO string.
  await sql`
    INSERT INTO harness_shared.user_sessions (token, user_id, expires_at, user_agent, remote_addr)
    VALUES (${token}, ${u.id}, ${expires.toISOString()}, ${meta?.user_agent ?? null}, ${meta?.remote_addr ?? null})
  `;
  await sql`
    UPDATE harness_shared.users SET last_login_at = now() WHERE id = ${u.id}
  `;

  return {
    token,
    user: {
      id: u.id,
      username,
      display_name: u.display_name,
      has_password: u.password_hash !== null,
    },
    expires_at: expires,
  };
}

export async function logout(token: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.user_sessions WHERE token = ${token}`;
}

export async function signup(
  username: string,
  display_name: string,
  password: string | null,
): Promise<User> {
  const { sql } = getOrgPg();
  username = username.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(username)) {
    throw Object.assign(new Error('invalid username'), { code: 'bad_username' });
  }
  if (!display_name.trim()) {
    throw Object.assign(new Error('display name required'), { code: 'bad_display_name' });
  }
  const passwordHash = password
    ? (await sql<{ hash: string }>`SELECT crypt(${password}, gen_salt('bf')) AS hash`)[0].hash
    : null;

  const rows = await sql<{ id: string }>`
    INSERT INTO harness_shared.users (username, display_name, password_hash)
    VALUES (${username}, ${display_name.trim()}, ${passwordHash})
    RETURNING id
  `;
  return {
    id: rows[0].id,
    username,
    display_name: display_name.trim(),
    has_password: passwordHash !== null,
  };
}

export async function changePassword(
  user_id: string,
  current: string | null,
  next: string | null,
): Promise<void> {
  const { sql } = getOrgPg();
  const rows = await sql<{ password_hash: string | null }>`
    SELECT password_hash FROM harness_shared.users WHERE id = ${user_id} LIMIT 1
  `;
  if (rows.length === 0) throw Object.assign(new Error('not found'), { code: 'unknown_user' });
  const current_hash = rows[0].password_hash;

  if (current_hash !== null) {
    if (!current) throw Object.assign(new Error('current password required'), { code: 'bad_password' });
    const check = await sql<{ ok: boolean }>`
      SELECT crypt(${current}, ${current_hash}) = ${current_hash} AS ok
    `;
    if (!check[0]?.ok) throw Object.assign(new Error('bad password'), { code: 'bad_password' });
  }

  const next_hash = next
    ? (await sql<{ hash: string }>`SELECT crypt(${next}, gen_salt('bf')) AS hash`)[0].hash
    : null;
  await sql`UPDATE harness_shared.users SET password_hash = ${next_hash} WHERE id = ${user_id}`;
  await sql`DELETE FROM harness_shared.user_sessions WHERE user_id = ${user_id}`;
}

/**
 * Seed the `default` user on first boot. Idempotent.
 * Called from instrumentation-node.ts.
 */
let _ensureDefaultDone = false;
export async function ensureDefaultUser(): Promise<void> {
  const { sql } = getOrgPg();
  if (_ensureDefaultDone) return;
  await sql`
    INSERT INTO harness_shared.users (username, display_name, password_hash)
    VALUES ('default', 'User', NULL)
    ON CONFLICT (username) DO NOTHING
  `;
  _ensureDefaultDone = true;
}

export async function updateDisplayName(user_id: string, display_name: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.users
       SET display_name = ${display_name}
     WHERE id = ${user_id}
  `;
}

export async function listUsers(): Promise<User[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string; username: string; display_name: string; password_hash: string | null }>`
    SELECT id, username, display_name, password_hash
      FROM harness_shared.users
     WHERE is_active = true
     ORDER BY username
  `;
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    display_name: r.display_name,
    has_password: r.password_hash !== null,
  }));
}
