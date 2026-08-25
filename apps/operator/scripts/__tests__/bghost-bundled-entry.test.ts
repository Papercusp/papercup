import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPTS_DIR = join(__dirname, '..');
const BUNDLE_HOST = join(SCRIPTS_DIR, '..', 'bin', 'bundle-host.sh');
const DROP_IN = join(SCRIPTS_DIR, 'systemd', 'papercup-bg-host.service.d', '95-bundled-entry.conf');
const README = join(SCRIPTS_DIR, 'systemd', 'README.md');

describe('papercup-bg-host bundled-entry systemd contract (EI-21434335931587523)', () => {
  const bundleHost = readFileSync(BUNDLE_HOST, 'utf8');
  const dropIn = readFileSync(DROP_IN, 'utf8');
  const readme = readFileSync(README, 'utf8');

  it('keeps the bundle-host consumer map aligned with the installed bg-host drop-in', () => {
    expect(bundleHost).toContain(':3271 bg-host');
    expect(bundleHost).toContain('95-bundled-entry.conf');
    expect(bundleHost).not.toContain('has NO ExecStartPre');
    expect(bundleHost).not.toContain('missing drop-in is filed separately');
    expect(bundleHost).not.toContain('(:3270 bg-host');
  });

  it('resets the base ExecStart, bundles first, and preserves the inline runtime environment', () => {
    const serviceLines = dropIn.split('\n').map((line) => line.trim());
    const execLines = serviceLines.filter((line) => line.startsWith('ExecStart'));

    expect(execLines).toEqual([
      `ExecStartPre=${BUNDLE_HOST}`,
      'ExecStart=',
      'ExecStart=/usr/bin/bash -c "set -a; [ -f .env.local ] && . ./.env.local; set +a; exec env \\',
    ]);
    expect(dropIn.indexOf('ExecStartPre=')).toBeLessThan(dropIn.indexOf('ExecStart=\n'));
    expect(dropIn.indexOf('ExecStart=\n')).toBeLessThan(dropIn.indexOf('ExecStart=/usr/bin/bash'));
    expect(dropIn).toContain('node dist-host/hono-host.mjs"');
    expect(dropIn).not.toContain('npx tsx bin/hono-host.ts');
    expect(dropIn).not.toMatch(/^Environment=/m);

    for (const assignment of [
      'PAPERCUSP_HONO_PORT=3271',
      'PAPERCUSP_BIND_HOST=127.0.0.1',
      'PAPERCUSP_BACKGROUND_WORKERS=1',
      'PAPERCUSP_DBOS_ENABLE=1',
      'PAPERCUSP_DBOS_ORCHESTRATOR=1',
      'PAPERCUSP_DBOS_ROUTINES=1',
      'PAPERCUSP_DBOS_TIMERS=1',
      'PAPERCUSP_DBOS_AUTOLOOP=0',
      'PAPERCUSP_DB_POOL_MAX=24',
      'DB_IDLE_TIMEOUT=10',
      'PAPERCUSP_EXPECTED_OPERATOR_PROCS=6',
      'DBOS__VMID=bg-host-3270',
      'DBOS__APPVERSION=bg-host-v1',
    ]) {
      expect(dropIn).toContain(`  ${assignment} \\`);
    }
  });

  it('documents the canonical symlink installation without restarting bg-host', () => {
    expect(readme).toContain('papercup-bg-host.service.d/95-bundled-entry.conf');
    expect(readme).toMatch(/mkdir -p ~\/\.config\/systemd\/user\/papercup-bg-host\.service\.d/);
    expect(readme).toMatch(/ln -sfn "\$\(pwd\)\/papercup-bg-host\.service\.d\/95-bundled-entry\.conf"/);
    expect(readme).toContain('systemctl --user daemon-reload');
    expect(readme).toMatch(/Do not restart bg-host\s+as part of this installation/);
  });
});
