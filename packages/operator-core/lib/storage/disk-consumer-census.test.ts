/**
 * resolveCensusSudo — when the disk consumer census walks as root
 * (disk-headroom-standing-reclaim-2026-10-12 P-001, R-1; WI-6554700010008933).
 *
 * A stub `sudo` on a private PATH stands in for the real binary, so the default
 * probe (`sudo -n true`) runs for real without needing real privilege.
 */
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, promises as fsp, rmSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measureDocker, resolveCensusSudo } from './disk-consumer-census';

vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  request: vi.fn(),
}));

const isRoot = process.getuid?.() === 0;

describe('resolveCensusSudo', () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'census-sudo-'));
    savedPath = process.env.PATH;
    process.env.PATH = dir;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  function stubSudo(exitCode: number): string {
    const bin = join(dir, 'sudo');
    writeFileSync(bin, `#!/bin/sh\n[ "$1" = "-n" ] || exit 9\nexit ${exitCode}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  it.skipIf(isRoot)('returns the sudo binary when `sudo -n true` succeeds', async () => {
    const bin = stubSudo(0);
    expect(await resolveCensusSudo()).toBe(bin);
  });

  it.skipIf(isRoot)('falls back to an unprivileged walk when sudo needs a password or is refused', async () => {
    // `sudo -n` exits 1 instead of prompting when no NOPASSWD rule applies (or under NoNewPrivileges).
    stubSudo(1);
    expect(await resolveCensusSudo()).toBeNull();
  });

  it.skipIf(isRoot)('does not probe when sudo is not installed', async () => {
    const probe = vi.fn(async () => true);
    expect(await resolveCensusSudo(probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('never elevates a process that is already root', async () => {
    stubSudo(0);
    const probe = vi.fn(async () => true);
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      expect(await resolveCensusSudo(probe)).toBeNull();
      expect(probe).not.toHaveBeenCalled();
    } finally {
      getuid.mockRestore();
    }
  });
});

describe('measureDocker response deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(fsp, 'access').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(request).mockReset();
  });

  // The engine's disk-usage walk can legitimately exceed 20 seconds. Model the
  // HTTP client's timeout and a delayed response independently of the reader.
  function engineWithDiskUsageDelay(delayMs: number): void {
    vi.mocked(request).mockImplementation((options, onResponse) => {
      const opts = options as RequestOptions;
      const req = new EventEmitter();
      let responseTimer: ReturnType<typeof setTimeout>;
      let deadlineTimer: ReturnType<typeof setTimeout>;
      Object.assign(req, {
        end() {
          deadlineTimer = setTimeout(() => req.emit('timeout'), Number(opts.timeout));
          responseTimer = setTimeout(() => {
            clearTimeout(deadlineTimer);
            const res = new EventEmitter();
            Object.assign(res, { statusCode: 200, setEncoding() {} });
            (onResponse as unknown as ((res: IncomingMessage) => void) | undefined)?.(res as IncomingMessage);
            res.emit('data', JSON.stringify(opts.path === '/info'
              ? { DockerRootDir: '/fixture/docker' }
              : {
                  LayersSize: 64,
                  Containers: [{ SizeRw: 2 }, { SizeRw: 3 }],
                  Volumes: [{ UsageData: { Size: 80 } }],
                  BuildCache: [{ Size: 7 }],
                }));
            res.emit('end');
          }, opts.path === '/info' ? 0 : delayMs);
        },
        destroy(error: Error) {
          clearTimeout(responseTimer);
          clearTimeout(deadlineTimer);
          req.emit('error', error);
        },
      });
      return req as ClientRequest;
    });
  }

  it('accepts a valid Docker disk-usage response after the old 20-second diagnostic cutoff', async () => {
    engineWithDiskUsageDelay(25_000);
    const result = measureDocker();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await result).toEqual({
      kind: 'docker',
      rootDir: '/fixture/docker',
      parts: [
        { consumer: 'docker:images', bytes: 64 },
        { consumer: 'docker:containers', bytes: 5 },
        { consumer: 'docker:volumes', bytes: 80 },
        { consumer: 'docker:build-cache', bytes: 7 },
      ],
    });
  });

  it('reports an explicit short deadline as a timeout rather than an empty inventory', async () => {
    engineWithDiskUsageDelay(25_000);
    const result = expect(measureDocker(20_000)).rejects.toThrow('docker /system/df timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await result;
  });

  it('still bounds an unresponsive engine with the maintained default deadline', async () => {
    engineWithDiskUsageDelay(200_000);
    const result = expect(measureDocker()).rejects.toThrow('docker /system/df timed out');
    await vi.advanceTimersByTimeAsync(180_000);
    await result;
  });
});
