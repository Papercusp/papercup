import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'op-last-scan-'));
vi.mock('./papercusp-root', () => ({
  papercuspPath: (...parts: string[]) => join(tmpRoot, ...parts),
}));

import { writeLastScan, readLastScan } from './operator-last-scan';

const PATH = join(tmpRoot, 'system', 'operator', 'last-scan.json');

beforeEach(() => {
  if (existsSync(PATH)) rmSync(PATH);
});
afterEach(() => {
  if (existsSync(PATH)) rmSync(PATH);
});

describe('writeLastScan + readLastScan', () => {
  it('round-trips a snapshot', () => {
    writeLastScan({
      scanCompletedAt: '2026-05-02T12:00:00.000Z',
      scanCostUsd: 0.123,
      cards: [{ id: 'a', title: 'Hi' }, { id: 'b', title: 'Bye' }],
    });
    const r = readLastScan();
    expect(r?.cards).toHaveLength(2);
    expect(r?.scanCostUsd).toBe(0.123);
  });

  it('returns null when no snapshot exists', () => {
    expect(readLastScan()).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    const { writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(join(tmpRoot, 'system', 'operator'), { recursive: true });
    writeFileSync(PATH, '{not json');
    expect(readLastScan()).toBeNull();
  });

  it('rejects non-object cards entries', () => {
    const { writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(join(tmpRoot, 'system', 'operator'), { recursive: true });
    writeFileSync(
      PATH,
      JSON.stringify({ cards: [null, 1, 'x', { id: 'good' }] }),
    );
    const r = readLastScan();
    expect(r?.cards).toEqual([{ id: 'good' }]);
  });
});
