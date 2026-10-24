import { describe, expect, it } from 'vitest';
import { boundedFrontier, censusSites, changedSites, selectSourcePath } from './lib/source-path-census.mjs';

describe('source-only call-site preparation', () => {
  it('retains a new import occurrence even when its module specifier already existed', () => {
    const before = censusSites('unit.ts', `async function handler(){ if (old) await import('./funding'); }`);
    const after = censusSites('unit.ts', `async function handler(){ if (old) await import('./funding'); if (preserveArtifact) await import('./funding'); }`);
    const added = changedSites(before, after).addedOrChanged;
    expect(added.filter(site => site.specifier === './funding')).toHaveLength(1);
    expect(added[0].predicates[0].condition).toBe('preserveArtifact');
    expect(added[0].byteEnd).toBeGreaterThan(added[0].byteStart);
  });
  it('keeps eager and pre-branch imports while proving a later lazy branch excluded', () => {
    const unit = censusSites('unit.ts', `import './eager'; async function handler(){
      const [{ verify }] = await Promise.all([import('./verifier')]);
      if (preserveArtifact) { verify(); return true; }
      if (otherRole) { await import('./role-repair'); }
    }`);
    const path = selectSourcePath(unit, { functionName: 'handler', branchValues: { preserveArtifact: true } });
    expect(path.selected.filter(site => site.specifier).map(site => site.specifier)).toEqual(['./eager', './verifier']);
    expect(path.selected.find(site => site.expression === 'verify')?.binding).toEqual({ imported: 'verify', specifiers: ['./verifier'] });
    expect(path.excluded.find(row => row.site.specifier === './role-repair')?.reason).toBe('selected-branch-terminates-before-site');
  });
  it('does not exclude a later branch when the selected branch can fall through', () => {
    const unit = censusSites('unit.ts', `async function handler(){ if(preserveArtifact){ if(bad) return; } await import('./later'); }`);
    const path = selectSourcePath(unit, { functionName: 'handler', branchValues: { preserveArtifact: true } });
    expect(path.selected.some(site => site.specifier === './later')).toBe(true);
  });
  it('retains nonliteral imports and computed dispatch as unresolved coverage', () => {
    const unit = censusSites('unit.ts', `async function handler(){ await import(which); operations[name](); }`);
    const path = selectSourcePath(unit, { functionName: 'handler' });
    expect(path.selected.find(site => site.kind === 'dynamic-import')?.specifier).toBeNull();
    expect(path.selected.find(site => site.expression === 'operations[name]')?.calleeCoverage).toBe('UNKNOWN');
  });
  it('does not confuse another endpoint handler with the selected handler', () => {
    const unit = censusSites('unit.ts', `const first = define({ async handler(){ await import('./first'); } });
      const second = define({ async handler(){ await import('./second'); } });`);
    const path = selectSourcePath(unit, { functionName: 'handler', containerName: 'first' });
    expect(path.selected.filter(site => site.specifier).map(site => site.specifier)).toEqual(['./first']);
  });
  it('retains an identical second import occurrence in the same function', () => {
    const before = censusSites('unit.ts', `async function handler(){ await import('./same'); }`);
    const after = censusSites('unit.ts', `async function handler(){ await import('./same'); await import('./same'); }`);
    expect(changedSites(before, after).addedOrChanged.filter(site => site.specifier === './same')).toHaveLength(1);
  });
  it('counts shared additions once and retains the same total bound across seeds', () => {
    const result = boundedFrontier([{ path: 'shared' }, { path: 'shared' }, { path: 'next' }], { priorAdditions: ['prior'], bound: 2 });
    expect(result.status).toBe('STOPPED-bound');
    expect(result.additions).toEqual(['prior', 'shared']);
    expect(result.refusedEdge?.path).toBe('next');
    expect(result.complete).toBe(false);
  });
});
