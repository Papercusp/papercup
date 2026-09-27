import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPilotCapabilityManifest, getCurrentCapabilityManifest } from './capability-catalog';
import {
  CapabilityPacketSchema,
  CapabilityPathSchema,
  capabilityHash,
  capabilityUnitHash,
  parseCapabilityManifest,
  type CapabilityPacket,
} from './capability-contracts';

const manifest = () => getPilotCapabilityManifest();
const domains = ['memory', 'harness', 'plans', 'dream', 'learnings', 'papercusp-su', 'packaged'];
function packet(): CapabilityPacket {
  const m = manifest();
  const unit = m.units[0]!;
  return {
    schemaVersion: 'dream-capability-packet-v1',
    scope: { workspaceId: 'test-workspace', potSlug: 'test-pot', repositoryId: 'test-repo' },
    unit,
    unitHash: capabilityUnitHash(unit),
    manifestRevision: m.revision,
    sources: unit.evidence.map((ref) => {
      const excerpt = ref.anchor + '\nfixture evidence';
      return {
        ...ref,
        excerpt,
        excerptHash: capabilityHash(excerpt),
        sourceHash: capabilityHash('full fixture source'),
        startLine: 10,
        endLine: 11,
      };
    }),
    extraction: {
      recipeVersion: 'fixture-v1',
      promptVersion: 'fixture-v1',
      capturedAt: '2026-09-07T08:00:00.000Z',
      sourceCommit: null,
      dirty: true,
      backend: 'ripgrep',
      indexHealth: 'unknown',
      artifactRef: 'fixture:packet',
      artifactHash: capabilityHash('fixture artifact'),
      durationMs: 1,
      securityScan: 'passed',
      costUsd: null,
    },
    coverage: {
      status: 'partial',
      includedPaths: unit.evidence.map((ref) => ref.path),
      excluded: ['Other modules'],
      unresolved: [],
      truncated: false,
      note: 'Fixture packet, not a source-verification verdict.',
    },
  };
}
describe('pilot capability catalog', () => {
  it('DREAM-CATALOGUE-EVIDENCE / DREAM-CATALOGUE-LIMITS: expands current source-backed units while preserving the frozen study', () => {
    const pilot = getPilotCapabilityManifest(), current = getCurrentCapabilityManifest();
    expect(pilot.revision).toBe('pilot-2026-09-07-v1');
    expect(pilot.units).toHaveLength(4);
    expect(current.units.slice(0, pilot.units.length)).toEqual(pilot.units);
    expect(current.units.map(u => u.id)).toEqual([...pilot.units.map(u => u.id), 'mechanism:scout.phase-deadline', 'capability:dream.source-freshness', 'mechanism:coord.event-fire-receipt']);
    expect(current.coverage.status).toBe('partial');
    expect(current.coverage.note).toContain('all other behavior remains unknown');
    const root = resolve(import.meta.dirname, '../../../..');
    for (const unit of current.units.slice(pilot.units.length)) {
      expect(unit.contracts.prerequisites.some(c => c.status === 'unknown')).toBe(true);
      for (const ref of unit.evidence) {
        const source = readFileSync(resolve(root, ref.path), 'utf8');
        expect(source, ref.path).toContain(ref.anchor);
        if (ref.kind === 'test') expect(source.slice(source.indexOf(ref.anchor), source.indexOf(ref.anchor) + 3_000)).toContain('expect(');
      }
    }
  });
  it('uses registered domains and distinct identities without claiming complete coverage', () => {
    const m = manifest();
    expect(new Set(m.units.map((unit) => unit.homeDomain)).size).toBeGreaterThan(2);
    expect(m.coverage.status).toBe('partial');
    expect(m.coverage.unmapped.length).toBeGreaterThan(0);
    expect(new Set(m.units.map((unit) => unit.granularity))).toEqual(new Set(['capability', 'mechanism']));
  });
  it('resolves every pilot implementation and meaningful test anchor in the current tree', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    for (const unit of manifest().units) {
      for (const ref of unit.evidence) {
        const contents = readFileSync(resolve(root, ref.path), 'utf8');
        expect(contents, ref.path + ':' + ref.anchor).toContain(ref.anchor);
        if (ref.kind === 'test') {
          const body = contents.slice(contents.indexOf(ref.anchor), contents.indexOf(ref.anchor) + 3_000);
          expect(body, ref.id).toMatch(/expect\(/);
        }
      }
    }
  });
  it.each(['unknown-domain', 'duplicate', 'missing-parent', 'cycle'])('rejects %s catalog identities', (fault) => {
    const m = manifest();
    if (fault === 'unknown-domain') m.units[0]!.homeDomain = 'made-up';
    if (fault === 'duplicate') m.units.push(structuredClone(m.units[0]!));
    if (fault === 'missing-parent') m.units[0]!.parentId = 'capability:absent';
    if (fault === 'cycle') {
      m.units[0]!.parentId = m.units[1]!.id;
      m.units[1]!.parentId = m.units[0]!.id;
    }
    expect(() => parseCapabilityManifest(m, domains)).toThrow();
  });
  it('accepts explicit overlap and valid parentage without duplicating a sampling home', () => {
    const m = manifest();
    m.units[0]!.parentId = m.units[1]!.id;
    m.units[0]!.overlapsUnitIds = [m.units[1]!.id];
    expect(parseCapabilityManifest(m, domains).units[0]!.homeDomain).toBe('memory');
  });
});
describe('capability evidence packet contracts', () => {
  it('preserves unknown index health and unknown cost without inventing zero or completeness', () => {
    const p = CapabilityPacketSchema.parse(packet());
    expect(p.extraction.costUsd).toBeNull();
    expect(p.extraction.indexHealth).toBe('unknown');
    expect(p.extraction.dirty).toBe(true);
  });
  it.each(['/etc/passwd', '../escape', 'a/../escape', 'a//b', 'a\\b', '-option', 'a/*.ts', './source'])(
    'rejects unsafe evidence path %s',
    (path) => {
      expect(CapabilityPathSchema.safeParse(path).success).toBe(false);
    },
  );
  it.each([
    'missing-citation',
    'invented-citation',
    'evaluation-without-test',
    'no-test',
    'hash',
    'range',
    'anchor',
    'source-identity',
    'unit-hash',
    'missing-provenance',
    'complete-coverage',
    'extra-field',
  ])('rejects %s', (fault) => {
    const p = packet();
    if (fault === 'missing-citation') p.unit.purpose[0]!.evidenceIds = [];
    if (fault === 'invented-citation') p.unit.mechanism[0]!.evidenceIds = ['invented'];
    if (fault === 'evaluation-without-test') p.unit.evaluation[0]!.evidenceIds = [p.unit.evidence[0]!.id];
    if (fault === 'no-test') p.unit.evidence = p.unit.evidence.filter((ref) => ref.kind !== 'test');
    if (fault === 'hash') p.sources[0]!.excerpt = 'changed bytes';
    if (fault === 'range') p.sources[0]!.endLine += 1;
    if (fault === 'anchor') {
      p.sources[0]!.excerpt = 'unrelated\nsource';
      p.sources[0]!.excerptHash = capabilityHash(p.sources[0]!.excerpt);
    }
    if (fault === 'source-identity') p.sources[0]!.path = 'other/source.ts';
    if (fault === 'unit-hash') p.unitHash = 'a'.repeat(64);
    if (fault === 'missing-provenance') (p.extraction as Partial<typeof p.extraction>).artifactRef = undefined;
    if (fault === 'complete-coverage') (p.coverage as unknown as { status: string }).status = 'complete';
    const input = fault === 'extra-field' ? { ...p, trusted: true } : p;
    expect(CapabilityPacketSchema.safeParse(input).success).toBe(false);
  });
  it.each([
    'contracts',
    'inputs',
    'outputs',
    'events',
    'state',
    'guarantees',
    'prerequisites',
    'failureModes',
    'resourceConstraints',
  ] as const)('rejects a missing required contract field: %s', (field) => {
    const p = packet();
    expect(CapabilityPacketSchema.safeParse(p).success).toBe(true);
    if (field === 'contracts') delete (p.unit as Partial<typeof p.unit>).contracts;
    else delete (p.unit.contracts as Partial<typeof p.unit.contracts>)[field];
    // Keep the hash consistent: a stale hash must not stand in for the contract detector.
    p.unitHash = capabilityHash(JSON.stringify(p.unit));
    const result = CapabilityPacketSchema.safeParse(p);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Missing contract field was admitted');
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual(
      field === 'contracts' ? ['unit', 'contracts'] : ['unit', 'contracts', field],
    );
  });
  it('bounds source excerpts instead of silently truncating evidence', () => {
    const p = packet();
    p.sources[0]!.excerpt = 'x'.repeat(12_001);
    p.sources[0]!.excerptHash = capabilityHash(p.sources[0]!.excerpt);
    expect(CapabilityPacketSchema.safeParse(p).success).toBe(false);
  });
});
