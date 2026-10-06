/**
 * WI-10006543: graph:query callers from the first-party TypeScript backend.
 * Runs on a throwaway repo with the repo's own `typescript` and the host's `rg`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstPartyCallers, findCandidateFiles } from './first-party-callers';
import {
  incomingCallSites,
  openScopedTsTree,
  openTsTree,
  reExportStub,
  tsDeclarations,
  type TsTree,
} from './typescript-service';

const FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true } }),
  // Two same-named declarations: grep never chooses, so the answer unions both.
  'src/a.ts': 'export function target(n: number): number {\n  return n + 1;\n}\n',
  'src/b.test.ts': 'function target(): string {\n  return "stub";\n}\nexport const fromStub = target();\n',
  // The barrel does not contain the word, so it is served as a re-export stub.
  'src/barrel.ts': 'export * from "./a";\nexport const unrelated = 1;\n',
  'src/use.ts': [
    'import { target } from "./barrel";',
    '// target(1) in a comment is not a call',
    'const label = "target(2) in a string is not a call";',
    'export const viaBarrel = target(3);',
    'export const parsed = parseInt(label);',
    '',
  ].join('\n'),
  // An untyped receiver: the checker cannot say which `target` this is.
  'scripts/hook.mjs': 'export function run(client) {\n  return client.target(4);\n}\n',
};

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'first-party-callers-'));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const lines = (sites: readonly { path: string; line1: number | null }[]): string[] =>
  sites.map((s) => `${s.path}:${s.line1}`).sort();

describe('firstPartyCallers', () => {
  it('unions every same-named declaration and follows an export-star chain through a stubbed barrel', () => {
    const a = firstPartyCallers({ ts, root, name: 'target' });
    expect(a.error).toBeNull();
    expect(a.backend).toBe('typescript-service');
    expect(a.attribution?.declarationCount).toBe(2);
    const resolved = a.sites.filter((s) => !s.detail);
    expect(lines(resolved)).toEqual(['src/b.test.ts:4', 'src/use.ts:4']);
    // The barrel was reached but not served in full.
    expect(a.attribution?.stubbedFiles).toBeGreaterThanOrEqual(1);
  });

  it('lists a call on an untyped receiver as unattributed, with the reason', () => {
    const a = firstPartyCallers({ ts, root, name: 'target' });
    const un = a.sites.filter((s) => s.detail);
    expect(lines(un)).toEqual(['scripts/hook.mjs:2']);
    expect(un[0]!.detail).toMatch(/^unattributed: the checker cannot type the receiver/);
    expect(a.attribution?.unattributed).toEqual({ external: 0, 'other-in-repo': 0, unresolved: 1 });
  });

  it('never reports comments, strings or the declarations themselves', () => {
    const keys = lines(firstPartyCallers({ ts, root, name: 'target' }).sites);
    for (const notACall of ['src/use.ts:2', 'src/use.ts:3', 'src/a.ts:1', 'src/b.test.ts:1']) {
      expect(keys).not.toContain(notACall);
    }
  });

  it('labels a call that resolves outside the repo as external', () => {
    const a = firstPartyCallers({ ts, root, name: 'parseInt' });
    expect(a.error).toBeNull();
    expect(lines(a.sites)).toEqual(['src/use.ts:5']);
    expect(a.sites[0]!.detail).toMatch(/^unattributed: resolves to a declaration outside the repo/);
    expect(a.attribution?.unattributed.external).toBe(1);
  });

  it('answers a name no source file contains with a healthy, trustworthy empty', () => {
    const a = firstPartyCallers({ ts, root, name: 'neverWrittenAnywhere' });
    expect(a.error).toBeNull();
    expect(a.sites).toEqual([]);
    expect(a.freshness.health).toBe('healthy');
    expect(a.attribution?.candidateFiles).toBe(0);
  });

  it('reports truncation against the full count', () => {
    const a = firstPartyCallers({ ts, root, name: 'target', limit: 1 });
    expect(a.sites).toHaveLength(1);
    expect(a.truncation).toEqual({ truncated: true, totalAvailable: 3, continuation: null });
  });

  it('fails loudly, never with a bare empty, when the question or the search cannot be answered', () => {
    const bad = firstPartyCallers({ ts, root, name: 'not an identifier' });
    expect(bad.error).toMatch(/one identifier/);
    expect(bad.freshness.health).toBe('unhealthy');
    const noRg = firstPartyCallers({ ts, root, name: 'target', rgPath: join(root, 'no-such-rg') });
    expect(noRg.error).toMatch(/^ripgrep could not run/);
    expect(noRg.sites).toEqual([]);
  });
});

describe('scoped program', () => {
  it('finds candidates by whole word only', () => {
    const found = findCandidateFiles(root, 'target').files.map((f) => f.slice(root.length + 1)).sort();
    expect(found).toEqual(['scripts/hook.mjs', 'src/a.ts', 'src/b.test.ts', 'src/use.ts']);
  });

  it('keeps only the re-export statements of a stubbed file', () => {
    expect(reExportStub(ts, 'x.ts', FILES['src/barrel.ts']!)).toBe('export * from "./a";');
  });

  const resolvedOf = (tree: TsTree): string[] => {
    const program = tree.service.getProgram()!;
    return lines(incomingCallSites(tree, program, tsDeclarations(tree, program, 'target')));
  };
  const withTree = <T>(tree: TsTree, fn: (t: TsTree) => T): T => {
    try {
      return fn(tree);
    } finally {
      tree.service.dispose();
    }
  };

  it('resolves the same callers as the whole-tree program the bench measured', () => {
    const scoped = withTree(openScopedTsTree(ts, root, findCandidateFiles(root, 'target').files), resolvedOf);
    const whole = withTree(openTsTree(ts, root), resolvedOf);
    expect(scoped).toEqual(whole);
    expect(scoped).toEqual(['src/b.test.ts:4', 'src/use.ts:4']);
  });

  it('serves the full transitive closure when the stub is the identity', () => {
    const candidates = findCandidateFiles(root, 'target').files;
    const closure = withTree(openScopedTsTree(ts, root, candidates, (_ts, _f, text) => text), resolvedOf);
    expect(closure).toEqual(['src/b.test.ts:4', 'src/use.ts:4']);
  });

  // Falsifiability control for the parity above: a stub that drops the barrel's
  // `export *` must break the chain, so the parity test is sensitive to the one
  // thing reExportStub is responsible for keeping.
  it('loses the export-star caller when the stub drops re-exports (control)', () => {
    const candidates = findCandidateFiles(root, 'target').files;
    const lossy = withTree(openScopedTsTree(ts, root, candidates, () => ''), resolvedOf);
    expect(lossy).not.toContain('src/use.ts:4');
    expect(lossy).toContain('src/b.test.ts:4');
    // ...and firstPartyCallers still lists the call, now as unattributed: the
    // syntactic sweep is what keeps grep-equivalence when resolution fails.
    const a = firstPartyCallers({ ts, root, name: 'target' });
    expect(lines(a.sites)).toContain('src/use.ts:4');
  });
});
