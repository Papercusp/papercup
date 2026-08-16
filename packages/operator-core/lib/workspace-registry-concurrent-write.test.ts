/**
 * writeRegistry must never publish a TORN registry under concurrent writes.
 *
 * `rename` being atomic guarantees a reader sees a whole FILE — it guarantees
 * nothing about that file's CONTENT. When the temp path is unique per PROCESS
 * rather than per WRITE, two concurrent `writeRegistry()` calls in one process
 * interleave truncate-then-write on the SAME temp file, and whichever renames
 * first publishes whatever bytes happen to be there — possibly zero. The reader
 * then gets `''`, and `JSON.parse('')` throws "Unexpected end of JSON input" on
 * a file that looks perfectly valid by the time anyone inspects it (WI-39392).
 *
 * That is not a cosmetic parse error: `readRegistry()` throws by design
 * (WI-6734) because returning an empty registry resolves `activeWorkspaceId()`
 * to the retired 'default' partition, and every scoped read then answers a
 * confident false NOT-FOUND.
 *
 * The CONTROL below is what makes this suite falsifiable without mutating the
 * shared checkout (a mutation probe against a swept tree can be committed by
 * git-sync mid-probe — forbidden here). It reimplements the OLD per-process
 * temp-path scheme locally and asserts the race is observable, so if the real
 * invariant ever regresses we know these assertions still have teeth.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegistry, writeRegistry, type WorkspaceRegistry } from './workspace-registry';

const KEY = 'PAPERCUSP_WORKSPACES_ROOT';

/** A registry big enough that a truncate-then-write window is observable. */
function bigRegistry(marker: string): WorkspaceRegistry {
  return {
    current: marker,
    workspaces: Array.from({ length: 400 }, (_, i) => ({
      id: `${marker}-ws-${i}`,
      name: `${marker} workspace ${i} — padding to widen the write window`,
      createdAt: 1_700_000_000_000 + i,
    })),
  } as WorkspaceRegistry;
}

describe('writeRegistry concurrency (WI-39392)', () => {
  let root: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[KEY];
    root = mkdtempSync(join(tmpdir(), 'pc-registry-concurrent-'));
    process.env[KEY] = root;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
    rmSync(root, { recursive: true, force: true });
  });

  it('never publishes a torn or empty registry under concurrent writes', async () => {
    // Interleave many writes as aggressively as the event loop allows. Each is
    // synchronous internally, so the collision this guards is between the
    // truncate of one write and the rename of another sharing a temp path.
    const rounds = 60;
    for (let round = 0; round < rounds; round++) {
      await Promise.all(
        Array.from({ length: 8 }, (_, w) =>
          Promise.resolve().then(() => writeRegistry(bigRegistry(`r${round}w${w}`))),
        ),
      );

      // The published file must ALWAYS be a whole, parseable document.
      const raw = readFileSync(join(root, 'registry.json'), 'utf8');
      expect(raw.length).toBeGreaterThan(0);
      expect(() => JSON.parse(raw)).not.toThrow();

      // And the canonical reader must never throw the unreadable-registry error.
      expect(() => readRegistry()).not.toThrow();
    }
  });

  it('leaves no temp files behind, so unique temp names cannot accumulate', async () => {
    await Promise.all(
      Array.from({ length: 16 }, (_, w) =>
        Promise.resolve().then(() => writeRegistry(bigRegistry(`cleanup${w}`))),
      ),
    );
    const { readdirSync } = await import('node:fs');
    const strays = readdirSync(root).filter((f) => f.endsWith('.tmp'));
    expect(strays).toEqual([]);
  });

  it('CONTROL: the retired per-PROCESS temp-path scheme really does tear (so the assertions above have teeth)', () => {
    // Reimplemented locally — the real writeRegistry is NOT mutated, because a
    // mutation probe against this shared checkout can be swept into a commit
    // while it runs.
    const dir = mkdtempSync(join(tmpdir(), 'pc-registry-control-'));
    try {
      const target = join(dir, 'registry.json');
      const shared = `${target}.${process.pid}.tmp`; // the OLD, per-process name
      const payload = JSON.stringify(bigRegistry('control'), null, 2);

      mkdirSync(dir, { recursive: true });
      // Writer A opens+truncates the shared temp and leaves it EMPTY (the
      // window a concurrent writer is inside when A renames).
      writeFileSync(shared, '');
      // Writer B renames that shared temp into place, publishing A's window.
      renameSync(shared, target);

      expect(existsSync(target)).toBe(true);
      const torn = readFileSync(target, 'utf8');
      expect(torn).toBe('');
      // This is the exact production symptom the fix removes.
      expect(() => JSON.parse(torn)).toThrow(/Unexpected end of JSON input/);
      // Sanity: the payload we DIDN'T publish is itself perfectly valid, so the
      // failure above is the race and not a bad fixture.
      expect(() => JSON.parse(payload)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
