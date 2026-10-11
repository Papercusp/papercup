/** Passive, bounded diagnostics for Vitest's real forks startup protocol. */
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

export function startupTraceEnv(env) {
  if (env?.PAPERCUSP_TEST_STARTUP_TRACE !== '1') return env;
  const preload = `--import=${JSON.stringify(new URL('./vitest-startup-trace.mjs', import.meta.url).href)}`;
  return { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} ${preload}`.trim() };
}

export function observeForkStartup(child, emit, now = () => performance.now()) {
  const origin = now();
  const originalSend = child.send;
  let closed = false;
  let start = null;
  let seenStarted = false;
  const record = (event, fields = {}) => emit({ event, elapsedMs: Math.round(now() - origin), ...fields });
  child.send = function(message, ...args) {
    if (message?.type === 'start' && start === null) {
      start = now();
      record('start-sent');
    }
    return originalSend.call(this, message, ...args);
  };
  const onMessage = message => {
    if (message?.type === 'started' && !seenStarted) {
      seenStarted = true;
      record('started-received', { startupMs: start === null ? null : Math.round(now() - start), error: Boolean(message.error) });
    }
  };
  const onExit = (code, signal) => record('worker-exit', { code, signal, started: seenStarted });
  const cleanup = () => {
    if (closed) return;
    closed = true;
    child.send = originalSend;
    child.removeListener('message', onMessage);
    child.removeListener('exit', onExit);
    child.removeListener('close', cleanup);
  };
  child.on('message', onMessage);
  child.once('exit', onExit);
  child.once('close', cleanup);
  return cleanup;
}

// No clients, intervals, or extra processes: existing runner shutdown owns the
// process group. This preload only observes IPC; it never changes the payload.
if (process.env.PAPERCUSP_TEST_STARTUP_TRACE === '1') {
  let remaining = 24;
  const emit = row => {
    if (remaining-- <= 0) return;
    try { process.stderr.write(`TEST_FILE_STARTUP_TRACE ${JSON.stringify({ pid: process.pid, ...row })}\n`); } catch { /* diagnostics cannot break execution */ }
  };
  emit({ event: 'node-loaded', nodeOptions: loaderIdentity(process.env.NODE_OPTIONS), execArgv: loaderIdentity(process.execArgv.join(' ')) });
  const originalFork = childProcess.fork;
  childProcess.fork = function(modulePath, ...args) {
    const child = originalFork.call(this, modulePath, ...args);
    if (String(modulePath).includes('vitest')) {
      emit({ event: 'worker-forked', childPid: child.pid });
      observeForkStartup(child, emit);
    }
    return child;
  };
  syncBuiltinESMExports();
}
