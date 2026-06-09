/**
 * Unit test for captureInstanceSpec — reads blueprintRef + repoSha + deployment +
 * genome from a live harness. PG-free: the registry + workspace are mocked; the
 * harness dir is a real temp dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

const projects: Array<Record<string, unknown>> = [];
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: async () => ({ projects }),
}));

import { captureInstanceSpec } from './capture';
import { applyGenomeConfig, writeGenomePrompts } from './genome-storage';
import { hashGenome } from './genome';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capture-spec-'));
  projects.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeBlueprint(harnessPath: string, childObj: Record<string, unknown>): void {
  mkdirSync(join(harnessPath, '.papercusp'), { recursive: true });
  writeFileSync(join(harnessPath, '.papercusp', 'blueprint.yaml'), stringifyYaml(childObj), 'utf8');
}

describe('captureInstanceSpec', () => {
  it('captures a vanilla research instance (repo-less, local, empty genome)', async () => {
    writeBlueprint(dir, { id: 'demo', extends: 'research' });
    projects.push({ slug: 'demo', path: dir });

    const spec = await captureInstanceSpec('demo', { workspaceId: 'test-ws' });
    expect(spec.blueprintRef.id).toBe('demo');
    expect(spec.blueprintRef.extends).toBe('research');
    expect(spec.blueprintRef.blueprint).toEqual({ id: 'demo', extends: 'research' });
    expect(spec.repoSha).toBeNull(); // no .git
    expect(spec.deploymentConfig).toEqual({ target: 'local' });
    expect(spec.genome).toEqual({ prompts: {}, config: {} });
  });

  it('captures the genome (prompt overlays + config knobs) + deployment', async () => {
    writeBlueprint(dir, { id: 'demo', extends: 'coding' });
    writeGenomePrompts(dir, { 'queen.placement.md': 'place the queen locally' });
    const configOverrides = applyGenomeConfig({ maxCostUsd: 5 }, { wake: { minSleepSec: 90 } });
    projects.push({
      slug: 'demo',
      path: dir,
      deployment: { target: 'latitude', region: 'NYC' },
      configOverrides,
    });

    const spec = await captureInstanceSpec('demo', { workspaceId: 'test-ws' });
    expect(spec.deploymentConfig).toEqual({ target: 'latitude', region: 'NYC' });
    expect(spec.genome.prompts).toEqual({ 'queen.placement.md': 'place the queen locally' });
    expect(spec.genome.config.wake).toEqual({ minSleepSec: 90 });
    // the genome content-addresses stably
    expect(hashGenome(spec.genome)).toMatch(/^gnm_[0-9a-f]{16}$/);
  });

  it('throws for an unknown harness', async () => {
    await expect(captureInstanceSpec('ghost', { workspaceId: 'test-ws' })).rejects.toThrow(/not found/);
  });

  it('throws for a harness with no blueprint.yaml', async () => {
    projects.push({ slug: 'demo', path: dir });
    await expect(captureInstanceSpec('demo', { workspaceId: 'test-ws' })).rejects.toThrow(/no blueprint\.yaml/);
  });
});
