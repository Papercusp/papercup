import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SYSTEMD_DIR = resolve(__dirname, '..', 'systemd');
const SIDECAR_UNIT = resolve(SYSTEMD_DIR, 'papercup-embed-sidecar.service');
const WATCHDOG_UNIT = resolve(SYSTEMD_DIR, 'papercup-embed-sidecar-watchdog.service');

describe('embed sidecar pressure supervision contract', () => {
  it('bounds sidecar memory and turns an OOM into a restartable unit failure', () => {
    const unit = readFileSync(SIDECAR_UNIT, 'utf8');

    expect(unit).toContain('MemoryAccounting=yes');
    expect(unit).toContain('MemoryHigh=8G');
    expect(unit).toContain('MemoryMax=12G');
    expect(unit).toContain('MemorySwapMax=0');
    expect(unit).toContain('OOMPolicy=kill');
    expect(unit).toContain('Restart=always');
  });

  it('probes the worker path with cache bypass and validates the response accounting', () => {
    const watchdog = readFileSync(WATCHDOG_UNIT, 'utf8');

    expect(watchdog).toContain('http://127.0.0.1:3384/embed');
    expect(watchdog).toContain('set -o pipefail');
    expect(watchdog).toContain('bypassCache');
    expect(watchdog).toContain('vectors');
    expect(watchdog).toContain('.cache');
    expect(watchdog).toContain('.hits == 0');
    expect(watchdog).toContain('.coalesced == 0');
    expect(watchdog).toContain('.inferred == 1');
    expect(watchdog).toContain('systemctl --user restart papercup-embed-sidecar.service');
    expect(watchdog).not.toContain('/healthz');
  });
});
