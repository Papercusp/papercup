/**
 * Marketplace service token (PG-backed, migration 024).
 *
 * Was previously `~/.papercusp/marketplace-secrets.env` in env-file
 * format, with `PAPERCUSP_MARKETPLACE_SERVICE_TOKENS` containing a JSON
 * array. The 3 publish/retract routes (templates publish, snapshots
 * publish, snapshots retract) all read this — moving to PG removes the
 * env-file parsing and gives consistent storage with the other operator
 * credentials tables.
 *
 * Env-var override: if `process.env.PAPERCUSP_MARKETPLACE_SERVICE_TOKENS`
 * is set, that wins. This preserves the deploy-time override path.
 *
 * Sensitive — NOT in zero_harness publication.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';

interface ServiceToken {
  /** Marketplace host the token authorizes (e.g. 'http://localhost:3057'). */
  host?: string;
  /** Bearer token. */
  token: string;
}

interface TokenPayload {
  tokens: ServiceToken[];
}

function parseEnvOverride(): ServiceToken[] | null {
  const raw = process.env.PAPERCUSP_MARKETPLACE_SERVICE_TOKENS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readServiceTokens(): Promise<ServiceToken[]> {
  // Env override wins (deploy-time injection, CI, etc.).
  const fromEnv = parseEnvOverride();
  if (fromEnv) return fromEnv;
  const row = await readOperatorState<TokenPayload>('operator_marketplace_token');
  return Array.isArray(row?.tokens) ? row.tokens : [];
}

export async function readFirstServiceToken(): Promise<string | null> {
  const tokens = await readServiceTokens();
  return tokens[0]?.token ?? null;
}

export async function writeServiceTokens(tokens: ServiceToken[]): Promise<void> {
  await writeOperatorState('operator_marketplace_token', { tokens });
}
