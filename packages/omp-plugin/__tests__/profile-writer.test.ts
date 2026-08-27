/**
 * profile-writer — materialises the session-scratch dir for OMP.
 *
 * The two security-critical invariants tested here:
 *   - The refresh token NEVER reaches disk (D-009).
 *   - `.mcp.json` carries the access token in the Authorization
 *     header, not in the URL (D-006).
 *
 * The functional invariants:
 *   - System-prompt path collapses persona + toolsmd correctly (with
 *     and without a persona).
 *   - Hooks and skills land under the right subdirs.
 *   - cleanupProfile is idempotent.
 *   - rewriteAccessToken swaps just the header.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBundle } from '../src/bundle-client.js';
import {
  writeProfile,
  rewriteAccessToken,
  cleanupProfile,
} from '../src/profile-writer.js';

// Point sessionScratchDir at a tmp directory by stubbing $XDG_RUNTIME_DIR.
// runtime-dir reads env at every call, so the override sticks even
// without a module reset.
const tmpRoot = mkdtempSync(join(tmpdir(), 'omp-profile-test-'));
process.env.XDG_RUNTIME_DIR = tmpRoot;
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

function makeBundle(overrides: Partial<AgentBundle> = {}): AgentBundle {
  return {
    persona: '# persona body\n',
    toolsmd: '# tools.md body\n',
    skills: [
      { name: 'skill-a.md', source: '# A\n' },
      { name: 'skill-b.md', source: '# B\n' },
    ],
    hooks: [{ name: 'enforce.ts', source: 'export const hook = 1;\n' }],
    mcp_url: 'http://operator.local/api/mcp?power_user=1',
    workspace: { id: 'ws-1', name: 'Workspace 1' },
    user: { id: 'u-1', username: 'alice', displayName: 'Alice' },
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

describe('writeProfile', () => {
  it('writes a system-prompt with persona + toolsmd concatenated', () => {
    const p = writeProfile('pus-sp1', makeBundle(), 'access-1');
    const body = readFileSync(p.systemPromptPath, 'utf8');
    expect(body).toBe('# persona body\n\n\n# tools.md body\n');
  });

  it('writes just the toolsmd when persona is empty', () => {
    const p = writeProfile('pus-sp2', makeBundle({ persona: '' }), 'access-1');
    const body = readFileSync(p.systemPromptPath, 'utf8');
    expect(body).toBe('# tools.md body\n');
  });

  it('writes .mcp.json with token in Authorization header — never in mcp_url (D-006)', () => {
    const p = writeProfile('pus-mc1', makeBundle(), 'access-secret');
    const raw = readFileSync(p.mcpConfigPath, 'utf8');
    const cfg = JSON.parse(raw) as {
      mcpServers: { papercusp: { url: string; headers: Record<string, string> } };
    };
    expect(cfg.mcpServers.papercusp.url).toBe('http://operator.local/api/mcp?power_user=1');
    expect(cfg.mcpServers.papercusp.headers.Authorization).toBe('Bearer access-secret');
    expect(cfg.mcpServers.papercusp.headers['x-papercusp-client']).toBe(
      '!printf %s "${PAPERCUSP_SID:-}"',
    );
    // The URL line in the JSON must NOT contain the token.
    expect(cfg.mcpServers.papercusp.url).not.toContain('access-secret');
  });

  it('never writes the refresh token anywhere on disk (D-009)', () => {
    const p = writeProfile('pus-rt1', makeBundle(), 'access-only');
    // Walk the scratch dir and assert NO file contains a refresh-shaped marker.
    // (The refresh token isn't even passed into writeProfile — but
    // guard against future regressions where someone wires it in.)
    const checked: string[] = [];
    function walk(dir: string): void {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) walk(full);
        else {
          const body = readFileSync(full, 'utf8');
          checked.push(full);
          expect(body).not.toContain('refresh');
          expect(body).not.toContain('REFRESH_SHAPED_FAKE_TOKEN');
        }
      }
    }
    walk(p.scratchDir);
    expect(checked.length).toBeGreaterThan(0);
  });

  it('writes every skill + hook to the right subdir', () => {
    const p = writeProfile('pus-sk1', makeBundle(), 'access-1');
    expect(p.skillPaths).toHaveLength(2);
    expect(p.hookPaths).toHaveLength(1);
    for (const sp of p.skillPaths) {
      expect(sp).toMatch(/\/skills\/skill-[ab]\.md$/);
      expect(existsSync(sp)).toBe(true);
    }
    expect(p.hookPaths[0]).toMatch(/\/hooks\/enforce\.ts$/);
    expect(readFileSync(p.hookPaths[0]!, 'utf8')).toContain('export const hook');
  });

  it('omits the skills/hooks subdir entirely when bundle has none', () => {
    const p = writeProfile(
      'pus-empty',
      makeBundle({ skills: [], hooks: [] }),
      'access-1',
    );
    expect(p.skillPaths).toEqual([]);
    expect(p.hookPaths).toEqual([]);
    expect(existsSync(join(p.scratchDir, 'skills'))).toBe(false);
    expect(existsSync(join(p.scratchDir, 'hooks'))).toBe(false);
  });
});

describe('rewriteAccessToken', () => {
  it('swaps just the Authorization header — leaves url + everything else alone', () => {
    const bundle = makeBundle();
    const p = writeProfile('pus-rw1', bundle, 'access-1');
    rewriteAccessToken(p, bundle, 'access-2');
    const cfg = JSON.parse(readFileSync(p.mcpConfigPath, 'utf8')) as {
      mcpServers: { papercusp: { url: string; headers: Record<string, string> } };
    };
    expect(cfg.mcpServers.papercusp.headers.Authorization).toBe('Bearer access-2');
    expect(cfg.mcpServers.papercusp.headers['x-papercusp-client']).toBe(
      '!printf %s "${PAPERCUSP_SID:-}"',
    );
    expect(cfg.mcpServers.papercusp.url).toBe(bundle.mcp_url);
  });
});

describe('cleanupProfile', () => {
  it('removes the scratch dir recursively', () => {
    const p = writeProfile('pus-cu1', makeBundle(), 'access-1');
    expect(existsSync(p.scratchDir)).toBe(true);
    cleanupProfile(p);
    expect(existsSync(p.scratchDir)).toBe(false);
  });

  it('is safe to call twice (idempotent)', () => {
    const p = writeProfile('pus-cu2', makeBundle(), 'access-1');
    cleanupProfile(p);
    expect(() => cleanupProfile(p)).not.toThrow();
  });
});
