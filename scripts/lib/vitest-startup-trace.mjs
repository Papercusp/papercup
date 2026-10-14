/** Passive, bounded diagnostics for Vitest's real forks lifecycle protocol. */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';

export function loaderIdentity(value = '') {
  const text = String(value);
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
    // Never print option values: paths/URLs can contain credentials.
    switches: [...new Set(text.match(/--(?:import|loader|experimental-loader|require|conditions)(?=[=\s]|$)|(?:^|\s)-r(?=[=\s]|$)/g) ?? [])].map(s => s.trim()),
  };
}

export function startupTraceEnv(env = process.env) {
  // A timeout cannot enable a preload retroactively. Keep the bounded lifecycle
  // trace in the router's existing captured stderr unless explicitly disabled.
  if (env.PAPERCUSP_TEST_STARTUP_TRACE === '0') return env;
  const preload = `--import=${JSON.stringify(new URL('./vitest-startup-trace.mjs', import.meta.url).href)}`;
  const options = env.NODE_OPTIONS ?? '';
  return { ...env, PAPERCUSP_TEST_STARTUP_TRACE: '1',
    NODE_OPTIONS: options.includes(preload) ? options : `${options} ${preload}`.trim() };
}

/**
 * @param {any} child - a forked child process (its `send` is wrapped in place).
 * @param {(row: Record<string, unknown>) => void} emit - receives one diagnostic row per startup event.
 * @param {() => number} [now]
 * @returns {() => void} stops observing.
 */
export function observeForkStartup(child, emit, now = () => performance.now()) {
  const origin = now();
  const originalSend = child.send;
  const originalKill = child.kill;
  let closed = false;
  let start = null;
  let stop = null;
  let seenStarted = false;
  let seenStopped = false;
  const record = (event, fields = {}) => {
    try { emit({ event, childPid: child.pid, elapsedMs: Math.round(now() - origin), ...fields }); }
    catch { /* A passive observer must not change the runner's IPC or signals. */ }
  };
  child.send = function(message, ...args) {
    if (message?.type === 'start' && start === null) {
      start = now();
      record('start-sent');
    }
    if (message?.type === 'stop' && stop === null) {
      stop = now();
      record('stop-sent');
    }
    return originalSend.call(this, message, ...args);
  };
  if (typeof originalKill === 'function') {
    child.kill = function(signal, ...args) {
      const sent = originalKill.call(this, signal, ...args);
      record('worker-signal', { signal: signal ?? 'SIGTERM', sent });
      return sent;
    };
  }
  const onMessage = message => {
    if (message?.type === 'started' && !seenStarted) {
      seenStarted = true;
      record('started-received', { startupMs: start === null ? null : Math.round(now() - start), error: Boolean(message.error) });
    }
    if (message?.type === 'stopped' && !seenStopped) {
      seenStopped = true;
      record('stopped-received', { stopMs: stop === null ? null : Math.round(now() - stop), error: Boolean(message.error) });
    }
  };
  const onExit = (code, signal) => record('worker-exit', { code, signal, started: seenStarted });
  const onDisconnect = () => record('worker-disconnect');
  const cleanup = () => {
    if (closed) return;
    closed = true;
    child.send = originalSend;
    if (typeof originalKill === 'function') child.kill = originalKill;
    child.removeListener('message', onMessage);
    child.removeListener('exit', onExit);
    child.removeListener('disconnect', onDisconnect);
    child.removeListener('close', onClose);
  };
  const onClose = (code, signal) => { record('worker-close', { code, signal }); cleanup(); };
  child.on('message', onMessage);
  child.once('exit', onExit);
  child.once('disconnect', onDisconnect);
  child.once('close', onClose);
  return cleanup;
}

// No clients, intervals, or extra processes: existing runner shutdown owns the
// process group. This preload only observes IPC; it never changes the payload.
function isVitestEntry(value) {
  const entry = String(value ?? '').replaceAll('\\', '/');
  return /(?:^|\/)(?:vitest\/(?:vitest\.mjs|dist\/(?:workers\/[^/]+|worker)\.[cm]?js)|\.bin\/vitest)$/.test(entry);
}

const traceMode = process.env.PAPERCUSP_TEST_STARTUP_TRACE;
if (traceMode === '1' || (traceMode === 'vitest-descendant'
    && isVitestEntry(process.argv[1]))) {
  // startupTraceEnv explicitly selects a root (including generic diagnostic
  // fixtures). Its descendants retain the preload and all source/admission
  // guards, but ordinary Node payloads must not receive diagnostic stderr.
  process.env.PAPERCUSP_TEST_STARTUP_TRACE = 'vitest-descendant';
  let remainingStartup = 24;
  let remainingShutdown = 24;
  const emit = row => {
    // Startup traffic cannot exhaust the evidence needed for a later stop hang.
    const shutdown = ['stop-sent', 'stopped-received', 'worker-signal',
      'worker-exit', 'worker-disconnect', 'worker-close'].includes(row.event);
    if (shutdown ? remainingShutdown-- <= 0 : remainingStartup-- <= 0) return;
    try { process.stderr.write(`TEST_FILE_STARTUP_TRACE ${JSON.stringify({ pid: process.pid, ...row })}\n`); } catch { /* diagnostics cannot break execution */ }
  };
  emit({ event: 'node-loaded', nodeOptions: loaderIdentity(process.env.NODE_OPTIONS), execArgv: loaderIdentity(process.execArgv.join(' ')) });
  const originalFork = childProcess.fork;
  childProcess.fork = function(modulePath, ...args) {
    const child = originalFork.call(this, modulePath, ...args);
    if (isVitestEntry(modulePath)) {
      emit({ event: 'worker-forked', childPid: child.pid });
      observeForkStartup(child, emit);
    }
    return child;
  };
  syncBuiltinESMExports();
}
