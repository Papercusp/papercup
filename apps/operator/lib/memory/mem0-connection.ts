/**
 * Connection-string resolver for mem0's pgvector backend.
 *
 * mem0ai/oss's pgvector provider takes a raw postgres:// URL, not a
 * tagged-template sql client. We compose it from the same source-of-
 * truth the rest of the app uses (embedded-pg-discovery + env override).
 */

import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';

export async function connectionString(): Promise<string> {
  // Prefer the env override (matches how everything else reads it).
  const fromEnv = process.env.HARNESS_ADMIN_DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  // Fall back to embedded-pg-discovery (reads ~/.papercusp/embedded-pg.json).
  return getHarnessAdminUrl();
}
