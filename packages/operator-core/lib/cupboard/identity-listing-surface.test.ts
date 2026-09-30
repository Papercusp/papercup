/**
 * portable-identity-packages P-016 — an identity listing's declared surface is
 * derived from the signed closure, serialized canonically, and checked by install
 * against the closure it verified. These tests pin the derivation, the wire bound,
 * every mismatch reason and the facet gate; the publish-to-install round trip runs
 * against real PG in third-party-portability.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { pinPackageInput, type ResolvedPackageInput } from '@papercusp/orchestrator/blueprint';
import { buildBlueprintReleaseArchive, diffBlueprintReleases } from './blueprint-release';
import type { ClassContractPayloadEntry } from './class-contract-payload';
import {
  IDENTITY_LISTING_SURFACE_MAX_CHARS,
  blueprintListingFacet,
  blueprintListingKind,
  checkListedIdentityFacet,
  identityListingSurface,
  identityListingSurfaceMismatch,
  isIdentityBlueprintSource,
  parseIdentityListingSurface,
  serializeIdentityListingSurface,
  type IdentityListingSurface,
  type IdentityListingSurfaceInput,
} from './identity-listing-surface';

const CLASS_REF = 'acmelabs.review-notes@1.0.0';

function pin(packageKind: ResolvedPackageInput['packageKind'], ref: string, fill: string, value?: unknown): ResolvedPackageInput {
  return {
    kind: 'package', packageKind, ref, revision: '1.0.0', contentHash: fill.repeat(64), files: [], dependencies: [],
    ...(value === undefined ? {} : { value }),
  };
}

const root = pin('blueprint', 'acme-reviewer', 'a', { id: 'acme-reviewer', slots: [{ slot: 'domain' }, { slot: 'not-a-slot' }] });
const recipe = pin('recipe', 'acme-notes', 'b', { id: 'acme-notes', script: 'return 1;' });
const guardRule = pin('rule', 'acme-no-rm', 'c', {
  ref: 'acme-no-rm', id: 'acme-no-rm', title: 'no rm', description: 'no recursive deletes', version: '1.0.0',
  delivery: 'sync', sink: 'pre-tool', tools: ['capability:bash'],
  guard: { deny: { 'input.command': { matches: 'rm -rf' } }, reason: 'no recursive deletes' },
});
const asyncRule = pin('rule', 'acme-notify', 'd', {
  ref: 'acme-notify', id: 'acme-notify', title: 'notify', description: 'tell the reviewer', version: '1.0.0',
  delivery: 'async', on: 'work.arrived', fire: 'class:notice.send@1.0.0#send',
});
const brokenRule = pin('rule', 'acme-broken', 'e', { ref: 'acme-broken', delivery: 'sync' });
const pack = pin('knowledge-pack', 'acme-review-kb', 'f', {
  items: [{ id: 'read-notes' }, { id: 'ask-first' }],
  docs: [
    { id: 'z-steps', title: 'Review steps', section: 'Review', body: 'not on the listing' },
    { id: 'a-intro', title: 'Intro', section: 'Start', body: 'not on the listing' },
  ],
});
const contributions = [
  { id: 'reviewer-rules', purpose: 'prompt', source: 'fixed', refresh: 'source-change', inputKind: 'prompt-file', ref: 'fixed:domain' },
  {
    id: 'review-notes', purpose: 'resource', source: 'provider', refresh: 'turn', inputKind: 'capability-provider',
    ref: 'acmelabs.review-notes@1', producerRef: 'acmelabs.review-notes@1', verb: 'read',
    injection: { sinks: ['turn-start'], trigger: { event: 'work:arrived' }, tokenBudget: 400, priority: 10, overBudget: 'omit' },
  },
] as IdentityListingSurfaceInput['contributions'];
const classContracts = [{ ref: CLASS_REF, contractHash: '9'.repeat(64) }] as ClassContractPayloadEntry[];

const input: IdentityListingSurfaceInput = {
  id: 'acme-reviewer', version: '1.0.0',
  grants: { requires: [CLASS_REF], optional: ['zeta.optional@1.0.0', CLASS_REF] },
  contributions,
  archive: { root, pins: [root, recipe, guardRule, asyncRule, brokenRule, pack], classContracts },
};
const identityRaw = { id: 'acme-reviewer', extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }] };
const source = { ...input, raw: identityRaw };

describe('identityListingSurface', () => {
  it('derives what a shopper previews from the closure alone', () => {
    expect(identityListingSurface(input)).toEqual({
      schemaVersion: 2,
      identity: { id: 'acme-reviewer', version: '1.0.0', slots: ['domain'] },
      contributions: [
        { id: 'reviewer-rules', inputKind: 'prompt-file', ref: 'fixed:domain', refresh: 'source-change' },
        { id: 'review-notes', inputKind: 'capability-provider', ref: 'acmelabs.review-notes@1', verb: 'read', refresh: 'turn',
          injection: { sinks: ['turn-start'], timing: 'on event work:arrived', tokenBudget: 400, priority: 10, overBudget: 'omit' } },
      ],
      hooks: {
        sync: [{ id: 'acme-no-rm', rule: 'acme-no-rm@1.0.0', sink: 'pre-tool', kind: 'guard', tools: ['capability:bash'] }],
        async: [{ id: 'acme-notify', rule: 'acme-notify@1.0.0', on: 'work.arrived', fire: 'class:notice.send@1.0.0#send' }],
        unreadable: ['acme-broken@1.0.0'],
      },
      packages: [
        { kind: 'knowledge-pack', ref: 'acme-review-kb', version: '1.0.0', contentHash: 'f'.repeat(64) },
        { kind: 'recipe', ref: 'acme-notes', version: '1.0.0', contentHash: 'b'.repeat(64) },
        { kind: 'rule', ref: 'acme-broken', version: '1.0.0', contentHash: 'e'.repeat(64) },
        { kind: 'rule', ref: 'acme-no-rm', version: '1.0.0', contentHash: 'c'.repeat(64) },
        { kind: 'rule', ref: 'acme-notify', version: '1.0.0', contentHash: 'd'.repeat(64) },
      ],
      knowledge: [{ ref: 'acme-review-kb', version: '1.0.0', memories: 2, docs: [
        { id: 'a-intro', title: 'Intro', section: 'Start' },
        { id: 'z-steps', title: 'Review steps', section: 'Review' },
      ] }],
      classContracts: [{ ref: CLASS_REF, contractHash: '9'.repeat(64) }],
      grants: { requires: [CLASS_REF], optional: [CLASS_REF, 'zeta.optional@1.0.0'] },
      // No knobs and no prompt files in this closure: only the byte count is declared.
      burnKnobs: [{ path: 'promptBytes', value: 0 }],
      permissions: [
        'context:acmelabs.review-notes@1 read',
        'event:acme-notify on work.arrived',
        `grant:${CLASS_REF}`,
        'grant:zeta.optional@1.0.0',
        'operation:class:notice.send@1.0.0#send',
        'rule:acme-no-rm (guard at pre-tool)',
        'shared:recipe:acme-notes',
      ],
      consent: 'required',
    });
  });

  it('serializes the same bytes whatever order the closure and grants arrive in', () => {
    const reordered: IdentityListingSurfaceInput = {
      ...input,
      grants: { optional: [CLASS_REF, 'zeta.optional@1.0.0'], requires: [CLASS_REF] },
      archive: { ...input.archive, pins: [...input.archive.pins].reverse() },
    };
    const text = serializeIdentityListingSurface(identityListingSurface(input));
    expect(serializeIdentityListingSurface(identityListingSurface(reordered))).toBe(text);
    expect(parseIdentityListingSurface(text)).toEqual(identityListingSurface(input));
  });

  it('is content-only when the identity reaches nothing beyond its own content', () => {
    const surface = identityListingSurface({
      id: 'plain', version: '1.0.0', grants: undefined, contributions: undefined,
      archive: { root, pins: [root, pack], classContracts: [] },
    });
    expect(surface).toMatchObject({ permissions: [], consent: 'content-only', grants: { requires: [], optional: [] } });
  });

  it('refuses a surface the Cupboard cannot store rather than truncating it', () => {
    const docs = Array.from({ length: 400 }, (_, index) => ({ id: `doc-${index}`, title: 'x'.repeat(40), section: 'Bulk' }));
    const huge = identityListingSurface({ ...input, archive: { ...input.archive,
      pins: [root, pin('knowledge-pack', 'bulk', '7', { items: [], docs })] } });
    expect(() => serializeIdentityListingSurface(huge))
      .toThrow(`the Cupboard stores at most ${IDENTITY_LISTING_SURFACE_MAX_CHARS}`);
  });
});

describe('burn knobs on the identity listing (agent-economy-flywheel P-015)', () => {
  function release(version: string, effort: string, intervalSec: number, persona: string) {
    const base = pinPackageInput({
      packageKind: 'blueprint', ref: 'acme-base', revision: version, files: [],
      value: { id: 'acme-base', version, roles: { worker: { effort } }, knobs: { loop: { intervalSec } } },
    });
    const rootPin = pinPackageInput({
      packageKind: 'blueprint', ref: 'acme-reviewer', revision: version,
      files: [{ path: 'prompts/persona.md', bytes: persona }],
      value: { id: 'acme-reviewer', version, extends: 'acme-base', slots: [{ slot: 'domain' }], knobs: { maxCostUsd: 2 } },
      dependencies: [{ packageKind: 'blueprint', ref: 'acme-base', revision: version, contentHash: base.contentHash }],
    });
    const archive = buildBlueprintReleaseArchive([base, rootPin], 'acme-reviewer');
    const surface = identityListingSurface({ id: 'acme-reviewer', version, grants: undefined, contributions: undefined, archive });
    return { archive, surface };
  }

  it('declares root and inherited knobs, role effort and prompt bytes, sorted by path', () => {
    expect(release('1.0.0', 'low', 60, 'review carefully\n').surface.burnKnobs).toEqual([
      { path: 'acme-base:loop.intervalSec', value: 60 },
      { path: 'acme-base:roles.worker.effort', value: 'low' },
      { path: 'maxCostUsd', value: 2 },
      { path: 'promptBytes', value: 17 },
    ]);
  });

  it('declares the values the release diff compares, so an upgrade changes both', () => {
    const before = release('1.0.0', 'low', 60, 'review carefully\n');
    const after = release('2.0.0', 'high', 30, 'review carefully\n');
    const diff = diffBlueprintReleases(before.archive, after.archive);
    expect(diff.burnKnobs).toEqual([
      { path: 'acme-base:loop.intervalSec', before: 60, after: 30 },
      { path: 'acme-base:roles.worker.effort', before: 'low', after: 'high' },
    ]);
    const declared = (surface: IdentityListingSurface) => new Map(surface.burnKnobs.map((k) => [k.path, k.value]));
    for (const change of diff.burnKnobs) {
      expect(declared(before.surface).get(change.path)).toEqual(change.before);
      expect(declared(after.surface).get(change.path)).toEqual(change.after);
    }
    // A listing that still declares the old knobs is refused for the new closure.
    const stale = serializeIdentityListingSurface({ ...after.surface, burnKnobs: before.surface.burnKnobs });
    expect(identityListingSurfaceMismatch(stale, after.surface)).toMatchObject({ reason: 'differs' });
    expect(identityListingSurfaceMismatch(serializeIdentityListingSurface(after.surface), after.surface)).toBeNull();
  });
});

describe('identityListingSurfaceMismatch', () => {
  const carried = identityListingSurface(input);
  const listed = serializeIdentityListingSurface(carried);
  const edit = (change: (surface: IdentityListingSurface) => unknown) =>
    JSON.stringify(change(JSON.parse(listed) as IdentityListingSurface));

  it('accepts exactly the carried surface, as text or parsed', () => {
    expect(identityListingSurfaceMismatch(listed, carried)).toBeNull();
    expect(identityListingSurfaceMismatch(JSON.parse(listed), carried)).toBeNull();
  });

  it.each([
    ['missing', null],
    ['missing', ''],
    ['unreadable', '{not json'],
    ['unreadable', '[]'],
    ['unreadable', '{"schemaVersion":1}'],
  ])('reports %s for %j', (reason, value) => {
    expect(identityListingSurfaceMismatch(value, carried)).toEqual({ reason, listed: null });
  });

  it('reports a schema-version skew separately from a difference', () => {
    // A listing published before burn knobs were declared (format 1) is refused
    // as a skew, not waved through as a surface that merely lacks a field.
    const older = edit((surface) => {
      const { burnKnobs, ...rest } = surface;
      void burnKnobs;
      return { ...rest, schemaVersion: 1 };
    });
    expect(identityListingSurfaceMismatch(older, carried))
      .toMatchObject({ reason: 'schema-version', listed: { schemaVersion: 1 } });
  });

  it('refuses a listing that describes less than the closure carries', () => {
    const quieter = edit((surface) => ({ ...surface, permissions: surface.permissions.filter((line) => !line.startsWith('rule:')) }));
    expect(identityListingSurfaceMismatch(quieter, carried)).toMatchObject({ reason: 'differs' });
    const noHooks = edit((surface) => ({ ...surface, hooks: { ...surface.hooks, sync: [] } }));
    expect(identityListingSurfaceMismatch(noHooks, carried)).toMatchObject({ reason: 'differs' });
  });
});

describe('the listing facet', () => {
  it('classifies hive, identity and harness blueprints', () => {
    expect(blueprintListingKind({ kind: 'hive' })).toBe('hive');
    expect(blueprintListingKind({ kind: 'pot' })).toBe('hive');
    expect(blueprintListingKind(identityRaw)).toBe('identity');
    expect(blueprintListingKind({ id: 'plain-harness', version: '1.0.0' })).toBe('harness');
    // A layer that declares slots but fails the schema never downgrades to a harness.
    expect(isIdentityBlueprintSource({ slots: 'not a list' })).toBe(true);
  });

  it('carries the serialized surface for an identity and nothing extra otherwise', () => {
    const snapshot = { ...source, grants: { requires: [CLASS_REF], optional: ['zeta.optional@1.0.0', CLASS_REF] },
      archive: input.archive as Parameters<typeof blueprintListingFacet>[0]['archive'] };
    expect(blueprintListingFacet(snapshot)).toEqual({
      blueprint_kind: 'identity', identity_surface: serializeIdentityListingSurface(identityListingSurface(input)),
    });
    expect(blueprintListingFacet({ ...snapshot, raw: { id: 'plain-harness' } })).toEqual({ blueprint_kind: 'harness' });
  });
});

describe('checkListedIdentityFacet', () => {
  const surface = identityListingSurface(input);
  const listedSurface = serializeIdentityListingSurface(surface);

  it('reports the carried surface without a listing (a direct GitHub install)', () => {
    expect(checkListedIdentityFacet(undefined, source)).toEqual({ surface, mismatch: null });
  });

  it('passes an identity listed with exactly its derived surface', () => {
    expect(checkListedIdentityFacet({ blueprintKind: 'identity', identitySurface: listedSurface }, source))
      .toEqual({ surface, mismatch: null });
  });

  it('refuses an identity listed under another facet, or without its surface', () => {
    expect(checkListedIdentityFacet({ blueprintKind: 'harness', identitySurface: null }, source).mismatch)
      .toEqual({ reason: 'facet', listedKind: 'harness', listed: null, carried: surface });
    expect(checkListedIdentityFacet({ blueprintKind: 'identity', identitySurface: null }, source).mismatch)
      .toEqual({ reason: 'missing', listedKind: 'identity', listed: null, carried: surface });
  });

  it('refuses a non-identity that claims the identity facet or a surface', () => {
    const harness = { ...source, raw: { id: 'plain-harness', version: '1.0.0' } };
    const refusal = { reason: 'not-an-identity', listed: null, carried: null };
    expect(checkListedIdentityFacet({ blueprintKind: 'identity', identitySurface: listedSurface }, harness))
      .toEqual({ surface: null, mismatch: { ...refusal, listedKind: 'identity' } });
    expect(checkListedIdentityFacet({ blueprintKind: 'harness', identitySurface: listedSurface }, harness))
      .toEqual({ surface: null, mismatch: { ...refusal, listedKind: 'harness' } });
    expect(checkListedIdentityFacet({ blueprintKind: 'harness', identitySurface: null }, harness))
      .toEqual({ surface: null, mismatch: null });
  });
});
