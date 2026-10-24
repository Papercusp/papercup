import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCloneIndex, cloneBlobSha, type CloneSource } from './clone-index';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL(
  './__fixtures__/clone-corpus-20261021/governor-sources.json', import.meta.url,
), 'utf8')) as {
  candidateCommit: string;
  members: (CloneSource & { sha256: string; gitBlobSha1: string })[];
};
const sharedPath = 'packages/operator-core/lib/learning-governor/registrants.ts';
const paths = fixture.members.map(row => row.path);
const current = [...paths, sharedPath].map(path => ({ path, source: readFileSync(resolve(root, path), 'utf8') }));
const redundantMass = (sources: CloneSource[]) => buildCloneIndex(sources).families().reduce((total, family) =>
  total + family.members.reduce((sum, member) => sum + member.mass, 0)
    - Math.max(...family.members.map(member => member.mass)), 0);

function assertGovernorRemediation(sources: CloneSource[]): void {
  const index = buildCloneIndex(sources);
  for (const path of [...paths, sharedPath]) {
    const file = index.getFile(path);
    if (!file || file.status !== 'indexed') throw new Error(`Unmeasured governor source: ${path}`);
    if (path !== sharedPath && file.functions.some(fn => fn.name.endsWith('GovernorGate'))) {
      throw new Error(`Separately maintained governor gate: ${path}`);
    }
  }
  if (redundantMass(sources) !== 0) throw new Error('Governor duplicate mass has returned');
}

describe('P020 measured clone-family remediation', () => {
  it('retains the frozen ten-governor prechange population and exact source identities', () => {
    expect(fixture.candidateCommit).toBe('7395c59c0032f6810f995a1ecf7966c92ac83448');
    expect(paths).toHaveLength(10);
    expect(new Set(paths).size).toBe(10);
    for (const member of fixture.members) {
      expect(cloneBlobSha(member.source)).toBe(member.gitBlobSha1);
      expect(createHash('sha256').update(member.source).digest('hex')).toBe(member.sha256);
    }
    const families = buildCloneIndex(fixture.members).families();
    expect(families).toHaveLength(1);
    expect(families[0].members.map(member => member.path).sort()).toEqual([...paths].sort());
    expect(families[0].members.every(member => member.name.endsWith('GovernorGate'))).toBe(true);
  });

  it('strictly reduces duplicate mass across migrated callers plus the shared implementation', () => {
    expect(redundantMass(fixture.members)).toBeGreaterThan(0);
    expect(redundantMass(current)).toBeLessThan(redundantMass(fixture.members));
    expect(() => assertGovernorRemediation(current)).not.toThrow();
  });

  it.each(fixture.members)('rejects restoring the removed duplicate in $path', member => {
    const restored = current.map(source => source.path === member.path ? member : source);
    expect(() => assertGovernorRemediation(restored)).toThrow('Separately maintained governor gate');
  });
});
