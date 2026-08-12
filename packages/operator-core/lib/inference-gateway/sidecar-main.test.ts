import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayLogLine } from './sidecar-main';

describe.sequential('gatewayLogLine bounded durable log', () => {
  const savedPath = process.env.PAPERCUSP_GATEWAY_LOG;
  const savedMaxBytes = process.env.PAPERCUSP_GATEWAY_LOG_MAX_BYTES;
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'papercusp-gateway-log-'));
    path = join(dir, 'gateway.log');
    process.env.PAPERCUSP_GATEWAY_LOG = path;
    process.env.PAPERCUSP_GATEWAY_LOG_MAX_BYTES = '1024';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env.PAPERCUSP_GATEWAY_LOG;
    else process.env.PAPERCUSP_GATEWAY_LOG = savedPath;
    if (savedMaxBytes === undefined) delete process.env.PAPERCUSP_GATEWAY_LOG_MAX_BYTES;
    else process.env.PAPERCUSP_GATEWAY_LOG_MAX_BYTES = savedMaxBytes;
  });

  it('rotates a bounded current segment before an append would cross the cap', () => {
    const previous = 'x'.repeat(1000);
    writeFileSync(path, previous);

    gatewayLogLine('rotation recurrence guard');

    expect(readFileSync(`${path}.1`, 'utf8')).toBe(previous);
    expect(readFileSync(path, 'utf8')).toContain('rotation recurrence guard');
    expect(statSync(path).size).toBeLessThanOrEqual(1024);
    expect(statSync(`${path}.1`).size).toBeLessThanOrEqual(1024);
  });

  it('self-heals a legacy runaway file without preserving it as an oversized backup', () => {
    writeFileSync(path, 'x'.repeat(4096));

    gatewayLogLine('legacy runaway recovery');

    expect(existsSync(`${path}.1`)).toBe(false);
    expect(readFileSync(path, 'utf8')).toContain('legacy runaway recovery');
    expect(statSync(path).size).toBeLessThanOrEqual(1024);
  });
});
