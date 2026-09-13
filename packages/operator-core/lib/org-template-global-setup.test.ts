import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  getOrBuildTemplate: vi.fn(async () => 'tmpl_test'),
  orgTemplateKey: vi.fn(() => 'org-key'),
  provisionOrgTemplate: vi.fn(async () => ({ migrationCount: 3 })),
}));

vi.mock('@papercusp/test-config/pg', () => ({
  getOrBuildTemplate: mocks.getOrBuildTemplate,
  probePgReachable: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../test/_org-test-db.ts', () => ({
  orgTemplateKey: mocks.orgTemplateKey,
  provisionOrgTemplate: mocks.provisionOrgTemplate,
}));

const { default: setup } = await import('../test/_org-template.globalSetup.ts');

describe('org template globalSetup', () => {
  it('keeps the shared org fixture on the lightweight Postgres helper subpath', () => {
    const source = readFileSync(new URL('../test/_org-test-db.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/from ['"]@papercusp\/test-config\/pg['"]/);
    expect(source).not.toMatch(/from ['"]@papercusp\/test-config['"]/);
  });

  it('pre-warms the migration-keyed template with the shared provisioner', async () => {
    await setup({} as never);

    expect(mocks.orgTemplateKey).toHaveBeenCalledOnce();
    expect(mocks.getOrBuildTemplate).toHaveBeenCalledWith('org-key', mocks.provisionOrgTemplate);
  });
});
