import { describe, expect, it } from 'vitest';
import { computeFindings } from '../../../../scripts/check-generic-independence.mjs';

/**
 * WI-4973 / decouple-generic-libs-private-deps-2026-08-03.
 *
 * Regression guard for the independence gate (`npm run lint:generic-independence`):
 * no `libs/generic/*` (or otherwise BORROWABLE) package may declare a hard
 * `dependencies`/`devDependencies`/`optionalDependencies` edge on another
 * `@papercusp/*` package that is itself NOT in the borrowable set — that is a
 * genuinely private coupling and breaks standalone consumption outright.
 *
 * The HARD-SECTION class (a borrowable-to-borrowable dep declared in the
 * wrong section) is real backlog, not yet fully zero (see the plan's P-003) —
 * this test intentionally does NOT assert findings.length === 0, only that
 * the worse class never regresses back in.
 */
describe('check-generic-independence: computeFindings against the real repo tree', () => {
  it('reports zero private-target findings (no borrowable lib depends on a genuinely private @papercusp/* package)', () => {
    const findings = computeFindings();
    const privateTargets = findings.filter((f) => f.severity === 'private-target');
    expect(privateTargets, JSON.stringify(privateTargets, null, 2)).toEqual([]);
  });

  it('every finding names a real dependency edge (lib, path, dep, section all non-empty)', () => {
    const findings = computeFindings();
    for (const f of findings) {
      expect(f.lib).toBeTruthy();
      expect(f.path).toBeTruthy();
      expect(f.dep).toMatch(/^@papercusp\//);
      expect(f.section).toBeTruthy();
    }
  });

  it('classifies a fixture private-target and a fixture hard-section edge correctly', () => {
    const borrowable = [
      ['fixture/pub-a', 'Pure utilities & infra'],
      ['fixture/pub-b', 'Pure utilities & infra'],
    ];
    const pkgs: Record<string, unknown> = {
      'fixture/pub-a': {
        name: '@papercusp/pub-a',
        dependencies: { '@papercusp/pub-b': '*' }, // hard-section: pub-b IS borrowable
        peerDependencies: { '@papercusp/priv-x': '*' }, // private-target: priv-x is NOT borrowable
      },
      'fixture/pub-b': { name: '@papercusp/pub-b' },
    };
    const findings = computeFindings({
      borrowable,
      submodules: {},
      readPkgFn: (p: string) => pkgs[p],
    });
    expect(findings).toHaveLength(2);
    const bySeverity = Object.fromEntries(findings.map((f) => [f.severity, f]));
    expect(bySeverity['hard-section']).toMatchObject({ lib: '@papercusp/pub-a', dep: '@papercusp/pub-b', section: 'dependencies' });
    expect(bySeverity['private-target']).toMatchObject({ lib: '@papercusp/pub-a', dep: '@papercusp/priv-x', section: 'peerDependencies' });
  });
});
