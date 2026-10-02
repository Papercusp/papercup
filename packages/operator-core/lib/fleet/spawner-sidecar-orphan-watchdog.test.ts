import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  armSpawnerSidecarOrphanWatchdog,
  ORPHAN_CHECK_INTERVAL_MS,
} from './spawner-sidecar-orphan-watchdog';

describe('spawner-sidecar owner-death watchdog (P-005)', () => {
  it('keeps the server alive for a live owner and shuts it down after owner death', () => {
    const callbacks: Array<() => void> = [];
    let ownerAlive = true;
    const schedule = vi.fn(
      (
        _name: string,
        _intervalMs: number,
        callback: () => void,
        _options: { category: 'watchdog'; classification: 'must-sample' },
      ) => callbacks.push(callback),
    );
    const shutdown = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn() };

    armSpawnerSidecarOrphanWatchdog(
      '/tmp/papercusp-spawner-49217.sock',
      shutdown,
      {
        isPidAlive: () => ownerAlive,
        schedule,
        logger,
      },
    );

    expect(schedule).toHaveBeenCalledWith(
      'spawner-sidecar-orphan-watchdog',
      ORPHAN_CHECK_INTERVAL_MS,
      expect.any(Function),
      { category: 'watchdog', classification: 'must-sample' },
    );
    expect(callbacks).toHaveLength(1);

    callbacks[0]!();
    expect(shutdown).not.toHaveBeenCalled();

    ownerAlive = false;
    callbacks[0]!();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('owner pid 49217 is gone'));
    expect(shutdown).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledWith('owner-gone');
  });

  it('does not arm against an explicit socket path with no derivable owner PID', () => {
    const schedule = vi.fn();
    const shutdown = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn() };

    armSpawnerSidecarOrphanWatchdog('/tmp/spawner.sock', shutdown, { schedule, logger });

    expect(schedule).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('orphan watchdog not armed'),
    );
  });

  it('remains wired into the shared DEV and PACKAGED server startup', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./spawner-sidecar-server.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('armSpawnerSidecarOrphanWatchdog(socketPath, shutdown)');
  });
});
