import { describe, expect, it } from 'vitest';
import {
  SELECTIVE_ACCEPTANCE_CORPUS,
  SELECTIVE_HISTORICAL_BASELINE,
  SELECTIVE_MUTATION_FIXTURE,
  SELECTIVE_PROPERTY_CONTROLS,
  SELECTIVE_SOURCE_BLOBS,
  verifySelectiveSnapshot,
} from './selective-corpus';

describe('selective graph corpus evidence boundaries', () => {
  it('rejects source with matching symbol lines but different bytes', () => {
    const fake = new Map<string, string[]>();
    for (const kase of SELECTIVE_ACCEPTANCE_CORPUS) {
      for (const pin of [...kase.expectedSites, ...kase.corroboration]) {
        const lines = fake.get(pin.path) ?? [];
        lines[pin.line1 - 1] = `${lines[pin.line1 - 1] ?? ''} ${pin.symbolOnLine}`;
        fake.set(pin.path, lines);
      }
    }
    const failures = verifySelectiveSnapshot(path => Buffer.from(fake.get(path)?.join('\n') ?? ''));
    expect(failures.filter(message => message.includes('blob differs'))).toHaveLength(Object.keys(SELECTIVE_SOURCE_BLOBS).length);
    expect(failures.filter(message => message.includes('no longer contains'))).toEqual([]);
  });

  it('reports unavailable source and moved lines as fixture errors', () => {
    const missing = verifySelectiveSnapshot(() => { throw new Error('no source'); });
    expect(missing.some(message => message.includes('frozen source unavailable'))).toBe(true);
    const moved = verifySelectiveSnapshot(() => Buffer.from('\n'));
    expect(moved.some(message => message.includes('selective-external-consumer'))).toBe(true);
  });

  it('keeps historical degraded evidence separate from comparable measurements', () => {
    expect(SELECTIVE_HISTORICAL_BASELINE.comparableTiming).toBe(false);
    const external = SELECTIVE_ACCEPTANCE_CORPUS.find(kase => kase.id === 'selective-external-consumer')!;
    expect(external.expectedSites.some(pin => pin.path.includes('design-compare/acceptance.ts'))).toBe(true);
    expect(external.expectedSites.some(pin => pin.path.endsWith('.test.ts'))).toBe(false);
  });

  it('carries dirty-state, disambiguation, reexport and recovery counterexamples', () => {
    expect(SELECTIVE_PROPERTY_CONTROLS.map(control => control.id)).toEqual([
      'ambiguity', 'reexport', 'dirty-edit', 'dirty-delete', 'refresh-failure', 'concurrent-refresh', 'child-crash',
    ]);
    expect(SELECTIVE_MUTATION_FIXTURE['barrel.ts']).toContain('shared as calculate');
    expect(SELECTIVE_MUTATION_FIXTURE['consumer.ts']).toContain('calculate(1)');
    expect(SELECTIVE_MUTATION_FIXTURE['unrelated.ts']).toContain('shared(value: string)');
  });
});
