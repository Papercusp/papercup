/**
 * Loader validation for the tui-pane UI surface (revive-plugin-system D-002).
 *
 * Asserts: the shipped reference plugin (example-tui-pane) loads cleanly; a
 * tui-pane declared without `ui:tui-pane` is rejected; a tui-pane without a
 * `command` is rejected; and the pre-existing react/iframe → `ui:harness-route`
 * rule still holds (so a tui-pane-only plugin is NOT forced to declare it).
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPluginFromDir, type LoadedPlugin } from './index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/plugin-loader/src → repo root is four levels up.
const REPO_ROOT = resolve(__dirname, '../../..');
const REFERENCE_PLUGIN = resolve(REPO_ROOT, 'libs/papercusp/plugins/example-tui-pane');

const ROOT = join(tmpdir(), `papercusp-tui-pane-test-${process.pid}`);

async function makeUiPlugin(
  name: string,
  capabilities: string[],
  ui: unknown[],
): Promise<string> {
  const dir = join(ROOT, name);
  await fs.mkdir(dir, { recursive: true });
  const manifest = { name, version: '0.1.0', papercusp: '^0.1.0', capabilities, ui, tools: [] };
  await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify(manifest), 'utf8');
  const entry =
    `module.exports = { name: ${JSON.stringify(name)}, version: '0.1.0', ` +
    `papercusp: '^0.1.0', capabilities: ${JSON.stringify(capabilities)}, ui: ${JSON.stringify(ui)} };`;
  await fs.writeFile(join(dir, 'index.cjs'), entry, 'utf8');
  return dir;
}

beforeAll(async () => {
  await fs.mkdir(ROOT, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('tui-pane manifest validation', () => {
  it('loads the shipped reference plugin (example-tui-pane) cleanly', async () => {
    const r = await loadPluginFromDir(REFERENCE_PLUGIN, 'global');
    assert(!('error' in r), `expected reference plugin to load, got: ${(r as { error?: string }).error}`);
    assert(!('skipped' in r));
    const lp = r as LoadedPlugin;
    const ui = (lp.plugin as { ui?: Array<{ type?: string; slug?: string; command?: string[] }> }).ui ?? [];
    const pane = ui.find((u) => u.type === 'tui-pane');
    assert(pane, 'reference plugin should declare a tui-pane');
    assert.equal(pane!.slug, 'demo');
    assert.deepEqual(pane!.command, ['sh', 'render.sh']);
  });

  it('accepts a synthetic tui-pane plugin with the right caps', async () => {
    const dir = await makeUiPlugin('fixture-tui-ok', ['ui:tui-pane', 'compute:exec:sh'], [
      { type: 'tui-pane', slug: 'p', label: 'P', command: ['sh', 'r.sh'] },
    ]);
    const r = await loadPluginFromDir(dir, 'global');
    assert(!('error' in r), `expected load, got: ${(r as { error?: string }).error}`);
  });

  it('rejects a tui-pane plugin lacking ui:tui-pane', async () => {
    const dir = await makeUiPlugin('fixture-tui-nocap', ['compute:exec:sh'], [
      { type: 'tui-pane', slug: 'p', label: 'P', command: ['sh'] },
    ]);
    const r = await loadPluginFromDir(dir, 'global');
    assert('error' in r, 'expected a validation error');
    assert.match((r as { error: string }).error, /ui:tui-pane/);
  });

  it('rejects a tui-pane entry without a command', async () => {
    const dir = await makeUiPlugin('fixture-tui-nocmd', ['ui:tui-pane'], [
      { type: 'tui-pane', slug: 'p', label: 'P' },
    ]);
    const r = await loadPluginFromDir(dir, 'global');
    assert('error' in r, 'expected a validation error');
    assert.match((r as { error: string }).error, /command/);
  });

  it('still requires ui:harness-route for a react/iframe surface', async () => {
    const dir = await makeUiPlugin('fixture-react-nocap', [], [
      { type: 'react', slug: 'r', label: 'R' },
    ]);
    const r = await loadPluginFromDir(dir, 'global');
    assert('error' in r, 'expected a validation error');
    assert.match((r as { error: string }).error, /ui:harness-route/);
  });

  it('does NOT force ui:harness-route on a tui-pane-only plugin', async () => {
    const dir = await makeUiPlugin('fixture-tui-only', ['ui:tui-pane', 'compute:exec:sh'], [
      { type: 'tui-pane', slug: 'p', label: 'P', command: ['sh'] },
    ]);
    const r = await loadPluginFromDir(dir, 'global');
    assert(!('error' in r), `tui-pane-only plugin should not need ui:harness-route, got: ${(r as { error?: string }).error}`);
  });
});
