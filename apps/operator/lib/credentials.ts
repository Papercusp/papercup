/**
 * Operator credentials storage — PG-backed (migration 020).
 *
 * Persisted in `harness_shared.operator_credentials` (NOT in zero_harness
 * publication — credentials must not be broadcast over WS). Was previously
 * `<papercuspRoot>/credentials.json` with 0600 chmod. PG gives us atomic
 * upsert and central backup; encryption-at-rest can layer on later via
 * pgcrypto if desired.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';

export interface Credentials {
  anthropic_api_key?: string;
  openai_api_key?: string;
  /** ZeroEntropy cross-encoder rerank key (@papercusp/rerank). Absent → search reranking is a no-op RRF passthrough. */
  zeroentropy_api_key?: string;
  github_pat?: string;
  updated_at?: string;
}

export async function readCredentials(): Promise<Credentials> {
  const raw = await readOperatorState<Credentials>('operator_credentials');
  return raw ?? {};
}

export async function writeCredentials(creds: Credentials): Promise<Credentials> {
  const next: Credentials = { ...creds, updated_at: new Date().toISOString() };
  await writeOperatorState('operator_credentials', next);
  return next;
}

/**
 * Mask a secret to last-4 form: "sk-ant-...AbCd".
 * Returns null if the input is empty/missing.
 */
export function maskSecret(value: string | undefined | null): string | null {
  if (!value || value.length < 8) return null;
  return `${value.slice(0, 7)}...${value.slice(-4)}`;
}

export function maskCredentials(creds: Credentials) {
  return {
    anthropic_api_key: maskSecret(creds.anthropic_api_key),
    openai_api_key: maskSecret(creds.openai_api_key),
    zeroentropy_api_key: maskSecret(creds.zeroentropy_api_key),
    github_pat: maskSecret(creds.github_pat),
    updated_at: creds.updated_at ?? null,
    path: 'harness_shared.operator_credentials',
  };
}

/** @deprecated returns table name now — kept for legacy callers that want a display path */
export function CREDENTIALS_PATH() { return 'harness_shared.operator_credentials'; }
