import WebSocket from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const DEFAULT_CLOSE_POLL_MS = 100;

/**
 * The client accepts either Node or browser-style event transports. Injected
 * test transports need only these operations, not WebSocket's static constants.
 * @typedef {{ readyState: number, send: (payload: string) => void, close: () => void,
 *   on?: (event: string, handler: (...args: any[]) => void) => unknown,
 *   once?: (event: string, handler: (...args: any[]) => void) => unknown,
 *   addEventListener?: (...args: any[]) => unknown }} CdpSocket
 * @typedef {(url: string, options?: RequestInit) => Promise<{ ok: boolean, json: () => Promise<any> }>} InspectorFetch
 * @typedef {(delay: number) => Promise<unknown>} InspectorSleep
 */

export class CdpEvaluationError extends Error {
  constructor(expression, exceptionDetails) {
    const description = exceptionDetails?.exception?.description
      ?? exceptionDetails?.text
      ?? JSON.stringify(exceptionDetails);
    super(`Runtime.evaluate failed: ${description}`);
    this.name = 'CdpEvaluationError';
    this.expression = expression;
    this.exceptionDetails = exceptionDetails;
  }
}

export class CdpProtocolError extends Error {
  constructor(method, error) {
    super(`${method} failed: ${error?.message ?? JSON.stringify(error)}`);
    this.name = 'CdpProtocolError';
    this.method = method;
    this.protocolError = error;
  }
}

export class CdpRequestTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`${method} timed out after ${timeoutMs}ms`);
    this.name = 'CdpRequestTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class CdpTransportClosedError extends Error {
  constructor(method) {
    super(`CDP transport closed while waiting for ${method}`);
    this.name = 'CdpTransportClosedError';
    this.method = method;
  }
}

/**
 * Read process/V8 counters without GC or changing an active heap profiler.
 * Inspector evaluations have no ESM dynamic-import callback on Node targets;
 * getBuiltinModule reaches the target's existing builtin instead. The caller
 * must name its PID so a reused inspector port cannot silently sample a peer.
 * These counters are not a retainer graph or an estimate of total native bytes.
 * @param {Pick<ReturnType<typeof createCdpClient>, 'evaluate'>} client
 * @param {{ expectedPid?: number }} [options]
 */
export async function readProcessMemory(client, { expectedPid } = {}) {
  if (!Number.isInteger(expectedPid) || expectedPid <= 0) {
    throw new TypeError('readProcessMemory requires a positive expectedPid');
  }
  const result = await client.evaluate(String.raw`(() => {
    if (typeof process.getBuiltinModule !== 'function') {
      throw new Error('This Node target does not support getBuiltinModule');
    }
    const v8 = process.getBuiltinModule('v8');
    return { pid: process.pid, at: Date.now(), uptime: process.uptime(),
      memory: process.memoryUsage(), heap: v8.getHeapStatistics() };
  })()`, { returnByValue: true });
  const sample = result?.result?.value;
  if (sample?.pid !== expectedPid) {
    throw new Error(`Inspector PID mismatch: expected ${expectedPid}, observed ${sample?.pid ?? 'unknown'}`);
  }
  return sample;
}

/**
 * Inspect logical payloads reachable from existing module-singleton roots.
 * No GC, queryObjects, getters, proxy traps or application iterators run.
 * Shared objects belong to the first observed root for counting purposes only.
 * Enumeration time is included; these counts are not retained heap/native bytes.
 * Exact owner selection bypasses registry order. Remaining global work/time
 * budgets are divided among remaining roots; enumeration can overrun time.
 * Opt-in operator-cache attribution visits each L1 value at depth zero with
 * fair per-value quotas. Keys leave the target only as bounded SHA-256 digests
 * and validated tool namespaces or known direct-writer families; shared values
 * count at their first entry. A writer family identifies a key contract, not
 * an allocation stack or exclusive retained ownership.
 * Offset pages use current insertion order, not a stable multi-read snapshot.
 * Digest selection and skipped page edges consume the same global work budget.
 * @param {Pick<ReturnType<typeof createCdpClient>, 'evaluate'>} client
 * @param {{ expectedPid: number, maxSlots?: number, maxObjects?: number,
 *   maxEntries?: number, maxFields?: number, maxDepth?: number, budgetMs?: number,
 *   owners?: string[], operatorCacheEntries?: boolean, maxCacheEntries?: number,
 *   maxEntryEntries?: number, maxEntryObjects?: number, maxKeyCodeUnits?: number,
 *   cacheEntryOffset?: number, cacheKeyDigests?: string[] }} options
 */
export async function readPinnedState(client, {
  expectedPid, maxSlots = 256, maxObjects = 4096, maxEntries = 8192,
  maxFields = 32, maxDepth = 5, budgetMs = 50, owners, operatorCacheEntries = false,
  maxCacheEntries = 64, maxEntryEntries = 2048, maxEntryObjects = 1024, maxKeyCodeUnits = 16384,
  cacheEntryOffset = 0, cacheKeyDigests,
}) {
  const limits = { maxSlots, maxObjects, maxEntries, maxFields, maxDepth, budgetMs,
    maxCacheEntries, maxEntryEntries, maxEntryObjects, maxKeyCodeUnits };
  if (!Number.isInteger(expectedPid) || expectedPid < 1 ||
      Object.values(limits).some(value => !Number.isInteger(value) || value < 1) ||
      maxSlots > 512 || maxObjects > 16384 || maxEntries > 32768 ||
      maxFields > 64 || maxDepth > 8 || budgetMs > 200 ||
      typeof operatorCacheEntries !== 'boolean' || maxCacheEntries > 256 ||
      maxEntryEntries > 32768 || maxEntryObjects > 16384 || maxKeyCodeUnits > 65536 ||
      !Number.isInteger(cacheEntryOffset) || cacheEntryOffset < 0 || cacheEntryOffset > 32768 ||
      (cacheKeyDigests !== undefined && (!Array.isArray(cacheKeyDigests) || cacheKeyDigests.length < 1 ||
        cacheKeyDigests.length > 256 || new Set(cacheKeyDigests).size !== cacheKeyDigests.length ||
        cacheKeyDigests.some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) ||
        cacheEntryOffset !== 0)) ||
      ((!operatorCacheEntries) && (cacheEntryOffset !== 0 || cacheKeyDigests !== undefined)) ||
      (owners !== undefined && (!Array.isArray(owners) || owners.length < 1 || owners.length > 64 ||
        new Set(owners).size !== owners.length || owners.some(name => typeof name !== 'string' ||
          name.length < 1 || name.length > 512)))) throw new TypeError('invalid pinned-state limits/PID/owners');
  const result = await client.evaluate(`(() => {
    if (process.pid !== ${expectedPid}) throw new Error('Inspector PID mismatch');
    const limits = ${JSON.stringify(limits)}, owners = ${JSON.stringify(owners ?? null)}, start = performance.now();
    const operatorCacheEntries = ${JSON.stringify(operatorCacheEntries)};
    const cacheEntryOffset = ${JSON.stringify(cacheEntryOffset)}, cacheKeyDigests = ${JSON.stringify(cacheKeyDigests ?? null)};
    const types = process.getBuiltinModule('util').types;
    const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
    const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
    const arrayBufferSize = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
    const typedSize = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
    const dataViewSize = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;
    const slots = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('@papercusp/module-singleton.slots'))?.value;
    if (!slots || types.isProxy(slots) || !types.isMap(slots)) return {
      pid: process.pid, registryPresent: false, population: null, checked: 0, roots: [], limits,
      observerMs: performance.now() - start, limited: false };
    const seen = new WeakSet(), roots = [];
    let objects = 0, entries = 0, limited = false;
    const expired = () => performance.now() - start >= limits.budgetMs;
    const population = mapSize.call(slots);
    const missingOwners = owners?.filter(name => !Map.prototype.has.call(slots, name)) ?? [];
    const selectedPopulation = owners ? owners.length - missingOwners.length : population;
    const candidates = owners ? owners.filter(name => Map.prototype.has.call(slots, name))
      .map(name => [name, Map.prototype.get.call(slots, name)]) : Map.prototype.entries.call(slots);
    const rootCount = Math.min(selectedPopulation, limits.maxSlots);
    for (const [name, slot] of candidates) {
      if (roots.length >= limits.maxSlots || expired()) { limited = true; break; }
      if (typeof name !== 'string') { limited = true; continue; }
      const rootStart = performance.now(), remainingRoots = Math.max(1, rootCount - roots.length);
      const quota = { entries: Math.max(1, Math.floor((limits.maxEntries - entries) / remainingRoots)),
        objects: Math.max(1, Math.floor((limits.maxObjects - objects) / remainingRoots)),
        budgetMs: Math.max(0, (limits.budgetMs - (rootStart - start)) / remainingRoots) };
      let entryEnd = Math.min(limits.maxEntries, entries + quota.entries);
      let objectEnd = Math.min(limits.maxObjects, objects + quota.objects);
      const rootExpired = () => expired() || performance.now() - rootStart >= quota.budgetMs;
      let valueDeadline = Infinity;
      const exhausted = () => entries >= entryEnd || objects >= objectEnd || rootExpired() ||
        performance.now() >= valueDeadline;
      const counters = () => ({ entries: 0,
        objects: 0, maps: 0, mapEntries: 0, arrays: 0, arrayEntries: 0, sets: 0, setEntries: 0,
        stringCodeUnits: 0, byteViewExtents: 0, arrayBufferExtents: 0, sharedEdges: 0,
        accessorsSkipped: 0, proxiesSkipped: 0, fieldsLimited: 0, depthLimited: 0, traversalLimited: false });
      let row = { owner: name.slice(0, 160), ownerTruncated: name.length > 160, quota, ...counters() };
      const visit = (value, depth) => {
        if (exhausted()) {
          row.traversalLimited = limited = true; return;
        }
        if (typeof value === 'string') { row.stringCodeUnits += value.length; return; }
        if (!value || typeof value !== 'object') return;
        if (types.isProxy(value)) { row.proxiesSkipped++; return; }
        if (seen.has(value)) { row.sharedEdges++; return; }
        seen.add(value); objects++; row.objects++;
        if (ArrayBuffer.isView(value)) {
          row.byteViewExtents += (types.isDataView(value) ? dataViewSize : typedSize).call(value); return;
        }
        if (types.isArrayBuffer(value)) { row.arrayBufferExtents += arrayBufferSize.call(value); return; }
        const map = types.isMap(value), set = types.isSet(value), array = Array.isArray(value);
        if (map) { row.maps++; row.mapEntries += mapSize.call(value); }
        if (set) { row.sets++; row.setEntries += setSize.call(value); }
        if (array) { row.arrays++; row.arrayEntries += Object.getOwnPropertyDescriptor(value, 'length').value; }
        if (depth >= limits.maxDepth) { row.depthLimited++; limited = true; return; }
        if (map || set) {
          const iterator = map ? Map.prototype.entries.call(value) : Set.prototype.values.call(value);
          for (const item of iterator) {
            if (exhausted()) {
              row.traversalLimited = limited = true; break;
            }
            entries++; row.entries++;
            if (map) { visit(item[0], depth + 1); visit(item[1], depth + 1); }
            else visit(item, depth + 1);
          }
          return;
        }
        if (array) {
          const length = Object.getOwnPropertyDescriptor(value, 'length').value;
          for (let i = 0; i < length; i++) {
            if (exhausted()) {
              row.traversalLimited = limited = true; break;
            }
            entries++; row.entries++;
            const field = Object.getOwnPropertyDescriptor(value, String(i));
            if (field && 'value' in field) visit(field.value, depth + 1);
            else if (field) row.accessorsSkipped++;
          }
          return;
        }
        // Symbols, non-enumerable fields and function closures are excluded.
        // Object.keys does not walk potentially proxied prototypes. V8 key
        // enumeration latency is observed, rather than promised a hard bound.
        const keys = Object.keys(value);
        if (keys.length > limits.maxFields) { row.fieldsLimited++; limited = true; }
        for (const key of keys.slice(0, limits.maxFields)) {
          if (exhausted()) {
            row.traversalLimited = limited = true; break;
          }
          entries++; row.entries++;
          const field = Object.getOwnPropertyDescriptor(value, key);
          if (field && 'value' in field) visit(field.value, depth + 1); else row.accessorsSkipped++;
        }
      };
      if (operatorCacheEntries && name === '@papercusp/operator-core.operatorCache') {
        const rootRow = row, rootEntryEnd = entryEnd, rootObjectEnd = objectEnd;
        // Fixed own-data path, never cache.get(), freshness(), getters or LRU touches.
        const data = (object, key) => {
          if (!object || typeof object !== 'object') return { status: 'missing' };
          if (types.isProxy(object)) { rootRow.proxiesSkipped++; return { status: 'proxy-skipped' }; }
          const field = Object.getOwnPropertyDescriptor(object, key);
          if (!field) return { status: 'missing' };
          if (!('value' in field)) { rootRow.accessorsSkipped++; return { status: 'accessor-skipped' }; }
          return { status: 'data', value: field.value };
        };
        let found = { status: 'data', value: slot };
        for (const field of ['value', 'cache', 'l1', 'map']) {
          if (found.status !== 'data') break;
          found = data(found.value, field);
        }
        const cache = { path: 'cache.l1.map', status: found.status, population: null,
          checked: 0, notChecked: null, scanned: 0, undigestibleKeys: 0, values: [],
          selection: { mode: cacheKeyDigests ? 'digests' : 'offset', offset: cacheEntryOffset,
            requestedKeyDigests: cacheKeyDigests, nextOffset: null, unresolvedKeyDigests: [],
            unresolvedAreMissing: false, selectedNotChecked: null,
            definition: 'Current insertion order; membership may change between reads. Unresolved digests are not missing unless the full scan is digestible.' },
          definition: 'Bounded L1 value payloads; excludes cache metadata/other roots and is not retained bytes.' };
        rootRow.cacheEntries = cache;
        if (found.status === 'data' && found.value && !types.isProxy(found.value) && types.isMap(found.value)) {
          const map = found.value, count = mapSize.call(map);
          cache.status = 'map'; cache.population = count;
          rootRow.maps = 1; rootRow.mapEntries = count;
          const selectedCount = Math.min(cacheKeyDigests ? cacheKeyDigests.length : Math.max(0, count - cacheEntryOffset),
            limits.maxCacheEntries);
          const requested = cacheKeyDigests ? new Set(cacheKeyDigests) : null, matched = new Set();
          const crypto = process.getBuiltinModule('crypto');
          for (const [key, wrapper] of Map.prototype.entries.call(map)) {
            if (cache.checked >= selectedCount || entries >= rootEntryEnd || objects >= rootObjectEnd || rootExpired()) break;
            entries++; rootRow.entries++; cache.scanned++; // Every scanned L1 edge consumes global work, even when skipped.
            if (!requested && cache.scanned <= cacheEntryOffset) continue;
            const keyString = typeof key === 'string';
            const boundedKey = keyString && key.length <= limits.maxKeyCodeUnits;
            const digest = boundedKey ? crypto.createHash('sha256').update(key).digest('hex') : null;
            if (!boundedKey) cache.undigestibleKeys++;
            if (requested && (!digest || !requested.has(digest))) continue;
            if (digest) matched.add(digest);
            const valueStart = performance.now(), remaining = Math.max(1, selectedCount - cache.checked);
            const valueQuota = {
              entries: Math.min(limits.maxEntryEntries, Math.floor((rootEntryEnd - entries) / remaining)),
              objects: Math.min(limits.maxEntryObjects, Math.floor((rootObjectEnd - objects) / remaining)),
              budgetMs: Math.max(0, (quota.budgetMs - (valueStart - rootStart)) / remaining) };
            entryEnd = entries + valueQuota.entries; objectEnd = objects + valueQuota.objects;
            valueDeadline = valueStart + valueQuota.budgetMs;
            const nul = boundedKey ? key.indexOf('\u0000') : -1;
            const pipe = nul > 0 ? key.indexOf('|', nul + 1) : -1;
            const namespace = pipe > nul + 1 && pipe - nul <= 121 ? key.slice(nul + 1, pipe) : null;
            const validNamespace = namespace !== null && !namespace.startsWith('jev-memory:') &&
              /^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_.-]*$/.test(namespace);
            // jevMemoryCacheKey writes directly through the operator Cache rather
            // than cachedRead: workspace + NUL + jev-memory:<SHA256>. Validate the
            // entire writer suffix; never return its digest or conversation data.
            const directKey = nul > 0 ? key.slice(nul + 1) : null;
            const jevWriter = directKey !== null && directKey.length === 75 &&
              /^jev-memory:[a-f0-9]{64}$/.test(directKey);
            const metadata = { keyDigest: digest,
              keyDigestUnavailable: boundedKey ? null : keyString ? 'key-length-limit' : 'non-string-key',
              keyCodeUnits: keyString ? key.length : null,
              keyFormat: validNamespace ? 'workspace-nul-tool-pipe' : jevWriter ? 'workspace-nul-jev-memory-sha256' : 'unknown',
              toolNamespace: validNamespace ? namespace : null,
              cacheOwner: validNamespace ? namespace : jevWriter ? 'jev-memory' : null, quota: valueQuota,
              softExpiry: 'unknown', hardExpiry: 'unknown', valueStatus: 'missing' };
            if (wrapper && typeof wrapper === 'object' && !types.isProxy(wrapper)) {
              for (const [field, target] of [['softExpiresAt', 'softExpiry'], ['hardExpiresAt', 'hardExpiry']]) {
                const descriptor = Object.getOwnPropertyDescriptor(wrapper, field);
                const expiry = descriptor && 'value' in descriptor ? descriptor.value : undefined;
                metadata[target] = expiry === Infinity ? 'infinite' : typeof expiry === 'number' && Number.isFinite(expiry)
                  ? Date.now() >= expiry ? 'expired' : 'pending' : 'unknown';
              }
            }
            const value = data(wrapper, 'value'); metadata.valueStatus = value.status;
            row = { ...metadata, ...counters() };
            if (value.status === 'data') visit(value.value, 0);
            cache.values.push(row); cache.checked++;
            for (const field of Object.keys(counters())) {
              if (field === 'traversalLimited') rootRow[field] ||= row[field];
              else rootRow[field] += row[field];
            }
          }
          cache.notChecked = count - cache.checked;
          cache.selection.nextOffset = !requested && cache.scanned < count && cache.scanned > cacheEntryOffset
            ? cache.scanned : null;
          cache.selection.selectedNotChecked = selectedCount - cache.checked;
          cache.selection.unresolvedKeyDigests = cacheKeyDigests?.filter(digest => !matched.has(digest)) ?? [];
          cache.selection.unresolvedAreMissing = Boolean(requested && cache.scanned === count && cache.undigestibleKeys === 0);
          cache.selection.scanComplete = cache.scanned === count;
          if (cache.notChecked > 0) rootRow.traversalLimited = limited = true;
        } else if (found.status === 'data') {
          cache.status = found.value && types.isProxy(found.value) ? 'proxy-skipped' : 'not-map';
          if (cache.status === 'proxy-skipped') rootRow.proxiesSkipped++;
        }
        row = rootRow;
      } else if (!slot || typeof slot !== 'object' || types.isProxy(slot)) row.proxiesSkipped++;
      else {
        const field = Object.getOwnPropertyDescriptor(slot, 'value');
        if (field && 'value' in field) visit(field.value, 0); else row.accessorsSkipped++;
      }
      roots.push(row);
    }
    return { pid: process.pid, registryPresent: true, population, checked: roots.length,
      selection: { requestedOwners: owners, selectedPopulation, missingOwners,
        excludedBySelection: population - selectedPopulation,
        selectedNotChecked: selectedPopulation - roots.length },
      notChecked: population - roots.length, objects, entries, roots, limits,
      limited, observerMs: performance.now() - start,
      definition: 'Bounded reachable logical payloads under named roots; not total retained heap/native bytes.' };
  })()`, { returnByValue: true });
  return result.result.value;
}

/** @typedef {{ pid: number, startedAt: number, until: number, endedAt: number,
 *   total: number, observerMs: number, limited: boolean,
 *   calls: Record<string, { calls: number, stacks: string[] }> }} FunctionCallTrace */

/**
 * Attribute explicitly selected calls without pausing the target. Conditions
 * always return false, record no arguments/source bodies, and expire even if
 * the connection disappears. Counts are capped observations, not a census.
 * Debugger/profiler settings belonging to other clients are never reset.
 * The bound covers capture/body time; protocol setup/cleanup has the client's
 * separate request timeout. This is diagnostic overhead, not allocation bytes.
 * @template T
 * @param {Pick<ReturnType<typeof createCdpClient>, 'send' | 'evaluate'>} client
 * @param {{ expectedPid: number, targets: { name: string, expression: string }[],
 *   durationMs?: number, maxCalls?: number, maxStacks?: number, maxStackChars?: number }} options
 * @param {() => Promise<T>} during
 * @returns {Promise<{ value: T, trace: FunctionCallTrace,
 *   limits: { durationMs: number, maxCalls: number, maxStacks: number, maxStackChars: number } }>}
 */
export async function withFunctionCallTrace(client, {
  expectedPid, targets, durationMs = 10_000, maxCalls = 128, maxStacks = 4, maxStackChars = 2000,
}, during) {
  if (!Number.isInteger(expectedPid) || expectedPid <= 0) throw new TypeError('trace requires a positive expectedPid');
  for (const { name, value, cap } of [{ name: 'durationMs', value: durationMs, cap: 30_000 },
    { name: 'maxCalls', value: maxCalls, cap: 512 }, { name: 'maxStacks', value: maxStacks, cap: 8 },
    { name: 'maxStackChars', value: maxStackChars, cap: 4096 }]) {
    if (!Number.isInteger(value) || value <= 0 || value > cap) throw new TypeError(`invalid trace ${name}`);
  }
  if (!Array.isArray(targets) || !targets.length || targets.length > 8 ||
    new Set(targets.map(target => target.name)).size !== targets.length ||
    targets.some(target => !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(target.name) ||
      typeof target.expression !== 'string' || !target.expression.length || target.expression.length > 4096) ||
    typeof during !== 'function') throw new TypeError('invalid trace targets/body');
  await readProcessMemory(client, { expectedPid });
  const key = `__papercuspCdpTrace_${randomUUID()}`;
  const literal = JSON.stringify(key);
  const breakpointIds = [];
  let timer;
  let failure;
  let failed = false;
  /** @type {{ value: T, trace: FunctionCallTrace, limits: { durationMs: number, maxCalls: number, maxStacks: number, maxStackChars: number } } | undefined} */
  let outcome;
  try {
    await client.send('Debugger.enable');
    await client.evaluate(`globalThis[${literal}] = { pid: process.pid, startedAt: Date.now(),
      until: 0, total: 0, observerMs: 0,
      calls: Object.fromEntries(${JSON.stringify(targets.map(target => [target.name, { calls: 0, stacks: [] }]))}) }`);
    for (const target of targets) {
      const remote = await client.evaluate(target.expression, { objectGroup: key });
      if (remote.result?.type !== 'function' || !remote.result.objectId) throw new Error(`trace target is not a function: ${target.name}`);
      const condition = `(() => { const t = globalThis[${literal}];
        if (!t || Date.now() >= t.until || t.total >= ${maxCalls}) return false;
        const started = performance.now(), c = t.calls[${JSON.stringify(target.name)}];
        t.total++; c.calls++;
        if (c.stacks.length < ${maxStacks}) {
          const stack = String(new Error().stack).slice(0, ${maxStackChars});
          if (!c.stacks.includes(stack)) c.stacks.push(stack);
        }
        t.observerMs += performance.now() - started; return false; })()`;
      const result = await client.send('Debugger.setBreakpointOnFunctionCall', { objectId: remote.result.objectId, condition });
      if (!result.breakpointId) throw new Error(`trace breakpoint missing: ${target.name}`);
      breakpointIds.push(result.breakpointId);
    }
    await client.evaluate(`Object.assign(globalThis[${literal}], { startedAt: Date.now(), until: Date.now() + ${durationMs} })`);
    /** @type {Promise<never>} */
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`function trace exceeded ${durationMs}ms`)), durationMs);
    });
    const value = await Promise.race([Promise.resolve().then(during), expired]);
    const snapshot = await client.evaluate(`({ ...globalThis[${literal}], endedAt: Date.now(),
      limited: globalThis[${literal}].total >= ${maxCalls} })`, { returnByValue: true });
    outcome = { value, trace: snapshot.result.value, limits: { durationMs, maxCalls, maxStacks, maxStackChars } };
  } catch (error) { failed = true; failure = error; }
  finally {
    clearTimeout(timer);
    // Attempt every cleanup even when one request fails. Removing the target
    // root makes any surviving conditional breakpoint inert immediately.
    const cleanup = await Promise.allSettled([
      ...breakpointIds.map(breakpointId => client.send('Debugger.removeBreakpoint', { breakpointId })),
      client.evaluate(`delete globalThis[${literal}]`),
      client.send('Runtime.releaseObjectGroup', { objectGroup: key }),
    ]);
    const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(failed ? [failure, ...errors] : errors, 'function trace cleanup failed');
  }
  if (failed) throw failure;
  if (!outcome) throw new Error('function trace returned no measurement');
  return outcome;
}

function addListener(ws, event, handler) {
  if (typeof ws.on === 'function') {
    ws.on(event, handler);
    return;
  }
  ws.addEventListener(event, handler);
}

function addOnceListener(ws, event, handler) {
  if (typeof ws.once === 'function') {
    ws.once(event, handler);
    return;
  }
  const once = (...args) => {
    ws.removeEventListener?.(event, once);
    handler(...args);
  };
  ws.addEventListener(event, once);
}

function messageText(data) {
  if (typeof data === 'string') return data;
  if (data?.data !== undefined) return messageText(data.data);
  return data?.toString?.() ?? String(data);
}

function errorMessage(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Render an inspector/browser URL safely for diagnostic output.
 *
 * Debugger and browser WebSocket URLs can carry credentials or short-lived
 * access tokens in their query string. Diagnostics only need the endpoint
 * identity, so omit credentials, search parameters, and fragments entirely.
 * An unparseable value is not echoed because it may itself contain a secret.
 */
export function redactDiagnosticUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname || '/'}`;
  } catch {
    return '<unparseable-url>';
  }
}

/**
 * Create a small CDP client whose Runtime.evaluate path cannot mistake
 * `exceptionDetails` for a successful evaluation.
 * @template {CdpSocket} [Socket=WebSocket]
 * @param {string} wsUrl
 * @param {{ WebSocketImpl?: new (url: string, options: import('ws').ClientOptions) => Socket,
 *   webSocketOptions?: import('ws').ClientOptions, requestTimeoutMs?: number }} [options]
 */
export function createCdpClient(
  wsUrl,
  {
    WebSocketImpl = WebSocket,
    webSocketOptions = { maxPayload: 1024 * 1024 * 1024 },
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {},
) {
  const ws = new WebSocketImpl(wsUrl, webSocketOptions);
  let nextId = 0;
  let transportClosed = false;
  const pending = new Map();

  const rejectPending = (error) => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(error instanceof CdpTransportClosedError
        ? error
        : errorMessage(error));
    }
  };

  addListener(ws, 'message', (data) => {
    let message;
    try {
      message = JSON.parse(messageText(data));
    } catch (error) {
      rejectPending(error);
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new CdpProtocolError(request.method, message.error));
    else request.resolve(message.result);
  });

  addListener(ws, 'close', () => {
    transportClosed = true;
    rejectPending(new CdpTransportClosedError('CDP request'));
  });
  addListener(ws, 'error', (error) => {
    if (!transportClosed) rejectPending(error);
  });

  const connect = () => {
    if (ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      addOnceListener(ws, 'open', resolve);
      addOnceListener(ws, 'error', (error) => reject(errorMessage(error)));
      addOnceListener(ws, 'close', () => reject(new CdpTransportClosedError('connect')));
    });
  };

  const send = (method, params = {}, timeoutMs = requestTimeoutMs) => {
    if (transportClosed) return Promise.reject(new CdpTransportClosedError(method));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CdpRequestTimeoutError(method, timeoutMs));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(errorMessage(error));
      }
    });
  };

  const evaluate = async (expression, params = {}, timeoutMs = requestTimeoutMs) => {
    const result = await send('Runtime.evaluate', { expression, ...params }, timeoutMs);
    if (result?.exceptionDetails) {
      throw new CdpEvaluationError(expression, result.exceptionDetails);
    }
    return result;
  };

  const close = () => {
    if (transportClosed) return;
    transportClosed = true;
    try {
      ws.close();
    } catch {
      // The target may have already torn down the transport.
    }
  };

  return { ws, connect, send, evaluate, close };
}

/**
 * Find a Node inspector target and retain its port for post-close verification.
 * @param {{ startPort?: number, portCount?: number, fetchImpl?: InspectorFetch,
 *   requestTimeoutMs?: number }} [options]
 */
export async function discoverInspector({
  startPort = 9229,
  portCount = 6,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 1_500,
} = {}) {
  for (let port = startPort; port < startPort + portCount; port += 1) {
    try {
      const response = await fetchImpl(
        `http://127.0.0.1:${port}/json/list`,
        { signal: AbortSignal.timeout(requestTimeoutMs) },
      );
      if (!response.ok) continue;
      const list = await response.json();
      const target = list.find((entry) => entry.webSocketDebuggerUrl);
      if (target) return { port, wsUrl: target.webSocketDebuggerUrl };
    } catch {
      // Try the next candidate port.
    }
  }
  return null;
}

async function inspectorResponds(port, fetchImpl) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`);
    // A successful HTTP response proves that the inspector is still listening,
    // even if its target list happens to be empty during shutdown.
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * @param {number} port
 * @param {{ fetchImpl?: InspectorFetch, sleepImpl?: InspectorSleep,
 *   timeoutMs?: number, pollIntervalMs?: number }} [options]
 */
export async function waitForInspectorClosed(
  port,
  {
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_CLOSE_POLL_MS,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await inspectorResponds(port, fetchImpl))) return true;
    if (Date.now() >= deadline) break;
    await sleepImpl(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}

/**
 * Close the target inspector, then prove the listening port went away.
 * `_debugEnd()` tears down the CDP transport before its reply can arrive, so
 * transport close/timeout is expected; Runtime.evaluate exceptions are not.
 * @param {Pick<ReturnType<typeof createCdpClient>, 'evaluate' | 'close'>} client
 * @param {number} port
 * @param {{ evaluateTimeoutMs?: number, fetchImpl?: InspectorFetch,
 *   sleepImpl?: InspectorSleep, verifyTimeoutMs?: number, pollIntervalMs?: number }} [options]
 */
export async function closeInspector(
  client,
  port,
  {
    evaluateTimeoutMs = 1_000,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    verifyTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_CLOSE_POLL_MS,
  } = {},
) {
  let evaluationError = null;
  try {
    await client.evaluate('process._debugEnd()', { returnByValue: true }, evaluateTimeoutMs);
  } catch (error) {
    if (!(error instanceof CdpRequestTimeoutError) && !(error instanceof CdpTransportClosedError)) {
      evaluationError = errorMessage(error);
    }
  } finally {
    client.close();
  }

  const closed = await waitForInspectorClosed(port, {
    fetchImpl,
    sleepImpl,
    timeoutMs: verifyTimeoutMs,
    pollIntervalMs,
  });
  if (!closed) {
    const detail = evaluationError ? `; close expression failed: ${evaluationError.message}` : '';
    throw new Error(`inspector still open on port ${port} after close request${detail}`);
  }
  if (evaluationError) throw evaluationError;
  return { closed: true };
}
