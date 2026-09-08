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
    expect(watchdog).toContain('http://127.0.0.1:3384/healthz');
    expect(watchdog).toContain('.ok == true');
    expect(watchdog).toContain('.workers.embedder.alive == true');
    expect(watchdog).toContain('.queue.saturated == true');
    expect(watchdog).toContain('.queue.depth > 0');
    expect(watchdog).toContain('deferring restart');
    expect(watchdog).toContain('embed worker probe failed — restarting papercup-embed-sidecar');
    expect(watchdog).not.toContain("|| { echo 'embed worker probe failed — restarting");
  });

  it('keeps the JSON payload quoted through systemd and bash parsing', () => {
    const watchdog = readFileSync(WATCHDOG_UNIT, 'utf8');
    const dataLine = watchdog.split('\n').find((line) => line.includes('--data-binary'));
    const jqLine = watchdog.split('\n').find((line) => line.includes('| jq -e'));

    // systemd consumes the \\\" escapes while building bash's -c argument. The
    // resulting shell command must still use single quotes around JSON; putting
    // the payload in a double-quoted systemd argument makes those quotes vanish
    // before bash parses it and turns a valid request into HTTP 400.
    expect(dataLine).toMatch(
      /--data-binary '\{\\"model\\":\\"gemma\\",\\"kind\\":\\"query\\",\\"texts\\":\[\\"papercup-embed-sidecar-watchdog\\"\],\\"bypassCache\\":true\}'/,
    );
    expect(dataLine).not.toMatch(/--data-binary "\{\\"model/);
    expect(jqLine).toMatch(/\| jq -e '/);
    expect(jqLine).not.toMatch(/\| jq -e "/);
  });
});
