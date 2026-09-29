import { describe, expect, it, vi } from 'vitest';
import type { ProviderBindingRow } from '../capability-class-registry-store';
import {
  findCapabilityProviderIdentityDependents,
  recipeProviderConsentRefusal,
  recipeProviderConsentSubject,
  recipeProviderPins,
  resolveCapabilityGrants,
  type CapabilityPotBinding,
  type CapabilityProviderCandidate,
} from './capability-grant-resolver';

const binding = (overrides: Partial<ProviderBindingRow> = {}): ProviderBindingRow => ({
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
  ...overrides,
});

const candidate = (
  overrides: Partial<CapabilityProviderCandidate> = {},
): CapabilityProviderCandidate => ({
  ...binding(),
  providerKind: 'tool',
  price: null,
  activePotBindings: 1,
  passingStructuralRuns: 1,
  totalStructuralRuns: 1,
  ...overrides,
});

const potBinding = (
  overrides: Partial<CapabilityPotBinding> = {},
): CapabilityPotBinding => ({
  ...binding(),
  providerKind: 'tool',
  potSlug: 'sales-ops',
  boundBy: 'operator-1',
  boundAt: '2026-09-07T00:00:00.000Z',
  ...overrides,
});

describe('resolveCapabilityGrants', () => {
  it('reuses an exact pot binding as SATISFIED without consulting candidates or disclosing', async () => {
    const listCandidates = vi.fn();
    const result = await resolveCapabilityGrants(
      { requires: ['crm.email@1.0.0'] },
      {
        getPotBinding: async () => potBinding(),
        listCandidates,
      },
      { mode: 'agent' },
    );

    expect(result).toMatchObject({
      ok: true,
      satisfied: ['crm.email@1.0.0'],
      selected: [],
      disclosures: [],
      requirements: [{ state: 'satisfied', binding: { providerPackage: 'acme-crm' } }],
    });
    expect(listCandidates).not.toHaveBeenCalled();
  });

  it('preselects a conformant publisher suggestion for an interactive one-click install', async () => {
    const stronger = candidate({
      providerPackage: 'best-crm',
      providerVersion: '4.0.0',
      behavioralStatus: 'passed',
      passingStructuralRuns: 20,
      totalStructuralRuns: 20,
      activePotBindings: 50,
    });
    const suggested = candidate({
      providerPackage: 'publisher-crm',
      providerVersion: '1.4.0',
      price: null,
      activePotBindings: null,
    });
    const result = await resolveCapabilityGrants(
      {
        requires: ['crm.email@1.0.0'],
        suggestedProviders: { 'crm.email@1.0.0': 'publisher-crm' },
      },
      {
        getPotBinding: async () => null,
        listCandidates: async () => [suggested, stronger],
      },
      { mode: 'interactive' },
    );

    expect(result.ok).toBe(true);
    expect(result.requirements[0]).toMatchObject({
      state: 'choosable',
      selection: {
        providerPackage: 'publisher-crm',
        providerVersion: '1.4.0',
        reason: 'publisher-suggestion',
        disclosureRequired: false,
      },
    });
    expect(result.requirements[0]?.candidates?.map((item) => item.providerPackage)).toEqual([
      'best-crm',
      'publisher-crm',
    ]);
    expect(result.requirements[0]?.candidates?.[1]).toMatchObject({
      price: null,
      activePotBindings: null,
    });
  });

  it('requires an interactive choice without a default and accepts an exact explicit selection', async () => {
    const candidates = [
      candidate({ providerPackage: 'one-crm', providerVersion: '1.0.0' }),
      candidate({ providerPackage: 'two-crm', providerVersion: '2.0.0' }),
    ];
    const deps = {
      getPotBinding: async () => null,
      listCandidates: async () => candidates,
    };

    const unresolved = await resolveCapabilityGrants(
      { requires: ['crm.email@1.0.0'] },
      deps,
      { mode: 'interactive' },
    );
    expect(unresolved).toMatchObject({
      ok: false,
      requiresChoice: ['crm.email@1.0.0'],
    });

    const selected = await resolveCapabilityGrants(
      { requires: ['crm.email@1.0.0'] },
      deps,
      {
        mode: 'interactive',
        selections: { 'crm.email@1.0.0': 'two-crm@2.0.0' },
      },
    );
    expect(selected).toMatchObject({
      ok: true,
      requiresChoice: [],
      selected: [{ providerPackage: 'two-crm', reason: 'explicit-selection' }],
    });
  });

  it('does not silently replace an invalid explicit choice in agent mode', async () => {
    const result = await resolveCapabilityGrants(
      { requires: ['crm.email@1.0.0'] },
      {
        getPotBinding: async () => null,
        listCandidates: async () => [candidate({ providerPackage: 'available-crm' })],
      },
      {
        mode: 'agent',
        selections: { 'crm.email@1.0.0': 'missing-crm@9.0.0' },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      selected: [],
      requiresChoice: ['crm.email@1.0.0'],
      requirements: [{
        state: 'choosable',
        selectionProblem: 'explicit provider missing-crm@9.0.0 is not an active conformant candidate',
      }],
    });
  });

  it('uses conformance and track record policy for agent installs and discloses the choice', async () => {
    const flakyPopular = candidate({
      providerPackage: 'flaky-popular',
      passingStructuralRuns: 9,
      totalStructuralRuns: 10,
      activePotBindings: 100,
    });
    const proven = candidate({
      providerPackage: 'proven',
      passingStructuralRuns: 5,
      totalStructuralRuns: 5,
      activePotBindings: 2,
    });
    const result = await resolveCapabilityGrants(
      { requires: ['crm.email@1.0.0'] },
      {
        getPotBinding: async () => null,
        listCandidates: async () => [flakyPopular, proven],
      },
      { mode: 'agent' },
    );

    expect(result).toMatchObject({
      ok: true,
      selected: [{
        providerPackage: 'proven',
        reason: 'evidence-policy',
        disclosureRequired: true,
      }],
    });
    expect(result.disclosures[0]).toContain('proven@2.0.0');
  });

  it('blocks absent required grants while preserving optional and invalid gaps visibly', async () => {
    const result = await resolveCapabilityGrants(
      {
        requires: ['missing.job@1.0.0'],
        optional: ['optional.job@1.0.0', 'not-versioned'],
      },
      {
        getPotBinding: async () => null,
        listCandidates: async () => [],
      },
      { mode: 'interactive' },
    );

    expect(result).toMatchObject({
      ok: false,
      missingRequired: ['missing.job@1.0.0'],
      missingOptional: ['optional.job@1.0.0', 'not-versioned'],
    });
    expect(result.requirements.map((item) => item.state)).toEqual([
      'absent',
      'absent',
      'absent',
    ]);
    expect(result.requirements[2]?.absentReason).toBe('invalid-class-ref');
  });
});

describe('findCapabilityProviderIdentityDependents', () => {
  it('names required and optional installed identities affected by an exact provider removal', () => {
    const dependents = findCapabilityProviderIdentityDependents({
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      pins: [
        {
          classRef: 'crm.email@1.0.0',
          providerPackage: 'acme-crm',
          providerVersion: '2.0.0',
        },
        {
          classRef: 'calendar.read@1.0.0',
          providerPackage: 'calendar-provider',
          providerVersion: '1.0.0',
        },
      ],
      identities: [
        {
          identityRef: 'sales@3.0.0',
          requires: ['crm.email@1.0.0'],
          optional: ['calendar.read@1.0.0'],
        },
        {
          identityRef: 'assistant@1.0.0',
          optional: ['crm.email@1.0.0'],
        },
      ],
    });

    expect(dependents).toEqual([
      {
        identityRef: 'assistant@1.0.0',
        classRef: 'crm.email@1.0.0',
        optional: true,
      },
      {
        identityRef: 'sales@3.0.0',
        classRef: 'crm.email@1.0.0',
        optional: false,
      },
    ]);
  });
});

describe('recipe provider pins and consent (P-013, D-019)', () => {
  const hex = (c: string) => c.repeat(64);
  const inspection = (recipeId: string) => ({
    ok: true as const,
    recipe: { id: recipeId, revision: hex('a') },
    inspectionPin: { sourceSha256: hex('b'), bindingsSha256: hex('c'), recipeRevision: hex('a') },
    toolNames: ['crm:read', 'crm:list'],
    requiredCapabilities: [],
    outputSchema: { type: 'object' },
  });
  const recipe = (overrides: Partial<CapabilityProviderCandidate> = {}) => candidate({
    providerPackage: 'initech-recipes',
    providerKind: 'recipe',
    verbBindings: { send: 'initech:send' },
    recipeInspections: { send: inspection('initech:send') },
    ...overrides,
  });

  it('pins every bound verb, and yields null for a kind-only or mismatched row', () => {
    expect(recipeProviderPins(recipe())).toEqual([{
      verb: 'send', recipeId: 'initech:send', recipeRevision: hex('a'),
      inspectionPinSha256: expect.stringMatching(/^[0-9a-f]{64}$/), toolNames: ['crm:list', 'crm:read'],
    }]);
    expect(recipeProviderPins(recipe({ recipeInspections: undefined }))).toBeNull();
    expect(recipeProviderPins(recipe({ recipeInspections: { send: inspection('initech:other') } }))).toBeNull();
    expect(recipeProviderPins(candidate())).toBeNull();
  });

  it('does not offer a kind-only recipe row as a candidate', async () => {
    const result = await resolveCapabilityGrants(
      { requires: ['crm.email@1.0.0'] },
      { getPotBinding: async () => null, listCandidates: async () => [recipe({ recipeInspections: undefined })] },
      { mode: 'agent' },
    );
    expect(result.missingRequired).toEqual(['crm.email@1.0.0']);
  });

  it('builds a subject only for recipe selections and refuses anything but the echoed approval', async () => {
    const result = await resolveCapabilityGrants(
      { requires: ['crm.email@1.0.0'] },
      { getPotBinding: async () => null, listCandidates: async () => [recipe()] },
      { mode: 'agent' },
    );
    expect(result.selected[0]).toMatchObject({ providerKind: 'recipe', reason: 'evidence-policy' });
    const scope = { workspaceId: 'workspace-1', potSlug: 'sales-ops' };
    expect(recipeProviderConsentSubject(scope, [{ ...result.selected[0]!, providerKind: 'tool' }])).toBeNull();
    const subject = recipeProviderConsentSubject(scope, result.selected)!;
    expect(recipeProviderConsentRefusal(undefined, subject)?.code).toBe('consent_required');
    expect(recipeProviderConsentRefusal({ ...subject, decision: 'rejected' }, subject)?.code).toBe('consent_rejected');
    expect(recipeProviderConsentRefusal({ ...subject, potSlug: 'other-pot', decision: 'approved' }, subject)?.code)
      .toBe('consent_mismatch');
    expect(recipeProviderConsentRefusal({ ...structuredClone(subject), decision: 'approved' }, subject)).toBeNull();
  });
});
