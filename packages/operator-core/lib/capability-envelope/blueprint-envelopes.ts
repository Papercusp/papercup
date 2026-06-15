/**
 * Per-hive capability envelopes from a blueprint's `fleet.workerRoles`
 * (hive-blueprint-generalization P-012). A hive blueprint may declare, per worker
 * role, the capability ALLOW-list its bees are confined to — the per-hive analogue of
 * the global `ROLE_ENVELOPES` tuning in `./policy`. This resolves that declaration
 * into the envelope map `evaluateCapabilityEnvelope` consumes (pass it as the
 * `envelopes` arg), MERGED OVER the global defaults so a role the blueprint does not
 * name keeps its global envelope.
 *
 * Behavior-preserving: a non-fleet harness (today's coding hive AND generic-hive, which
 * declare no `fleet`) ⇒ `undefined`, so the caller uses the global `ROLE_ENVELOPES`
 * map unchanged. Reading is best-effort + fail-safe (a bad/absent blueprint ⇒ undefined).
 *
 * Caching: keyed by stateDir + the blueprint file's mtime, so the (cheap) blueprint
 * read happens at most once per harness-config version — never on the per-call hot path.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { ROLE_ENVELOPES, type RoleEnvelope } from './policy';

interface CacheEntry {
  mtimeMs: number;
  envelopes: Partial<Record<string, RoleEnvelope>> | undefined;
}
const cache = new Map<string, CacheEntry>();

/** Test seam: drop the mtime cache so a fixture's rewritten blueprint is re-read. */
export function __clearBlueprintEnvelopeCache(): void {
  cache.clear();
}

export function blueprintRoleEnvelopes(
  stateDir: string,
): Partial<Record<string, RoleEnvelope>> | undefined {
  const f = join(stateDir, 'blueprint.yaml');
  let mtimeMs = 0;
  try {
    if (!existsSync(f)) return undefined;
    mtimeMs = statSync(f).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = cache.get(stateDir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.envelopes;

  let envelopes: Partial<Record<string, RoleEnvelope>> | undefined;
  try {
    const workerRoles = loadBlueprintFromFile(f).blueprint.fleet?.workerRoles ?? [];
    if (workerRoles.length === 0) {
      envelopes = undefined;
    } else {
      const merged: Partial<Record<string, RoleEnvelope>> = { ...ROLE_ENVELOPES };
      for (const wr of workerRoles) {
        // A declared capability list IS that role's allow-list (the per-hive envelope);
        // an empty list leaves the role's global envelope untouched.
        if (wr.capabilities && wr.capabilities.length > 0) {
          merged[wr.id] = { ...merged[wr.id], allowCapabilities: wr.capabilities };
        }
      }
      envelopes = merged;
    }
  } catch {
    envelopes = undefined; // fail-safe: a bad blueprint never strands capability checks
  }
  cache.set(stateDir, { mtimeMs, envelopes });
  return envelopes;
}
