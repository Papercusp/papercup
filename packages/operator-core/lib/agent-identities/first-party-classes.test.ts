/** P-005 (D-039): builtin producers are first-party capability classes. The
 * migration is output-identical, and the binder holds each first-party output
 * to its class contract. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  BlueprintContributionSchema,
  builtinBlueprintPath,
  FIRST_PARTY_CONTEXT_CLASSES,
  FIRST_PARTY_INPUT_KIND,
  firstPartyClassRef,
  resolveFirstPartyContextClass,
} from '@papercusp/orchestrator/blueprint';
import { bindSelectedIdentityOutputs } from './source';

interface GoldenScenario {
  name: string;
  identityId: string;
  sink: string;
  outputs: Array<{ contributionId: string; value?: unknown; omission?: { reason: string; errorRef?: string } }>;
  expected: Array<{ contributionId: string; legacyProducerRef: string; status: string; outputRevision: string | null }>;
}

// Receipts captured from the pre-migration binder (function-path producerRef),
// one scenario per builtin consumer's output set.
const golden = JSON.parse(readFileSync(new URL('./fixtures/p005-first-party-golden.json', import.meta.url), 'utf8')) as {
  scenarios: GoldenScenario[];
};
const scope = { workspace: 'ws-test', ownerId: 'su-1' };
const observedAt = '2026-09-30T12:00:00.000Z';

function builtinProviderContributions() {
  const root = dirname(dirname(builtinBlueprintPath('su')));
  return readdirSync(root).filter((id) => existsSync(join(root, id, 'blueprint.yaml'))).flatMap((id) => {
    const raw = parseYaml(readFileSync(join(root, id, 'blueprint.yaml'), 'utf8')) as {
      contributions?: Array<{ id: string; source: string; inputKind: string; producerRef?: string; verb?: string }>;
    };
    return (raw.contributions ?? [])
      .filter((entry) => entry.source === 'provider' && entry.inputKind !== 'capability-provider')
      .map((entry) => ({ identityId: id, ...entry }));
  });
}

describe('P-005 first-party producer classes', () => {
  it('replays every pre-migration consumer output set to identical receipts', async () => {
    expect(golden.scenarios).toHaveLength(14);
    for (const scenario of golden.scenarios) {
      const receipt = await bindSelectedIdentityOutputs({
        identityId: scenario.identityId, sourceTier: 'builtin', outputs: scenario.outputs as never,
        scope: { ...scope, sink: scenario.sink }, observedAt,
      });
      expect(receipt.contributions, scenario.name).toHaveLength(scenario.expected.length);
      for (const expected of scenario.expected) {
        const actual = receipt.contributions.find((entry) => entry.contributionId === expected.contributionId);
        const firstParty = actual && resolveFirstPartyContextClass(actual.producerRef);
        expect(firstParty, `${scenario.name}/${expected.contributionId}`).toBeTruthy();
        // The conformed provider IS the producer the identity named before.
        expect(actual, `${scenario.name}/${expected.contributionId}`).toMatchObject({
          status: expected.status,
          outputRevision: expected.outputRevision,
          classRef: firstPartyClassRef(firstParty!),
          providerRef: `first-party:${expected.legacyProducerRef}`,
        });
      }
    }
  });

  it('names a catalog class for every builtin setting or prompt provider, and uses every class', () => {
    const contributions = builtinProviderContributions();
    expect(contributions.length).toBeGreaterThan(0);
    const used = new Set<string>();
    for (const entry of contributions) {
      const firstParty = entry.producerRef ? resolveFirstPartyContextClass(entry.producerRef) : null;
      expect(firstParty, `${entry.identityId}/${entry.id}`).not.toBeNull();
      expect(entry.verb, `${entry.identityId}/${entry.id}`).toBe(firstParty!.verb);
      expect(FIRST_PARTY_INPUT_KIND[firstParty!.outputKind], `${entry.identityId}/${entry.id}`).toBe(entry.inputKind);
      used.add(firstParty!.id);
    }
    expect([...used].sort()).toEqual(FIRST_PARTY_CONTEXT_CLASSES.map((entry) => entry.id).sort());
  });

  it('refuses a function-path producer and a setting that names no first-party class', () => {
    const setting = { id: 'brief', purpose: 'operational', source: 'provider', refresh: 'turn',
      inputKind: 'setting', ref: 'brief' } as const;
    expect(BlueprintContributionSchema.safeParse({ ...setting, producerRef: 'papercusp.mode-state@1', verb: 'read' }).success)
      .toBe(true);
    for (const producer of [
      { producerRef: 'modes/store:agent_modes', verb: 'read' },
      { producerRef: 'acme.brief@1', verb: 'read' },
      { producerRef: 'papercusp.mode-state@1', verb: 'render' },
      { producerRef: 'papercusp.goal-kickoff@1', verb: 'render' },
    ]) {
      expect(BlueprintContributionSchema.safeParse({ ...setting, ...producer }).success, producer.producerRef).toBe(false);
    }
  });

  it('refuses a required output that breaks its class schema', async () => {
    await expect(bindSelectedIdentityOutputs({
      identityId: 'su', sourceTier: 'builtin',
      outputs: [
        { contributionId: 'current-mode-state', value: { mode: 'auto' } },
        { contributionId: 'current-assignment', value: { ownerId: 'su-1', intent: null, currentPlanSlug: null } },
      ],
      scope: { ...scope, sink: 'turn-start' }, observedAt,
    })).rejects.toThrow(/current-mode-state output refused: schema-mismatch/);
  });

  it('omits an optional output that breaks its class schema, with the class on the receipt', async () => {
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'su.practice', sourceTier: 'builtin',
      outputs: [{ contributionId: 'coord-orientation', value: { self: { ownerId: 'su-1' } } }],
      scope: { ...scope, sink: 'on-demand' }, observedAt,
    });
    expect(receipt.contributions).toContainEqual({
      contributionId: 'coord-orientation', producerRef: 'papercusp.coord-orientation@1', outputRevision: null,
      status: 'omitted:unavailable', errorRef: 'capability-output:schema-mismatch',
      classRef: 'papercusp.coord-orientation@1.0.0',
      providerRef: 'first-party:agent-tools/coordination/tools/orient:composeOrient',
    });
  });
});
