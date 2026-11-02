import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { enumerateSecuritySourcePopulation, type PinnedSecuritySource, type SecuritySourceSnapshot } from './security-source-census';

const commit = 'a'.repeat(40);
const blobHash = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const source = (path: string, text: string): PinnedSecuritySource => ({ path, repository: '.', commit,
  blobOid: blobHash(Buffer.from(text)), bytes: Buffer.from(text) });
const snapshot = (sources: PinnedSecuritySource[]): SecuritySourceSnapshot => ({ sources, repositories: [{ path: '.', commit }], unresolved: [] });

describe('pinned security source discovery', () => {
  it('retains every call/import occurrence and alias, dynamic and test leads without claiming runtime closure', () => {
    const text = `import { spawn as launch } from 'node:child_process';
      export async function handler(){ launch('one'); launch('one'); await import(which); operations[name](); }`;
    const result = enumerateSecuritySourcePopulation(snapshot([source('handlers/a.ts', text),
      source('tests/fixture.ts', 'fetch("http://fixture");'),
      source('systemd/operator.service', '[Service]\nExecStart=/usr/bin/node host.js\n')]));
    expect(result.sites.filter(site => site.path === 'handlers/a.ts')).toHaveLength(5);
    const launches = result.sites.filter(site => site.expression === 'launch');
    expect(launches).toHaveLength(2);
    expect(launches[0].binding).toEqual({ imported: 'spawn', specifiers: ['node:child_process'] });
    expect(launches[0].fingerprint).not.toBe(launches[1].fingerprint);
    expect(launches.every(site => site.calleeCoverage === 'UNKNOWN')).toBe(true);
    expect(result.sites.find(site => site.expression === 'operations[name]')?.calleeCoverage).toBe('UNKNOWN');
    expect(result.sites.find(site => site.kind === 'dynamic-import')?.specifier).toBeNull();
    expect(result.sites.find(site => site.path === 'tests/fixture.ts')?.sourceKind).toBe('test-or-fixture');
    expect(result.sites[0].fileSha256).toBe(createHash('sha256').update(text).digest('hex'));
    expect(result.inventory.groups.launchers.map(lead => lead.id)).toContain('systemd/operator.service');
    expect(result.inventory.unresolved).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'dynamic-or-generated-module' })]));
    expect(result.closureAccepted).toBe(false); expect(result.executionAdmitted).toBe(false);
  });

  it('keeps every bounded/unreadable input and parser gap addressable', () => {
    const input = snapshot([source('a.ts', 'one();two();'), source('b.ts', 'three();'),
      source('c.ts', 'four();'), source('d.ts', 'function broken( {'),
      { ...source('e.ts', ''), bytes: Buffer.from([0xff]), blobOid: blobHash(Buffer.from([0xff])) }]);
    input.unresolved = [{ path: 'missing-submodule', reason: 'pinned-repository-unavailable' }];
    const bounded = enumerateSecuritySourcePopulation(input, { maxFiles: 1, maxSites: 1 });
    expect(bounded.sites).toHaveLength(1);
    expect(bounded.inventory.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'b.ts', reason: 'source-file-budget' }),
      expect.objectContaining({ path: 'c.ts', reason: 'source-file-budget' }),
      expect.objectContaining({ path: 'a.ts', reason: 'source-site-budget', omittedSites: 1 }),
      expect.objectContaining({ path: 'missing-submodule', reason: 'pinned-repository-unavailable' }),
    ]));
    const parsed = enumerateSecuritySourcePopulation(input);
    expect(parsed.inventory.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'd.ts', reason: 'source-site-parser-failed' }),
      expect.objectContaining({ path: 'e.ts', reason: 'source-not-utf8' }),
    ]));
    expect(enumerateSecuritySourcePopulation(snapshot([source('a.ts', 'one();')]), { maxBytes: 1 }).inventory.unresolved)
      .toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'source-byte-budget' })]));
    expect(enumerateSecuritySourcePopulation(snapshot([source('a.ts', 'one();')]), { maxInputBytes: 1 }).inventory.unresolved)
      .toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'source-input-budget' })]));
  });

  it('binds exact bytes and repositories deterministically and refuses aliases, duplicates and changed pins', () => {
    const a = source('a.ts', 'one();'), b = source('b.ts', 'two();');
    const first = enumerateSecuritySourcePopulation(snapshot([a, b]));
    expect(enumerateSecuritySourcePopulation(snapshot([b, a])).fingerprint).toBe(first.fingerprint);
    expect(enumerateSecuritySourcePopulation(snapshot([a, source('b.ts', 'other();')])).fingerprint).not.toBe(first.fingerprint);
    expect(() => enumerateSecuritySourcePopulation(snapshot([a, a]))).toThrow('duplicate_path');
    expect(() => enumerateSecuritySourcePopulation(snapshot([{ ...a, path: '../escape.ts' }]))).toThrow('noncanonical_path');
    expect(() => enumerateSecuritySourcePopulation(snapshot([{ ...a, commit: 'c'.repeat(40) }]))).toThrow('pin_mismatch');
    expect(() => enumerateSecuritySourcePopulation(snapshot([{ ...a, bytes: Buffer.from('changed();') }]))).toThrow('blob_mismatch');
    expect(() => enumerateSecuritySourcePopulation(snapshot([a]), { maxSites: 0 })).toThrow('positive_budget');
  });
});
