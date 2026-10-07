import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixture = vi.hoisted(() => ({ root: '' }));
const privateRead = vi.hoisted(() => vi.fn(() => { throw new Error('PRIVATE_CANARY'); }));
vi.mock('../_repo-paths', () => ({ get REPO_ROOT() { return fixture.root; } }));
vi.mock('../_engineering-adapter', () => ({ engineeringAdapter: {}, engineeringAdapterForSlugs: privateRead }));
vi.mock('../../../harness-registry', () => ({ loadHarnessRegistry: privateRead, resolveHarnessContentPath: privateRead }));

let search: typeof import('../search').default;
let get: typeof import('../get').default;
beforeAll(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'public-docs-handler-'));
  const content = join(fixture.root, 'apps/papercusp-docs/src/content/docs');
  await mkdir(content, { recursive: true });
  await writeFile(join(content, 'faq.mdx'), '---\ntitle: Common questions\n---\n## Browser\nRemote browser work continues while the host stays connected.');
  await mkdir(join(fixture.root, 'private'));
  await writeFile(join(fixture.root, 'private/secret.mdx'), 'PRIVATE_CANARY browser secret');
  vi.stubEnv('PAPERCUSP_PROJECT_DOCS_ROOT', join(fixture.root, 'private'));
  [search, get] = await Promise.all([import('../search').then((m) => m.default), import('../get').then((m) => m.default)]);
}, 30_000);
afterAll(async () => { vi.unstubAllEnvs(); await rm(fixture.root, { recursive: true, force: true }); });

function payload(result: unknown) {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe('public docs handler routing and isolation', () => {
  it.each(['papercup', 'papercup-deep'])('%s defaults a fresh session to public content even with a private project scope', async (role) => {
    const ctx = { role, harnessSlug: 'private-project' } as never;
    expect(search.agentRoles).toContain(role);
    expect(get.agentRoles).toContain(role);
    const found = payload(await search.handler({ query: 'browser' } as never, ctx));
    expect(found).toMatchObject({ surface: 'public', hits: [expect.objectContaining({ slug: 'faq' })] });
    const page = payload(await get.handler({ slugs: ['faq'] } as never, ctx));
    expect(JSON.stringify(page)).toContain('Remote browser work continues');
    for (const harness of ['private-project', 'engineering', 'all']) {
      expect(payload(await search.handler({ query: 'browser', harness } as never, ctx))).toMatchObject({ error: 'public_scope_conflict' });
      expect(payload(await get.handler({ slugs: ['secret'], harness } as never, ctx))).toMatchObject({ error: 'public_scope_conflict' });
    }
    for (const slug of ['private/secret', '../private/secret', '/internal/docs/secret']) {
      expect(JSON.stringify(payload(await get.handler({ slugs: [slug] } as never, ctx)))).not.toContain('PRIVATE_CANARY');
    }
    expect(payload(await get.handler({ slugs: ['faq'], source: true } as never, ctx))).toMatchObject({ error: 'public_source_read_forbidden' });
    expect(privateRead).not.toHaveBeenCalled();
  });

  it('an explicit public scope bypasses private adapter routing for an authorized engineering caller', async () => {
    const ctx = { role: 'operator', isSuperuser: true, harnessSlug: 'private-project' } as never;
    expect(payload(await search.handler({ scope: 'public', query: 'browser' } as never, ctx))).toMatchObject({ surface: 'public' });
    expect(JSON.stringify(payload(await get.handler({ scope: 'public', slugs: ['faq'] } as never, ctx)))).toContain('Remote browser work continues');
    expect(privateRead).not.toHaveBeenCalled();
  });
});
