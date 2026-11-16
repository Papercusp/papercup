import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import {
  PRODUCTION_TOOL_REGISTRY_ENTRYPOINT,
  buildBuiltinToolCatalog,
  buildProductionToolSourceFiles,
  buildBuiltinToolDescriptors,
} from './static-tool-catalog';

describe('static tool catalog derivation', () => {
  it('retains capability descriptors through shared defaults and aliased imported constants', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-capability-descriptors-'));
    const write = (path: string, text: string) => {
      const fullPath = resolve(root, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
    };
    try {
      write('package.json', JSON.stringify({ workspaces: [] }));
      write(PRODUCTION_TOOL_REGISTRY_ENTRYPOINT,
        "import { TOOL as N, CAP as permission } from './names';\n" +
        "const common = { capability: 'capability:bash' } as const;\n" +
        "defineTool({ ...common, name: N });\n" +
        "defineTool({ name: 'fixture:override', ...common, capability: permission });\n" +
        "defineUITool({ name: 'internal', expose: { mcp: { name: 'fixture:public' } }, capability: permission });\n");
      write('packages/operator-core/lib/agent-tools/names.ts',
        "export { TOOL, CAP } from './identity';\n");
      write('packages/operator-core/lib/agent-tools/identity.ts',
        "export const TOOL = 'fixture:shared';\nexport const CAP = 'capability:read';\n");
      const result = buildBuiltinToolDescriptors(root);
      expect(result.declarations.map(({ name, capability }) => ({ name, capability }))).toEqual([
        { name: 'fixture:override', capability: 'capability:read' },
        { name: 'fixture:public', capability: 'capability:read' },
        { name: 'fixture:shared', capability: 'capability:bash' },
      ]);
      expect(result.sources.find(row => row.path.endsWith('/identity.ts'))?.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps missing, dynamic and overwritten capabilities unresolved and preserves conflicting declarations', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-unresolved-capability-'));
    mkdirSync(dirname(resolve(root, PRODUCTION_TOOL_REGISTRY_ENTRYPOINT)), { recursive: true });
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ workspaces: [] }));
    try {
      writeFileSync(resolve(root, PRODUCTION_TOOL_REGISTRY_ENTRYPOINT),
        "const stale = { capability: 'capability:read', ...dynamic };\n" +
        "defineTool({ name: 'fixture:missing' });\n" +
        "defineTool({ name: 'fixture:dynamic', capability: compute() });\n" +
        "defineTool({ name: 'fixture:spread', capability: 'capability:read', ...dynamic });\n" +
        "defineTool({ ...stale, name: 'fixture:stale' });\n" +
        "defineTool({ name: 'fixture:restored', ...dynamic, capability: 'capability:bash' });\n" +
        "defineTool({ name: 'fixture:conflict', capability: 'capability:read' });\n" +
        "defineTool({ name: 'fixture:conflict', capability: 'capability:bash' });\n");
      const rows = buildBuiltinToolDescriptors(root).declarations;
      for (const name of ['missing', 'dynamic', 'spread', 'stale']) {
        expect(rows.find(row => row.name === `fixture:${name}`)?.capability).toBeNull();
      }
      expect(rows.find(row => row.name === 'fixture:restored')?.capability).toBe('capability:bash');
      expect(rows.filter(row => row.name === 'fixture:conflict').map(row => row.capability))
        .toEqual(['capability:read', 'capability:bash']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refreshes a current descriptor census and protects the cached source receipts from caller mutation', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-capability-refresh-'));
    const entry = resolve(root, PRODUCTION_TOOL_REGISTRY_ENTRYPOINT);
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ workspaces: [] }));
    try {
      writeFileSync(entry, "defineTool({ name: 'fixture:before', capability: 'capability:read' });\n");
      const original = buildBuiltinToolDescriptors(root);
      const digest = original.sources[0].sha256;
      original.declarations[0].capability = null;
      original.sources[0].sha256 = 'changed';
      expect(buildBuiltinToolDescriptors(root).declarations[0].capability).toBe('capability:read');
      expect(buildBuiltinToolDescriptors(root).sources[0].sha256).toBe(digest);
      writeFileSync(entry, "defineTool({ name: 'fixture:after', capability: 'capability:bash' });\n");
      const current = buildBuiltinToolDescriptors(root, { refresh: true });
      expect(current.declarations[0].name).toBe('fixture:after');
      expect(current.sources[0].sha256).not.toBe(digest);
      expect([...buildBuiltinToolCatalog(root)]).toEqual(['fixture:after']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves an imported string identity through an aliased re-export', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-string-identity-'));
    const write = (path: string, text: string) => {
      const fullPath = resolve(root, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
    };
    try {
      write('package.json', JSON.stringify({ workspaces: [] }));
      write(PRODUCTION_TOOL_REGISTRY_ENTRYPOINT,
        "import { publicName as identity } from './names';\ndefineTool({ name: identity });\n");
      write('packages/operator-core/lib/agent-tools/names.ts',
        "export { TOOL as publicName } from './identity';\n");
      write('packages/operator-core/lib/agent-tools/identity.ts',
        "export const TOOL = 'fixture:continue' as const;\nexport const UNUSED = 'fixture:unused';\n");
      expect([...buildBuiltinToolCatalog(root)]).toEqual(['fixture:continue']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "import type { Ignored } from './types';",
    "import { type Ignored } from './types';",
  ])('does not read type-only dependencies when resolving tool identities: %s', (typeImport) => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-type-only-'));
    const write = (path: string, text: string) => {
      const fullPath = resolve(root, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
      return fullPath;
    };
    try {
      write('package.json', JSON.stringify({ workspaces: [] }));
      const entry = write(PRODUCTION_TOOL_REGISTRY_ENTRYPOINT,
        `${typeImport}\nimport { TOOL } from './identity';\ndefineTool({ name: TOOL });\n`);
      const identity = write('packages/operator-core/lib/agent-tools/identity.ts',
        "export const TOOL = 'fixture:runtime-identity';\n");
      const types = write('packages/operator-core/lib/agent-tools/types.ts',
        'export interface Ignored { name: string }\n');
      const reads = vi.mocked(fs.readFileSync);
      reads.mockClear();
      expect([...buildBuiltinToolCatalog(root)]).toEqual(['fixture:runtime-identity']);
      expect(buildProductionToolSourceFiles(root)).toEqual([entry, identity].sort());
      expect(reads.mock.calls.some(([path]) => path === identity)).toBe(true);
      expect(reads.mock.calls.filter(([path]) => path === types)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "export type { Ignored } from './types';",
    "export { type Ignored } from './types';",
  ])('does not read type-only re-exports when resolving tool identities: %s', (typeExport) => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-type-export-'));
    const write = (path: string, text: string) => {
      const fullPath = resolve(root, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
      return fullPath;
    };
    try {
      write('package.json', JSON.stringify({ workspaces: [] }));
      const entry = write(PRODUCTION_TOOL_REGISTRY_ENTRYPOINT,
        "import { TOOL } from './names';\ndefineTool({ name: TOOL });\n");
      const names = write('packages/operator-core/lib/agent-tools/names.ts',
        `${typeExport}\nexport const TOOL = 'fixture:runtime-export';\n`);
      const types = write('packages/operator-core/lib/agent-tools/types.ts',
        'export interface Ignored { name: string }\n');
      const reads = vi.mocked(fs.readFileSync);
      reads.mockClear();
      expect([...buildBuiltinToolCatalog(root)]).toEqual(['fixture:runtime-export']);
      expect(buildProductionToolSourceFiles(root)).toEqual([entry, names].sort());
      expect(reads.mock.calls.some(([path]) => path === names)).toBe(true);
      expect(reads.mock.calls.filter(([path]) => path === types)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('follows a runtime default import alongside named type imports', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-default-type-'));
    const write = (path: string, text: string) => {
      const fullPath = resolve(root, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
      return fullPath;
    };
    try {
      write('package.json', JSON.stringify({ workspaces: [] }));
      const entry = write(PRODUCTION_TOOL_REGISTRY_ENTRYPOINT,
        "import runtime, { type Ignored } from './runtime';\nvoid runtime;\n");
      const runtime = write('packages/operator-core/lib/agent-tools/runtime.ts',
        "export interface Ignored {}\nexport default 1;\ndefineTool({ name: 'fixture:default-runtime' });\n");
      expect([...buildBuiltinToolCatalog(root)]).toEqual(['fixture:default-runtime']);
      expect(buildProductionToolSourceFiles(root)).toEqual([entry, runtime].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads each module once when identity resolution and runtime traversal share dependencies', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-single-read-'));
    const write = (path: string, text: string) => {
      const fullPath = resolve(root, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
      return fullPath;
    };
    try {
      write('package.json', JSON.stringify({ workspaces: [] }));
      const entry = write(PRODUCTION_TOOL_REGISTRY_ENTRYPOINT,
        "import { publicName as identity } from './names';\ndefineTool({ name: identity });\n");
      const barrel = write('packages/operator-core/lib/agent-tools/names.ts',
        "export { TOOL as publicName } from './identity';\n");
      const identity = write('packages/operator-core/lib/agent-tools/identity.ts',
        "export const TOOL = 'fixture:single-read' as const;\n");
      const reads = vi.mocked(fs.readFileSync);
      reads.mockClear();
      expect([...buildBuiltinToolCatalog(root)]).toEqual(['fixture:single-read']);
      expect(buildProductionToolSourceFiles(root)).toEqual([entry, identity, barrel].sort());
      for (const file of [entry, barrel, identity]) {
        expect(reads.mock.calls.filter(([path]) => path === file), file).toHaveLength(1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['...definition', 'fixture:read'],
    ["name: 'fixture:overridden', ...definition", 'fixture:read'],
    ["...definition, name: 'fixture:override'", 'fixture:override'],
  ])('resolves an imported definition spread in assignment order: %s', (properties, expected) => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-definition-spread-'));
    const write = (path: string, text: string) => {
      const fullPath = resolve(root, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
    };
    try {
      write('package.json', JSON.stringify({ workspaces: [] }));
      write(PRODUCTION_TOOL_REGISTRY_ENTRYPOINT,
        "import { shared as definition } from './definitions';\n"
        + `defineTool({ ${properties}, agentRoles: [] });\n`);
      write('packages/operator-core/lib/agent-tools/definitions.ts',
        "export { readDefinition as shared } from './read-handler';\n");
      write('packages/operator-core/lib/agent-tools/read-handler.ts',
        "export const readDefinition = { name: 'fixture:read', description: 'Reader' } as const;\n"
        + "export const unregistered = { name: 'fixture:unregistered' };\n");
      expect([...buildBuiltinToolCatalog(root)]).toEqual([expected]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves extensionless dotted module names and still refuses a missing dotted module', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-dotted-module-'));
    const write = (path: string, text: string) => {
      const fullPath = resolve(root, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
    };
    try {
      write('package.json', JSON.stringify({ workspaces: [] }));
      write(PRODUCTION_TOOL_REGISTRY_ENTRYPOINT, "import type { Job } from './callers.worker';\nimport './callers.worker';\nimport './runtime.generated';");
      write('packages/operator-core/lib/agent-tools/callers.worker.ts', 'export interface Job { name: string }');
      write('packages/operator-core/lib/agent-tools/runtime.generated.mts', 'export const ready = true;');
      expect(buildProductionToolSourceFiles(root)).toEqual(expect.arrayContaining([
        resolve(root, 'packages/operator-core/lib/agent-tools/callers.worker.ts'),
        resolve(root, 'packages/operator-core/lib/agent-tools/runtime.generated.mts'),
      ]));

      const missing = resolve(root, 'missing');
      write('missing/package.json', JSON.stringify({ workspaces: [] }));
      write(`missing/${PRODUCTION_TOOL_REGISTRY_ENTRYPOINT}`, "import './absent.worker';");
      expect(() => buildProductionToolSourceFiles(missing)).toThrow('could not resolve ./absent.worker');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('resolves the specific .mjs workspace export with reversed ordering=%s', (reversed) => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-exports-'));
    const write = (path: string, text: string) => {
      const fullPath = resolve(root, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
    };
    try {
      write('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
      const entries = [['./lib/*', './lib/*.ts'], ['./lib/*.mjs', './lib/*.mjs']];
      write('packages/fixture/package.json', JSON.stringify({
        name: '@test/fixture', exports: Object.fromEntries(reversed ? entries.reverse() : entries),
      }));
      write(PRODUCTION_TOOL_REGISTRY_ENTRYPOINT, "import '@test/fixture/lib/probe.mjs';");
      write('packages/fixture/lib/probe.mjs', 'export const probe = true;');
      expect(buildProductionToolSourceFiles(root)).toContain(resolve(root, 'packages/fixture/lib/probe.mjs'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the longer export base and does not fall through a blocked specific export', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-export-base-'));
    const write = (path: string, text: string) => {
      const fullPath = resolve(root, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
    };
    try {
      write('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
      write('packages/fixture/package.json', JSON.stringify({
        name: '@test/fixture', exports: { './lib/*': './generic/*.ts', './lib/specific/*': './specific/*.mjs' },
      }));
      write(PRODUCTION_TOOL_REGISTRY_ENTRYPOINT, "import '@test/fixture/lib/specific/probe';");
      write('packages/fixture/specific/probe.mjs', 'export const probe = true;');
      expect(buildProductionToolSourceFiles(root)).toContain(resolve(root, 'packages/fixture/specific/probe.mjs'));
      // A new root avoids the scanner's immutable-snapshot cache for the second graph.
      const blocked = resolve(root, 'blocked');
      write('blocked/package.json', JSON.stringify({ workspaces: ['packages/*'] }));
      write('blocked/packages/fixture/package.json', JSON.stringify({
        name: '@test/fixture', exports: { './lib/*': './generic/*.ts', './lib/*.mjs': null },
      }));
      write(`blocked/${PRODUCTION_TOOL_REGISTRY_ENTRYPOINT}`, "import '@test/fixture/lib/probe.mjs';");
      write('blocked/packages/fixture/generic/probe.mjs.ts', 'export const probe = true;');
      expect(() => buildProductionToolSourceFiles(blocked)).toThrow('could not resolve workspace import');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
