/**
 * readRegistry() must ABSORB a transient torn/garbage read instead of
 * throwing WorkspaceRegistryUnreadableError the instant a re-read also fails
 * — EI-21148378726402614: two concurrent MCP calls both hit "Unexpected end
 * of JSON input" reading ~/.papercusp-workspaces/registry.json, and the file
 * "self-recovered and [was] valid" seconds later. writeRegistry() is already
 * provably atomic (temp file + fsync + unique-per-write rename — see
 * workspace-registry-concurrent-write.test.ts), so there is no torn WRITE
 * left to reproduce here; this test proves the READ side now rides out *some
 * other* process/tool/environment handing back a truncated read for a few
 * attempts in a row, whatever produces that window, without crashing the
 * whole request the way the original one-shot retry did.
 *
 * `node:fs` is mocked at the module level (the same pattern used in
 * endpoint-route/__tests__/launch-su.test.ts) so `readFileSync` can be rigged
 * to return garbage for the registry path a controlled number of times while
 * every other fs call — including `writeRegistry`'s own writes — hits the
 * real filesystem. A prior attempt at this coverage used namespace-wide
 * `vi.spyOn` mocking and found it unreliable under this package's ESM live
 * bindings (see the comment above the CONTROL test in
 * workspace-registry-concurrent-write.test.ts); `vi.mock` + `vi.hoisted` does
 * not have that problem because it replaces the module binding itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Mutable state the mock factory and the tests both need to see — must be
 *  `vi.hoisted` because `vi.mock` factories run before this file's own
 *  top-level `let`/`const` bindings would otherwise be initialized. */
const registryReadRig = vi.hoisted(() => ({ garbageReadsRemaining: 0 }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const path = args[0];
      if (
        typeof path === 'string' &&
        path.endsWith('registry.json') &&
        registryReadRig.garbageReadsRemaining > 0
      ) {
        registryReadRig.garbageReadsRemaining--;
        // Same shape as the production symptom: a truncated document — bytes,
        // but not a whole one.
        return '{"current":"papercusp-workspace","workspa';
      }
      return actual.readFileSync(...args);
    },
  };
});

// Static import AFTER the vi.mock call — vitest hoists vi.mock calls above
// every import in the file regardless of textual order, so this binds to the
// mocked node:fs (the same convention launch-su.test.ts uses).
import { readRegistry, writeRegistry, WorkspaceRegistryUnreadableError } from './workspace-registry';

const KEY = 'PAPERCUSP_WORKSPACES_ROOT';

describe('workspace-registry — read retry absorbs a transient torn read (EI-21148378726402614)', () => {
  let root: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[KEY];
    root = mkdtempSync(join(tmpdir(), 'ws-registry-torn-read-'));
    process.env[KEY] = root;
    registryReadRig.garbageReadsRemaining = 0;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
    registryReadRig.garbageReadsRemaining = 0;
    rmSync(root, { recursive: true, force: true });
  });

  it('rides out a handful of transient garbage reads instead of throwing', () => {
    const reg = {
      current: 'papercusp-workspace',
      workspaces: [{ id: 'papercusp-workspace', name: 'P', createdAt: 1 }],
    };
    writeRegistry(reg);

    // Fewer garbage reads than the retry budget — readRegistry() must
    // eventually see the real, valid content and return it rather than
    // throwing on the first (or second) failed attempt.
    registryReadRig.garbageReadsRemaining = 3;
    expect(readRegistry()).toEqual(reg);
    // The rig's counter hit zero — proving the retries actually happened
    // (a single-attempt reader would have thrown well before this).
    expect(registryReadRig.garbageReadsRemaining).toBe(0);
  });

  it('still throws WorkspaceRegistryUnreadableError once the retry budget is exhausted — a genuinely corrupt registry is never masked (WI-6734)', () => {
    writeRegistry({ current: 'papercusp-workspace', workspaces: [] });

    // Far more garbage reads than any bounded retry budget can absorb — this
    // is what a PERSISTENTLY corrupt registry looks like from the reader's
    // side, and it must still surface as an error, never silently degrade to
    // an empty registry.
    registryReadRig.garbageReadsRemaining = 1000;
    expect(() => readRegistry()).toThrow(WorkspaceRegistryUnreadableError);
  });
});
