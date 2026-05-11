import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  CURRENT_VERSION,
  SHIPPED_VERSIONS,
  dirToVersion,
  witPath,
} from './index';

describe('@papercusp/plugin-wit', () => {
  it('witPath resolves to a real file for every shipped version', () => {
    for (const v of SHIPPED_VERSIONS) {
      const p = witPath(v);
      expect(existsSync(p)).toBe(true);
      // Sanity: the file should look like WIT (starts with package declaration
      // or comment, contains "interface" + "world plugin").
      const contents = readFileSync(p, 'utf8');
      expect(contents).toMatch(/package\s+papercup:plugin/);
      expect(contents).toMatch(/world\s+plugin/);
    }
  });

  it('witPath rejects unknown versions with a clear error', () => {
    expect(() => witPath('99.99.99' as never)).toThrow(/unknown WIT version/);
  });

  it("dirToVersion converts semver to v_-form (mirrors Rust crate's layout)", () => {
    expect(dirToVersion('0.1.0')).toBe('v0_1_0');
  });

  it('CURRENT_VERSION is one of SHIPPED_VERSIONS', () => {
    expect(SHIPPED_VERSIONS as readonly string[]).toContain(CURRENT_VERSION);
  });

  it('the v0.1.0 WIT file declares all the host imports + lifecycle export', () => {
    // Cross-runtime contract: both jco-transpiled JS host + wasmtime Rust
    // host MUST agree on what the world contains. If this test fails after
    // a WIT change, you've broken the contract — bump version instead.
    const contents = readFileSync(witPath('0.1.0'), 'utf8');
    for (const decl of [
      'interface logging',
      'interface lifecycle',
      'interface http',
      'interface secrets',
      'interface events',
      'interface actions',
      'import logging',
      'import http',
      'import secrets',
      'import events',
      'export lifecycle',
      'export actions',
    ]) {
      expect(contents).toContain(decl);
    }
  });
});
