/**
 * Drift-guard for the auditor G4 (P-011) spawn-env least-privilege strip.
 *
 * The orchestrator's `scopeSpawnEnvForRole(env, 'auditor')` strips every
 * search-provider API key from the read-only auditor's child env, using a
 * LOCAL const `SEARCH_PROVIDER_ENV_KEYS` (in `@papercusp/orchestrator`'s
 * `invoke.ts`) — it can't import the operator's canonical
 * `SEARCH_PROVIDERS` list (`apps/operator/lib/search-provider-credentials.ts`)
 * because that would be a wrong-direction submodule import (operator →
 * orchestrator is allowed; orchestrator → operator is not).
 *
 * So the two declarations could silently diverge: if someone adds a provider
 * to the operator's `SEARCH_PROVIDERS` but not to the orchestrator's const,
 * the new key would NOT be stripped from the auditor's env — a silent
 * under-strip (the read-only auditor would carry a secret it doesn't use).
 *
 * This test lives in apps/operator — the one layer that imports BOTH — and
 * asserts the orchestrator const covers exactly the set of env var names the
 * operator's provider list produces. Same pattern as
 * `agent-backend-sync.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { SEARCH_PROVIDER_ENV_KEYS } from '@papercusp/orchestrator';
import { SEARCH_PROVIDERS } from '../search-provider-credentials';

/** Every env var name the operator's provider list can carry: primaries +
 *  alternates + multi-field configs (e.g. SearXNG). */
function operatorSearchEnvKeys(): string[] {
  const out = new Set<string>();
  for (const p of SEARCH_PROVIDERS) {
    out.add(p.primary);
    for (const a of p.alternates ?? []) out.add(a);
    for (const f of p.fields ?? []) out.add(f);
  }
  return [...out];
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('auditor G4 search-provider strip stays in sync with the operator provider list', () => {
  it('the orchestrator SEARCH_PROVIDER_ENV_KEYS equals the operator-derived env-key set', () => {
    // If this fails after adding a provider to SEARCH_PROVIDERS, mirror the
    // new env var name(s) into SEARCH_PROVIDER_ENV_KEYS in the orchestrator's
    // invoke.ts — otherwise the auditor would not have that key stripped.
    expect(sorted(SEARCH_PROVIDER_ENV_KEYS)).toEqual(sorted(operatorSearchEnvKeys()));
  });

  it('the orchestrator const has no duplicate names', () => {
    expect(SEARCH_PROVIDER_ENV_KEYS.length).toBe(new Set(SEARCH_PROVIDER_ENV_KEYS).size);
  });
});
