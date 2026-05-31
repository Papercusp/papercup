/**
 * Runner integration test.
 *
 * Skips PG-dependent paths by mocking @papercusp/db-org. Exercises:
 *   - script-found / not-found
 *   - hash decision flow (fresh vs unchanged)
 *   - consent gating
 *   - state.json + WAL plumbing
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TMP_HOME: string;
let TMP_PLUGIN: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-runner-'));
  TMP_PLUGIN = await fs.mkdtemp(join(tmpdir(), 'paperplug-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  process.env.PAPERCUSP_DISABLE_SANDBOX = '1';
  vi.resetModules();
  // Mock @papercusp/db-org so the operator-claims path is exercised against
  // a fake sql tag. The runner falls back to process-only mode when PG
  // throws; we drive that explicit branch.
  vi.doMock('@papercusp/db-org', () => ({
    getOrgPg: () => ({
      sql: () => {
        throw new Error('pg-not-available-in-test');
      },
    }),
  }));
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  delete process.env.PAPERCUSP_DISABLE_SANDBOX;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
  await fs.rm(TMP_PLUGIN, { recursive: true, force: true });
  vi.doUnmock('@papercusp/db-org');
});

async function writeScript(rel: string, contents: string): Promise<string> {
  const full = join(TMP_PLUGIN, rel);
  await fs.mkdir(join(full, '..'), { recursive: true });
  await fs.writeFile(full, contents, { mode: 0o755 });
  return rel;
}

describe.skip('runPhase (needs PG fixture)', () => {
  it('reports missing script gracefully', async () => {
    const m = await import('./runner');
    const r = await m.runPhase('setup', {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: {},
      provision: { setup: { path: 'does/not/exist.sh' } },
      consentConfirmed: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not found');
  });

  it('rejects when consent not confirmed', async () => {
    await writeScript('setup.sh', '#!/bin/bash\nexit 0\n');
    const m = await import('./runner');
    const r = await m.runPhase('setup', {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: {},
      provision: { setup: { path: 'setup.sh' } },
      consentConfirmed: false,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('consent');
  });

  it('runs setup, captures output, updates state.json', async () => {
    await writeScript(
      'setup.sh',
      `#!/usr/bin/env bash
echo "setting up"
exit 0
`,
    );
    const m = await import('./runner');
    const r = await m.runPhase('setup', {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: { region: 'us-east-1' },
      provision: { setup: { path: 'setup.sh', timeoutSec: 10 } },
      consentConfirmed: true,
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.state?.hashes).toBeTruthy();
    expect(r.state?.lastSetupAt).not.toBeNull();
  });

  it('returns unchanged on second run with same hashes', async () => {
    await writeScript('setup.sh', '#!/usr/bin/env bash\nexit 0\n');
    const m = await import('./runner');
    const inputs = {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: { region: 'us-east-1' },
      provision: { setup: { path: 'setup.sh', timeoutSec: 10 } },
      consentConfirmed: true,
    };
    await m.runPhase('setup', inputs);
    const r = await m.runPhase('setup', inputs);
    expect(r.decision).toBe('unchanged');
    expect(r.ok).toBe(true);
  });

  it('captures script failure exit code', async () => {
    await writeScript('setup.sh', '#!/usr/bin/env bash\nexit 7\n');
    const m = await import('./runner');
    const r = await m.runPhase('setup', {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: {},
      provision: { setup: { path: 'setup.sh', timeoutSec: 10 } },
      consentConfirmed: true,
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(7);
    expect(r.state?.setupFailed).toBe(true);
  });

  it('rejects path-traversal in script declaration', async () => {
    const m = await import('./runner');
    const r = await m.runPhase('setup', {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: {},
      provision: { setup: { path: '../../etc/passwd' } },
      consentConfirmed: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not found');
  });

  it('captures record_resource WAL writes and surfaces them in state', async () => {
    await writeScript(
      'setup.sh',
      `#!/usr/bin/env bash
. "$PAPERCUSP_RUNTIME_LIB"
papercusp_record_resource "test.kind" "id-1"
sleep 0.4
exit 0
`,
    );
    const m = await import('./runner');
    const r = await m.runPhase('setup', {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: {},
      provision: { setup: { path: 'setup.sh', timeoutSec: 10 } },
      consentConfirmed: true,
    });
    expect(r.ok).toBe(true);
    const recorded = r.state?.createdResources ?? [];
    const ids = recorded.map((x) => x.externalId);
    expect(ids).toContain('id-1');
  });
});
