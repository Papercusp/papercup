/**
 * moduleDir — the runtime-portable `import.meta.dirname`. The real-world
 * failure this pins: the operator Hono host runs agent-mcp through tsx's CJS
 * transform where `import.meta.dirname` is undefined, and the prompt
 * resolvers (`agent:role`, `operator:scanner`) crashed with `paths[0] must be
 * of type string` — masked until the HostPlatform registration fix exposed it.
 */
import { describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleDir } from './module-dir';

const fakeMeta = (over: Partial<ImportMeta>): ImportMeta => over as ImportMeta;

describe('moduleDir', () => {
  it('returns this module dir under the test runtime (real import.meta)', () => {
    expect(moduleDir(import.meta)).toBe(dirname(fileURLToPath(import.meta.url)));
  });

  it('prefers dirname when present', () => {
    expect(moduleDir(fakeMeta({ dirname: '/some/dir', url: 'file:///other/x.ts' }))).toBe(
      '/some/dir',
    );
  });

  it('derives from url when dirname is absent (tsx CJS transform shape)', () => {
    expect(moduleDir(fakeMeta({ url: 'file:///repo/pkg/src/mod.ts' }))).toBe('/repo/pkg/src');
  });

  it('returns null for a non-file url', () => {
    expect(moduleDir(fakeMeta({ url: 'data:text/javascript,export{}' }))).toBeNull();
  });

  it('returns null when neither dirname nor url exists', () => {
    expect(moduleDir(fakeMeta({}))).toBeNull();
  });
});
