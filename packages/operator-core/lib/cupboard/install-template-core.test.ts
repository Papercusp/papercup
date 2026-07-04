/**
 * Install-template-from-Cupboard core (app-templates-2026-07-04 P-010).
 * Pure-ish: clone / installed dir / tmp are injected, so this covers the
 * locate→validate→catalog-check→copy flow without real git or network.
 * `cloneRepo` is faked by copying a local fixture dir. Validation runs
 * against the REAL @papercusp/template-kit COMPONENT_CATALOG — a fixture
 * pinning `hive-app-seam@0.1.0` therefore also pins the catalog's living
 * version (rot in either side fails here, by design).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installTemplateFromCupboardCore,
  InstallTemplateError,
  type InstallTemplateCoreDeps,
} from './install-template-core';

let root: string;         // scratch root for fixtures + install target
let fixtureRepo: string;  // the "remote" repo a fake clone copies from
let installedDir: string; // the install target (~/.papercusp/templates stand-in)

const VALID_YAML = [
  'id: neat-template',
  'version: 0.1.0',
  'scope: aspect',
  'summary: a neat test template',
  'components:',
  '  - { id: hive-app-seam, version: 0.1.0 }',
  'contracts: []',
  'decisionPoints:',
  '  - { id: seam-kind, prompt: pick the seam work-item kind }',
  'composesWith: []',
  'checks:',
  '  - { id: seam-round-trip, run: checks/seam-round-trip.test.ts }',
].join('\n');

async function writeTemplate(dir: string, yaml: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'template.yaml'), yaml, 'utf8');
}

function makeDeps(over: Partial<InstallTemplateCoreDeps> = {}): InstallTemplateCoreDeps {
  return {
    cloneRepo: async (_url, dest) => {
      await fs.cp(fixtureRepo, dest, { recursive: true });
    },
    installedTemplatesDir: () => installedDir,
    tmpDir: () => root,
    ...over,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'install-tpl-core-'));
  fixtureRepo = join(root, 'remote');
  installedDir = join(root, 'templates');
  await fs.mkdir(fixtureRepo, { recursive: true });
  // a .git dir that must NOT be copied into the install
  await fs.mkdir(join(fixtureRepo, '.git'), { recursive: true });
  await fs.writeFile(join(fixtureRepo, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('installTemplateFromCupboardCore', () => {
  it('installs a root-level template (validates, copies, excludes .git)', async () => {
    await writeTemplate(fixtureRepo, VALID_YAML);
    await fs.writeFile(join(fixtureRepo, 'GUIDE.md'), '# compose like so', 'utf8');
    await fs.mkdir(join(fixtureRepo, 'checks'), { recursive: true });
    await fs.writeFile(join(fixtureRepo, 'checks', 'seam-round-trip.test.ts'), '// check', 'utf8');

    const res = await installTemplateFromCupboardCore(
      { githubUrl: 'https://github.com/acme/neat-template' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.id).toBe('neat-template');
    expect(res.version).toBe('0.1.0');
    expect(res.scope).toBe('aspect');
    expect(res.hasGuide).toBe(true);
    expect(res.components).toEqual([{ id: 'hive-app-seam', version: '0.1.0' }]);
    expect(res.installedTo).toBe(join(installedDir, 'neat-template'));
    expect(existsSync(join(installedDir, 'neat-template', 'template.yaml'))).toBe(true);
    expect(existsSync(join(installedDir, 'neat-template', 'GUIDE.md'))).toBe(true);
    expect(existsSync(join(installedDir, 'neat-template', 'checks', 'seam-round-trip.test.ts'))).toBe(true);
    expect(existsSync(join(installedDir, 'neat-template', '.git'))).toBe(false);
  });

  it('prefers templates/<listing_ref> (the papercup official-library layout)', async () => {
    await writeTemplate(join(fixtureRepo, 'templates', 'neat-template'), VALID_YAML);
    // decoy at root that must NOT win when the listing_ref subdir exists
    await writeTemplate(fixtureRepo, VALID_YAML.replace('id: neat-template', 'id: root-decoy'));

    const res = await installTemplateFromCupboardCore(
      { githubUrl: 'https://github.com/acme/lib', listingRef: 'neat-template' },
      makeDeps(),
    );
    expect(res.id).toBe('neat-template');
  });

  it('falls back to a bare <listing_ref> subdir, then the repo root', async () => {
    await writeTemplate(join(fixtureRepo, 'neat-template'), VALID_YAML);
    const res = await installTemplateFromCupboardCore(
      { githubUrl: 'https://github.com/acme/lib', listingRef: 'neat-template' },
      makeDeps(),
    );
    expect(res.id).toBe('neat-template');

    await fs.rm(join(fixtureRepo, 'neat-template'), { recursive: true });
    await writeTemplate(fixtureRepo, VALID_YAML);
    const res2 = await installTemplateFromCupboardCore(
      { githubUrl: 'https://github.com/acme/lib', listingRef: 'missing-subdir' },
      makeDeps(),
    );
    expect(res2.id).toBe('neat-template');
  });

  it('rejects a non-GitHub URL (400)', async () => {
    await expect(
      installTemplateFromCupboardCore({ githubUrl: 'https://evil.example/x/y' }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a repo with no template.yaml anywhere (422)', async () => {
    await expect(
      installTemplateFromCupboardCore({ githubUrl: 'https://github.com/acme/empty' }, makeDeps()),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects a manifest that fails the kit schema (422, all problems listed)', async () => {
    await writeTemplate(fixtureRepo, 'id: BadId\nversion: nope');
    const err = await installTemplateFromCupboardCore(
      { githubUrl: 'https://github.com/acme/bad' },
      makeDeps(),
    ).catch((e) => e as InstallTemplateError);
    expect(err).toBeInstanceOf(InstallTemplateError);
    expect((err as InstallTemplateError).status).toBe(422);
    expect((err as InstallTemplateError).message).toContain('invalid template manifest');
  });

  it('rejects a stale component pin (catalog cross-validation, 422)', async () => {
    await writeTemplate(
      fixtureRepo,
      VALID_YAML.replace('{ id: hive-app-seam, version: 0.1.0 }', '{ id: hive-app-seam, version: 9.9.9 }'),
    );
    const err = await installTemplateFromCupboardCore(
      { githubUrl: 'https://github.com/acme/stale' },
      makeDeps(),
    ).catch((e) => e as InstallTemplateError);
    expect(err).toBeInstanceOf(InstallTemplateError);
    expect((err as InstallTemplateError).status).toBe(422);
    expect((err as InstallTemplateError).message).toContain('stale pin');
  });

  it('rejects an unknown component ref (422)', async () => {
    await writeTemplate(
      fixtureRepo,
      VALID_YAML.replace('{ id: hive-app-seam, version: 0.1.0 }', '{ id: not-a-component, version: 1.0.0 }'),
    );
    await expect(
      installTemplateFromCupboardCore({ githubUrl: 'https://github.com/acme/unknown' }, makeDeps()),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('a path-traversal listing_ref cannot escape the clone (falls through to root)', async () => {
    await writeTemplate(fixtureRepo, VALID_YAML);
    const res = await installTemplateFromCupboardCore(
      { githubUrl: 'https://github.com/acme/lib', listingRef: '../../outside' },
      makeDeps(),
    );
    // the unsafe ref is discarded (isSafeListingRef), root still resolves
    expect(res.id).toBe('neat-template');
  });

  it('re-install replaces the target dir (no stale leftover files)', async () => {
    await writeTemplate(fixtureRepo, VALID_YAML);
    await fs.writeFile(join(fixtureRepo, 'stale.md'), 'old file', 'utf8');
    await installTemplateFromCupboardCore({ githubUrl: 'https://github.com/acme/t' }, makeDeps());
    expect(existsSync(join(installedDir, 'neat-template', 'stale.md'))).toBe(true);

    await fs.rm(join(fixtureRepo, 'stale.md'));
    await installTemplateFromCupboardCore({ githubUrl: 'https://github.com/acme/t' }, makeDeps());
    expect(existsSync(join(installedDir, 'neat-template', 'stale.md'))).toBe(false);
    expect(existsSync(join(installedDir, 'neat-template', 'template.yaml'))).toBe(true);
  });

  it('cleans up the clone scratch dir on success AND failure', async () => {
    await writeTemplate(fixtureRepo, VALID_YAML);
    await installTemplateFromCupboardCore({ githubUrl: 'https://github.com/acme/t' }, makeDeps());
    let leftovers = (await fs.readdir(root)).filter((n) => n.startsWith('cupboard-template-'));
    expect(leftovers).toEqual([]);

    await fs.rm(join(fixtureRepo, 'template.yaml'));
    await installTemplateFromCupboardCore({ githubUrl: 'https://github.com/acme/t' }, makeDeps()).catch(() => {});
    leftovers = (await fs.readdir(root)).filter((n) => n.startsWith('cupboard-template-'));
    expect(leftovers).toEqual([]);
  });

  it('the REAL repo templates install clean end-to-end (live pin — catches template↔catalog rot)', async () => {
    // The papercup repo's own templates/ dir is the v1 source of truth the
    // Cupboard listings point at (D-005) — install each reference template
    // from a fixture repo shaped exactly like papercup.
    const repoTemplatesDir = join(__dirname, '..', '..', '..', '..', 'templates');
    for (const id of ['agentic-desktop-app', 'papercusp-ops-hives', 'tauri-desktop-shell']) {
      const src = join(repoTemplatesDir, id);
      if (!existsSync(join(src, 'template.yaml'))) continue; // repo layout moved — kit suite pins that
      await fs.cp(src, join(fixtureRepo, 'templates', id), { recursive: true });
      const res = await installTemplateFromCupboardCore(
        { githubUrl: 'https://github.com/papercup-ai/papercup', listingRef: id },
        makeDeps(),
      );
      expect(res.id).toBe(id);
      expect(res.hasGuide).toBe(true);
      expect(existsSync(join(installedDir, id, 'template.yaml'))).toBe(true);
    }
  });
});
