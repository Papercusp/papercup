import { describe, expect, it } from 'vitest';
import { assertStateCensusComplete, generateStateCensus, type CensusDeclaration } from './state-census';

const declaration: CensusDeclaration = {
  kind: 'path', root: 'app-home', name: 'hives', classification: 'state',
  producer: 'hive-store', descendants: true,
};

describe('producer-derived state census', () => {
  it('fails drift verification when a new path has no producer declaration', () => {
    const census = generateStateCensus([
      { kind: 'path', root: 'app-home', name: 'hives/project' },
      { kind: 'path', root: 'app-home', name: 'new-state' },
    ], [declaration]);
    expect(census.residue).toHaveLength(1);
    expect(() => assertStateCensusComplete(census)).toThrow('unclassified:path:app-home:new-state');
  });

  it('does not conflate roots or directory-name prefixes', () => {
    const census = generateStateCensus([
      { kind: 'path', root: 'config-home', name: 'hives/project' },
      { kind: 'path', root: 'app-home', name: 'hives-old/project' },
    ], [declaration]);
    expect(census.residue).toHaveLength(2);
  });

  it('fails on conflicting declarations instead of choosing the first', () => {
    const census = generateStateCensus([declaration], [declaration,
      { ...declaration, classification: 'cache', producer: 'other' }]);
    expect(census.inventory[0].classification).toBeNull();
    expect(() => assertStateCensusComplete(census)).toThrow('conflicting');
  });

  it('covers each non-path entry only by exact producer identity', () => {
    const entries: CensusDeclaration[] = ['database', 'unit', 'secret'].map(kind => ({
      kind: kind as CensusDeclaration['kind'], root: 'host', name: kind,
      classification: kind === 'secret' ? 'secret' : 'state', producer: kind,
    }));
    const census = generateStateCensus(entries, entries);
    expect(census.ok).toBe(true);
    expect(() => assertStateCensusComplete(census)).not.toThrow();
  });
});
