/** P-027: real package discovery feeds the registry and the generic Integrations card model. */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPlugins } from '@papercusp/plugin-loader';
import { registerPluginProviders } from '../plugin-host-runtime';
import { createProviderRegistry } from '../integrations/provider-registry';
import { summarizeIntegrationProvider } from '../integrations/ticket-integrations';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOT = join(tmpdir(), `social-package-install-${process.pid}-${Date.now()}`);
afterAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });

// Later social packages extend this population as their implementation lands.
const PACKAGES = ['facebook-pages'];
describe('installed social packages use the generic Integrations model', () => {
  it.each(PACKAGES)('%s loads from the install path with declared setup and capabilities', async (id) => {
    const projectDir = join(ROOT, id);
    const installed = join(projectDir, 'plugins', id);
    await fs.mkdir(installed, { recursive: true });
    await fs.cp(join(REPO, 'libs/papercusp/plugins', id), installed, { recursive: true });
    const globalPluginsDir = join(projectDir, 'empty-global');
    await fs.mkdir(globalPluginsDir, { recursive: true });
    const { loaded, errors } = await loadPlugins({ projectDir, harnessSlugs: [], globalPluginsDir });
    expect(errors).toEqual([]);
    const registry = createProviderRegistry();
    const failures: unknown[] = [];
    expect(await registerPluginProviders(loaded, (failure) => failures.push(failure), registry)).toEqual([id]);
    expect(failures).toEqual([]);
    const entry = registry.get(id)!;
    expect(entry.descriptor.datatypes).toEqual(['social-post']);
    expect(await entry.adapter!.describe()).toEqual(entry.descriptor);
    const model = summarizeIntegrationProvider(entry, [], {
      ref: 'facebook', configured: false, clientId: null, hasClientSecret: false,
      redirectUri: 'https://operator.example/api/oauth/callback', savedAt: null,
    });
    expect(model).toMatchObject({ id, displayName: 'Facebook Pages', tracksTickets: false, requiredConfig: ['pageId'], capabilities: ['social.post', 'social.reply', 'social.delete'] });
    expect(new URL(model.connectHref!, 'https://operator.example').searchParams.get('plugin')).toContain(id);
    expect(model.appRegistration?.createUrl).toBe('https://developers.facebook.com/apps/');
    expect(model.oauthClient).toMatchObject({ configured: false, secretRequired: true });
    expect(registry.forDatatype('social-post', 'social.post').map((e) => e.descriptor.id)).toEqual([id]);
    const triggerPack = JSON.parse(await fs.readFile(join(REPO, 'libs/papercusp/plugins/social-facebook-pages/papercusp.json'), 'utf8'));
    expect(triggerPack.triggerPack.bindings.map((b: { source: { sourceKind: string }; eventPattern: string }) => [b.source.sourceKind, b.eventPattern])).toEqual([
      [id, `ext:${id}:post`], [id, `ext:${id}:comment`], [id, `ext:${id}:reply`],
    ]);
  });
});
