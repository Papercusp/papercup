import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { SU_MODE_DOCUMENTS } from '@papercusp/orchestrator/blueprint';
import {
  bindSelectedIdentityOutputArtifact, bindSelectedIdentityOutputs, compileSelectedIdentityResources,
  getSelectedModeCatalog, getSelectedModeDefinitions,
} from './source';

const scope = { workspace: 'ws-test', goal: 'goal-1', ownerId: 'su-goal-1' };
const observedAt = '2026-09-24T13:00:00.000Z';

describe('selected identity producer output binding', () => {
  it('resolves a selected abstract identity recipe with the existing package compiler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'selected-resource-identity-'));
    const id = 'resource-domain';
    const blueprintDir = join(root, '.papercusp', 'blueprints', id);
    const recipeDir = join(root, 'home', 'recipes', 'selected-recipe');
    try {
      mkdirSync(blueprintDir, { recursive: true });
      mkdirSync(recipeDir, { recursive: true });
      writeFileSync(join(blueprintDir, 'blueprint.yaml'), stringifyYaml({
        id, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
        bundles: [{ kind: 'recipe', ref: 'selected-recipe', version: '1.0.0' }],
      }));
      writeFileSync(join(recipeDir, 'recipe.json'), JSON.stringify({
        id: 'selected-recipe', title: 'Selected recipe', script: 'return 1',
      }));
      writeFileSync(join(recipeDir, 'listing.json'), JSON.stringify({ version: '1.0.0' }));
      vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
      const artifact = await compileSelectedIdentityResources({
        identityId: id, repoDir: root, workspaceId: 'ws-test', harnessSlug: 'harness-test',
      });
      expect(artifact?.inputs).toContainEqual(expect.objectContaining({
        kind: 'package', packageKind: 'recipe', ref: 'selected-recipe',
      }));
      expect(artifact?.configuration).not.toHaveProperty('workItem');
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads one selected mode catalog revision for direct and implied definitions', async () => {
    const catalog = await getSelectedModeCatalog();
    const selected = await getSelectedModeDefinitions(['goal', 'auto', 'goal', 'cold-auto']);
    expect(selected.size).toBe(3);
    for (const modeId of ['goal', 'auto']) {
      const definition = selected.get(modeId)!;
      const entry = catalog.entries.find((candidate) => candidate.id === modeId)!;
      expect(definition.catalogRevision).toBe(catalog.revision);
      expect(definition.sourceRevision).toBe(entry.sourceHash);
      expect(definition.definitionHash).toBe(entry.definitionHash);
      expect(definition.contractRevision).toBe(createHash('sha256').update(definition.contract).digest('hex'));
    }
    expect(selected.get('cold-auto')!.contract).toContain('## COLD AUTO');
    expect(selected.get('cold-auto')!.sourceRevision).toBe(selected.get('auto')!.sourceRevision);
    await expect(getSelectedModeDefinitions(['unknown-mode'])).rejects.toThrow(/no selected fixed definition/);
  });

  it('binds every catalogued mode state through its declared turn producer and fixed definition', async () => {
    for (const document of SU_MODE_DOCUMENTS) {
      const bound = await bindSelectedIdentityOutputArtifact({
        identityId: document.id,
        sourceTier: 'builtin',
        outputs: [{ contributionId: 'current-mode-state', value: { mode: document.modes[0] } }],
        scope,
        observedAt,
      });
      expect(bound.artifact.provenance, document.id).toContainEqual(expect.objectContaining({
        path: 'contribution.current-mode-state', decision: 'provider:turn',
        producerRef: 'modes/store:agent_modes',
      }));
      expect(bound.artifact.provenance, document.id).toContainEqual(expect.objectContaining({
        path: `contribution.${document.modes[0]}-definition`, decision: 'fixed:source-change',
      }));
    }
  });

  it('accepts an explicit mode-state omission before a recovery holder is attached', async () => {
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.mode-goal',
      sourceTier: 'builtin',
      outputs: [
        { contributionId: 'current-mode-state', omission: { reason: 'not-requested' } },
        { contributionId: 'goal-kickoff', value: 'GOAL recovery kickoff' },
        { contributionId: 'goal-portfolio', omission: { reason: 'not-requested' } },
      ],
      scope: { workspace: 'ws-test', ownerId: 'su-recovery' },
      observedAt,
    });
    expect(receipt.contributions).toContainEqual(expect.objectContaining({
      contributionId: 'current-mode-state', status: 'omitted:not-requested',
    }));
    expect(receipt).not.toHaveProperty('artifact');
  });

  it('pins the already-rendered turn-start prompt with the fixed SU practice prompt', async () => {
    const block = '## Orientation\n- held: WI-9';
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.practice',
      sourceTier: 'builtin',
      outputs: [{ contributionId: 'turn-start-orientation', value: block }],
      scope: { workspace: 'ws-test', ownerId: 'su-1', sink: 'turn-start' },
      observedAt,
    });
    expect(receipt.specificationRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.contributions).toEqual([
      expect.objectContaining({ contributionId: 'turn-start-orientation', status: 'bound',
        outputRevision: createHash('sha256').update(block).digest('hex') }),
    ]);
  });

  it('pins the GOAL obligation projection while explicitly omitting other launch-only providers', async () => {
    const text = '- 📌 goal action: place the next plan';
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.mode-goal',
      sourceTier: 'builtin',
      outputs: [
        { contributionId: 'current-mode-state', value: [{ mode: 'goal', axisKey: 'goal' }] },
        { contributionId: 'goal-kickoff', omission: { reason: 'not-requested' } },
        { contributionId: 'goal-portfolio', omission: { reason: 'not-requested' } },
        { contributionId: 'goal-obligations', value: text },
      ],
      scope: { workspace: 'ws-test', ownerId: 'su-1', sink: 'turn-start' },
      observedAt,
    });
    expect(receipt.specificationRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.contributions).toContainEqual(expect.objectContaining({
      contributionId: 'goal-obligations', status: 'bound',
      outputRevision: createHash('sha256').update(text).digest('hex'),
    }));
  });

  it('pins an existing structured orient result with the fixed SU practice prompt', async () => {
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.practice',
      sourceTier: 'builtin',
      outputs: [{ contributionId: 'coord-orientation', value: { ok: true, self: { ownerId: 'su-1' } } }],
      scope: { workspace: 'ws-test', ownerId: 'su-1' },
      observedAt,
    });
    expect(receipt.specificationRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.contributions).toEqual([
      expect.objectContaining({ contributionId: 'coord-orientation', status: 'bound' }),
    ]);
  });

  it('binds the same source revision selected by the installed mode catalog', async () => {
    const catalog = await getSelectedModeCatalog();
    const goal = catalog.entries.find((entry) => entry.id === 'goal');
    const definition = (await getSelectedModeDefinitions(['goal'])).get('goal');
    expect(goal).toBeDefined();
    expect(definition).toBeDefined();
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.mode-goal',
      outputs: [
        { contributionId: 'current-mode-state', value: { ok: true, mode: { id: 'goal' } } },
        { contributionId: 'goal-kickoff', value: 'GOAL kickoff' },
        { contributionId: 'goal-portfolio', omission: { reason: 'not-requested' } },
      ],
      scope,
      observedAt,
    });
    expect(receipt.sourceRevision).toBe(goal!.sourceHash);
    expect(receipt.definitionRevision).toBe(definition!.contractRevision);
    expect(receipt.catalogRevision).toBe(catalog.revision);
  });

  it('pins one already-produced kickoff and an explicit absent portfolio with the fixed GOAL definition', async () => {
    const kickoff = 'You are in GOAL mode on goal goal-1';
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.mode-goal',
      sourceTier: 'builtin',
      outputs: [
        { contributionId: 'current-mode-state', value: { ok: true, mode: { id: 'goal' } } },
        { contributionId: 'goal-kickoff', value: kickoff },
        { contributionId: 'goal-portfolio', omission: { reason: 'not-requested' } },
      ],
      scope,
      observedAt,
    });

    expect(receipt.specificationRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.contributions).toEqual([
      expect.objectContaining({ contributionId: 'current-mode-state', status: 'bound' }),
      expect.objectContaining({
        contributionId: 'goal-kickoff',
        status: 'bound',
        outputRevision: createHash('sha256').update(kickoff).digest('hex'),
      }),
      expect.objectContaining({
        contributionId: 'goal-portfolio', status: 'omitted:not-requested', outputRevision: null,
      }),
    ]);
  });

  it('refuses a provider failure without a traceable error reference', async () => {
    await expect(bindSelectedIdentityOutputs({
      identityId: 'su.mode-goal',
      sourceTier: 'builtin',
      outputs: [
        { contributionId: 'current-mode-state', value: { ok: true, mode: { id: 'goal' } } },
        { contributionId: 'goal-kickoff', value: 'GOAL kickoff' },
        { contributionId: 'goal-portfolio', omission: { reason: 'unavailable' } },
      ],
      scope,
      observedAt,
    })).rejects.toThrow(/unavailable needs errorRef/);
  });
});
