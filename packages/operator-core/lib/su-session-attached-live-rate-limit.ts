import type { SuSessionDescriptor, SuSessionEvent } from '@papercusp/chat-protocol';
import { redactSensitiveText } from './sensitive-text';

/** Snapshot the same pending criteria as Vitest's waitForImportsToResolve.
 * moduleExecutionInfo contains completed imports, so cannot diagnose this wait.
 * Keep this synchronous and bounded: it runs before interrupted fixture cleanup. */
export function nativePendingImports(worker: unknown) {
  const maxItems = 12, maxEdges = 4, maxScan = 10_000, maxIdLength = 256;
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const ids = (value: unknown, limit: number) => {
    if (!(value instanceof Set)) return { state: value === undefined ? 'unavailable' : 'invalid',
      count: null, ids: [], truncated: false, invalidIds: 0 };
    const result: string[] = [];
    let scanned = 0, invalidIds = 0, shortened = false;
    for (const id of value) {
      if (scanned++ >= limit) break;
      if (typeof id !== 'string') { invalidIds++; continue; }
      const safe = redactSensitiveText(id);
      shortened ||= safe.length > maxIdLength;
      result.push(safe.slice(0, maxIdLength));
    }
    return { state: invalidIds ? 'invalid' : 'available', count: value.size, ids: result,
      truncated: value.size > limit || shortened, invalidIds };
  };
  const state = record(worker);
  const map = record(state?.evaluatedModules)?.idToModuleMap;
  const pending: Array<{ id: string; idTruncated: boolean;
    imports: ReturnType<typeof ids>; importers: ReturnType<typeof ids> }> = [];
  let scanned = 0, pendingSeen = 0, invalidNodes = 0;
  if (map instanceof Map) {
    for (const [id, value] of map) {
      if (scanned >= maxScan) break;
      scanned++;
      const node = record(value);
      if (typeof id !== 'string' || !node || typeof node.evaluated !== 'boolean') { invalidNodes++; continue; }
      if (!node.promise || node.evaluated) continue;
      pendingSeen++;
      if (pending.length >= maxItems) continue;
      const safe = redactSensitiveText(id);
      pending.push({ id: safe.slice(0, maxIdLength), idTruncated: safe.length > maxIdLength,
        imports: ids(node.imports, maxEdges), importers: ids(node.importers, maxEdges) });
    }
  }
  const available = map instanceof Map;
  const scanComplete = available && scanned === map.size;
  // Vitest writes these only when evaluation finishes. Durations INCLUDE child
  // imports; selfTime subtracts them. Retain both rankings, never sum durations.
  const timings = state?.moduleExecutionInfo;
  const completed: Array<{ id: string; importer: string | null; durationMs: number; selfMs: number;
    idsTruncated: boolean }> = [];
  let timingsScanned = 0, invalidTimings = 0;
  if (timings instanceof Map) for (const [id, value] of timings) {
    if (timingsScanned >= maxScan) break;
    timingsScanned++;
    const info = record(value);
    if (typeof id !== 'string' || !info || typeof info.duration !== 'number' || !Number.isFinite(info.duration)
      || info.duration < 0 || typeof info.selfTime !== 'number' || !Number.isFinite(info.selfTime)
      || (info.importer !== undefined && typeof info.importer !== 'string')) { invalidTimings++; continue; }
    const safe = redactSensitiveText(id);
    const importer = typeof info.importer === 'string' ? redactSensitiveText(info.importer) : null;
    completed.push({ id: safe.slice(0, maxIdLength), importer: importer?.slice(0, maxIdLength) ?? null,
      durationMs: info.duration, selfMs: info.selfTime,
      idsTruncated: safe.length > maxIdLength || (importer?.length ?? 0) > maxIdLength });
  }
  return {
    schemaVersion: 'native-pending-imports-v1',
    workerState: state ? 'available' : worker === undefined ? 'unavailable' : 'invalid',
    resolving: ids(state?.resolvingModules, maxItems),
    evaluating: { state: available ? invalidNodes ? 'invalid' : 'available' : map === undefined ? 'unavailable' : 'invalid',
      total: available ? map.size : null, scanned, invalidNodes, scanComplete,
      pendingCount: scanComplete && !invalidNodes ? pendingSeen : null, pendingSeen, pending,
      truncated: available && (!scanComplete || pendingSeen > pending.length) },
    completed: { state: timings instanceof Map ? invalidTimings ? 'invalid' : 'available'
      : timings === undefined ? 'unavailable' : 'invalid',
      total: timings instanceof Map ? timings.size : null, scanned: timingsScanned, invalidTimings,
      scanComplete: timings instanceof Map && timingsScanned === timings.size,
      truncated: timings instanceof Map && (timings.size > maxScan || completed.length > maxItems),
      durationBasis: 'inclusive-evaluator-wall-ms', selfBasis: 'duration-minus-child-imports-ms',
      slowestByDuration: [...completed].sort((a, b) => b.durationMs - a.durationMs).slice(0, maxItems),
      slowestBySelf: completed.sort((a, b) => b.selfMs - a.selfMs).slice(0, maxItems) },
  };
}

/** Retain the measured route and structured refusal before native teardown. */
export function nativeAcceptanceFailure(input: {
  backend: 'claude' | 'codex'; model: string; account: string; stage: string;
  descriptor?: SuSessionDescriptor; events: readonly SuSessionEvent[]; error: unknown;
}) {
  const descriptor = input.descriptor;
  return {
    backend: input.backend, model: input.model, accountRequested: input.account, stage: input.stage,
    accountServed: descriptor?.accountServed ?? null,
    ownerId: descriptor?.identity.ownerId ?? null,
    nativeSessionId: descriptor?.identity.nativeSessionId ?? null,
    runtimeGeneration: descriptor?.runtimeGeneration ?? null,
    lifecycle: descriptor?.lifecycle ?? null,
    message: redactSensitiveText(input.error instanceof Error ? input.error.message : String(input.error)),
    errors: input.events.flatMap(event => event.type === 'error'
      ? [{ code: event.code, message: redactSensitiveText(event.message) }] : []).slice(-8),
    accepted: false,
  };
}

const CONFIRMED_PROVIDER_RATE_LIMIT_RE =
  /(\b429\b|rate.?limit|too many requests|slow down|temporarily limiting|weekly limit)/i;

function systemTranscriptMatches(events: readonly SuSessionEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'transcript' &&
    event.phase === 'delta' &&
    event.role === 'system' &&
    event.content &&
    CONFIRMED_PROVIDER_RATE_LIMIT_RE.test(event.content)
      ? [event.content]
      : [],
  );
}

/** Distinguish provider-capacity evidence from an attached-engine regression. */
export function confirmedProviderRateLimit(
  events: readonly SuSessionEvent[],
): { confirmed: boolean; signals: string[] } {
  const structured = events.flatMap((event) =>
    event.type === 'error' && CONFIRMED_PROVIDER_RATE_LIMIT_RE.test(event.message) ? [event.message] : [],
  );
  const prose = systemTranscriptMatches(events);
  return { confirmed: structured.length > 0 || prose.length >= 2, signals: [...structured, ...prose] };
}

/** Abort a live acceptance wait when the provider has already refused the turn. */
export function throwIfProviderRateLimited(events: readonly SuSessionEvent[], stage: string): void {
  const limit = confirmedProviderRateLimit(events);
  if (limit.confirmed) {
    throw new Error(`${stage} cannot run: confirmed provider rate limit (${limit.signals.join('; ')})`);
  }
}

/** A rejected native model cannot produce the reply or approval being awaited.
 * Read only structured runtime evidence; assistant prose is not a refusal. */
export function throwIfProviderRefused(events: readonly SuSessionEvent[], stage: string): void {
  throwIfProviderRateLimited(events, stage);
  const rejection = events.find((event) => {
    const message = event.type === 'error' ? event.message
      : event.type === 'lifecycle' && event.state === 'waiting-for-owner' ? event.reason : undefined;
    return message && /The '[^']+' model is not supported when using Codex with a ChatGPT account\./.test(message);
  });
  if (rejection) {
    const reason = rejection.type === 'error' ? rejection.message
      : rejection.type === 'lifecycle' ? rejection.reason : undefined;
    throw new Error(`${stage} cannot run: confirmed provider model rejection (${reason})`);
  }
}
