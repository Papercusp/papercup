import { createHash } from 'node:crypto';
import type { UnifiedToolContext } from '@papercusp/tooldef';

export type PermissionInputJson = null | boolean | number | string | PermissionInputJson[] |
  { [key: string]: PermissionInputJson };

/** Shared with the comparison replay: preserve authority containers and absence
 * without executing getters, toJSON hooks, or unknown service objects. */
export function idopAuthorityData(value: unknown, ancestors = new Set<object>()): PermissionInputJson {
  if (value === undefined) return ['undefined'];
  if (Object.is(value, -0)) return ['negative-zero'];
  if (value === null || ['string', 'boolean'].includes(typeof value) ||
      typeof value === 'number' && Number.isFinite(value)) return value as PermissionInputJson;
  if (typeof value !== 'object' || !value || ancestors.has(value)) throw new Error('IDOP authority requires acyclic data-only inputs');
  const next = new Set(ancestors).add(value);
  const encode = (entry: unknown) => idopAuthorityData(entry, next);
  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    const prototype = value instanceof Date ? Date.prototype : value instanceof Map ? Map.prototype : Set.prototype;
    if (Object.getPrototypeOf(value) !== prototype || Reflect.ownKeys(value).length) {
      throw new Error('IDOP authority container has an unsupported prototype or extra properties');
    }
    if (value instanceof Date && Number.isFinite(value.getTime())) return ['date', value.toISOString()];
    if (value instanceof Map) return ['map', [...value].map(([key, entry]) => [encode(key), encode(entry)])];
    if (value instanceof Set) return ['set', [...value].map(encode)];
    throw new Error('IDOP authority has an invalid Date');
  }
  if (Array.isArray(value)) {
    if (Object.getOwnPropertyNames(value).length !== value.length + 1 || Object.getOwnPropertySymbols(value).length) {
      throw new Error('IDOP authority array has holes or extra properties');
    }
    return ['array', Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) throw new Error('IDOP authority has an unreadable accessor');
      return encode(descriptor.value);
    })];
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) {
    throw new Error('IDOP authority has an unsupported prototype or symbol');
  }
  return ['object', Object.entries(Object.getOwnPropertyDescriptors(value)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, descriptor]) => {
      if (!('value' in descriptor)) throw new Error('IDOP authority has an unreadable accessor');
      return [key, encode(descriptor.value)];
    })];
}

export function idopAuthorityValue(data: PermissionInputJson): unknown {
  if (!Array.isArray(data)) return data;
  const [kind, body] = data;
  const entries = body as PermissionInputJson[];
  switch (kind) {
    case 'undefined': return undefined;
    case 'negative-zero': return -0;
    case 'date': return new Date(body as string);
    case 'array': return entries.map(idopAuthorityValue);
    case 'set': return new Set(entries.map(idopAuthorityValue));
    case 'map': return new Map(entries.map(entry => {
      const [key, value] = entry as PermissionInputJson[];
      return [idopAuthorityValue(key), idopAuthorityValue(value)];
    }));
    case 'object': return Object.fromEntries(entries.map(entry => {
      const [key, value] = entry as [string, PermissionInputJson];
      return [key, idopAuthorityValue(value)];
    }));
    default: throw new Error('IDOP invalid authority data tag');
  }
}

const permissionContextKeys = [
  'principal', 'gateBypass', 'isSuperuser', 'isPowerUser', 'profile', 'workspaceId',
  'harnessSlug', 'role', 'uiClientId', 'advSessionId', 'runId', 'spawnId', 'parentSpawnId',
  'sigVerifiedSpawn', 'transport', 'projectDir', 'stateDir', 'featureId', 'chunkId',
  'quotaSubject', 'kernelBoundary', 'dispatchBoundary', 'kernelOwnership',
  'requestedExecutionRevision', 'appliedExecutionRevision', 'executionRevision',
  'indirectDispatch', 'codeMode', 'telemetrySurface', 'callerAgent', 'callerModel',
  'planRunSessionId', 'reactionCause',
] as const satisfies readonly (keyof UnifiedToolContext)[];
const principalKeys = new Set(['slug', 'workspaceId', 'capabilities', 'kind', 'authMethod',
  'trust', 'roles', 'allowedTools', 'label']);

/** Observe the actual dispatch context, never derive privilege from a launch
 * record or role. This deliberately bounded projection is NOT a complete host,
 * kernel, argument or vault snapshot. Excluded key names make that limit
 * inspectable; no request headers, arguments or service state are persisted.
 * Unserializable evidence stays explicitly unavailable without changing tool
 * admission. Neither status authorizes replay as the observed caller. */
export function captureOriginalPermissionContext(ctx: UnifiedToolContext) {
  const scope = 'original-dispatch-context-projection' as const;
  const schemaVersion = 1 as const;
  const unavailable = (reason: string) => ({ schemaVersion, scope, status: 'unavailable' as const, reason });
  const descriptors = Object.getOwnPropertyDescriptors(ctx);
  const excludedKeys = Object.keys(descriptors).filter(key =>
    !permissionContextKeys.some(selected => selected === key)).sort();
  const context: Record<string, unknown> = Object.create(null);
  for (const key of permissionContextKeys) {
    const descriptor = descriptors[key];
    if (!descriptor) continue;
    if (!('value' in descriptor)) return unavailable('context-accessor');
    context[key] = descriptor.value;
  }
  if (Object.getOwnPropertySymbols(ctx).length) return unavailable('context-symbol');
  const principal = context.principal;
  if (principal !== undefined && principal !== null &&
      (typeof principal !== 'object' || Object.getOwnPropertyNames(principal).some(key => !principalKeys.has(key)))) {
    return unavailable('unsupported-principal');
  }
  try {
    const data = idopAuthorityData(context);
    const bytes = JSON.stringify(data);
    if (Buffer.byteLength(bytes, 'utf8') > 64 * 1024) return unavailable('context-size-limit');
    return { schemaVersion, scope, status: 'captured' as const,
      keys: Object.keys(context).sort(), excludedKeys, data,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return unavailable('unsupported-authority-data');
  }
}
