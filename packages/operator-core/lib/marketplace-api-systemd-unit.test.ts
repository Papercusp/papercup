/**
 * The marketplace API's development watcher survives a crashed server child.
 * A systemd unit that launches `npm run dev` therefore looks active while
 * :3057 is dark. Keep the supervised entry point on the non-watching script.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const unit = readFileSync(
  new URL('../../../apps/operator/scripts/systemd/marketplace-api.service', import.meta.url),
  'utf8',
);

describe('marketplace-api systemd unit', () => {
  it('supervises the non-watching start script', () => {
    const execStart = unit.split('\n').find((line) => line.startsWith('ExecStart='));
    expect(execStart).toBe("ExecStart=/bin/bash -c 'exec /home/linuxbrew/.linuxbrew/bin/npm start'");
    expect(execStart).not.toMatch(/npm run dev|tsx watch/);
  });

  it('rate-limits real process failures', () => {
    expect(unit).toMatch(/\[Unit\][\s\S]*StartLimitIntervalSec=300[\s\S]*StartLimitBurst=5/);
    expect(unit).toMatch(/\[Service\][\s\S]*Restart=on-failure[\s\S]*RestartSec=3/);
  });
});
