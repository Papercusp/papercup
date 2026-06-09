/**
 * Tests for buildConsentSummary's runtime-availability gating
 * (rev3 plan G+3 / A9 fix).
 *
 * Per the design boundary, runtime requirement is read from the
 * INSTALLED plugin's manifest at consent time — NOT from the snapshot.
 * Tests stage local plugins with explicit runtime fields under a
 * tempdir + PAPERCUSP_HOME, then run the consent summary against
 * different RuntimeAvailability shapes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ALL_RUNTIMES_AVAILABLE,
  buildConsentSummary,
  type RuntimeAvailability,
} from './plugin-reenable';
import type { SnapshotPlugin, SnapshotPluginRuntime } from './manifest';

const STAGED_HOME = join(
  tmpdir(),
  `papercusp-reenable-test-${process.pid}-${Date.now()}`,
);
const ORIGINAL_HOME = process.env.PAPERCUSP_HOME;

async function stageInstalledPlugin(opts: {
  name: string;
  version: string;
  capabilities?: string[];
  runtime?: SnapshotPluginRuntime;
}): Promise<void> {
  const dir = join(STAGED_HOME, 'global-plugins', opts.name);
  await fs.mkdir(dir, { recursive: true });
  const manifest: Record<string, unknown> = {
    name: opts.name,
    version: opts.version,
    capabilities: opts.capabilities ?? [],
  };
  if (opts.runtime !== undefined) manifest.runtime = opts.runtime;
  await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify(manifest));
}

function snapshotEntry(opts: {
  name: string;
  version?: string;
  capabilities?: string[];
  runtime?: SnapshotPluginRuntime;
}): SnapshotPlugin {
  return {
    name: opts.name,
    version: opts.version ?? '1.0.0',
    capabilities: opts.capabilities ?? [],
    configJson: '{}',
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
  };
}

beforeAll(() => {
  process.env.PAPERCUSP_HOME = STAGED_HOME;
});

afterAll(async () => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.PAPERCUSP_HOME;
  } else {
    process.env.PAPERCUSP_HOME = ORIGINAL_HOME;
  }
  await fs.rm(STAGED_HOME, { recursive: true, force: true });
});

describe('buildConsentSummary — runtime availability gating (G+3)', () => {
  it('default availability (all true) admits every installed plugin', async () => {
    await stageInstalledPlugin({
      name: 'plugin-default-runtime',
      version: '1.0.0',
      runtime: 'wasm',
    });
    const summary = await buildConsentSummary([
      snapshotEntry({ name: 'plugin-default-runtime' }),
    ]);
    expect(summary.skipped).toEqual([]);
    expect(summary.plugins.map((p) => p.name)).toContain('plugin-default-runtime');
  });

  it('plugin requiring WASM is skipped when host has wasm:false', async () => {
    await stageInstalledPlugin({
      name: 'plugin-wasm-only',
      version: '2.1.0',
      runtime: 'wasm',
    });
    const noWasm: RuntimeAvailability = { js: true, wasm: false, daemon: true };
    const summary = await buildConsentSummary(
      [snapshotEntry({ name: 'plugin-wasm-only' })],
      noWasm,
    );
    expect(summary.plugins).toEqual([]);
    expect(summary.skipped).toEqual([
      {
        name: 'plugin-wasm-only',
        version: '2.1.0',
        requiredRuntime: 'wasm',
        reason: 'runtime-not-available',
      },
    ]);
  });

  it('plugin requiring daemon is skipped when host has daemon:false', async () => {
    await stageInstalledPlugin({
      name: 'plugin-daemon-only',
      version: '0.5.0',
      runtime: 'daemon',
    });
    const noDaemon: RuntimeAvailability = { js: true, wasm: true, daemon: false };
    const summary = await buildConsentSummary(
      [snapshotEntry({ name: 'plugin-daemon-only' })],
      noDaemon,
    );
    expect(summary.skipped[0]?.requiredRuntime).toBe('daemon');
  });

  it("installed plugin with no `runtime` field defaults to 'js' (legacy back-compat)", async () => {
    await stageInstalledPlugin({
      name: 'plugin-legacy-no-runtime',
      version: '1.0.0',
      // runtime omitted on purpose — pre-G plugins didn't declare
    });
    const noJs: RuntimeAvailability = { js: false, wasm: true, daemon: true };
    const summary = await buildConsentSummary(
      [snapshotEntry({ name: 'plugin-legacy-no-runtime' })],
      noJs,
    );
    // Should be skipped because JS unavailable + legacy default = 'js'
    expect(summary.skipped[0]?.requiredRuntime).toBe('js');
  });

  it('snapshot.runtime is IGNORED — installed manifest is the source of truth', async () => {
    // Local manifest says 'js'; snapshot claims 'wasm'. Per A9 fix the
    // snapshot's claim is advisory only — host satisfies based on
    // local manifest. With wasm:false, plugin should still admit
    // because local manifest says js.
    await stageInstalledPlugin({
      name: 'plugin-rebadged',
      version: '3.0.0',
      runtime: 'js',
    });
    const noWasm: RuntimeAvailability = { js: true, wasm: false, daemon: true };
    const summary = await buildConsentSummary(
      [
        // Snapshot LIES: claims it was captured against a wasm runtime.
        snapshotEntry({ name: 'plugin-rebadged', runtime: 'wasm' }),
      ],
      noWasm,
    );
    expect(summary.skipped).toEqual([]);
    expect(summary.plugins.map((p) => p.name)).toContain('plugin-rebadged');
  });

  it('mixed snapshot: some skipped, some admitted, some missing', async () => {
    await stageInstalledPlugin({
      name: 'plugin-mix-js',
      version: '1.0.0',
      runtime: 'js',
    });
    await stageInstalledPlugin({
      name: 'plugin-mix-wasm',
      version: '1.0.0',
      runtime: 'wasm',
    });
    // plugin-mix-missing is NOT staged.
    const noWasm: RuntimeAvailability = { js: true, wasm: false, daemon: true };
    const summary = await buildConsentSummary(
      [
        snapshotEntry({ name: 'plugin-mix-js' }),
        snapshotEntry({ name: 'plugin-mix-wasm' }),
        snapshotEntry({ name: 'plugin-mix-missing' }),
      ],
      noWasm,
    );
    expect(summary.plugins.map((p) => p.name)).toEqual(['plugin-mix-js']);
    expect(summary.skipped.map((s) => s.name)).toEqual(['plugin-mix-wasm']);
    expect(summary.missing.map((m) => m.name)).toEqual(['plugin-mix-missing']);
  });

  it('skipped plugins do NOT appear in summary.plugins or capDeltas', async () => {
    // Even if the snapshot's caps differ from the installed plugin,
    // a runtime-skipped plugin shouldn't show up in capDeltas (it's
    // not being enabled — comparing caps would be misleading).
    await stageInstalledPlugin({
      name: 'plugin-cap-delta-but-skipped',
      version: '1.0.0',
      capabilities: ['cap-x'],
      runtime: 'wasm',
    });
    const noWasm: RuntimeAvailability = { js: true, wasm: false, daemon: true };
    const summary = await buildConsentSummary(
      [
        snapshotEntry({
          name: 'plugin-cap-delta-but-skipped',
          capabilities: ['cap-y'], // different from installed
        }),
      ],
      noWasm,
    );
    expect(summary.plugins).toEqual([]);
    expect(summary.capDeltas).toEqual([]);
    expect(summary.skipped).toHaveLength(1);
  });

  it('explicit ALL_RUNTIMES_AVAILABLE matches default arg behavior', async () => {
    await stageInstalledPlugin({
      name: 'plugin-explicit-all',
      version: '1.0.0',
      runtime: 'wasm',
    });
    const a = await buildConsentSummary([snapshotEntry({ name: 'plugin-explicit-all' })]);
    const b = await buildConsentSummary(
      [snapshotEntry({ name: 'plugin-explicit-all' })],
      ALL_RUNTIMES_AVAILABLE,
    );
    expect(a).toEqual(b);
  });
});
