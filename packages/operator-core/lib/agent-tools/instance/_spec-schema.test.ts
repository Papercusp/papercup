/**
 * Unit tests for the tool-boundary zod schemas (INST-2): `InstanceSpecArgSchema` +
 * `GenomeDeltaArgSchema` — the instance:boot / instance:clone arg boundary.
 *
 * The schema is strict on the spec shape and permissive on the deployment + genome-
 * config blocks (validated downstream). These pin: a real captured-spec shape parses;
 * a wrong-typed `repoSha`, a missing `blueprintRef.id`, and a non-record config axis
 * all fail; and the genome delta accepts a `null` remove-overlay but rejects a number.
 */
import { describe, it, expect } from 'vitest';
import { InstanceSpecArgSchema, GenomeDeltaArgSchema } from './_spec-schema';
import type { InstanceSpec } from '../../instance-spec';

/** A representative `captureInstanceSpec` output (research = repo-less ⇒ repoSha null). */
const capturedSpec: InstanceSpec = {
  specVersion: 1,
  blueprintRef: {
    id: 'base-harness',
    extends: 'research',
    version: '1.0.0',
    blueprint: { id: 'base-harness', extends: 'research' },
  },
  repoSha: null,
  deploymentConfig: { target: 'local' },
  genome: {
    prompts: { 'queen.placement.md': 'place the queen locally' },
    config: { wake: { minSleepSec: 90 } },
  },
};

describe('InstanceSpecArgSchema', () => {
  it('(a) parses a real captureInstanceSpec output', () => {
    const r = InstanceSpecArgSchema.safeParse(capturedSpec);
    expect(r.success).toBe(true);
  });

  it('also parses a spec with a concrete repoSha (the repo-backed case)', () => {
    const r = InstanceSpecArgSchema.safeParse({ ...capturedSpec, repoSha: 'abc123def456' });
    expect(r.success).toBe(true);
  });

  it('(b) rejects a numeric repoSha — it is z.string().nullable()', () => {
    const r = InstanceSpecArgSchema.safeParse({ ...capturedSpec, repoSha: 42 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.join('.') === 'repoSha')).toBe(true);
  });

  it('repoSha is required (not optional) — omitting it fails', () => {
    const { repoSha: _omit, ...withoutSha } = capturedSpec;
    expect(InstanceSpecArgSchema.safeParse(withoutSha).success).toBe(false);
  });

  it('(c) rejects a blueprintRef missing its required id', () => {
    const r = InstanceSpecArgSchema.safeParse({
      ...capturedSpec,
      blueprintRef: { extends: 'research' },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.join('.') === 'blueprintRef.id')).toBe(true);
  });

  it('rejects an empty blueprintRef.id (min(1))', () => {
    const r = InstanceSpecArgSchema.safeParse({
      ...capturedSpec,
      blueprintRef: { id: '' },
    });
    expect(r.success).toBe(false);
  });

  it('(d) rejects a genome.config axis that is a string, not a record', () => {
    const r = InstanceSpecArgSchema.safeParse({
      ...capturedSpec,
      genome: { prompts: {}, config: { wake: 'fast' } },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.join('.').startsWith('genome.config.wake'))).toBe(true);
  });

  it('rejects a genome.prompts value that is not a string', () => {
    const r = InstanceSpecArgSchema.safeParse({
      ...capturedSpec,
      genome: { prompts: { 'a.md': 5 }, config: {} },
    });
    expect(r.success).toBe(false);
  });
});

describe('GenomeDeltaArgSchema', () => {
  it('(e) accepts a null prompt value (a remove-overlay delta)', () => {
    expect(GenomeDeltaArgSchema.safeParse({ prompts: { 'a.md': null } }).success).toBe(true);
  });

  it('accepts an add/replace prompt overlay and a config-axis patch', () => {
    const r = GenomeDeltaArgSchema.safeParse({
      prompts: { 'a.md': 'overlay text' },
      config: { wake: { minSleepSec: 120 } },
    });
    expect(r.success).toBe(true);
  });

  it('accepts an empty delta', () => {
    expect(GenomeDeltaArgSchema.safeParse({}).success).toBe(true);
  });

  it('(e) rejects a numeric prompt value', () => {
    expect(GenomeDeltaArgSchema.safeParse({ prompts: { 'a.md': 5 } }).success).toBe(false);
  });
});
