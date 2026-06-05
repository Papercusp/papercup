/**
 * End-to-end integration: synthesize a plugin with a setup.sh that
 * exercises every primitive (USER_VAR_*, OUTPUT_*, papercusp_record_resource,
 * papercusp_state_set, papercusp_render_templates), run it through the
 * full runner pipeline against a real bash, verify:
 *   - state.json captures recorded resources
 *   - state.json captures outputs
 *   - *.tmpl files in projectDir get rendered with substituted values
 *   - .tmpl files are removed after render
 *   - skip-dirs (.git, node_modules) are honoured
 *
 * Skips on non-Linux (the runner uses bash; the helpers assume GNU envsubst).
 */

import { promises as fs } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isLinux = platform() === 'linux';

let TMP_HOME: string;
let TMP_PLUGIN: string;
let TMP_PROJECT: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-render-'));
  TMP_PLUGIN = await fs.mkdtemp(join(tmpdir(), 'paperplug-render-'));
  TMP_PROJECT = await fs.mkdtemp(join(tmpdir(), 'paperproj-render-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  process.env.PAPERCUSP_DISABLE_SANDBOX = '1';
  vi.resetModules();
  vi.doMock('@papercusp/db-org', () => ({
    getOrgPg: () => ({
      sql: () => {
        throw new Error('no PG in this test');
      },
    }),
  }));
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  delete process.env.PAPERCUSP_DISABLE_SANDBOX;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
  await fs.rm(TMP_PLUGIN, { recursive: true, force: true });
  await fs.rm(TMP_PROJECT, { recursive: true, force: true });
});

const SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
. "$PAPERCUSP_RUNTIME_LIB"

# Read flattened user vars
papercusp_progress "step:read" "got USER_VAR_PROJECT_NAME=$USER_VAR_PROJECT_NAME"
papercusp_progress "step:read" "got USER_VAR_REGION=$USER_VAR_REGION"

# Record fake resources
papercusp_record_resource "synthetic.thing" "thing-123"
papercusp_record_resource "synthetic.other" "other-456"

# Set outputs that .tmpl files reference
papercusp_state_set "computedId" "\\"$USER_VAR_PROJECT_NAME-final\\""
papercusp_state_set "computedRegion" "\\"$USER_VAR_REGION\\""

# Export the same values to the script's env so envsubst can see them
export OUTPUT_computedId="$USER_VAR_PROJECT_NAME-final"
export OUTPUT_computedRegion="$USER_VAR_REGION"

# Render templates
papercusp_render_templates

# Brief delay so the runner's FIFO tail catches up before the script
# exits — matches the pattern in runner.test.ts.
sleep 0.4
`;

describe.skip('render-templates end-to-end (needs PG fixture)', () => {
  it.skipIf(!isLinux)('flattens USER_VAR_*, runs setup.sh, renders .tmpl files', async () => {
    // Set up the plugin with a setup.sh
    await fs.mkdir(join(TMP_PLUGIN, 'provision'), { recursive: true });
    const scriptPath = join(TMP_PLUGIN, 'provision', 'setup.sh');
    await fs.writeFile(scriptPath, SCRIPT);
    await fs.chmod(scriptPath, 0o755);

    // Set up project dir with templates + skip-dirs
    await fs.writeFile(
      join(TMP_PROJECT, 'wrangler.toml.tmpl'),
      `name = "\${OUTPUT_computedId}"\nregion = "\${OUTPUT_computedRegion}"\nproject = "\${USER_VAR_PROJECT_NAME}"\n`,
    );
    await fs.writeFile(
      join(TMP_PROJECT, '.env.production.tmpl'),
      `PUBLIC_NAME=\${USER_VAR_PROJECT_NAME}\n`,
    );
    // Should be skipped:
    await fs.mkdir(join(TMP_PROJECT, 'node_modules'), { recursive: true });
    await fs.writeFile(join(TMP_PROJECT, 'node_modules', 'fake.tmpl'), 'should not be rendered');
    await fs.mkdir(join(TMP_PROJECT, '.git'), { recursive: true });
    await fs.writeFile(join(TMP_PROJECT, '.git', 'config.tmpl'), 'should not be rendered');

    const { runPhase } = await import('./runner');

    const result = await runPhase('setup', {
      harness: 'test-harness',
      plugin: 'synthetic-plugin',
      publisher: '@test',
      pluginVersion: '0.1.0',
      pluginDir: TMP_PLUGIN,
      projectDir: TMP_PROJECT,
      config: {
        projectName: 'demo',
        region: 'us-east-1',
      },
      provision: {
        setup: { path: 'provision/setup.sh', timeoutSec: 30 },
      },
      consentConfirmed: true,
    });

    if (!result.ok) {
      // Surface the runner's diagnostics to make debugging easier
      throw new Error(`runPhase failed: ${result.error ?? 'unknown'}; exit=${result.exitCode}`);
    }

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);

    // 1. Templates rendered
    const wrangler = await fs.readFile(join(TMP_PROJECT, 'wrangler.toml'), 'utf8');
    expect(wrangler).toContain('name = "demo-final"');
    expect(wrangler).toContain('region = "us-east-1"');
    expect(wrangler).toContain('project = "demo"');
    const env = await fs.readFile(join(TMP_PROJECT, '.env.production'), 'utf8');
    expect(env).toContain('PUBLIC_NAME=demo');

    // 2. .tmpl files removed after render
    expect(await fileExists(join(TMP_PROJECT, 'wrangler.toml.tmpl'))).toBe(false);
    expect(await fileExists(join(TMP_PROJECT, '.env.production.tmpl'))).toBe(false);

    // 3. Skip-dirs honoured
    expect(await fileExists(join(TMP_PROJECT, 'node_modules', 'fake.tmpl'))).toBe(true);
    expect(await fileExists(join(TMP_PROJECT, '.git', 'config.tmpl'))).toBe(true);

    // 4. state.json captures resources + outputs
    expect(result.state?.createdResources?.length ?? 0).toBe(2);
    const resourceKinds = (result.state?.createdResources ?? []).map((r: any) => r.kind);
    expect(resourceKinds).toContain('synthetic.thing');
    expect(resourceKinds).toContain('synthetic.other');
    expect(result.state?.outputs?.computedId).toBe('demo-final');
    expect(result.state?.outputs?.computedRegion).toBe('us-east-1');
  }, 30_000);

  it.skipIf(!isLinux)('renders zero templates without error when project dir has none', async () => {
    await fs.mkdir(join(TMP_PLUGIN, 'provision'), { recursive: true });
    const scriptPath = join(TMP_PLUGIN, 'provision', 'setup.sh');
    await fs.writeFile(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
. "$PAPERCUSP_RUNTIME_LIB"
papercusp_render_templates
`);
    await fs.chmod(scriptPath, 0o755);

    const { runPhase } = await import('./runner');

    const result = await runPhase('setup', {
      harness: 'no-tmpl',
      plugin: 'synthetic-plugin',
      publisher: '@test',
      pluginVersion: '0.1.0',
      pluginDir: TMP_PLUGIN,
      projectDir: TMP_PROJECT,
      config: {},
      provision: { setup: { path: 'provision/setup.sh', timeoutSec: 30 } },
      consentConfirmed: true,
    });
    expect(result.ok).toBe(true);
  }, 30_000);

  it.skipIf(!isLinux)('warns and exits cleanly when projectDir is undefined', async () => {
    await fs.mkdir(join(TMP_PLUGIN, 'provision'), { recursive: true });
    const scriptPath = join(TMP_PLUGIN, 'provision', 'setup.sh');
    await fs.writeFile(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
. "$PAPERCUSP_RUNTIME_LIB"
papercusp_render_templates
echo "still ran"
`);
    await fs.chmod(scriptPath, 0o755);

    const { runPhase } = await import('./runner');

    const result = await runPhase('setup', {
      harness: 'no-projectdir',
      plugin: 'synthetic-plugin',
      publisher: '@test',
      pluginVersion: '0.1.0',
      pluginDir: TMP_PLUGIN,
      // projectDir intentionally omitted
      config: {},
      provision: { setup: { path: 'provision/setup.sh', timeoutSec: 30 } },
      consentConfirmed: true,
    });
    // The helper warns but doesn't fail the script.
    expect(result.ok).toBe(true);
  }, 30_000);
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch { return false; }
}
