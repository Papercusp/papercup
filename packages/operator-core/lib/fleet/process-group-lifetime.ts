import type { ChildProcess } from 'node:child_process';

/** Shared exit fence for the sidecar and local Git runners. The caller owns a
 * referenced child spawned with detached:true on POSIX, retains its deadline
 * and escalation until this fence completes, and calls waitForExit after close.
 * This is extracted from execProcess so local execution uses the same proof
 * without importing the sidecar's admission/runtime dependencies. */
export function processGroupLifetime(child: ChildProcess, report: (message: string) => void) {
  const group = process.platform !== 'win32' ? child.pid : undefined;
  return {
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
    async waitForExit(): Promise<void> {
      if (group === undefined) return;
      // A successful parent can close its pipes while helpers still run. A
      // deadline or an unsuccessful probe must never manufacture an exit receipt.
      let probeFailureReported = false;
      for (;;) {
        try {
          process.kill(-group, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
          if (!probeFailureReported) {
            report(`process-group exit unverified: ${String(error)}`);
            probeFailureReported = true;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}
