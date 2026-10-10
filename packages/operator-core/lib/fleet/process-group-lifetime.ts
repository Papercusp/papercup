import type { ChildProcess } from 'node:child_process';
import { pinModuleState } from '@papercusp/module-singleton';

// The operator's normal shutdown does not await individual routine promises.
// Keep exact live groups enrolled until their exit fence, so a host replacement
// cannot leave a bulk fetch writing after the old host has gone away.
const shutdownGroups = pinModuleState('operator-core.process-group-lifetime.shutdown', () => {
  const groups = new Set<(signal: NodeJS.Signals) => void>();
  const signalAll = (signal: NodeJS.Signals): void => {
    for (const stop of groups) stop(signal);
  };
  process.on('exit', () => signalAll('SIGKILL'));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const stop = (): void => {
      signalAll('SIGTERM');
      if (process.listenerCount(signal) === 1) {
        // Preserve Node's default termination when no host owns a graceful
        // shutdown handler. Installing a cleanup listener must not keep it alive.
        signalAll('SIGKILL');
        process.removeListener(signal, stop);
        process.kill(process.pid, signal);
      } else {
        const escalation = setTimeout(() => signalAll('SIGKILL'), 2_000);
        escalation.unref?.();
      }
    };
    process.on(signal, stop);
  }
  return groups;
});

/** Shared exit fence for the sidecar and local Git runners. The caller owns a
 * referenced child spawned with detached:true on POSIX, retains its deadline
 * and escalation until this fence completes, and calls waitForExit after close.
 * This is extracted from execProcess so local execution uses the same proof
 * without importing the sidecar's admission/runtime dependencies. */
export function processGroupLifetime(child: ChildProcess, report: (message: string) => void) {
  const group = process.platform !== 'win32' ? child.pid : undefined;
  const lifetime = {
    signal(signal: NodeJS.Signals): void {
      try {
        if (group === undefined) child.kill(signal);
        else process.kill(-group, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          report(`process-group ${signal} failed: ${String(error)}`);
        }
      }
    },
    async waitForExit(options: { timeoutMs?: number } = {}): Promise<void> {
      if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
        throw new Error('process-group exit deadline must be a positive safe integer');
      }
      const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
      if (group === undefined) {
        while (child.exitCode === null && child.signalCode === null) {
          if (Date.now() >= deadline) throw new Error('child exit unverified before deadline');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        shutdownGroups.delete(lifetime.signal);
        return;
      }
      // A successful parent can close its pipes while helpers still run. A
      // deadline or an unsuccessful probe must never manufacture an exit receipt.
      let probeFailureReported = false;
      for (;;) {
        try {
          process.kill(-group, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            shutdownGroups.delete(lifetime.signal);
            return;
          }
          if (!probeFailureReported) {
            report(`process-group exit unverified: ${String(error)}`);
            probeFailureReported = true;
          }
        }
        if (Date.now() >= deadline) throw new Error(`process-group ${group} exit unverified before deadline`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    /** Keep escalation and the exit fence alive even after the leader exits. */
    async terminate(options: { graceMs?: number; killWaitMs?: number } = {}): Promise<void> {
      const graceMs = options.graceMs ?? 5_000;
      const killWaitMs = options.killWaitMs ?? 5_000;
      if (![graceMs, killWaitMs, graceMs + killWaitMs].every(ms => Number.isSafeInteger(ms) && ms > 0)) {
        throw new Error('process-group termination deadlines must be positive safe integers');
      }
      lifetime.signal('SIGTERM');
      const escalation = setTimeout(() => lifetime.signal('SIGKILL'), graceMs);
      try { await lifetime.waitForExit({ timeoutMs: graceMs + killWaitMs }); }
      finally { clearTimeout(escalation); }
    },
  };
  if (child.pid !== undefined) shutdownGroups.add(lifetime.signal);
  return lifetime;
}
