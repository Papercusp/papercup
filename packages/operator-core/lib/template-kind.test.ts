/**
 * Coverage for template-kind: resolveTemplateKind's source-order fallback
 * (manifest templateKind → topology:multi⇒org → registry harness_kind →
 * default 'coding'), the pure pluginAllowsKind gate, and
 * readPluginRequiresTemplateKinds. Uses real temp files under a mocked
 * papercuspRoot (more robust than mocking node:fs/promises).
 */
import { afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'tkind-')) };
});
vi.mock('./papercusp-root', () => ({ papercuspRoot: () => H.root }));

import { resolveTemplateKind, pluginAllowsKind, readPluginRequiresTemplateKinds } from './template-kind';

function writeManifest(slug: string, obj: unknown) {
  mkdirSync(join(H.root, 'harnesses', slug), { recursive: true });
  writeFileSync(join(H.root, 'harnesses', slug, 'papercusp.json'), JSON.stringify(obj));
}
function writeRegistry(obj: unknown) {
  writeFileSync(join(H.root, 'registry.json'), JSON.stringify(obj));
}
function tmpPluginDir(obj?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'plug-'));
  if (obj !== undefined) writeFileSync(join(dir, 'papercusp.json'), JSON.stringify(obj));
  return dir;
}

afterEach(() => {
  rmSync(join(H.root, 'harnesses'), { recursive: true, force: true });
  rmSync(join(H.root, 'registry.json'), { force: true });
});
afterAll(() => rmSync(H.root, { recursive: true, force: true }));

describe('resolveTemplateKind — source order', () => {
  it('uses the manifest templateKind when present', async () => {
    writeManifest('h', { templateKind: 'department' });
    expect(await resolveTemplateKind('h')).toBe('department');
  });

  it("maps topology:'multi' to 'org' when no explicit templateKind", async () => {
    writeManifest('h', { topology: 'multi' });
    expect(await resolveTemplateKind('h')).toBe('org');
  });

  it('falls back to the registry harness_kind', async () => {
    writeManifest('h', {}); // present but no kind hint
    writeRegistry({ projects: [{ slug: 'h', harness_kind: 'org' }] });
    expect(await resolveTemplateKind('h')).toBe('org');
  });

  it("defaults to 'coding' when nothing provides a kind", async () => {
    expect(await resolveTemplateKind('nonexistent')).toBe('coding');
  });
});

describe('pluginAllowsKind (pure gate)', () => {
  it('allows any kind when requires is empty / not an array', () => {
    expect(pluginAllowsKind(undefined, 'coding')).toBe(true);
    expect(pluginAllowsKind([], 'coding')).toBe(true);
    expect(pluginAllowsKind('nope', 'coding')).toBe(true);
  });

  it('enforces membership when a non-empty list is declared', () => {
    expect(pluginAllowsKind(['org', 'department'], 'org')).toBe(true);
    expect(pluginAllowsKind(['org', 'department'], 'coding')).toBe(false);
  });
});

describe('readPluginRequiresTemplateKinds', () => {
  it('returns the string-filtered array', async () => {
    const dir = tmpPluginDir({ requiresTemplateKinds: ['org', 5, 'coding'] });
    expect(await readPluginRequiresTemplateKinds(dir)).toEqual(['org', 'coding']);
  });

  it('returns null when the field is absent', async () => {
    const dir = tmpPluginDir({ name: 'x' });
    expect(await readPluginRequiresTemplateKinds(dir)).toBeNull();
  });

  it('returns null when the manifest is unreadable', async () => {
    const dir = tmpPluginDir(); // no papercusp.json
    expect(await readPluginRequiresTemplateKinds(dir)).toBeNull();
  });
});
