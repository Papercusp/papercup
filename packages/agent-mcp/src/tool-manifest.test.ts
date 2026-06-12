/**
 * Tests for applyToolManifest — the cache-stability filter that freezes the
 * MCP tools/list surface so the upstream prompt cache doesn't bust mid-session
 * (plan P-024). It had no coverage. Drives the REAL file-read path via a temp
 * manifest + AGENT_MCP_TOOL_MANIFEST rather than mocking fs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHostPlatform } from '@papercusp/host-platform';
import { desktopHostPlatform } from '@papercusp/host-platform/desktop';
import { applyToolManifest, reloadToolManifest, hasToolManifest } from './tool-manifest';

// The SUT reads via HostPlatform now; register the real desktop impl so the
// test keeps driving the actual file-read path (not a stub of it).
registerHostPlatform(desktopHostPlatform);

let dir: string;
let manifestFile: string;
const ORIG = process.env.AGENT_MCP_TOOL_MANIFEST;

const T = (...names: string[]) => names.map((name) => ({ name }));
const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name);

function writeManifest(data: unknown): void {
  writeFileSync(manifestFile, JSON.stringify(data));
  reloadToolManifest();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toolman-'));
  manifestFile = join(dir, 'tool-manifest.json');
  process.env.AGENT_MCP_TOOL_MANIFEST = manifestFile;
  reloadToolManifest(); // file absent for now → next load() = expose-all
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.AGENT_MCP_TOOL_MANIFEST;
  else process.env.AGENT_MCP_TOOL_MANIFEST = ORIG;
  reloadToolManifest();
  rmSync(dir, { recursive: true, force: true });
});

describe('applyToolManifest — expose-all fallbacks (backward compatible)', () => {
  it('no manifest file → exposes everything unchanged', () => {
    expect(hasToolManifest()).toBe(false);
    expect(names(applyToolManifest(T('a', 'b', 'c')))).toEqual(['a', 'b', 'c']);
  });

  it('empty-array manifest → exposes everything', () => {
    writeManifest([]);
    expect(hasToolManifest()).toBe(false);
    expect(names(applyToolManifest(T('a', 'b')))).toEqual(['a', 'b']);
  });

  it('non-string-array manifest → exposes everything', () => {
    writeManifest([1, 2, 3]);
    expect(names(applyToolManifest(T('a', 'b')))).toEqual(['a', 'b']);
  });

  it('unparseable manifest → exposes everything', () => {
    writeFileSync(manifestFile, 'not json{');
    reloadToolManifest();
    expect(names(applyToolManifest(T('a', 'b')))).toEqual(['a', 'b']);
  });

  it('bypass:true ignores even a valid manifest', () => {
    writeManifest(['a']); // would otherwise drop b, c
    expect(names(applyToolManifest(T('a', 'b', 'c'), { bypass: true }))).toEqual(['a', 'b', 'c']);
  });
});

describe('applyToolManifest — pinning', () => {
  it('filters to the manifest set, dropping unlisted tools', () => {
    writeManifest(['a', 'c']);
    expect(hasToolManifest()).toBe(true);
    expect(names(applyToolManifest(T('a', 'b', 'c', 'd')))).toEqual(['a', 'c']);
  });

  it('reorders output to manifest order (cache-stable), independent of input order', () => {
    writeManifest(['c', 'a', 'b']);
    expect(names(applyToolManifest(T('a', 'b', 'c')))).toEqual(['c', 'a', 'b']);
    // Different input order → same manifest-ordered output.
    expect(names(applyToolManifest(T('b', 'c', 'a')))).toEqual(['c', 'a', 'b']);
  });

  it('accepts the { tools: [...] } object form', () => {
    writeManifest({ tools: ['b'] });
    expect(hasToolManifest()).toBe(true);
    expect(names(applyToolManifest(T('a', 'b', 'c')))).toEqual(['b']);
  });
});
