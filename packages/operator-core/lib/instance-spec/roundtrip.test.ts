/**
 * The InstanceSpec round-trip (P-006): create a harness → capture its spec → boot a
 * new instance from the spec → capture that → assert the two specs are IDENTICAL.
 * And: `vary` yields a fair same-origin clone differing only by the genome delta.
 *
 * PG-free: the registry is an in-memory store, schema scaffold + trigger
 * materialization are no-ops, and the dependency gate is routed through the real
 * assembler so the built-in `research` blueprint's in-process tool deps resolve.
 * The harness dirs are real temp dirs; the create/capture/boot code paths are REAL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Shared in-memory registry — both create (write) and capture (read) use it.
const projects: Array<Record<string, unknown>> = [];
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: async () => ({ projects: projects.map((p) => ({ ...p })) }),
  saveHarnessRegistry: async (reg: { projects: Array<Record<string, unknown>> }) => {
    projects.length = 0;
    projects.push(...reg.projects);
  },
  // harness:create now routes its insert through mutateHarnessRegistry for an
  // atomic read-check-write (audit P-006 / EI-82). Mirror load→mutate→save on
  // the same in-memory store so the round-trip stays PG-free.
  mutateHarnessRegistry: async (
    mutator: (reg: { projects: Array<Record<string, unknown>> }) => { projects: Array<Record<string, unknown>> },
  ) => {
    const next = mutator({ projects: projects.map((p) => ({ ...p })) });
    projects.length = 0;
    projects.push(...next.projects);
    return next;
  },
}));
vi.mock('../scaffold-harness-schema', () => ({ scaffoldHarnessSchema: async () => {} }));
vi.mock('../blueprint/materialize-triggers', () => ({ materializeBlueprintTriggers: async () => [] }));
// Route the dep gate through the REAL assembler with the built-in tool names research declares.
vi.mock('../cupboard/pack-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cupboard/pack-catalog')>();
  return {
    ...actual,
    derivePackCatalog: async () =>
      actual.assemblePackCatalog({
        installed: [],
        projectedTools: [],
        legacyCatalogNames: ['features:get', 'plans:items', 'work_items:list'],
        cupboardUnits: [],
        cupboardReachable: true,
      }),
  };
});

import { captureInstanceSpec } from './capture';
import { bootInstanceSpec } from './boot';
import { varyInstanceSpec, sameOrigin, specsIdentical } from './vary';
import { canonicalGenomeJson } from './genome';

let parent: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'inst-roundtrip-'));
  projects.length = 0;
});
afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

const WS = { workspaceId: 'test-ws' };

describe('capture → boot round-trips to an identical instance', () => {
  it('booting a captured spec yields a byte-identical spec', async () => {
    // 1. Create a base research instance with a genome (prompt overlay + wake knob).
    const createTool = (await import('../agent-tools/harness/create')).default as { handler: (a: unknown, c?: unknown) => Promise<{ content: { text: string }[] }> };
    const created = await createTool.handler({
      slug: 'base-harness',
      parentDir: parent,
      folderName: 'base',
      blueprintId: 'research',
      instance: {
        genome: {
          prompts: { 'queen.placement.md': 'place the queen locally' },
          config: { wake: { minSleepSec: 90 } },
        },
      },
    });
    const createdPayload = JSON.parse((created as { content: { text: string }[] }).content[0]!.text);
    expect(createdPayload.ok).toBe(true);

    // 2. Capture the base instance.
    const spec = await captureInstanceSpec('base-harness', WS);
    expect(spec.repoSha).toBeNull(); // research = repo-less
    expect(spec.deploymentConfig).toEqual({ target: 'local' });
    expect(spec.genome.prompts).toEqual({ 'queen.placement.md': 'place the queen locally' });
    expect(spec.genome.config.wake).toEqual({ minSleepSec: 90 });

    // 3. Boot an identical instance from the spec.
    const boot = await bootInstanceSpec(spec, { slug: 'clone-harness', parentDir: parent, folderName: 'clone' });
    expect(boot.ok).toBe(true);

    // 4. Capture the booted instance → it must be IDENTICAL to the source spec.
    const spec2 = await captureInstanceSpec('clone-harness', WS);
    expect(specsIdentical(spec, spec2)).toBe(true);
    expect(canonicalGenomeJson(spec2.genome)).toBe(canonicalGenomeJson(spec.genome));
  });

  it('a vanilla (genome-less) instance also round-trips identically', async () => {
    const createTool = (await import('../agent-tools/harness/create')).default as { handler: (a: unknown, c?: unknown) => Promise<{ content: { text: string }[] }> };
    await createTool.handler({
      slug: 'plain-base',
      parentDir: parent,
      folderName: 'plain',
      blueprintId: 'research',
    });
    const spec = await captureInstanceSpec('plain-base', WS);
    expect(spec.genome).toEqual({ prompts: {}, config: {} });

    const boot = await bootInstanceSpec(spec, { slug: 'plain-clone', parentDir: parent, folderName: 'plain2' });
    expect(boot.ok).toBe(true);
    const spec2 = await captureInstanceSpec('plain-clone', WS);
    expect(specsIdentical(spec, spec2)).toBe(true);
  });
});

describe('vary yields a fair same-origin clone differing only by the genome', () => {
  it('booting a varied spec is same-origin with the base but has the delta genome', async () => {
    const createTool = (await import('../agent-tools/harness/create')).default as { handler: (a: unknown, c?: unknown) => Promise<{ content: { text: string }[] }> };
    await createTool.handler({
      slug: 'champion',
      parentDir: parent,
      folderName: 'champ',
      blueprintId: 'research',
      instance: { genome: { config: { wake: { minSleepSec: 60 } } } },
    });

    const base = await captureInstanceSpec('champion', WS);
    const challenger = varyInstanceSpec(base, { config: { wake: { minSleepSec: 120 } } });

    // same origin, different genome
    expect(sameOrigin(base, challenger)).toBe(true);
    expect(specsIdentical(base, challenger)).toBe(false);
    expect(challenger.genome.config.wake).toEqual({ minSleepSec: 120 });

    // boot the challenger → capturing it reproduces the delta, still same-origin
    const boot = await bootInstanceSpec(challenger, { slug: 'challenger', parentDir: parent, folderName: 'chal' });
    expect(boot.ok).toBe(true);
    const booted = await captureInstanceSpec('challenger', WS);
    expect(sameOrigin(base, booted)).toBe(true);
    expect(booted.genome.config.wake).toEqual({ minSleepSec: 120 });
  });
});
