/**
 * Connection-string resolver for mem0's pgvector backend.
 *
 * mem0ai/oss's PGVector provider takes DISCRETE fields (user, password,
 * host, port, dbname) — NOT a connectionString. So we parse the canonical
 * URL into pieces here.
 */

import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';

export interface Mem0PgConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  dbname: string;
}

export async function connectionString(): Promise<string> {
  const fromEnv = process.env.HARNESS_ADMIN_DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  return getHarnessAdminUrl();
}

export async function pgFields(): Promise<Mem0PgConnection> {
  const url = await connectionString();
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    dbname: u.pathname.replace(/^\//, '') || 'papercusp',
  };
}
