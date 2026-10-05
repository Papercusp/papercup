/**
 * An INDEPENDENTLY PACKAGED provider, end to end through the real plugin
 * contract (generalized-integrations-google-migration-cupboard-workflows-
 * 2026-10-05, P-001 / D-006).
 *
 * Unlike plugin-provider-wiring.test.ts (which injects in-memory LoadedPlugin
 * objects), this writes real plugin PACKAGES to disk — a `papercusp.json`
 * manifest declaring a `provider` plus a CommonJS entry exporting a
 * `providerAdapter` — and drives them through the real `loadPlugins`
 * discovery and the host's `registerPluginProviders`. Nothing here edits
 * operator-core source or writes a shared table: the package is the only
 * input, which is the property the plan's contract promises a third-party
 * author.
 *
 * Covers spec clauses AUTO-BAR-R-1-P-001 (registers descriptor + adapter with
 * a capability subset) and ITEM-P-001-contract (a second package declaring an
 * already-registered provider id is refused with the named
 * `duplicate-provider` error, and the first registration survives).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins } from '@papercusp/plugin-loader';
import { registerPluginProviders, type ProviderRegistrationFailure } from '../plugin-host-runtime';
import { createProviderRegistry } from './provider-registry';

const ROOT = join(tmpdir(), `papercusp-provider-package-it-${process.pid}-${Date.now()}`);

function descriptor(id: string, capabilities: string[]): Record<string, unknown> {
  return {
    id,
    contractVersion: 1,
    datatypes: ['email-message'],
    capabilities,
    egressHosts: ['mail.example.com'],
  };
}

/** Write one plugin package exactly as an outside author would publish it. */
async function writeProviderPackage(projectDir: string, name: string, provider: Record<string, unknown>) {
  const dir = join(projectDir, 'plugins', name);
  await fs.mkdir(dir, { recursive: true });
  const manifest = { name, version: '0.1.0', papercusp: '^0.1.0', capabilities: [], tools: [], provider };
  await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify(manifest), 'utf8');
  await fs.writeFile(
    join(dir, 'index.cjs'),
    [
      `const provider = ${JSON.stringify(provider)};`,
      'module.exports = {',
      `  name: ${JSON.stringify(name)}, version: '0.1.0', papercusp: '^0.1.0', capabilities: [],`,
      '  providerAdapter: {',
      '    describe: () => provider,',
      "    syncPage: async () => ({ records: [{ id: 'm1' }], nextCursor: null, hasMore: false }),",
      "    invoke: async (req) => ({ ok: true, echoed: req && req.capability }),",
      '  },',
      '};',
    ].join('\n'),
    'utf8',
  );
}

async function discover(projectDir: string) {
  const emptyGlobal = join(projectDir, 'no-global-plugins');
  await fs.mkdir(emptyGlobal, { recursive: true });
  return loadPlugins({ projectDir, harnessSlugs: [], globalPluginsDir: emptyGlobal });
}

beforeAll(async () => {
  await fs.mkdir(ROOT, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('independently packaged provider through the plugin contract (P-001)', () => {
  it('registers the descriptor and a callable adapter with exactly the declared capability subset', async () => {
    const projectDir = join(ROOT, 'single');
    await writeProviderPackage(projectDir, 'acme-mail', descriptor('acme-mail', ['mail.read']));

    const { loaded, errors } = await discover(projectDir);
    expect(errors).toEqual([]);
    const pkg = loaded.find((lp) => lp.plugin.name === 'acme-mail');
    expect(pkg?.provider?.id).toBe('acme-mail');

    const registry = createProviderRegistry();
    const failures: ProviderRegistrationFailure[] = [];
    const registered = await registerPluginProviders(loaded, (f) => failures.push(f), registry);

    expect(failures).toEqual([]);
    expect(registered).toEqual(['acme-mail']);
    const entry = registry.get('acme-mail');
    expect(entry?.pluginName).toBe('acme-mail');
    expect(entry?.runtime).toBe('js');
    // A capability SUBSET: the provider serves mail.read only, so a lookup for
    // a capability it did not declare must not route to it.
    expect(entry?.descriptor.capabilities).toEqual(['mail.read']);
    expect(registry.forDatatype('email-message', 'mail.read').map((p) => p.descriptor.id)).toEqual(['acme-mail']);
    expect(registry.forDatatype('email-message', 'mail.send')).toEqual([]);
    // The adapter that registered is the package's own code, and it answers.
    const page = await entry!.adapter!.syncPage({} as never);
    expect(page).toMatchObject({ records: [{ id: 'm1' }], hasMore: false });
  });

  it('refuses a second package declaring an already-registered provider id with duplicate-provider', async () => {
    const projectDir = join(ROOT, 'duplicate');
    await writeProviderPackage(projectDir, 'acme-mail', descriptor('shared-mail', ['mail.read']));
    await writeProviderPackage(projectDir, 'copycat-mail', descriptor('shared-mail', ['mail.read', 'mail.send']));

    const { loaded, errors } = await discover(projectDir);
    expect(errors).toEqual([]);
    expect(loaded.filter((lp) => lp.provider?.id === 'shared-mail')).toHaveLength(2);

    const registry = createProviderRegistry();
    const failures: ProviderRegistrationFailure[] = [];
    const registered = await registerPluginProviders(loaded, (f) => failures.push(f), registry);

    expect(registered).toEqual(['shared-mail']);
    expect(failures).toHaveLength(1);
    const [failure] = failures;
    expect(failure.code).toBe('duplicate-provider');
    expect(failure.provider).toBe('shared-mail');
    const winner = registry.get('shared-mail')!.pluginName;
    expect(failure.plugin).not.toBe(winner);
    expect(failure.error).toContain(`already registered by plugin "${winner}"`);
    // The refusal leaves the first registration intact, capabilities unwidened.
    expect(registry.list()).toHaveLength(1);
    expect(registry.forDatatype('email-message', 'mail.send')).toEqual(
      winner === 'copycat-mail' ? registry.list() : [],
    );
  });
});
