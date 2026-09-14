/**
 * Install-blueprint-from-Cupboard core
 * (official-blueprints-cupboard-publish-2026-06-05 P-004). Pure-ish: clone /
 * installed dir / extends-resolver / host capability sets are injected, so this
 * covers the locate→validate→dep-check→copy flow without real git, network, or
 * the tool catalog. `cloneRepo` is faked by copying a local fixture dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBuiltinExtends, pinPackageInput, validateAgentInputClosure } from '@papercusp/orchestrator/blueprint';
import { resolvePromptFile } from '@papercusp/orchestrator';
import { makeComposedResolveExtends } from '@papercusp/blueprint-distribution';
import {
  installBlueprintFromCupboardCore,
  InstallBlueprintError,
  type InstallBlueprintCoreDeps,
} from './install-blueprint-core';
import type { CapabilityProviderCandidate } from './capability-grant-resolver';

let root: string;        // scratch root for fixtures + install target
let fixtureRepo: string; // the "remote" repo a fake clone copies from
let installedDir: string; // the install target (~/.papercusp/blueprints stand-in)

const RUNNABLE_YAML = [
  'id: neat-bp',
  'version: 0.2.0',
  'description: a neat test blueprint',
  'workItem: { kind: feature }',
  'spine: { edges: { DONE: { to: done } } }',
].join('\n');

const capabilityCandidate = (): CapabilityProviderCandidate => ({
  classRef: 'crm.email@1.0.0',
  providerPackage: 'acme-crm',
  providerVersion: '2.0.0',
  verbBindings: { send: 'acme:send-email' },
  conformanceRunId: 'run-acme',
  conformanceStatus: 'passed',
  behavioralStatus: 'not-required',
  behavioralRunRef: null,
  registryRevision: 'registry-r1',
  status: 'active',
  updatedAt: '2026-09-07T00:00:00.000Z',
  price: null,
  activePotBindings: 4,
  passingStructuralRuns: 3,
  totalStructuralRuns: 3,
});

async function writeBlueprint(dir: string, yaml: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'blueprint.yaml'), yaml, 'utf8');
}

function makeDeps(over: Partial<InstallBlueprintCoreDeps> = {}): InstallBlueprintCoreDeps {
  return {
    cloneRepo: async (_url, dest) => {
      await fs.cp(fixtureRepo, dest, { recursive: true });
    },
    installedBlueprintsDir: () => installedDir,
    tmpDir: () => root,
    // Installed tier (the target dir) + the engine's bundled floor — the same
    // composition the operator wires, against the test's own installed dir.
    resolveExtends: makeComposedResolveExtends({ installedDir }),
    resolveHostSets: async () => ({
      availableTools: new Set<string>(),
      installedPlugins: new Set<string>(),
      cupboardPlugins: new Set<string>(),
      cupboardReachable: true,
    }),
    validateCapabilityGrants: async () => [],
    reviewCapabilityProviderPackages: async (selections) => ({
      ok: true,
      roots: selections.map((selection) => ({
        providerPackage: selection.providerPackage,
        providerVersion: selection.providerVersion,
        classRefs: [selection.classRef],
        kind: 'plugin' as const,
        status: 'installed' as const,
        listingId: null,
      })),
      units: [],
      stillMissing: { tools: [], packs: [], plugins: [], events: [] },
      advisory: [],
      rounds: 0,
    }),
    ...over,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'install-bp-core-'));
  fixtureRepo = join(root, 'remote');
  installedDir = join(root, 'blueprints');
  await fs.mkdir(fixtureRepo, { recursive: true });
  // a .git dir that must NOT be copied into the install
  await fs.mkdir(join(fixtureRepo, '.git'), { recursive: true });
  await fs.writeFile(join(fixtureRepo, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('installBlueprintFromCupboardCore', () => {
  it('installs a root-level blueprint (validates, copies, excludes .git)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML);
    await fs.mkdir(join(fixtureRepo, 'prompts'), { recursive: true });
    await fs.writeFile(join(fixtureRepo, 'prompts', 'director.md'), '# persona', 'utf8');

    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/neat-bp' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.id).toBe('neat-bp');
    expect(res.version).toBe('0.2.0');
    expect(res.operation).toBe('install');
    expect(res.release.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(res.abstract).toBe(false);
    expect(res.installedTo).toBe(join(installedDir, 'neat-bp'));
    expect(existsSync(join(installedDir, 'neat-bp', 'blueprint.yaml'))).toBe(true);
    // blueprint-local prompts ride along; .git does not
    expect(existsSync(join(installedDir, 'neat-bp', 'prompts', 'director.md'))).toBe(true);
    expect(existsSync(join(installedDir, 'neat-bp', '.git'))).toBe(false);
    const source = res.depCheck?.pins?.find((pin) => pin.ref === 'neat-bp');
    expect(source?.files.map((file) => file.path)).toEqual(['blueprint.yaml', 'prompts/director.md']);
    expect(Buffer.from(source!.files[1]!.bytes, 'base64').toString()).toBe('# persona');
    expect(() => validateAgentInputClosure(res.depCheck!.pins!)).not.toThrow();
  });

  it('pins inherited source prompts and a transitive bundled graph on the real install path', async () => {
    const baseDir = join(root, 'local-parent');
    await writeBlueprint(baseDir, 'id: parent\nversion: 1.0.0');
    await fs.mkdir(join(baseDir, 'prompts'));
    await fs.writeFile(join(baseDir, 'prompts/worker.md'), 'inherited prompt');
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\nextends: parent\nbundles: [{ kind: recipe, ref: job, version: 1.0.0 }]');
    const leaf = pinPackageInput({ packageKind: 'rubric', ref: 'judge', revision: '1', files: [{ path: 'rubric.json', bytes: '{}' }] });
    const job = pinPackageInput({ packageKind: 'recipe', ref: 'job', revision: '1.0.0', files: [{ path: 'recipe.json', bytes: '{}' }],
      dependencies: [{ packageKind: leaf.packageKind, ref: leaf.ref, revision: leaf.revision, contentHash: leaf.contentHash }] });
    const res = await installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/neat-bp' }, makeDeps({
      resolveExtends: (id) => id === 'parent' ? join(baseDir, 'blueprint.yaml') : null,
      resolvePackage: async ({ ref }) => ref === 'job' ? job : leaf,
    }));
    expect(res.depCheck?.pins?.map((pin) => pin.ref).sort()).toEqual(['job', 'judge', 'neat-bp', 'parent']);
    const parent = res.depCheck!.pins!.find((pin) => pin.ref === 'parent')!;
    expect(parent.files.map((file) => file.path)).toContain('prompts/worker.md');
    await fs.rm(baseDir, { recursive: true, force: true });
    expect(() => validateAgentInputClosure(res.depCheck!.pins!)).not.toThrow();
  });

  it('rejects absent or conflicting bundle pins before replacing an installed blueprint', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\nbundles: [{ kind: recipe, ref: job, version: 2.0.0 }]');
    await writeBlueprint(join(installedDir, 'neat-bp'), 'id: preserved');
    const job = pinPackageInput({ packageKind: 'recipe', ref: 'job', revision: '1.0.0', files: [] });
    for (const resolvePackage of [async () => null, async () => job]) {
      await expect(installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/neat-bp' }, makeDeps({ resolvePackage })))
        .rejects.toMatchObject({ status: 422 });
      expect(await fs.readFile(join(installedDir, 'neat-bp/blueprint.yaml'), 'utf8')).toBe('id: preserved');
    }
  });

  // blueprint-role-bundling P-006 — the marketplace round-trip: an installed
  // blueprint resolves its roles from its OWN prompts dir + the base library, with
  // NO global prompts/ dir present (the Phase-5 end-state). installedDir is
  // <root>/blueprints, so a resolver rooted at <root> sees exactly the installed
  // layout (blueprints/<id>/prompts → blueprints/base/prompts).
  it('round-trip — an installed blueprint spawns its roles from its own dir + base (no global lib)', async () => {
    // The base role library under the host (the universal fall-through).
    await fs.mkdir(join(installedDir, 'base', 'prompts'), { recursive: true });
    await fs.writeFile(join(installedDir, 'base', 'prompts', 'worker.md'), '# base worker', 'utf8');
    // A blueprint that ships its OWN director persona (and inherits worker from base).
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML);
    await fs.mkdir(join(fixtureRepo, 'prompts'), { recursive: true });
    await fs.writeFile(join(fixtureRepo, 'prompts', 'director.md'), '# installed director', 'utf8');

    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/neat-bp' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);

    const ctx = { harnessDir: root, phase: '', dept: '', blueprintId: 'neat-bp' };
    // its OWN role resolves from the installed blueprint dir …
    expect(resolvePromptFile(ctx, 'director')).toBe(join(installedDir, 'neat-bp', 'prompts', 'director.md'));
    // … a role it does NOT ship falls through to the base library …
    expect(resolvePromptFile(ctx, 'worker')).toBe(join(installedDir, 'base', 'prompts', 'worker.md'));
    // … and there is NO global prompts/ dir anywhere in the host (the Phase-5 invariant).
    expect(existsSync(join(root, 'prompts'))).toBe(false);
  });

  it('prefers the listing_ref subdir (multi-blueprint repo — the official library layout)', async () => {
    await writeBlueprint(join(fixtureRepo, 'neat-bp'), RUNNABLE_YAML);
    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/blueprints', listingRef: 'neat-bp' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.id).toBe('neat-bp');
  });

  it.each([
    ['the authored publisher layout', join('.papercusp', 'blueprints')],
    ['the first-party library layout', join('packages', 'harness', 'blueprints')],
  ])('round-trips listing_ref through %s', async (_label, relativeRoot) => {
    await writeBlueprint(join(fixtureRepo, relativeRoot, 'neat-bp'), RUNNABLE_YAML);
    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/blueprints', listingRef: 'neat-bp' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.id).toBe('neat-bp');
    expect(existsSync(join(installedDir, 'neat-bp', 'blueprint.yaml'))).toBe(true);
  });

  it('resolves extends against the bundled built-in floor (D-004)', async () => {
    await writeBlueprint(fixtureRepo, [
      'id: child-of-base',
      'extends: base',
      'workItem: { kind: feature }',
      'spine: { edges: { DONE: { to: done } } }',
    ].join('\n'));
    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/child-of-base' },
      makeDeps({
        resolveExtends: makeComposedResolveExtends({ installedDir, builtin: resolveBuiltinExtends }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.id).toBe('child-of-base');
  });

  it('installs an abstract parent-only blueprint (no workItem/spine) without full validation', async () => {
    await writeBlueprint(fixtureRepo, 'id: my-base\nversion: 1.0.0\nknobs: { logRetention: 100 }');
    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/my-base' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.abstract).toBe(true);
    expect(res.depCheck?.pins?.[0]?.ref).toBe('my-base');
    expect(existsSync(join(installedDir, 'my-base', 'blueprint.yaml'))).toBe(true);
  });

  it('refuses an absent required capability provider before identity bytes land', async () => {
    await writeBlueprint(
      fixtureRepo,
      RUNNABLE_YAML +
        '\nslots: [{ slot: domain }]' +
        '\ngrants: { requires: [crm.email@1.0.0] }',
    );
    await expect(installBlueprintFromCupboardCore(
      {
        githubUrl: 'https://github.com/acme/neat-bp',
        capabilityContext: {
          workspaceId: 'workspace-1',
          potSlug: 'sales-ops',
          mode: 'interactive',
        },
      },
      makeDeps({
        capabilityGrantDeps: {
          getPotBinding: async () => null,
          listCandidates: async () => [],
        },
      }),
    )).rejects.toMatchObject({
      status: 409,
      code: 'required_capability_provider_absent',
      data: {
        missingRequired: ['crm.email@1.0.0'],
      },
    });
    expect(existsSync(join(installedDir, 'neat-bp'))).toBe(false);
  });

  it('checks grants inherited by an abstract identity before placing its bytes', async () => {
    const parent = join(root, 'parent');
    await writeBlueprint(parent, 'id: grant-parent\nversion: 1.0.0\ngrants: { requires: [crm.email@1.0.0] }');
    await writeBlueprint(fixtureRepo, 'id: neat-bp\nversion: 1.0.0\nextends: grant-parent\nslots: [{ slot: domain }]');
    await expect(installBlueprintFromCupboardCore({
      githubUrl: 'https://github.com/acme/neat-bp',
      capabilityContext: { workspaceId: 'workspace-1', potSlug: 'sales-ops', mode: 'agent' },
    }, makeDeps({
      resolveExtends: (id) => id === 'grant-parent' ? join(parent, 'blueprint.yaml') : null,
      capabilityGrantDeps: { getPotBinding: async () => null, listCandidates: async () => [] },
    }))).rejects.toMatchObject({
      code: 'required_capability_provider_absent',
      data: { missingRequired: ['crm.email@1.0.0'] },
    });
    expect(existsSync(join(installedDir, 'neat-bp'))).toBe(false);
  });

  it.each(['outside-ceiling', 'policy-unavailable'] as const)(
    'refuses %s before provider installation, binding writes or identity release',
    async (cause) => {
      await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\ngrants: { requires: [crm.email@1.0.0] }');
      const install = vi.fn();
      const bind = vi.fn();
      const validate = vi.fn(async () => [{
        code: 'capability_unsatisfied' as const, cause, classRef: 'crm.email@1.0.0',
        routes: ['operator-notify', 'suggest-provider', 'needs_human'] as const,
      }]);
      await expect(installBlueprintFromCupboardCore({
        githubUrl: 'https://github.com/acme/neat-bp',
        capabilityContext: { workspaceId: 'workspace-1', potSlug: 'sales-ops', role: 'worker', mode: 'agent',
          installProviderPackages: true },
      }, makeDeps({
        capabilityGrantDeps: { getPotBinding: async () => null, listCandidates: async () => [capabilityCandidate()] },
        validateCapabilityGrants: validate,
        installCapabilityProviderPackages: install, commitCapabilitySelections: bind,
      }))).rejects.toMatchObject({ code: 'capability_unsatisfied', status: 403,
        data: { failures: [{ cause, classRef: 'crm.email@1.0.0' }] } });
      expect(validate).toHaveBeenCalledWith(expect.objectContaining({ ok: true }),
        expect.objectContaining({ role: 'worker', potSlug: 'sales-ops' }));
      expect(install).not.toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
      expect(existsSync(join(installedDir, 'neat-bp'))).toBe(false);
    },
  );

  it('cannot install grants through an adapter that omitted the ceiling validator', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\ngrants: { optional: [crm.email@1.0.0] }');
    await expect(installBlueprintFromCupboardCore({
      githubUrl: 'https://github.com/acme/neat-bp',
      capabilityContext: { workspaceId: 'workspace-1', potSlug: 'sales-ops', mode: 'agent' },
    }, makeDeps({
      capabilityGrantDeps: { getPotBinding: async () => null, listCandidates: async () => [] },
      validateCapabilityGrants: undefined,
    }))).rejects.toMatchObject({ code: 'capability_policy_unavailable' });
    expect(existsSync(join(installedDir, 'neat-bp'))).toBe(false);
  });

  it('installs with a visible optional capability gap', async () => {
    await writeBlueprint(
      fixtureRepo,
      RUNNABLE_YAML +
        '\nslots: [{ slot: domain }]' +
        '\ngrants: { optional: [crm.email@1.0.0] }',
    );
    const result = await installBlueprintFromCupboardCore(
      {
        githubUrl: 'https://github.com/acme/neat-bp',
        capabilityContext: {
          workspaceId: 'workspace-1',
          potSlug: 'sales-ops',
          mode: 'interactive',
        },
      },
      makeDeps({
        capabilityGrantDeps: {
          getPotBinding: async () => null,
          listCandidates: async () => [],
        },
      }),
    );

    expect(result.capabilityGrants).toMatchObject({
      ok: true,
      missingRequired: [],
      missingOptional: ['crm.email@1.0.0'],
      requirements: [{ state: 'absent', optional: true }],
    });
    expect(existsSync(join(installedDir, 'neat-bp', 'blueprint.yaml'))).toBe(true);
  });

  it('persists an agent-selected exact provider before committing the identity release', async () => {
    await writeBlueprint(
      fixtureRepo,
      RUNNABLE_YAML +
        '\nslots: [{ slot: domain }]' +
        '\ngrants: { requires: [crm.email@1.0.0] }',
    );
    const rollback = vi.fn(async () => {});
    const commitCapabilitySelections = vi.fn(async () => ({ rollback }));
    const result = await installBlueprintFromCupboardCore(
      {
        githubUrl: 'https://github.com/acme/neat-bp',
        capabilityContext: {
          workspaceId: 'workspace-1',
          potSlug: 'sales-ops',
          mode: 'agent',
        },
      },
      makeDeps({
        capabilityGrantDeps: {
          getPotBinding: async () => null,
          listCandidates: async () => [capabilityCandidate()],
        },
        commitCapabilitySelections,
      }),
    );

    expect(commitCapabilitySelections).toHaveBeenCalledWith([
      expect.objectContaining({
        classRef: 'crm.email@1.0.0',
        providerPackage: 'acme-crm',
        providerVersion: '2.0.0',
        reason: 'evidence-policy',
      }),
    ]);
    expect(rollback).not.toHaveBeenCalled();
    expect(result.capabilityGrants?.disclosures).toHaveLength(1);
  });

  it('returns the complete provider review and requires consent before package or identity writes', async () => {
    await writeBlueprint(
      fixtureRepo,
      RUNNABLE_YAML +
        '\nslots: [{ slot: domain }]' +
        '\ngrants: { requires: [crm.email@1.0.0] }',
    );
    const commitCapabilitySelections = vi.fn(async () => ({ rollback: async () => {} }));
    const installCapabilityProviderPackages = vi.fn();
    const review = {
      ok: true,
      roots: [{
        providerPackage: 'acme-crm', providerVersion: '2.0.0',
        classRefs: ['crm.email@1.0.0'], kind: 'plugin' as const,
        status: 'installable' as const, listingId: 'listing-acme-crm',
      }],
      units: [{
        name: 'acme-crm', version: '2.0.0', kind: 'plugin' as const,
        listingId: 'listing-acme-crm',
        review: {
          name: 'acme-crm', version: '2.0.0', kind: 'plugin',
          capabilities: ['net:fetch'],
          dependencies: { tools: [], packs: ['audit-pack'], plugins: [], events: [] },
        },
      }, {
        name: 'audit-pack', version: '1.0.0', kind: 'pack' as const,
        listingId: 'listing-audit-pack',
        review: {
          name: 'audit-pack', version: '1.0.0', kind: 'pack', capabilities: [],
          dependencies: { tools: [], packs: [], plugins: [], events: [] },
        },
      }],
      stillMissing: { tools: [], packs: [], plugins: [], events: [] },
      advisory: [],
      rounds: 2,
    };

    await expect(installBlueprintFromCupboardCore(
      {
        githubUrl: 'https://github.com/acme/neat-bp',
        capabilityContext: {
          workspaceId: 'workspace-1', potSlug: 'sales-ops', mode: 'agent',
        },
      },
      makeDeps({
        capabilityGrantDeps: {
          getPotBinding: async () => null,
          listCandidates: async () => [capabilityCandidate()],
        },
        reviewCapabilityProviderPackages: async () => review,
        installCapabilityProviderPackages,
        commitCapabilitySelections,
      }),
    )).rejects.toMatchObject({
      status: 409,
      code: 'capability_provider_install_consent_required',
      data: { capabilityProviderReview: { units: [{ name: 'acme-crm' }, { name: 'audit-pack' }] } },
    });
    expect(installCapabilityProviderPackages).not.toHaveBeenCalled();
    expect(commitCapabilitySelections).not.toHaveBeenCalled();
    expect(existsSync(join(installedDir, 'neat-bp'))).toBe(false);
  });

  it('installs the consented provider closure before binding and identity release', async () => {
    await writeBlueprint(
      fixtureRepo,
      RUNNABLE_YAML +
        '\nslots: [{ slot: domain }]' +
        '\ngrants: { requires: [crm.email@1.0.0] }',
    );
    const order: string[] = [];
    const review = {
      ok: true,
      roots: [{
        providerPackage: 'acme-crm', providerVersion: '2.0.0',
        classRefs: ['crm.email@1.0.0'], kind: 'plugin' as const,
        status: 'installable' as const, listingId: 'listing-acme-crm',
      }],
      units: [{
        name: 'acme-crm', version: '2.0.0', kind: 'plugin' as const,
        listingId: 'listing-acme-crm',
        review: {
          name: 'acme-crm', version: '2.0.0', kind: 'plugin', capabilities: [],
          dependencies: { tools: [], packs: [], plugins: [], events: [] },
        },
      }],
      stillMissing: { tools: [], packs: [], plugins: [], events: [] },
      advisory: [],
      rounds: 1,
    };
    const installResult = {
      ok: true,
      installed: [{ name: 'acme-crm', kind: 'plugin' as const, listingId: 'listing-acme-crm', tools: [] }],
      stillMissing: { tools: [], packs: [], plugins: [], events: [] },
      advisory: [],
      rounds: 1,
      receipts: review.units,
    };
    const result = await installBlueprintFromCupboardCore(
      {
        githubUrl: 'https://github.com/acme/neat-bp',
        capabilityContext: {
          workspaceId: 'workspace-1', potSlug: 'sales-ops', mode: 'agent',
          installProviderPackages: true,
        },
      },
      makeDeps({
        capabilityGrantDeps: {
          getPotBinding: async () => null,
          listCandidates: async () => [capabilityCandidate()],
        },
        reviewCapabilityProviderPackages: async () => review,
        installCapabilityProviderPackages: async () => {
          order.push('install-packages');
          return installResult;
        },
        commitCapabilitySelections: async () => {
          order.push('bind-provider');
          return { rollback: async () => {} };
        },
      }),
    );
    order.push('identity-installed');

    expect(order).toEqual(['install-packages', 'bind-provider', 'identity-installed']);
    expect(result.capabilityProviderReview?.units).toHaveLength(1);
    expect(result.capabilityProviderInstalls?.receipts).toHaveLength(1);
  });

  it('compensates a new provider binding when the identity release fails', async () => {
    await writeBlueprint(
      fixtureRepo,
      RUNNABLE_YAML +
        '\nslots: [{ slot: domain }]' +
        '\ngrants: { requires: [crm.email@1.0.0] }',
    );
    const rollback = vi.fn(async () => {});
    await expect(installBlueprintFromCupboardCore(
      {
        githubUrl: 'https://github.com/acme/neat-bp',
        expectedRelease: { contentHash: 'sha256:' + 'f'.repeat(64) },
        capabilityContext: {
          workspaceId: 'workspace-1',
          potSlug: 'sales-ops',
          mode: 'agent',
        },
      },
      makeDeps({
        capabilityGrantDeps: {
          getPotBinding: async () => null,
          listCandidates: async () => [capabilityCandidate()],
        },
        commitCapabilitySelections: async () => ({ rollback }),
      }),
    )).rejects.toBeInstanceOf(InstallBlueprintError);

    expect(rollback).toHaveBeenCalledOnce();
    expect(existsSync(join(installedDir, 'neat-bp'))).toBe(false);
  });

  it('rejects an invalid github_url', async () => {
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'http://evil.example/x' }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a repo with no blueprint.yaml', async () => {
    await fs.writeFile(join(fixtureRepo, 'README.md'), 'nope', 'utf8');
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/empty' }, makeDeps()),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects an unsafe blueprint id (path traversal)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML.replace('id: neat-bp', 'id: ../escape'));
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/evil' }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });

  it('rejects a structurally invalid runnable blueprint', async () => {
    await writeBlueprint(fixtureRepo, 'id: broken\nworkItem: { kind: feature }\nspine: { edges: {} }');
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/broken' }, makeDeps()),
    ).rejects.toMatchObject({ status: 422 });
    expect(existsSync(join(installedDir, 'broken'))).toBe(false);
  });

  it('hard-fails a missing TOOL dependency (catalog is authoritative)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\ndependencies: { tools: ["nope:missing"] }');
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/neat-bp' }, makeDeps()),
    ).rejects.toThrow(/tool dependencies unmet/);
  });

  it('passes when declared tools are in the catalog; Cupboard-installable plugins are advisory', async () => {
    await writeBlueprint(
      fixtureRepo,
      RUNNABLE_YAML + '\ndependencies: { tools: ["work_items:list"], plugins: ["repomix"] }',
    );
    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/neat-bp' },
      makeDeps({
        resolveHostSets: async () => ({
          availableTools: new Set(['work_items:list']),
          installedPlugins: new Set<string>(),
          cupboardPlugins: new Set(['repomix']),
          cupboardReachable: true,
        }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.depCheck?.installable.plugins).toEqual(['repomix']);
  });

  it('hard-fails a plugin in neither installed nor Cupboard when the Cupboard was reachable', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\ndependencies: { plugins: ["ghost-plugin"] }');
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/neat-bp' }, makeDeps()),
    ).rejects.toThrow(/dependencies unmet: ghost-plugin/);
  });

  it('resolves a spawned-blueprint dep against the built-in/installed tier (P-007)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\ndependencies: { blueprints: ["coding"] }');
    const result = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/neat-bp' },
      makeDeps({
        resolveHostSets: async () => ({
          availableTools: new Set<string>(),
          installedPlugins: new Set<string>(),
          cupboardPlugins: new Set<string>(),
          availableBlueprints: new Set<string>(['coding']),
          cupboardReachable: true,
        }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.dependencies.blueprints).toEqual(['coding']);
    expect(result.depCheck?.missing.blueprints).toEqual([]);
  });

  it('hard-fails a spawned-blueprint dep absent from every tier when the Cupboard was reachable (P-007)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\ndependencies: { blueprints: ["ghost-bp"] }');
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/neat-bp' }, makeDeps()),
    ).rejects.toThrow(/dependencies unmet: ghost-bp/);
  });

  it('does NOT fail missing plugins when the Cupboard was unreachable (transient outage)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\ndependencies: { plugins: ["ghost-plugin"] }');
    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/neat-bp' },
      makeDeps({
        resolveHostSets: async () => ({
          availableTools: new Set<string>(),
          installedPlugins: new Set<string>(),
          cupboardPlugins: new Set<string>(),
          cupboardReachable: false,
        }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.depCheck?.missing.plugins).toEqual(['ghost-plugin']);
  });

  it('overwrite-installs (re-install replaces the dir)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML);
    await installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/neat-bp' }, makeDeps());
    // stale file from a previous version must not survive a re-install
    await fs.writeFile(join(installedDir, 'neat-bp', 'stale.md'), 'old', 'utf8');
    const second = await installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/neat-bp' }, makeDeps());
    expect(second.operation).toBe('no-op');
    expect(existsSync(join(installedDir, 'neat-bp', 'stale.md'))).toBe(false);
    expect(existsSync(join(installedDir, 'neat-bp', 'blueprint.yaml'))).toBe(true);
    expect(existsSync(join(installedDir, '.releases', 'neat-bp', second.release.packageContentHash, 'closure.json'))).toBe(true);
  });

  it('refuses a listed package hash mismatch and a combined activation slot conflict before replacing the active dir', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\nslots: [{ slot: domain }]');
    await expect(installBlueprintFromCupboardCore({
      githubUrl: 'https://github.com/acme/neat-bp',
      expectedRelease: { contentHash: `sha256:${'0'.repeat(64)}` },
    }, makeDeps())).rejects.toMatchObject({ status: 422 });
    await expect(installBlueprintFromCupboardCore({
      githubUrl: 'https://github.com/acme/neat-bp',
      activationStack: [{ id: 'other-domain', slots: ['domain'] }],
    }, makeDeps())).rejects.toMatchObject({ status: 409 });
    expect(existsSync(join(installedDir, 'neat-bp'))).toBe(false);
  });

  it('exports the error class with status mapping', () => {
    const e = new InstallBlueprintError('x', 422);
    expect(e.status).toBe(422);
    expect(e.name).toBe('InstallBlueprintError');
  });
});
