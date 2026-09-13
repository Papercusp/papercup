/**
 * Probe whether a TCP port can be bound on a host without retaining the
 * listener. This is shared by the headless `serve` entrypoint and the Hono
 * host's pre-bootstrap guard so they use the same OS-level availability check.
 */
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';

/**
 * Return true when the operating system accepts a temporary bind for `port`.
 *
 * Port 0 is intentionally allowed: Node uses it to request an ephemeral port,
 * and callers that support that mode should retain the existing behavior.
 * Invalid numeric ports resolve false instead of leaving a probe promise
 * unresolved after a synchronous `listen()` validation error.
 */
export function portAvailable(port: number, host: string): Promise<boolean> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const probe = createServer();
    let settled = false;

    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      probe.removeListener('error', onError);
      if (probe.listening) {
        probe.close(() => resolve(available));
      } else {
        resolve(available);
      }
    };

    const onError = (): void => finish(false);

    probe.unref();
    probe.once('error', onError);
    try {
      probe.listen(port, host, () => finish(true));
    } catch {
      finish(false);
    }
  });
}

/**
 * Synchronous companion for entrypoints that must probe before importing a
 * large startup graph. The child owns the asynchronous bind/close lifecycle;
 * the caller blocks only for that tiny probe and receives the same OS-level
 * answer without a top-level await (which `tsx` compiles to CommonJS).
 */
export function portAvailableSync(port: number, host: string): boolean {
  if (!Number.isInteger(port) || port < 0 || port > 65535) return false;

  const probe = [
    "const net=require('node:net');",
    'const server=net.createServer();',
    "server.once('error',()=>process.exit(1));",
    `server.listen(${port}, ${JSON.stringify(host)}, () => server.close(() => process.exit(0)));`,
  ].join('');
  const result = spawnSync(process.execPath, ['-e', probe], { stdio: 'ignore' });
  return result.status === 0;
}
