/**
 * Coverage for the local rubric store (local-first-party-rubric-bundling-2026-07-07) —
 * the bundled first-party rubrics behind the workspace-store seed. Hermetic where it
 * can be: fixture rubric dirs on disk, roots injected (no PAPERCUSP_RUBRICS_DIR, no
 * DB). Exercises: layered enumeration + user-shadows-bundled, listing.json fallback,
 * ref/id resolution, METHOD.md read, the seed's pure no-clobber/idempotence core — and
 * a build-time guarantee that the REAL in-repo rubrics/ content dirs parse against
 * rubricTemplateDataSchema (what the seed will fail-loud validate at propose time).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listLocalRubrics,
  resolveLocalRubric,
  readLocalRubricMethod,
  rubricsNeedingSeed,
  type RubricRoot,
} from './rubric-store';
import { rubricTemplateDataSchema } from '../agent-tools/plans/rubric-template';

let scratch: string;
let bundled: string;
let user: string;
let roots: RubricRoot[];

const criterion = (key: string) => ({
  key,
  title: `t-${key}`,
  model: 'how it should work',
  method: 'how to check',
  driftMarkers: 'what broken looks like',
});

const manifest = (rubricId: string, extra: object = {}) => ({
  rubricId,
  title: `Rubric ${rubricId}`,
  characteristic: 'agent-behavior',
  description: 'd',
  ratingScale: ['pass', 'partial', 'fail', 'unknown'],
  methodRef: null,
  criteria: [criterion('c-one')],
  version: '0.1.0',
  source: 'first-party',
  ...extra,
});

function writeRubric(
  root: string,
  ref: string,
  opts: { manifest?: object; listing?: object; method?: string } = {},
): string {
  const dir = join(root, ref);
  mkdirSync(dir, { recursive: true });
  if (opts.manifest !== undefined) writeFileSync(join(dir, 'rubric.json'), JSON.stringify(opts.manifest));
  if (opts.listing !== undefined) writeFileSync(join(dir, 'listing.json'), JSON.stringify(opts.listing));
  if (opts.method !== undefined) writeFileSync(join(dir, 'METHOD.md'), opts.method);
  return dir;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'rstore-'));
  bundled = join(scratch, 'bundled');
  user = join(scratch, 'user');
  mkdirSync(bundled, { recursive: true });
  mkdirSync(user, { recursive: true });
  roots = [
    { dir: bundled, layer: 'bundled' },
    { dir: user, layer: 'user' },
  ];
});
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
});

describe('listLocalRubrics', () => {
  it('enumerates self-describing dirs, skips non-rubrics, sorts by ref', () => {
    writeRubric(bundled, 'su-agent-behavior', { manifest: manifest('su-agent-behavior'), method: '# how' });
    writeRubric(bundled, 'fleet-execution-health', {
      manifest: manifest('fleet-execution-health', { characteristic: 'fleet-execution' }),
    });
    writeFileSync(join(bundled, 'README.md'), '# not a rubric'); // skipped (not a dir)
    mkdirSync(join(bundled, 'empty-dir')); // skipped (no rubric.json)
    writeRubric(bundled, 'broken', { manifest: { rubricId: 'broken', title: 'x' } }); // skipped (no criteria/scale)

    const all = listLocalRubrics(roots);
    expect(all.map((r) => r.ref)).toEqual(['fleet-execution-health', 'su-agent-behavior']);
    expect(all.find((r) => r.ref === 'su-agent-behavior')).toMatchObject({
      rubricId: 'su-agent-behavior',
      title: 'Rubric su-agent-behavior',
      characteristic: 'agent-behavior',
      layer: 'bundled',
      source: 'first-party',
      version: '0.1.0',
    });
  });

  it('a user-layer ref shadows a bundled one (the v2 install-over-first-party seam)', () => {
    writeRubric(bundled, 'su-agent-behavior', { manifest: manifest('su-agent-behavior') });
    writeRubric(user, 'su-agent-behavior', {
      manifest: manifest('su-agent-behavior', { title: 'Installed', source: 'installed' }),
    });
    const all = listLocalRubrics(roots);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ title: 'Installed', layer: 'user', source: 'installed' });
  });

  it('listing.json fills storefront gaps the manifest lacks (description/version)', () => {
    const thin = manifest('su-agent-behavior');
    delete (thin as Record<string, unknown>).description;
    delete (thin as Record<string, unknown>).version;
    writeRubric(bundled, 'su-agent-behavior', {
      manifest: thin,
      listing: { id: 'su-agent-behavior', description: 'from listing', version: '0.2.0' },
    });
    expect(listLocalRubrics(roots)[0]).toMatchObject({ description: 'from listing', version: '0.2.0' });
  });
});

describe('resolveLocalRubric + readLocalRubricMethod', () => {
  it('resolves by ref and by rubricId, null on miss; reads METHOD.md when shipped', () => {
    const dir = writeRubric(bundled, 'su-agent-behavior', {
      manifest: manifest('su-agent-behavior', { methodRef: 'su-agent-behavior' }),
      method: '# The exam\nMode A probe',
    });
    writeRubric(bundled, 'no-method', { manifest: manifest('no-method') });

    expect(resolveLocalRubric('su-agent-behavior', roots)?.dir).toBe(dir);
    expect(resolveLocalRubric('nope', roots)).toBeNull();
    expect(readLocalRubricMethod({ dir })).toContain('Mode A probe');
    expect(readLocalRubricMethod(resolveLocalRubric('no-method', roots)!)).toBeNull();
  });
});

describe('rubricsNeedingSeed (the seed decision core)', () => {
  it('no-clobber: an existing workspace rubricId always wins; idempotent on re-run', () => {
    writeRubric(bundled, 'su-agent-behavior', { manifest: manifest('su-agent-behavior') });
    writeRubric(bundled, 'pot-coordination-health', {
      manifest: manifest('pot-coordination-health', { characteristic: 'hive-coordination' }),
    });
    const all = listLocalRubrics(roots);

    // cold start: everything seeds
    expect(rubricsNeedingSeed(all, new Set()).map((r) => r.rubricId)).toEqual([
      'pot-coordination-health',
      'su-agent-behavior',
    ]);
    // an existing id (any status — even a half-authored row) blocks its seed
    expect(rubricsNeedingSeed(all, new Set(['su-agent-behavior'])).map((r) => r.rubricId)).toEqual([
      'pot-coordination-health',
    ]);
    // after a full seed, a re-run is a no-op (idempotence)
    expect(rubricsNeedingSeed(all, new Set(all.map((r) => r.rubricId)))).toEqual([]);
  });
});

describe('the REAL bundled first-party set (in-repo rubrics/)', () => {
  // <repo>/packages/operator-core/lib/cupboard → four levels up is the repo root.
  const inRepo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'rubrics');

  it('every shipped rubric dir resolves and its data passes rubricTemplateDataSchema', () => {
    expect(existsSync(inRepo)).toBe(true);
    const shipped = listLocalRubrics([{ dir: inRepo, layer: 'bundled' }]);
    expect(shipped.map((r) => r.rubricId)).toEqual([
      'experiment-component-quality',
      'experiment-hive-quality',
      'experiment-instance-quality',
      'experiment-replay-quality',
      'fleet-execution-health',
      'pot-coordination-health',
      'su-agent-behavior',
    ]);
    for (const r of shipped) {
      // exactly what the seed hands proposeRubric → buildRubricTemplateData validates
      const parsed = rubricTemplateDataSchema.safeParse({
        characteristic: r.characteristic,
        criteria: r.criteria,
        ratingScale: r.ratingScale,
        ...(r.methodRef ? { methodRef: r.methodRef } : {}),
        ...(r.description ? { description: r.description } : {}),
      });
      expect(parsed.success, `rubric.json for '${r.rubricId}' must satisfy the rubric template schema`).toBe(true);
      expect(r.source).toBe('first-party');
      // a rubric that declares a methodRef must ship its METHOD.md runbook copy
      if (r.methodRef) expect(readLocalRubricMethod(r)).toBeTruthy();
    }
  });
});
