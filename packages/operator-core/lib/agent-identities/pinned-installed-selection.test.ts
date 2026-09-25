import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { layerContentHash } from '@papercusp/orchestrator/blueprint';
import {
  commitBlueprintRelease,
  readBlueprintLifecycle,
  snapshotBlueprintReleaseSource,
} from '../cupboard/blueprint-release';
import { INSTALLED_BLUEPRINTS_DIR, operatorResolveExtends } from '../blueprint/installed-blueprints';
import { getIdentitySource, resolvePinnedIdentityLaunchSelection } from './source';

describe('selected installed identity continuity', () => {
  it('retains the saved v1 release and refuses to silently resolve its pin through installed v2', async () => {
    const root = mkdtempSync(join(tmpdir(), 'p006-installed-pin-'));
    const home = join(root, 'home');
    const id = 'p006-installed-domain';
    const ref = `domain:${id}`;
    vi.stubEnv('PAPERCUSP_HOME', home);
    try {
      const install = async (version: string, prompt: string) => {
        const sourceDir = join(root, `source-${version}`);
        mkdirSync(join(sourceDir, 'prompts'), { recursive: true });
        const raw = { id, extends: 'base', version, slots: [{ slot: 'domain' }] };
        writeFileSync(join(sourceDir, 'blueprint.yaml'), stringify({
          ...raw,
          attestation: { contentHash: layerContentHash(raw), signedBy: 'test-publisher' },
        }));
        writeFileSync(join(sourceDir, 'prompts', 'domain.md'), prompt);
        const snapshot = await snapshotBlueprintReleaseSource({
          blueprintFile: join(sourceDir, 'blueprint.yaml'),
          resolveExtends: operatorResolveExtends(),
        });
        return commitBlueprintRelease({
          installedDir: INSTALLED_BLUEPRINTS_DIR(), sourceDir, id, version,
          source: 'https://example.invalid/p006-installed-domain',
          pins: snapshot.archive.pins,
        });
      };

      expect((await install('1.0.0', 'VERSION ONE\n')).operation).toBe('install');
      const v1 = await getIdentitySource(id, { repoDir: root });
      expect(v1.ok).toBe(true);
      if (!v1.ok) throw new Error('installed v1 did not resolve');
      const pin = { ref, sourceRevision: v1.contentHash };
      await expect(resolvePinnedIdentityLaunchSelection({
        ...pin, repoDir: root, stack: [ref],
      })).resolves.toMatchObject({ compositionRootId: null });

      expect((await install('1.0.1', 'VERSION TWO\n')).operation).toBe('update');
      const lifecycle = await readBlueprintLifecycle(INSTALLED_BLUEPRINTS_DIR(), id);
      expect(lifecycle.active?.version).toBe('1.0.1');
      expect(lifecycle.releases.map((release) => release.version)).toEqual(['1.0.1', '1.0.0']);
      expect(existsSync(join(INSTALLED_BLUEPRINTS_DIR(), '.releases', id,
        lifecycle.releases[1]!.contentHash, 'content', 'blueprint.yaml'))).toBe(true);
      const v2 = await getIdentitySource(id, { repoDir: root });
      expect(v2.ok).toBe(true);
      if (!v2.ok) throw new Error('installed v2 did not resolve');
      expect(v2.contentHash).not.toBe(pin.sourceRevision);
      await expect(resolvePinnedIdentityLaunchSelection({
        ...pin, repoDir: root, stack: [ref],
      })).rejects.toThrow(/source revision changed before rebuild/);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
