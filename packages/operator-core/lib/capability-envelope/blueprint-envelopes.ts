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
import { loadBlueprintFromFile, type ResolvedAgentSpecification } from '@papercusp/orchestrator/blueprint';
import type { PotCapabilityProviderBindingRow } from '../capability-class-registry-store';
import { matchesAny, PROTECTED_CAPABILITY_GLOBS, ROLE_ENVELOPES, type RoleEnvelope } from './policy';

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

export interface IdentityGrantFailure {
  code: 'capability_unsatisfied';
  classRef: string | null;
  cause: 'stale-artifact' | 'policy-unavailable' | 'provider-unbound' | 'provider-changed' | 'tool-unavailable' | 'outside-ceiling';
  toolName?: string;
  routes: readonly ['operator-notify', 'suggest-provider', 'needs_human'];
}

/** A resolved narrowing, never a replacement for the caller's role ceiling. */
export type IdentityGrantEnvelope =
  | { applied: false }
  | {
      applied: true;
      specificationRevision: string;
      policyRevision: string;
      allowedTools: readonly string[];
      failures: readonly IdentityGrantFailure[];
    };

/**
 * P-005/D-005: derive exact tool grants from an APPLIED compiled artifact and
 * current host policy. No reads/cache here: dispatch must supply fresh bindings
 * and ceilings at each enforcement boundary, including after prompt failure.
 * The artifact must already have passed the compiler's integrity check. Tools,
 * bindings and ceilings are host-resolved evidence, never tool-call arguments.
 *
 * Rebinding does not silently activate a different provider under an old pin.
 * Optional unavailable providers grant nothing; a required failure closes the
 * whole envelope. No grants declaration preserves the legacy role-envelope path.
 */
export function resolveIdentityGrantEnvelope(input: {
  specification: ResolvedAgentSpecification;
  appliedSpecificationRevision: string;
  policyRevision: string;
  potSlug: string;
  bindings: readonly PotCapabilityProviderBindingRow[] | null;
  /** Every independently authorized ceiling must pass. Null/empty = unknown. */
  ceilings: readonly RoleEnvelope[] | null;
  /** Exact projected tool name -> required capabilities, read from the host. */
  tools: ReadonlyMap<string, readonly string[]>;
  protectedAdditions?: readonly string[];
}): IdentityGrantEnvelope {
  const { specification } = input;
  const grants = specification.configuration.grants;
  if (!grants) return { applied: false };
  const failures: IdentityGrantFailure[] = [];
  const allowedTools = new Set<string>();
  const fail = (cause: IdentityGrantFailure['cause'], classRef: string | null, toolName?: string) => {
    failures.push({ code: 'capability_unsatisfied', cause, classRef,
      ...(toolName ? { toolName } : {}), routes: ['operator-notify', 'suggest-provider', 'needs_human'] });
  };
  const result = (): IdentityGrantEnvelope => ({
    applied: true,
    specificationRevision: specification.specificationRevision,
    policyRevision: input.policyRevision,
    allowedTools: failures.length ? [] : [...allowedTools].sort(),
    failures,
  });
  if (specification.specificationRevision !== input.appliedSpecificationRevision) {
    fail('stale-artifact', null);
    return result();
  }
  if (!input.policyRevision.trim() || !input.potSlug.trim() || !input.bindings || !input.ceilings?.length) {
    fail('policy-unavailable', null);
    return result();
  }
  const pins = specification.inputs.filter((entry) => entry.kind === 'capability-provider');
  const required = new Set(grants.requires ?? []);
  const classes = new Set([...required, ...(grants.optional ?? [])]);
  const floor = [...PROTECTED_CAPABILITY_GLOBS, ...(input.protectedAdditions ?? [])];
  for (const classRef of classes) {
    const matchingPins = pins.filter((pin) => pin.ref === classRef);
    // An optional class absent at compilation cannot acquire authority later.
    if (matchingPins.length === 0 && !required.has(classRef)) continue;
    const current = input.bindings.filter((binding) =>
      binding.classRef === classRef && binding.potSlug === input.potSlug &&
      binding.status === 'active' && binding.conformanceStatus === 'passed');
    if (current.length === 0) {
      if (required.has(classRef)) fail('provider-unbound', classRef);
      continue;
    }
    const pin = matchingPins[0];
    const binding = current[0];
    const sameVerbs = pin && Object.keys(pin.verbBindings).length === Object.keys(binding.verbBindings).length &&
      Object.entries(pin.verbBindings).every(([verb, tool]) => binding.verbBindings[verb] === tool);
    if (matchingPins.length !== 1 || current.length !== 1 || !pin ||
        pin.providerPackage !== binding.providerPackage || pin.providerVersion !== binding.providerVersion ||
        pin.registryRevision !== binding.registryRevision || pin.conformanceRunId !== binding.conformanceRunId || !sameVerbs) {
      if (required.has(classRef)) fail('provider-changed', classRef);
      continue;
    }
    const classTools = [...new Set(Object.values(pin.verbBindings))];
    const permitted: string[] = [];
    for (const toolName of classTools) {
      const capabilities = input.tools.get(toolName);
      if (!capabilities) {
        fail('tool-unavailable', classRef, toolName);
        continue;
      }
      const withinCeiling = !matchesAny(toolName, floor) && !capabilities.some((cap) => matchesAny(cap, floor)) &&
        input.ceilings.every((ceiling) => {
          if (ceiling.denyCapabilities && [toolName, ...capabilities].some((cap) => matchesAny(cap, ceiling.denyCapabilities!))) return false;
          if (ceiling.allowCapabilities === undefined) return true;
          // Explicit empty allow-list means deny all here. Do not inherit the
          // historical empty-list/default-allow convention of unbound roles.
          return matchesAny(toolName, ceiling.allowCapabilities) ||
            (capabilities.length > 0 && capabilities.every((cap) => matchesAny(cap, ceiling.allowCapabilities!)));
        });
      if (!withinCeiling) fail('outside-ceiling', classRef, toolName);
      else permitted.push(toolName);
    }
    permitted.forEach((toolName) => allowedTools.add(toolName));
  }
  return result();
}
