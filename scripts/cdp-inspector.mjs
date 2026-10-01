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
