import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'op-idle-'));
vi.mock('./papercusp-root', () => ({
  papercuspPath: (...parts: string[]) => join(tmpRoot, ...parts),
}));

import { writeSnapshot, readSnapshot, canShortCircuit } from './operator-idle-snapshot';

const PATH = join(tmpRoot, 'system', 'operator', 'idle-snapshot.json');

beforeEach(() => {
  if (existsSync(PATH)) rmSync(PATH);
});
afterEach(() => {
  if (existsSync(PATH)) rmSync(PATH);
});

describe('idle snapshot', () => {
  it('writes + reads a snapshot', () => {
    writeSnapshot('fp123', [{ id: 'a' }]);
    expect(readSnapshot()?.fingerprint).toBe('fp123');
  });

  it('canShortCircuit returns the snapshot when fingerprint matches and ttl ok', () => {
    writeSnapshot('fp', [{ id: 'a' }]);
    expect(canShortCircuit('fp')?.fingerprint).toBe('fp');
  });

  it('returns null when fingerprint differs', () => {
    writeSnapshot('fp', [{ id: 'a' }]);
    expect(canShortCircuit('different')).toBeNull();
  });

  it('returns null past TTL', () => {
    mkdirSync(join(tmpRoot, 'system', 'operator'), { recursive: true });
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    writeFileSync(
      PATH,
      JSON.stringify({ fingerprint: 'fp', computedAt: old, ttlMs: 30 * 60_000, cards: [] }),
    );
    expect(canShortCircuit('fp')).toBeNull();
  });

  it('returns null when no snapshot exists', () => {
    expect(canShortCircuit('fp')).toBeNull();
  });
});
